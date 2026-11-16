import { getVoiceConnections } from '@discordjs/voice';
import { Events, Status, type Client, type Interaction } from 'discord.js';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { feeds } from '../changes.ts';
import { config } from '../config.ts';
import { db, getKv, setKv, transaction } from '../db.ts';
import { machineChange, readMachine, type MachineReading } from '../machine.ts';
import * as perf from '../perf.ts';
import { LOOP_VOICE_COUNTS, type LoopVoice } from '../voiceJoin.ts';
import type { Feature } from '../types.ts';

/**
 * Keeps an eye on how the bot and its containers are doing: samples the bot every 15 seconds, asks the voice, music
 * and loop containers for their memory and CPU every 30, hears from the web UI, and keeps it all a minute at a time
 */

/** How often the bot looks at itself, and asks the other containers how they are */
export const SAMPLE_MS = 15_000;
export const POLL_MS = 30_000;
const POLL_TIMEOUT_MS = 5_000;
/** The web UI reports every 30 seconds; missing three in a row counts as down */
const WEB_STALE_MS = 95_000;
export const ROLLUP_MS = 15 * 60_000;
export const MINUTES_KEPT_MS = 2 * 86_400_000;
export const ROLLUPS_KEPT_MS = 30 * 86_400_000;
const SLOW_KEPT = 500;
/** A command, button or menu that took this long to answer is kept for a look, as Discord gives up at 3 */
const SLOW_ANSWER_S = 2;
/** Discord's "Unknown interaction": it stopped waiting for the first answer */
const EXPIRED = 10062;

