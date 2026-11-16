import { db } from '../db.ts';
import * as perf from '../perf.ts';
import { POLL_MS, ROLLUP_MS, SAMPLE_MS } from './health.ts';
import { VOICES } from './say.ts';

/**
 * The Health view's numbers: how the bot and its containers did over the last hour, day, week or month, from what
 * features/health.ts keeps. Each range is read at its own grain, so every chart has 60 to 168 points
 */

export const RANGES = {
  '1h': { ms: 3_600_000, step: 60_000 },
  '24h': { ms: 86_400_000, step: 15 * 60_000 },
  '7d': { ms: 7 * 86_400_000, step: 3_600_000 },
  '30d': { ms: 30 * 86_400_000, step: 6 * 3_600_000 },
} as const;
export type Range = keyof typeof RANGES;

/** Where each number stops being fine, and where it's bad. Phase 3's alerts go by the same ones */
export const LIMITS = {
  /** 95th percentile, seconds. Discord gives up at 3 */
  commandAnswer: [1.5, 3],
  soundStart: [1, 3],
  /** Lines of 300 characters or fewer: a paragraph takes seconds more */
  speechMake: [2.5, 5],
  /** A song not downloaded ahead takes most of 10 seconds from YouTube */
  musicStart: [8, 15],
  /** Share of audio frames mixed late */
  stutter: [0.005, 0.02],
  /** The event loop's delay, the worst point's average, seconds */
  loopDelay: [0.1, 0.5],
  /** Share of a container's memory limit in use now */
  memory: [0.8, 0.9],
  /** Share of web UI answers that were server errors or found the bot gone, as during a redeploy */
  webErrors: [0.01, 0.05],
  /** In people's browsers, 95th percentiles: a tap answered, the page opening, and the page reacting to a tap */
  browserTap: [0.5, 1.5],
  pageShown: [3, 6],
  browserResponse: [0.2, 0.5],
  /** Minutes away from Discord in the range: never bad, as it's back */
  discordDown: [2, Infinity],
} as const satisfies Record<string, readonly [number, number]>;

export type Status = 'fine' | 'slow' | 'bad' | 'quiet';

/** Fine below the first limit, slow from it, bad from the second */
const judge = (value: number | null, [slow, bad]: readonly [number, number]): Status => (value === null ? 'quiet' : value >= bad ? 'bad' : value >= slow ? 'slow' : 'fine');
const worse = (...all: Status[]): Status => (['bad', 'slow', 'fine', 'quiet'] as const).find((s) => all.includes(s)) ?? 'quiet';

/** One stretch of one series: what the minutes in it add up to */
interface Cell {
  count: number;
  sum: number;
  max: number;
  buckets: number[] | null;
}

const add = (into: Cell | null, row: Cell): Cell => {
  if (!into) return { count: row.count, sum: row.sum, max: row.max, buckets: row.buckets && [...row.buckets] };
  into.max = into.count === 0 ? row.max : Math.max(into.max, row.max);
  into.count += row.count;
  into.sum += row.sum;
  if (row.buckets) into.buckets = into.buckets ? into.buckets.map((n, i) => n + (row.buckets![i] ?? 0)) : [...row.buckets];
  return into;
};

/**
 * The time under which a share `q` of the timings fell, from their buckets, as Prometheus's histogram_quantile works it
 * out: in a straight line across the bucket it falls in. Never more than the slowest seen
 */
export function quantile(cell: Cell | null, q: number): number | null {
  if (!cell?.buckets || cell.count <= 0) return null;
  const wanted = q * cell.count;
  let below = 0;
  for (let i = 0; i < cell.buckets.length; i++) {
    const n = cell.buckets[i];
    if (n > 0 && below + n >= wanted) {
      if (i === perf.BUCKETS.length) return cell.max;
      const from = i === 0 ? 0 : perf.BUCKETS[i - 1];
      return Math.min(cell.max, from + (perf.BUCKETS[i] - from) * ((wanted - below) / n));
    }
    below += n;
  }
  return cell.max;
}

