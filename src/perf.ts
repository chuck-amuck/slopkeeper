import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/**
 * How the bot and its containers are doing: counts, values sampled now and then, and timings. Everything here is in
 * memory, with no database, so the loop bot can measure too. The bot's health feature (features/health.ts) keeps it a
 * minute at a time, and GET /metrics answers with it in Prometheus's text format, for Grafana or anything like it.
 * Times are in seconds and sizes in bytes, as Prometheus names them
 */

type Kind = 'counter' | 'gauge' | 'histogram';

/** Every measurement, so a name can't be misspelt in one place and missed by everything that reads it */
const METRICS = {
  discord_connected: ['gauge', 'Whether the bot is connected to Discord’s gateway: 1 or 0'],
  discord_gateway_ping_seconds: ['gauge', 'Round trip of the Discord gateway’s heartbeat'],
  discord_gateway_reconnects_total: ['counter', 'Times the Discord gateway connection dropped and reconnected'],
  discord_interaction_answer_seconds: ['histogram', 'From a command, button or menu arriving to Discord taking its first answer'],
  discord_interactions_total: ['counter', 'Commands, buttons and menus handled, by how it went: ok, failed or expired (answered after Discord’s 3 seconds)'],
  voice_connections: ['gauge', 'Voice channels the bot is in'],
  voice_connect_seconds: ['histogram', 'Joining a voice channel, until it’s ready to play'],
  voice_connect_failures_total: ['counter', 'Voice channels the bot couldn’t join in time'],
  voice_disconnects_total: ['counter', 'Times a voice connection dropped'],
  audio_start_seconds: ['histogram', 'From asking to play to it being heard, joining voice included: sound, speech (once made) or music (once downloaded)'],
  speech_seconds: ['histogram', 'From a line being asked for to it being heard, queue and making included'],
  speech_make_seconds: ['histogram', 'Making a line that wasn’t made a moment ago: the voice container, then levelling and effects'],
  speech_failures_total: ['counter', 'Lines that couldn’t be made or played'],
  voice_synth_seconds: ['histogram', 'The voice container’s own time to say a line, by voice'],
  voice_model_load_seconds: ['histogram', 'The voice container loading a voice model it didn’t have in memory: its first line since starting, or since being let go'],
  music_start_seconds: ['histogram', 'From a song being due to it being heard, the download included'],
  music_download_seconds: ['histogram', 'Getting a song from the music container, by whether it had it already'],
  mixer_frames_total: ['counter', 'Audio frames mixed, 50 a second while anything plays'],
  mixer_late_frames_total: ['counter', 'Audio frames mixed after they were due, which people hear as a stutter'],
  api_requests_total: ['counter', 'Management API answers, by area and status class'],
  api_request_seconds: ['histogram', 'Management API answers, by area, leaving out requests that wait for a change'],
  event_loop_delay_seconds: ['gauge', 'How late timers ran, the 99th percentile over the last 15 seconds'],
  event_loop_utilization: ['gauge', 'Share of the time the bot’s event loop was busy, 0 to 1'],
  heap_used_bytes: ['gauge', 'JavaScript heap in use'],
  container_up: ['gauge', 'Whether each container answered lately: 1 or 0'],
  container_memory_bytes: ['gauge', 'Memory each container uses, as Docker counts it (page cache it can drop left out)'],
  container_memory_limit_bytes: ['gauge', 'Memory each container may use, where it has a limit'],
  container_cpu_cores: ['gauge', 'CPU each container used lately, in cores'],
  voice_models_loaded: ['gauge', 'Voice models the voice container holds in memory'],
  web_requests_total: ['counter', 'Requests the web UI answered, by status class'],
  web_bot_unreachable_total: ['counter', 'Web UI requests the bot didn’t answer'],
} as const satisfies Record<string, readonly [Kind, string]>;

export type Metric = keyof typeof METRICS;
type Named<K extends Kind> = { [M in Metric]: (typeof METRICS)[M][0] extends K ? M : never }[Metric];
export type Counter = Named<'counter'>;
export type Gauge = Named<'gauge'>;
export type Timing = Named<'histogram'>;
export type Labels = Record<string, string>;

/** Upper bounds of the timing buckets, in seconds: from a quick API answer to a slow song download */
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const PREFIX = 'slopkeeper_';

interface Series {
  name: Metric;
  labels: Labels;
}

/** Since the bot started, for Prometheus */
interface Total extends Series {
  value: number;
}
interface Histogram extends Series {
  count: number;
  sum: number;
  /** Per bucket, not cumulative, with one more for anything over the last */
  buckets: number[];
}

/** A minute of one series, for keeping. Counters add up `count`; gauges are samples, averaged as sum / count */
export interface MinuteRow extends Series {
  at: number;
  count: number;
  sum: number;
  max: number;
  buckets: number[] | null;
}