const insertMinute = db.prepare('INSERT INTO perf_minutes (at, span, name, labels, count, sum, max, buckets) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const insertSlow = db.prepare('INSERT INTO perf_slow (at, guild_id, what, seconds, steps, detail) VALUES (?, ?, ?, ?, ?, ?)');

/** Writes the minutes that are over, and anything slow, in one go. `all` includes the minute still going */
export function store(all = false) {
  const { minutes, slow } = perf.take(all);
  if (!minutes.length && !slow.length) return;
  transaction(() => {
    for (const m of minutes) insertMinute.run(m.at, 1, m.name, JSON.stringify(m.labels), m.count, m.sum, m.max, m.buckets && JSON.stringify(m.buckets));
    for (const s of slow) insertSlow.run(s.at, s.guildId, s.what, s.seconds, JSON.stringify(s.steps), JSON.stringify(s.detail));
  });
  // A Health view on screen fetches again once there's another minute to show
  if (minutes.length) feeds.health.changedEverywhere();
}

interface MinuteFromDb {
  at: number;
  name: string;
  labels: string;
  count: number;
  sum: number;
  max: number;
  buckets: string | null;
}

/** Adds up every whole 15 minutes not added up yet, then lets go of what's past keeping */
export function rollUp(now = Date.now()) {
  const upTo = Math.floor(now / ROLLUP_MS) * ROLLUP_MS;
  const last = (db.prepare('SELECT MAX(at) AS at FROM perf_minutes WHERE span = 15').get() as { at: number | null }).at;
  const from = last === null ? 0 : last + ROLLUP_MS;
  if (from >= upTo) return;
  const rows = db.prepare('SELECT at, name, labels, count, sum, max, buckets FROM perf_minutes WHERE span = 1 AND at >= ? AND at < ?').all(from, upTo) as unknown as MinuteFromDb[];
  const blocks = new Map<string, MinuteFromDb & { counts: number[] | null }>();
  for (const row of rows) {
    const at = Math.floor(row.at / ROLLUP_MS) * ROLLUP_MS;
    const key = `${at}\n${row.name}\n${row.labels}`;
    const buckets = row.buckets ? (JSON.parse(row.buckets) as number[]) : null;
    const block = blocks.get(key);
    if (!block) {
      blocks.set(key, { ...row, at, counts: buckets });
      continue;
    }
    block.count += row.count;
    block.sum += row.sum;
    block.max = Math.max(block.max, row.max);
    if (buckets) block.counts = block.counts ? block.counts.map((n, i) => n + (buckets[i] ?? 0)) : buckets;
  }
  transaction(() => {
    for (const b of blocks.values()) insertMinute.run(b.at, 15, b.name, b.labels, b.count, b.sum, b.max, b.counts && JSON.stringify(b.counts));
    db.prepare('DELETE FROM perf_minutes WHERE span = 1 AND at < ?').run(now - MINUTES_KEPT_MS);
    db.prepare('DELETE FROM perf_minutes WHERE span = 15 AND at < ?').run(now - ROLLUPS_KEPT_MS);
    db.prepare('DELETE FROM perf_slow WHERE at < ? OR id NOT IN (SELECT id FROM perf_slow ORDER BY id DESC LIMIT ?)').run(now - ROLLUPS_KEPT_MS, SLOW_KEPT);
  });
}

/** Each container's running totals when last heard from, to work out what happened since */
const lastSeen = new Map<string, { usage: perf.ContainerUsage; at: number }>();

const RESOURCES = ['cpu', 'memory', 'io'] as const;

/** Notes what a container said it's using */
export function containerSeen(container: string, usage: perf.ContainerUsage, at = performance.now()) {
  const labels = { container };
  perf.gauge('container_up', 1, labels);
  perf.gauge('container_memory_bytes', usage.memoryBytes, labels);
  if (usage.memoryLimitBytes) perf.gauge('container_memory_limit_bytes', usage.memoryLimitBytes, labels);
  const before = lastSeen.get(container);
  lastSeen.set(container, { usage, at });
  if (!before || at - before.at <= 1000) return;
  const seconds = (at - before.at) / 1000;
  // Each total only counts up while the container runs, so one that went down means it restarted and counts from nothing again
  const grew = (a: number | null | undefined, b: number | null | undefined) => (typeof a === 'number' && typeof b === 'number' && b >= a ? b - a : null);
  const cpu = grew(before.usage.cpuSeconds, usage.cpuSeconds);
  if (cpu !== null) perf.gauge('container_cpu_cores', cpu / seconds, labels);
  for (const resource of RESOURCES) {
    const stalled = grew(before.usage.stallSeconds?.[resource], usage.stallSeconds?.[resource]);
    if (stalled !== null) perf.gauge('container_stall_ratio', Math.min(1, stalled / seconds), { container, resource });
  }
  const periods = grew(before.usage.cpuPeriods, usage.cpuPeriods);
  const throttled = grew(before.usage.throttledPeriods, usage.throttledPeriods);
  if (periods !== null && throttled !== null) perf.gauge('container_throttled_ratio', periods > 0 ? Math.min(1, throttled / periods) : 0, labels);
  const killed = grew(before.usage.oomKills, usage.oomKills);
  if (killed) perf.count('container_oom_kills_total', labels, killed);
}

let machineBefore: MachineReading | null = null;

/** The machine the containers run on, every 15 seconds with the bot */
export function sampleMachine(reading = readMachine(config.dataDir)) {
  const before = machineBefore;
  machineBefore = reading;
  if (reading.cpu) perf.gauge('vm_cpus', reading.cpu.cores);
  if (reading.memory) {
    perf.gauge('vm_memory_total_bytes', reading.memory.total);
    perf.gauge('vm_memory_used_bytes', reading.memory.total - reading.memory.available);
    perf.gauge('vm_swap_used_bytes', reading.memory.swapTotal - reading.memory.swapFree);
  }
  if (reading.disk) {
    perf.gauge('vm_disk_free_bytes', reading.disk.free);
    perf.gauge('vm_disk_total_bytes', reading.disk.total);
  }
  if (!before) return;
  const change = machineChange(before, reading);
  if (change.cpuBusy !== null) perf.gauge('vm_cpu_busy_ratio', change.cpuBusy);
  if (change.cpuIowait !== null) perf.gauge('vm_cpu_iowait_ratio', change.cpuIowait);
  if (change.cpuSteal !== null) perf.gauge('vm_cpu_steal_ratio', change.cpuSteal);
  if (change.swapPagesPerSecond !== null) perf.gauge('vm_swap_pages_per_second', change.swapPagesPerSecond);
  for (const resource of RESOURCES) {
    const stalled = change.stall[resource];
    if (stalled !== null) perf.gauge('vm_stall_ratio', stalled, { resource });
  }
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const countOrNull = (n: unknown) => (isCount(n) ? n : null);

/** A container's GET /stats answer, or the web UI's report, if it says what it should. Stall times and the like are newer, so may be missing */
function usageIn(body: unknown): perf.ContainerUsage | null {
  const b = body as Record<string, unknown> | null;
  if (!b || !isCount(b.memoryBytes) || !isCount(b.cpuSeconds)) return null;
  const stall = b.stallSeconds && typeof b.stallSeconds === 'object' ? (b.stallSeconds as Record<string, unknown>) : {};
  return {
    memoryBytes: b.memoryBytes,
    cpuSeconds: b.cpuSeconds,
    memoryLimitBytes: isCount(b.memoryLimitBytes) && b.memoryLimitBytes > 0 ? b.memoryLimitBytes : null,
    stallSeconds: { cpu: countOrNull(stall.cpu), memory: countOrNull(stall.memory), io: countOrNull(stall.io) },
    cpuPeriods: countOrNull(b.cpuPeriods),
    throttledPeriods: countOrNull(b.throttledPeriods),
    oomKills: countOrNull(b.oomKills),
  };
}

let webSeenAt = 0;
/** When the bot started listening for the web UI, so one that never reports shows as down too */
let webWaitingSince = 0;

/** The web UI's report of itself, every 30 seconds: its own usage, and how many requests it answered since the last one */
export function webReport(body: unknown): boolean {
  const usage = usageIn(body);
  if (!usage) return false;
  webSeenAt = Date.now();
  containerSeen('web', usage);
  const b = body as { requests?: unknown; botUnreachable?: unknown };
  if (b.requests && typeof b.requests === 'object') {
    for (const [status, n] of Object.entries(b.requests)) if (/^[1-5]xx$/.test(status) && isCount(n) && n > 0) perf.count('web_requests_total', { status }, n);
  }
  if (isCount(b.botUnreachable) && b.botUnreachable > 0) perf.count('web_bot_unreachable_total', {}, b.botUnreachable);
  return true;
}

/** The most of each kind of timing one browser report may hold: a minute of a busy tab is well under it */
const BROWSER_MOST = 500;
/** Anything longer is a tab that was asleep, not a slow answer */
const BROWSER_LONGEST_S = 120;
/** All browsers together may send this many reports a minute, many times what friends' open tabs would, so one stuck in a loop can't bury the rest */
const BROWSER_REPORTS_PER_MINUTE = 120;
let browserMinute = 0;
let browserReports = 0;
/** Taps the browser didn't time, as it times only those over 16 ms, are noted as this */
const QUICK_RESPONSE_S = 0.016;

const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= BROWSER_LONGEST_S;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);

/**
 * A browser's timings since its last report, which the web UI passes on with where it came from. Nothing in it says
 * who it was. Returns whether it was a report
 */
export function browserReport(body: unknown): boolean {
  const b = body as Record<string, unknown> | null;
  const via = oneOf(b?.via, ['home', 'away'] as const);
  const device = oneOf(b?.device, ['phone', 'computer'] as const);
  if (!b || !via || !device) return false;
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== browserMinute) [browserMinute, browserReports] = [minute, 0];
  // Taken as a report, just not kept
  if (++browserReports > BROWSER_REPORTS_PER_MINUTE) return true;
  const where = { via, device };
  const requests = Array.isArray(b.requests) ? b.requests.slice(0, BROWSER_MOST) : [];
  for (const r of requests) {
    if (!Array.isArray(r)) continue;
    const [kind, seconds, network] = r as unknown[];
    const k = oneOf(kind, ['action', 'load'] as const);
    // Every answer through the web UI says the bot's part, so the network's is known; without it, something's off
    if (!k || !isTime(seconds) || !isTime(network) || network > seconds) continue;
    perf.time('browser_request_seconds', seconds, { ...where, kind: k });
    perf.time('browser_network_seconds', network, { ...where, kind: k });
  }
  const page = b.page as Record<string, unknown> | null | undefined;
  if (page && typeof page === 'object') {
    if (isTime(page.firstByte)) perf.time('browser_page_seconds', page.firstByte, { ...where, step: 'first_byte' });
    if (isTime(page.shown)) perf.time('browser_page_seconds', page.shown, { ...where, step: 'shown' });
  }
  const responses = Array.isArray(b.responses) ? b.responses.slice(0, BROWSER_MOST) : [];
  for (const seconds of responses) if (isTime(seconds)) perf.time('browser_response_seconds', seconds, where);
  const quick = typeof b.quickResponses === 'number' && Number.isInteger(b.quickResponses) ? Math.min(BROWSER_MOST, Math.max(0, b.quickResponses)) : 0;
  for (let n = 0; n < quick; n++) perf.time('browser_response_seconds', QUICK_RESPONSE_S, where);
  return true;
}