const average = (cell: Cell | null) => (cell && cell.count > 0 ? cell.sum / cell.count : null);
const rounded = (n: number | null, places = 3) => (n === null ? null : Math.round(n * 10 ** places) / 10 ** places);

interface Row {
  at: number;
  name: string;
  labels: string;
  count: number;
  sum: number;
  max: number;
  buckets: string | null;
}

/** Every series in the range, a cell per point: name → labels (as kept) → cells */
type Read = Map<string, Map<string, { labels: perf.Labels; cells: (Cell | null)[] }>>;

function read(start: number, step: number, points: number): Read {
  const end = start + step * points;
  // Fifteen-minute rows where they're coarse enough, then the minutes not added up into one yet. Two days of minutes are kept
  const coarse = step >= ROLLUP_MS;
  const rolled = coarse ? ((db.prepare('SELECT MAX(at) AS at FROM perf_minutes WHERE span = 15').get() as { at: number | null }).at ?? start - ROLLUP_MS) + ROLLUP_MS : start;
  const rows = [
    ...(coarse ? (db.prepare('SELECT at, name, labels, count, sum, max, buckets FROM perf_minutes WHERE span = 15 AND at >= ? AND at < ?').all(start, Math.min(end, rolled)) as unknown as Row[]) : []),
    ...(db.prepare('SELECT at, name, labels, count, sum, max, buckets FROM perf_minutes WHERE span = 1 AND at >= ? AND at < ?').all(Math.max(start, rolled), end) as unknown as Row[]),
  ];
  const found: Read = new Map();
  for (const row of rows) {
    const i = Math.floor((row.at - start) / step);
    if (i < 0 || i >= points) continue;
    const byLabels = found.get(row.name) ?? found.set(row.name, new Map()).get(row.name)!;
    let series = byLabels.get(row.labels);
    if (!series) byLabels.set(row.labels, (series = { labels: JSON.parse(row.labels) as perf.Labels, cells: new Array<Cell | null>(points).fill(null) }));
    series.cells[i] = add(series.cells[i], { count: row.count, sum: row.sum, max: row.max, buckets: row.buckets ? (JSON.parse(row.buckets) as number[]) : null });
  }
  return found;
}

/** The cells of every series of `name` whose labels `match`, added up point by point */
function cellsOf(found: Read, points: number, name: perf.Metric, match: (labels: perf.Labels) => boolean = () => true): (Cell | null)[] {
  const cells = new Array<Cell | null>(points).fill(null);
  for (const { labels, cells: theirs } of found.get(name)?.values() ?? []) {
    if (!match(labels)) continue;
    theirs.forEach((cell, i) => cell && (cells[i] = add(cells[i], cell)));
  }
  return cells;
}

const total = (cells: (Cell | null)[]) => cells.reduce<Cell | null>((all, cell) => (cell ? add(all, cell) : all), null);
const counted = (cells: (Cell | null)[]) => total(cells)?.count ?? 0;

/** A timing's typical and 95th-percentile time over the range, and its 95th percentile at each point */
function timing(cells: (Cell | null)[]) {
  const all = total(cells);
  return { count: all?.count ?? 0, p50: rounded(quantile(all, 0.5)), p95: rounded(quantile(all, 0.95)), series: cells.map((c) => rounded(quantile(c, 0.95))) };
}

const CONTAINERS = ['bot', 'web', 'voice', 'music', 'loop'];

export interface SlowItem {
  at: number;
  what: string;
  seconds: number;
  /** Leaving out time spent waiting behind others */
  own: number;
  steps: perf.Step[];
  detail: Record<string, string | number | boolean>;
}

/** How many of the slowest, and of the newest, a range lists */
const SLOW_LISTED = 20;

