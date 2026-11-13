import { getVoiceConnections } from '@discordjs/voice';
import { Events, Status, type Client, type Interaction } from 'discord.js';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { config } from '../config.ts';
import { db, transaction } from '../db.ts';
import * as perf from '../perf.ts';
import type { Feature } from '../types.ts';

/**
 * Keeps an eye on how the bot and its containers are doing: samples the bot every 15 seconds, asks the voice, music
 * and loop containers for their memory and CPU every 30, hears from the web UI, and keeps it all a minute at a time
 */

const SAMPLE_MS = 15_000;
const POLL_MS = 30_000;
const POLL_TIMEOUT_MS = 5_000;
/** The web UI reports every 30 seconds; missing three in a row counts as down */
const WEB_STALE_MS = 95_000;
const ROLLUP_MS = 15 * 60_000;
const MINUTES_KEPT_MS = 2 * 86_400_000;
const ROLLUPS_KEPT_MS = 30 * 86_400_000;
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

/** Each container's CPU time when last heard from, to work out how much it's used since */
const cpuSeen = new Map<string, { seconds: number; at: number }>();

/** Notes what a container said it's using */
export function containerSeen(container: string, usage: perf.ContainerUsage) {
  const labels = { container };
  perf.gauge('container_up', 1, labels);
  perf.gauge('container_memory_bytes', usage.memoryBytes, labels);
  if (usage.memoryLimitBytes) perf.gauge('container_memory_limit_bytes', usage.memoryLimitBytes, labels);
  const at = performance.now();
  const before = cpuSeen.get(container);
  cpuSeen.set(container, { seconds: usage.cpuSeconds, at });
  // A restarted container counts from nothing again
  if (before && usage.cpuSeconds >= before.seconds && at - before.at > 1000) perf.gauge('container_cpu_cores', (usage.cpuSeconds - before.seconds) / ((at - before.at) / 1000), labels);
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A container's GET /stats answer, or the web UI's report, if it says what it should */
function usageIn(body: unknown): perf.ContainerUsage | null {
  const b = body as Record<string, unknown> | null;
  if (!b || !isCount(b.memoryBytes) || !isCount(b.cpuSeconds)) return null;
  return { memoryBytes: b.memoryBytes, cpuSeconds: b.cpuSeconds, memoryLimitBytes: isCount(b.memoryLimitBytes) && b.memoryLimitBytes > 0 ? b.memoryLimitBytes : null };
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

/** The containers the bot asks, where they're set up */
const polled = () =>
  [
    { container: 'voice', url: config.voiceUrl, token: null },
    { container: 'music', url: config.musicUrl, token: config.musicToken },
    { container: 'loop', url: config.loopBotUrl, token: config.loopToken },
  ].filter((c) => c.url);

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
      } catch {
        perf.gauge('container_up', 0, { container });
      }
    }),
  );
  // Only with the API on, since the web UI can't be there without it
  if (config.apiToken && Date.now() - (webSeenAt || webWaitingSince) > WEB_STALE_MS) perf.gauge('container_up', 0, { container: 'web' });
}

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let busy = performance.eventLoopUtilization();

/** The bot as it is now */
export function sample(client: Client) {
  perf.gauge('discord_connected', client.ws.status === Status.Ready ? 1 : 0);
  if (client.ws.ping >= 0) perf.gauge('discord_gateway_ping_seconds', client.ws.ping / 1000);
  perf.gauge('voice_connections', getVoiceConnections().size);
  if (loopDelay.count) perf.gauge('event_loop_delay_seconds', loopDelay.percentile(99) / 1e9);
  loopDelay.reset();
  const since = performance.eventLoopUtilization(busy);
  busy = performance.eventLoopUtilization();
  perf.gauge('event_loop_utilization', since.utilization);
  perf.gauge('heap_used_bytes', process.memoryUsage().heapUsed);
  containerSeen('bot', perf.containerUsage());
}

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
    webWaitingSince = Date.now();
    loopDelay.enable();
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
    try {
      store(true);
    } catch (err) {
      console.error('Couldn’t keep the last minute’s health numbers:', err);
    }
  },
};