/** The containers the bot asks, where they're set up */
const polled = () =>
  [
    { container: 'voice', url: config.voiceUrl, token: null },
    { container: 'music', url: config.musicUrl, token: config.musicToken },
    { container: 'loop', url: config.loopBotUrl, token: config.loopToken },
  ].filter((c) => c.url);

const LOOP_SEEN_KEY = 'loop_voice_seen';

/**
 * Adds what's new in the loop bot's voice totals to this bot's counts, labelled as the loop bot's. What it last saw is
 * kept, so neither bot restarting loses or repeats any: a loop bot that started since then has all of its totals new
 */
export function loopVoice(voice: unknown) {
  if (!voice || typeof voice !== 'object') return;
  const now = voice as Record<string, unknown>;
  if (!isCount(now.startedAt)) return;
  let seen: Partial<LoopVoice> = {};
  try {
    seen = JSON.parse(getKv(LOOP_SEEN_KEY) ?? '{}');
  } catch {}
  const restarted = seen.startedAt !== now.startedAt;
  const next: Record<string, number> = { startedAt: now.startedAt };
  let changed = restarted;
  for (const [field, name] of Object.entries(LOOP_VOICE_COUNTS) as [keyof typeof LOOP_VOICE_COUNTS, string][]) {
    const before = restarted ? 0 : (seen[field] ?? 0);
    const total = now[field];
    // A missing or odd total leaves the last one standing, so the next good one isn't counted twice
    if (!isCount(total) || total < before) {
      next[field] = before;
      continue;
    }
    next[field] = total;
    if (total > before) {
      perf.count(name as perf.Counter, { bot: 'loop' }, total - before);
      changed = true;
    }
  }
  if (changed) setKv(LOOP_SEEN_KEY, JSON.stringify(next));
}