/** This server's slow ones, and those of no server, in the range: the slowest and the newest, each up to 20 */
export function slowList(guildId: string, start: number): SlowItem[] {
  const rows = db.prepare('SELECT at, what, seconds, steps, detail FROM perf_slow WHERE at >= ? AND (guild_id = ? OR guild_id IS NULL) ORDER BY at DESC').all(start, guildId) as unknown as {
    at: number;
    what: string;
    seconds: number;
    steps: string;
    detail: string;
  }[];
  const items = rows.map((r): SlowItem => {
    const steps = JSON.parse(r.steps) as perf.Step[];
    const detail = JSON.parse(r.detail) as SlowItem['detail'];
    // Voices by their names, as the web UI shows them
    if (typeof detail.voice === 'string') detail.voice = VOICES.find((v) => v.id === detail.voice)?.name ?? detail.voice;
    return { at: r.at, what: r.what, seconds: r.seconds, own: rounded(perf.ownTime(r.seconds, steps), 4)!, steps, detail };
  });
  const listed = new Set([...items.slice(0, SLOW_LISTED), ...[...items].sort((a, b) => b.own - a.own).slice(0, SLOW_LISTED)]);
  return items.filter((item) => listed.has(item));
}

/** Everything the Health view shows for `range` but the slow list, which is each server's own */
export function healthNumbers(range: Range, now = Date.now()) {
  const { ms, step } = RANGES[range];
  const points = ms / step;
  // Minutes are kept once they're over, so the hour ends with the last whole one; longer ranges end with the stretch still going
  const end = range === '1h' ? Math.floor(now / step) * step : Math.floor(now / step) * step + step;
  const start = end - ms;
  const found = read(start, step, points);
  const of = (name: perf.Metric, match?: (labels: perf.Labels) => boolean) => cellsOf(found, points, name, match);

  // Discord: samples every 15 seconds, so one that says it wasn't connected is 15 seconds away
  const connected = of('discord_connected');
  const connectedAll = total(connected);
  const discordDownMinutes = connectedAll ? ((connectedAll.count - connectedAll.sum) * SAMPLE_MS) / 60_000 : 0;
  const connectedNow = perf.gaugeValue('discord_connected');
  const pingNow = perf.gaugeValue('discord_gateway_ping_seconds');
  const discord = {
    connectedNow: connectedNow === undefined ? null : connectedNow === 1,
    pingNow: pingNow === undefined ? null : rounded(pingNow),
    connectedShare: rounded(average(connectedAll), 4),
    downMinutes: rounded(discordDownMinutes, 1),
    reconnects: counted(of('discord_gateway_reconnects_total')),
    ping: of('discord_gateway_ping_seconds').map((c) => rounded(average(c))),
    connected: connected.map((c) => rounded(average(c), 3)),
    status: connectedNow === 0 ? ('bad' as Status) : connectedAll ? judge(discordDownMinutes, LIMITS.discordDown) : ('quiet' as Status),
  };

  // Commands, buttons and menus
  const outcomes = { ok: 0, failed: 0, expired: 0 };
  for (const { labels, cells } of found.get('discord_interactions_total')?.values() ?? []) {
    const key = labels.outcome as keyof typeof outcomes;
    if (key in outcomes) outcomes[key] += counted(cells);
  }
  const answered = outcomes.ok + outcomes.failed + outcomes.expired;
  const answerTimes = timing(of('discord_interaction_answer_seconds'));
  const commands = {
    ...outcomes,
    total: answered,
    inTime: answered ? rounded((answered - outcomes.expired) / answered, 4) : null,
    ...answerTimes,
    status: answered ? worse(judge(answerTimes.p95, LIMITS.commandAnswer), outcomes.failed + outcomes.expired > 0 ? 'slow' : 'fine') : ('quiet' as Status),
  };

  const soundTimes = timing(of('audio_start_seconds', (l) => l.kind === 'sound'));
  const sounds = { ...soundTimes, status: soundTimes.count ? judge(soundTimes.p95, LIMITS.soundStart) : ('quiet' as Status) };

  // Lines timed before they were by length are left out, as paragraphs among them would hide what a short one takes
  const makeTimes = timing(of('speech_make_seconds', (l) => l.length === 'short'));
  const lines = counted(of('speech_seconds'));
  const failures = counted(of('speech_failures_total'));
  const loads = timing(of('voice_model_load_seconds'));
  const speech = {
    lines,
    failures,
    ...makeTimes,
    modelLoads: loads.count,
    modelLoadP95: loads.p95,
    status: lines || failures ? worse(makeTimes.count ? judge(makeTimes.p95, LIMITS.speechMake) : 'fine', failures ? 'slow' : 'fine') : ('quiet' as Status),
  };

  const startTimes = timing(of('music_start_seconds'));
  const music = {
    ...startTimes,
    kept: counted(of('music_download_seconds', (l) => l.kept === 'yes')),
    downloaded: counted(of('music_download_seconds', (l) => l.kept === 'no')),
    status: startTimes.count ? judge(startTimes.p95, LIMITS.musicStart) : ('quiet' as Status),
  };

  const frames = of('mixer_frames_total');
  const late = of('mixer_late_frames_total');
  const framesAll = counted(frames);
  const lateAll = counted(late);
  const stutterShare = framesAll ? lateAll / framesAll : null;
  const stutter = {
    frames: framesAll,
    late: lateAll,
    share: rounded(stutterShare, 5),
    series: frames.map((c, i) => (c && c.count ? rounded((late[i]?.count ?? 0) / c.count, 5) : null)),
    status: judge(stutterShare, LIMITS.stutter),
  };

  const delay = of('event_loop_delay_seconds');
  const delayPoints = delay.map(average);
  const worstDelay = delayPoints.reduce<number | null>((worst, d) => (d === null ? worst : Math.max(worst ?? 0, d)), null);
  const heapNow = perf.gaugeValue('heap_used_bytes');
  const bot = {
    worstDelay: rounded(worstDelay),
    peakDelay: rounded(total(delay)?.max ?? null),
    busy: rounded(average(total(of('event_loop_utilization'))), 3),
    heapNow: heapNow === undefined ? null : Math.round(heapNow),
    heapPeak: total(of('heap_used_bytes'))?.max ?? null,
    delay: delayPoints.map((d) => rounded(d)),
    status: judge(worstDelay, LIMITS.loopDelay),
  };

  const requests = { ok: 0, errors: 0 };
  for (const { labels, cells } of found.get('web_requests_total')?.values() ?? []) requests[labels.status === '5xx' ? 'errors' : 'ok'] += counted(cells);
  const requestsAll = requests.ok + requests.errors;
  const unreachable = counted(of('web_bot_unreachable_total'));
  const apiTimes = timing(of('api_request_seconds'));
  const web = {
    requests: requestsAll,
    errors: requests.errors,
    unreachable,
    apiP50: apiTimes.p50,
    apiP95: apiTimes.p95,
    // Requests that found the bot gone are among the errors already
    status: requestsAll ? judge(requests.errors / requestsAll, LIMITS.webErrors) : ('quiet' as Status),
  };

  // The web UI as people see it, in their browsers. Taps are actions: loads include whole pages of data
  const tapCells = of('browser_request_seconds', (l) => l.kind === 'action');
  const taps = timing(tapCells);
  const shown = timing(of('browser_page_seconds', (l) => l.step === 'shown'));
  const responses = timing(of('browser_response_seconds'));
  const tapsAll = total(tapCells);
  const networkAll = total(of('browser_network_seconds', (l) => l.kind === 'action'));
  const where = (via: string) => ({
    taps: timing(of('browser_request_seconds', (l) => l.kind === 'action' && l.via === via)),
    shown: timing(of('browser_page_seconds', (l) => l.step === 'shown' && l.via === via)),
  });
  const home = where('home');
  const away = where('away');
  const onDevice = (device: string) => timing(of('browser_request_seconds', (l) => l.kind === 'action' && l.device === device));
  const browser = {
    taps: { count: taps.count, p50: taps.p50, p95: taps.p95 },
    shown: { count: shown.count, p50: shown.p50, p95: shown.p95 },
    responses: { count: responses.count, p95: responses.p95 },
    /** Of the time taps took, the share that wasn't the bot */
    networkShare: tapsAll && networkAll && tapsAll.sum > 0 ? rounded(Math.min(1, networkAll.sum / tapsAll.sum), 3) : null,
    home: { taps: home.taps.p95, shown: home.shown.p95, tapSeries: home.taps.series, shownSeries: home.shown.series },
    away: { taps: away.taps.p95, shown: away.shown.p95, tapSeries: away.taps.series, shownSeries: away.shown.series },
    phone: onDevice('phone').p95,
    computer: onDevice('computer').p95,
    status:
      taps.count || shown.count || responses.count
        ? worse(judge(taps.p95, LIMITS.browserTap), judge(shown.p95, LIMITS.pageShown), judge(responses.p95, LIMITS.browserResponse), 'fine')
        : ('quiet' as Status),
  };

  const seen = new Set(CONTAINERS.filter((c) => perf.gaugeValue('container_up', { container: c }) !== undefined));
  for (const { labels } of found.get('container_up')?.values() ?? []) if (labels.container) seen.add(labels.container);
  const containers = [...seen]
    .sort((a, b) => (CONTAINERS.indexOf(a) + 1 || 99) - (CONTAINERS.indexOf(b) + 1 || 99))
    .map((name) => {
      const mine = (labels: perf.Labels) => labels.container === name;
      const up = of('container_up', mine);
      const upAll = total(up);
      const upNow = perf.gaugeValue('container_up', { container: name });
      const memory = of('container_memory_bytes', mine);
      const cpu = of('container_cpu_cores', mine);
      const memoryNow = perf.gaugeValue('container_memory_bytes', { container: name }) ?? null;
      const limit = perf.gaugeValue('container_memory_limit_bytes', { container: name }) ?? total(of('container_memory_limit_bytes', mine))?.max ?? null;
      // The bot sees itself every 15 seconds, and asks the others every 30
      const downMinutes = upAll ? ((upAll.count - upAll.sum) * (name === 'bot' ? SAMPLE_MS : POLL_MS)) / 60_000 : 0;
      const memoryShare = memoryNow !== null && limit ? memoryNow / limit : null;
      const peakShare = limit ? (total(memory)?.max ?? 0) / limit : null;
      return {
        name,
        upNow: upNow === undefined ? null : upNow === 1,
        downMinutes: rounded(downMinutes, 1),
        memoryNow: memoryNow === null ? null : Math.round(memoryNow),
        memoryPeak: total(memory)?.max ?? null,
        memoryLimit: limit,
        cpuAverage: rounded(average(total(cpu))),
        cpuPeak: rounded(total(cpu)?.max ?? null),
        memory: memory.map((c) => (c ? Math.round(average(c)!) : null)),
        cpu: cpu.map((c) => rounded(average(c))),
        status: upNow === 0 ? ('bad' as Status) : worse(judge(memoryShare, LIMITS.memory), downMinutes > 0 || (peakShare ?? 0) >= LIMITS.memory[1] ? 'slow' : 'fine'),
      };
    });

  return { range, start, step, points, limits: LIMITS, discord, commands, sounds, speech, music, stutter, bot, web, browser, containers };
}

export type HealthNumbers = ReturnType<typeof healthNumbers>;

/** Everything the Health view shows for `range`, with the slow list for `guildId` */
export function healthReport(guildId: string, range: Range, now = Date.now()) {
  const numbers = healthNumbers(range, now);
  return { ...numbers, slow: slowList(guildId, numbers.start) };
}