/** A step of something slow, in seconds, and which step it's part of, if it's part of one */
export type Step = [name: string, seconds: number, of?: string];

/** Something that took long enough to be worth looking at later */
export interface SlowRecord {
  at: number;
  guildId: string | null;
  what: string;
  seconds: number;
  steps: Step[];
  detail: Record<string, string | number | boolean>;
}

const MINUTE_MS = 60_000;

const counters = new Map<string, Total>();
const gauges = new Map<string, Total>();
const histograms = new Map<string, Histogram>();

/** Minutes are only gathered once something keeps them (features/health.ts), so the loop bot and tests don't pile them up */
let keeping = false;
let minuteAt = 0;
let minute = new Map<string, MinuteRow>();
const finished: MinuteRow[] = [];
const slowOnes: SlowRecord[] = [];

let now = () => Date.now();

const keyOf = (name: string, labels: Labels) => {
  const keys = Object.keys(labels);
  if (!keys.length) return name;
  return name + JSON.stringify(keys.sort().map((k) => [k, labels[k]]));
};

const round = (seconds: number) => Math.round(seconds * 1e4) / 1e4;

/** Moves on to the minute it is now, setting aside the one that's over */
function roll(): number {
  const at = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
  if (at === minuteAt) return at;
  finished.push(...minute.values());
  minute = new Map();
  minuteAt = at;
  return at;
}

function inMinute(name: Metric, labels: Labels, key: string, histogram: boolean): MinuteRow | undefined {
  if (!keeping) return undefined;
  const at = roll();
  let row = minute.get(key);
  if (!row) minute.set(key, (row = { name, labels, at, count: 0, sum: 0, max: 0, buckets: histogram ? new Array(BUCKETS.length + 1).fill(0) : null }));
  return row;
}

const bucketOf = (seconds: number) => {
  const i = BUCKETS.findIndex((upTo) => seconds <= upTo);
  return i === -1 ? BUCKETS.length : i;
};

/** Adds to a count */
export function count(name: Counter, labels: Labels = {}, by = 1) {
  const key = keyOf(name, labels);
  const total = counters.get(key);
  if (total) total.value += by;
  else counters.set(key, { name, labels, value: by });
  const row = inMinute(name, labels, key, false);
  if (row) {
    row.count += by;
    row.sum += by;
  }
}

/** Sets a value as it is now, like memory in use. Each one set is also a sample for the minute's average and highest */
export function gauge(name: Gauge, value: number, labels: Labels = {}) {
  if (!Number.isFinite(value)) return;
  const key = keyOf(name, labels);
  gauges.set(key, { name, labels, value });
  const row = inMinute(name, labels, key, false);
  if (row) {
    row.count += 1;
    row.sum += value;
    row.max = row.count === 1 ? value : Math.max(row.max, value);
  }
}

/** Notes how long something took, in seconds */
export function time(name: Timing, seconds: number, labels: Labels = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const key = keyOf(name, labels);
  let h = histograms.get(key);
  if (!h) histograms.set(key, (h = { name, labels, count: 0, sum: 0, buckets: new Array(BUCKETS.length + 1).fill(0) }));
  const bucket = bucketOf(seconds);
  h.count += 1;
  h.sum += seconds;
  h.buckets[bucket] += 1;
  const row = inMinute(name, labels, key, true);
  if (row) {
    row.count += 1;
    row.sum += seconds;
    row.max = Math.max(row.max, seconds);
    row.buckets![bucket] += 1;
  }
}

/** The current value of a gauge, if it's been set */
export const gaugeValue = (name: Gauge, labels: Labels = {}) => gauges.get(keyOf(name, labels))?.value;

/** Notes something slow, for the list of the slowest lately */
export function slow(record: Omit<SlowRecord, 'at'>) {
  if (!keeping) return;
  slowOnes.push({ ...record, at: now(), seconds: round(record.seconds), steps: record.steps.map(([name, s, of]) => (of ? [name, round(s), of] : [name, round(s)])) });
}

/** Starts or stops gathering minutes and slow records for keeping */
export function keep(on: boolean) {
  keeping = on;
  if (!on) {
    minute = new Map();
    finished.length = 0;
    slowOnes.length = 0;
  }
}

/** The minutes that are over, and slow records, since this was last asked. `all` includes the minute still going, for shutting down */
export function take(all = false): { minutes: MinuteRow[]; slow: SlowRecord[] } {
  if (keeping) roll();
  const minutes = finished.splice(0);
  if (all) {
    minutes.push(...minute.values());
    minute = new Map();
  }
  return { minutes, slow: slowOnes.splice(0) };
}