export async function poll() {
  await Promise.all(
    polled().map(async ({ container, url, token }) => {
      try {
        const res = await fetch(`${url}/stats`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        const body = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
        const usage = usageIn(body);
        if (!usage) throw new Error(`answered ${res.status}`);
        containerSeen(container, usage);
        if (container === 'voice' && isCount(body?.modelsLoaded)) perf.gauge('voice_models_loaded', body.modelsLoaded);
        if (container === 'loop') loopVoice(body?.voice);
      } catch {
        perf.gauge('container_up', 0, { container });
      }
    }),
  );
  // Only with the API on, since the web UI can't be there without it
  if (config.apiToken && Date.now() - (webSeenAt || webWaitingSince) > WEB_STALE_MS) perf.gauge('container_up', 0, { container: 'web' });
}

// The sampler's timer fires this often, and what it reads includes the wait itself: an idle loop reads this much
const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

/**
 * Takes the sampler's own 20 ms out of the delays kept before it was taken out as they're read, once, so the chart
 * doesn't drop by 20 ms where it changed
 */
export function correctLoopDelays(before = Date.now()) {
  if (getKv('loop_delay_corrected')) return;
  const ms = LOOP_RESOLUTION_MS / 1000;
  transaction(() => {
    // By span and name, as the index has them, rather than looking through every row
    db.prepare("UPDATE perf_minutes SET sum = MAX(0, sum - count * ?), max = MAX(0, max - ?) WHERE span IN (1, 15) AND name = 'event_loop_delay_seconds' AND at <= ?").run(ms, ms, before);
    setKv('loop_delay_corrected', String(before));
  });
}
let busy = performance.eventLoopUtilization();

/** The bot as it is now */
export function sample(client: Client) {
  perf.gauge('discord_connected', client.ws.status === Status.Ready ? 1 : 0);
  if (client.ws.ping >= 0) perf.gauge('discord_gateway_ping_seconds', client.ws.ping / 1000);
  perf.gauge('voice_connections', getVoiceConnections().size);
  if (loopDelay.count) perf.gauge('event_loop_delay_seconds', Math.max(0, loopDelay.percentile(99) / 1e6 - LOOP_RESOLUTION_MS) / 1000);
  loopDelay.reset();
  const since = performance.eventLoopUtilization(busy);
  busy = performance.eventLoopUtilization();
  perf.gauge('event_loop_utilization', since.utilization);
  perf.gauge('heap_used_bytes', process.memoryUsage().heapUsed);
  containerSeen('bot', perf.containerUsage());
  sampleMachine();
}

/** Every garbage collection pause, which stops the bot while it runs */
const gcPauses = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) perf.time('gc_pause_seconds', entry.duration / 1000);
});