/** The value of `name` in a Server-Timing header, like `synth;dur=812.5, load;dur=0`, as seconds */
export function serverTiming(header: string | null | undefined): Map<string, number> {
  const found = new Map<string, number>();
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((p) => p.trim());
    const dur = params.find((p) => p.startsWith('dur='));
    const ms = dur ? Number(dur.slice(4)) : NaN;
    if (name && Number.isFinite(ms) && ms >= 0) found.set(name, Math.round(ms * 1000) / 1e6);
  }
  return found;
}

/**
 * Times something people wait for, step by step: `step` closes the step that's been going since the last one. `end`
 * notes the whole time, and keeps the steps if it took `slowAfter` seconds or more
 */
export class Trace {
  readonly steps: Step[] = [];
  readonly detail: Record<string, string | number | boolean> = {};
  private readonly start = performance.now();
  private last = this.start;
  private ended = false;
  private readonly metric: Timing;
  private readonly what: string;
  private readonly guildId: string | null;
  private readonly slowAfter: number;
  private readonly labels: Labels;

  constructor(metric: Timing, what: string, guildId: string | null, slowAfter: number, labels: Labels = {}) {
    this.metric = metric;
    this.what = what;
    this.guildId = guildId;
    this.slowAfter = slowAfter;
    this.labels = labels;
  }

  step(name: string) {
    const at = performance.now();
    this.steps.push([name, (at - this.last) / 1000]);
    this.last = at;
  }

  /** A part of a step, timed by something else, like the voice container's own time */
  part(name: string, seconds: number, of: string) {
    this.steps.push([name, seconds, of]);
  }

  /** Notes the whole time, once. Returns it, in seconds */
  end(): number {
    const seconds = (performance.now() - this.start) / 1000;
    if (this.ended) return seconds;
    this.ended = true;
    time(this.metric, seconds, this.labels);
    if (seconds >= this.slowAfter) slow({ guildId: this.guildId, what: this.what, seconds, steps: this.steps, detail: this.detail });
    return seconds;
  }
}

const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
const labelText = (labels: Labels, extra?: [string, string]) => {
  const pairs = Object.entries(labels);
  if (extra) pairs.push(extra);
  return pairs.length ? `{${pairs.map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}` : '';
};
const number = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

/** Everything measured, in Prometheus's text format */
export function prometheus(): string {
  const lines: string[] = [];
  const byName = new Map<Metric, string[]>();
  const add = (name: Metric, line: string) => (byName.get(name) ?? byName.set(name, []).get(name)!).push(line);
  for (const t of [...counters.values(), ...gauges.values()]) add(t.name, `${PREFIX}${t.name}${labelText(t.labels)} ${number(t.value)}`);
  for (const h of histograms.values()) {
    let below = 0;
    BUCKETS.forEach((upTo, i) => {
      below += h.buckets[i];
      add(h.name, `${PREFIX}${h.name}_bucket${labelText(h.labels, ['le', String(upTo)])} ${below}`);
    });
    add(h.name, `${PREFIX}${h.name}_bucket${labelText(h.labels, ['le', '+Inf'])} ${h.count}`);
    add(h.name, `${PREFIX}${h.name}_sum${labelText(h.labels)} ${number(h.sum)}`);
    add(h.name, `${PREFIX}${h.name}_count${labelText(h.labels)} ${h.count}`);
  }
  for (const name of Object.keys(METRICS) as Metric[]) {
    const found = byName.get(name);
    if (!found) continue;
    const [kind, help] = METRICS[name];
    lines.push(`# HELP ${PREFIX}${name} ${help}`, `# TYPE ${PREFIX}${name} ${kind}`, ...found);
  }
  return `${lines.join('\n')}\n`;
}

/** What a container reports about itself on GET /stats, and the web UI sends the bot */
export interface ContainerUsage {
  memoryBytes: number;
  memoryLimitBytes: number | null;
  cpuSeconds: number;
}

const CGROUP = '/sys/fs/cgroup';

/** This container's memory and CPU from its cgroup, as `docker stats` counts them, or this process's outside one */
export function containerUsage(root = CGROUP): ContainerUsage {
  try {
    const file = (name: string) => readFileSync(`${root}/${name}`, 'utf8');
    const stat = (text: string, key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
    const current = Number(file('memory.current'));
    const max = file('memory.max').trim();
    const usec = stat(file('cpu.stat'), 'usage_usec');
    return { memoryBytes: Math.max(0, current - stat(file('memory.stat'), 'inactive_file')), memoryLimitBytes: max === 'max' ? null : Number(max), cpuSeconds: usec / 1e6 };
  } catch {
    const { user, system } = process.cpuUsage();
    return { memoryBytes: process.memoryUsage.rss(), memoryLimitBytes: null, cpuSeconds: (user + system) / 1e6 };
  }
}

/** For tests: a clock, and starting again from nothing */
export function testing(clock: () => number = () => Date.now()) {
  now = clock;
  counters.clear();
  gauges.clear();
  histograms.clear();
  minuteAt = 0;
  keep(false);
}