const ANSWERS = ['reply', 'deferReply', 'deferUpdate', 'update', 'showModal', 'respond'] as const;

function nameOf(i: Interaction): { kind: string; name: string } {
  if (i.isChatInputCommand() || i.isAutocomplete()) {
    const name = [`/${i.commandName}`, i.options.getSubcommandGroup(false), i.options.getSubcommand(false)].filter(Boolean).join(' ');
    return { kind: i.isAutocomplete() ? 'autocomplete' : 'command', name };
  }
  if (i.isContextMenuCommand()) return { kind: 'menu', name: i.commandName };
  if (i.isMessageComponent()) return { kind: 'component', name: i.customId.split(':')[0] };
  if (i.isModalSubmit()) return { kind: 'modal', name: i.customId.split(':')[0] };
  return { kind: 'other', name: 'other' };
}

/**
 * Times how long a command, button or menu takes to get its first answer to Discord, which must come within 3
 * seconds. Returns what to call once it's been handled, saying whether it threw
 */
export function timeInteraction(i: Interaction): (failed: boolean) => void {
  const labels = nameOf(i);
  const start = performance.now();
  let answer: Promise<unknown> | undefined;
  let expired = false;
  const target = i as unknown as Record<string, unknown>;
  for (const method of ANSWERS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      const result: unknown = Reflect.apply(original, this, args);
      if (!answer) {
        answer = Promise.resolve(result);
        answer.then(
          () => {
            const seconds = (performance.now() - start) / 1000;
            perf.time('discord_interaction_answer_seconds', seconds, labels);
            if (seconds >= SLOW_ANSWER_S) perf.slow({ guildId: i.guildId, what: labels.name, seconds, steps: [], detail: { kind: labels.kind } });
          },
          (err: unknown) => void (expired ||= (err as { code?: unknown } | null)?.code === EXPIRED),
        );
      }
      return result;
    };
  }
  // Counted once the first answer has settled, as a handler may not wait for it, and Discord may yet refuse it
  return (failed) =>
    void (answer ?? Promise.resolve())
      .catch(() => {})
      .then(() => perf.count('discord_interactions_total', { ...labels, outcome: expired ? 'expired' : failed ? 'failed' : 'ok' }));
}

const timers: NodeJS.Timeout[] = [];

export const health: Feature = {
  setup(client) {
    perf.keep(true);
    try {
      correctLoopDelays();
    } catch (err) {
      console.error('Couldn’t correct the event loop delays kept:', err);
    }
    webWaitingSince = Date.now();
    loopDelay.enable();
    gcPauses.observe({ entryTypes: ['gc'] });
    client.on(Events.ShardReconnecting, () => perf.count('discord_gateway_reconnects_total'));
    const every = (ms: number, fn: () => unknown) => timers.push(setInterval(() => void Promise.resolve().then(fn).catch((err) => console.error('Health check failed:', err)), ms).unref());
    every(SAMPLE_MS, () => {
      sample(client);
      store();
      rollUp();
    });
    every(POLL_MS, poll);
    sample(client);
    void poll();
  },
  shutdown() {
    for (const timer of timers.splice(0)) clearInterval(timer);
    loopDelay.disable();
    gcPauses.disconnect();
    try {
      store(true);
    } catch (err) {
      console.error('Couldn’t keep the last minute’s health numbers:', err);
    }
  },
};
