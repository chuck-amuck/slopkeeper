import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { healthOf } from '../src/api/health.ts';
import { feeds } from '../src/changes.ts';
import { db, setKv } from '../src/db.ts';
import { browserReport, containerSeen, correctLoopDelays, rollUp, sampleMachine, store } from '../src/features/health.ts';
import { customWindow, FEWEST_TO_JUDGE, healthReport, quantile, verdictOf } from '../src/features/healthReport.ts';
import type { MachineReading } from '../src/machine.ts';
import * as perf from '../src/perf.ts';
import { GUILD, ok, refused } from './apiFixture.ts';

// The Health tab's numbers: each range at its own grain, percentiles from buckets, and each server's own slow list

const NOW = Date.UTC(2026, 10, 15, 12, 30, 20);
const MINUTE = 60_000;
const at = (minutesAgo: number) => Math.floor(NOW / MINUTE) * MINUTE - minutesAgo * MINUTE;

const insert = db.prepare('INSERT INTO perf_minutes (at, span, name, labels, count, sum, max, buckets) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
function minute(when: number, name: string, labels: Record<string, string>, count: number, sum: number, max: number, buckets: number[] | null = null, span = 1) {
  insert.run(when, span, name, JSON.stringify(labels), count, sum, max, buckets && JSON.stringify(buckets));
}
/** Timing buckets with `n` in the bucket up to `upTo` seconds */
const bucketed = (upTo: number, n: number) => perf.BUCKETS.map((b) => (b === upTo ? n : 0)).concat(0);

beforeEach(() => {
  perf.testing(() => NOW);
  db.exec('DELETE FROM perf_minutes; DELETE FROM perf_slow');
});

test('a percentile falls in a straight line across its bucket, and never past the slowest seen', () => {
  const ten = { count: 10, sum: 4, max: 0.5, buckets: bucketed(0.5, 10) };
  assert.equal(quantile(ten, 0.5), 0.375);
  assert.equal(quantile(ten, 1), 0.5);
  assert.equal(quantile({ ...ten, max: 0.3 }, 0.95), 0.3);
  const over = { count: 2, sum: 200, max: 120, buckets: perf.BUCKETS.map(() => 0).concat(2) };
  assert.equal(quantile(over, 0.5), 120, 'past the last bucket, the slowest seen');
  assert.equal(quantile(null, 0.5), null);
  assert.equal(quantile({ count: 0, sum: 0, max: 0, buckets: bucketed(1, 0) }, 0.5), null);
});

test('the hour has a point a minute, up to the last whole one, and a minute cut short by a restart is added up', () => {
  const short = { length: 'short' };
  minute(at(1), 'speech_make_seconds', short, 1, 0.4, 0.4, bucketed(0.5, 1));
  minute(at(1), 'speech_make_seconds', short, 1, 0.45, 0.45, bucketed(0.5, 1));
  minute(at(1), 'speech_make_seconds', { length: 'long' }, 1, 9, 9, bucketed(10, 1));
  minute(at(1), 'speech_make_seconds', {}, 1, 9, 9, bucketed(10, 1));
  minute(at(0), 'speech_make_seconds', short, 1, 9, 9, bucketed(10, 1));
  minute(at(61), 'speech_make_seconds', short, 1, 9, 9, bucketed(10, 1));
  minute(at(1), 'speech_seconds', {}, 2, 2, 1, bucketed(1, 2));
  const report = healthReport(GUILD, '1h', NOW);
  assert.equal(report.points, 60);
  assert.equal(report.start + 60 * MINUTE, at(0), 'the minute still going is left out');
  assert.equal(report.speech.count, 2, 'the two rows of one minute, without long lines, those timed before lines were by length, or anything from before the hour');
  assert.equal(report.speech.series.at(-1), 0.45);
  assert.equal(report.speech.series.filter((p) => p !== null).length, 1);
  assert.equal(report.speech.lines, 2);
  assert.equal(report.speech.status, 'fine');
});

test('a week reads the fifteen-minute rows, then the minutes not added up yet, without counting any twice', () => {
  const block = Math.floor(NOW / (15 * MINUTE)) * 15 * MINUTE - 15 * MINUTE;
  minute(block, 'mixer_frames_total', {}, 1000, 1000, 0, null, 15);
  minute(block, 'mixer_late_frames_total', {}, 30, 30, 0, null, 15);
  // Already in the block above
  minute(block + MINUTE, 'mixer_frames_total', {}, 50, 50, 0);
  // Since it
  minute(block + 15 * MINUTE, 'mixer_frames_total', {}, 1000, 1000, 0);
  minute(block - 8 * 86_400_000, 'mixer_frames_total', {}, 5000, 5000, 0, null, 15);
  const report = healthReport(GUILD, '7d', NOW);
  assert.equal(report.points, 168);
  assert.equal(report.stutter.frames, 2000);
  assert.equal(report.stutter.late, 30);
  assert.equal(report.stutter.share, 0.015);
  assert.equal(report.stutter.status, 'slow');
  assert.equal(healthReport(GUILD, '30d', NOW).points, 120);
  assert.equal(healthReport(GUILD, '24h', NOW).stutter.frames, 2000, 'a day reads fifteen-minute rows too');
});

test('gauges are added up into each point, however many minutes and series it has', () => {
  // A day is read a point every 15 minutes, here from minutes alone, as none have been added up yet
  const point = Math.floor(NOW / (15 * MINUTE)) * 15 * MINUTE - 30 * MINUTE;
  minute(point, 'discord_gateway_ping_seconds', {}, 1, 0.1, 0.1);
  minute(point + MINUTE, 'discord_gateway_ping_seconds', {}, 2, 0.5, 0.4);
  minute(point + 14 * MINUTE, 'discord_gateway_ping_seconds', {}, 1, 0.3, 0.3);
  minute(point + 15 * MINUTE, 'discord_gateway_ping_seconds', {}, 1, 0.05, 0.05);
  // Two series of one counter, added together
  minute(point, 'mixer_frames_total', { a: '1' }, 100, 100, 0);
  minute(point + 3 * MINUTE, 'mixer_frames_total', { a: '2' }, 50, 50, 0);
  minute(point + 3 * MINUTE, 'mixer_late_frames_total', {}, 3, 3, 0);
  const report = healthReport(GUILD, '24h', NOW);
  const i = (point - report.start) / (15 * MINUTE);
  assert.deepEqual(report.discord.ping.slice(i, i + 2), [0.225, 0.05]);
  assert.equal(report.stutter.frames, 150);
  assert.equal(report.stutter.late, 3);
});

test('Discord and each container count the time they were away', () => {
  perf.gauge('discord_connected', 1);
  // Four samples a minute, two of them away: 30 seconds
  minute(at(5), 'discord_connected', {}, 4, 2, 1);
  minute(at(4), 'discord_gateway_ping_seconds', {}, 4, 0.2, 0.06);
  minute(at(4), 'discord_gateway_reconnects_total', {}, 1, 1, 0);
  perf.gauge('container_up', 1, { container: 'voice' });
  perf.gauge('container_memory_bytes', 950, { container: 'voice' });
  perf.gauge('container_memory_limit_bytes', 1000, { container: 'voice' });
  minute(at(3), 'container_up', { container: 'voice' }, 2, 1, 1);
  minute(at(3), 'container_memory_bytes', { container: 'voice' }, 2, 1000, 600);
  minute(at(3), 'container_up', { container: 'music' }, 2, 2, 1);
  const report = healthReport(GUILD, '1h', NOW);
  assert.equal(report.discord.downMinutes, 0.5);
  assert.equal(report.discord.reconnects, 1);
  assert.equal(report.discord.ping.at(-4), 0.05);
  assert.equal(report.discord.status, 'fine', 'under two minutes away');
  assert.equal(report.discord.connectedNow, true);
  const [voice, music] = report.containers;
  assert.deepEqual([voice.name, voice.downMinutes, voice.memoryNow, voice.memoryLimit, voice.memoryPeak, voice.status], ['voice', 0.5, 950, 1000, 600, 'bad']);
  assert.equal(voice.memory.at(-3), 500);
  assert.deepEqual([music.name, music.upNow, music.downMinutes, music.status], ['music', null, 0, 'fine']);
  perf.gauge('discord_connected', 0);
  assert.equal(healthReport(GUILD, '1h', NOW).discord.status, 'bad');
});

test('commands count how each went, and nothing measured is quiet', () => {
  minute(at(2), 'discord_interactions_total', { kind: 'command', name: '/say', outcome: 'ok' }, 8, 8, 0);
  minute(at(2), 'discord_interactions_total', { kind: 'command', name: '/say', outcome: 'expired' }, 2, 2, 0);
  minute(at(2), 'discord_interaction_answer_seconds', { kind: 'command', name: '/say' }, 10, 3, 0.4, bucketed(0.5, 10));
  const report = healthReport(GUILD, '1h', NOW);
  assert.deepEqual([report.commands.total, report.commands.ok, report.commands.expired, report.commands.inTime, report.commands.status], [10, 8, 2, 0.8, 'slow']);
  assert.equal(report.sounds.status, 'quiet');
  assert.equal(report.music.status, 'quiet');
  assert.equal(report.web.status, 'quiet');
  assert.equal(report.sounds.p95, null);
});

test('the web UI is judged by the share of answers that failed, those that found the bot gone among them', () => {
  minute(at(2), 'web_requests_total', { status: '2xx' }, 97, 97, 0);
  minute(at(2), 'web_requests_total', { status: '5xx' }, 3, 3, 0);
  minute(at(2), 'web_bot_unreachable_total', {}, 3, 3, 0);
  const { web } = healthReport(GUILD, '1h', NOW);
  assert.deepEqual([web.requests, web.errors, web.unreachable, web.status], [100, 3, 3, 'slow']);
});

test('the slow list is this server’s, ranked leaving out time spent waiting', () => {
  const slow = db.prepare('INSERT INTO perf_slow (at, guild_id, what, seconds, steps, detail) VALUES (?, ?, ?, ?, ?, ?)');
  slow.run(at(10), GUILD, 'Speech', 33, JSON.stringify([['waiting', 32.8], ['making', 0.2]]), JSON.stringify({ voice: 'scottish', characters: 40 }));
  slow.run(at(9), GUILD, 'Music', 12, JSON.stringify([['download', 11.9], ['starting', 0.1]]), '{}');
  slow.run(at(8), 'elsewhere', 'Sound', 50, '[]', '{}');
  slow.run(at(7), null, 'Web UI: guilds', 3, '[]', '{}');
  slow.run(at(90), GUILD, 'Music', 40, '[]', '{}');
  const { slow: listed } = healthReport(GUILD, '1h', NOW);
  assert.deepEqual(
    listed.map((s) => [s.what, s.own]),
    [
      ['Web UI: guilds', 3],
      ['Music', 12],
      ['Speech', 0.2],
    ],
    'newest first, without another server’s or anything from before the hour',
  );
  assert.equal(listed[2].detail.voice, 'Scottish');
  for (let n = 0; n < 30; n++) slow.run(at(5) + n, GUILD, 'Sound', 2, '[]', '{}');
  const many = healthReport(GUILD, '1h', NOW).slow;
  assert.ok(many.some((s) => s.what === 'Music'), 'the slowest stay listed beside the 20 newest');
  assert.ok(!many.some((s) => s.what === 'Speech'), 'neither among the newest nor the slowest');
  assert.equal(many.length, 22);
});

test('speech that only waited behind other lines isn’t kept as slow', () => {
  perf.keep(true);
  const queued = new perf.Trace('speech_seconds', 'Speech', GUILD, 0.05);
  queued.steps.push(['waiting', 60]);
  queued.end();
  const made = new perf.Trace('speech_seconds', 'Speech', GUILD, 0);
  made.steps.push(['waiting', 60]);
  made.end();
  store();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_slow').get() as { n: number }).n, 1);
  assert.equal(perf.ownTime(10, [['waiting', 4], ['waiting', 3, 'making'], ['making', 6]]), 6);
});

test('the API answers a range, refuses others, and keeps each range for a moment', async () => {
  minute(at(1), 'speech_make_seconds', {}, 1, 0.4, 0.4, bucketed(0.5, 1));
  const report = await ok(`/guilds/${GUILD}/health?range=1h`);
  assert.equal(report.range, '1h');
  assert.equal(report.timeZone, 'America/Chicago');
  assert.equal(report.version, feeds.health.version(GUILD));
  assert.equal((await ok(`/guilds/${GUILD}/health`)).range, '24h');
  assert.match(await refused(400, `/guilds/${GUILD}/health?range=1y`), /1h, 24h, 7d, 30d/);
  const first = healthOf('1h', Date.now());
  minute(at(1), 'speech_make_seconds', {}, 1, 0.4, 0.4, bucketed(0.5, 1));
  assert.equal(healthOf('1h', Date.now()), first, 'the same answer within 15 seconds, for every server');
  feeds.health.changedEverywhere();
  assert.notEqual(healthOf('1h', Date.now()), first, 'worked out again once another minute is kept');
});

test('keeping a minute tells pages showing Health', async () => {
  perf.keep(true);
  const before = feeds.health.version(GUILD);
  store();
  perf.slow({ guildId: GUILD, what: 'Sound', seconds: 3, steps: [], detail: {} });
  store();
  assert.equal(feeds.health.version(GUILD), before, 'not when there was nothing to keep, or only something slow');
  perf.count('mixer_frames_total');
  store(true);
  assert.notEqual(feeds.health.version(GUILD), before);
  const update = await ok(`/guilds/${GUILD}/updates?health=${encodeURIComponent(before)}`);
  assert.deepEqual(update.health, { version: feeds.health.version(GUILD) });
});

test('a browser’s report is kept by where it came from, with anything odd left out', (t) => {
  // Reports are counted a minute at a time, so the minute can't turn part way
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  perf.keep(true);
  assert.equal(browserReport({ device: 'phone', requests: [] }), false, 'without where it came from');
  assert.equal(browserReport({ via: 'home', device: 'tablet' }), false);
  assert.equal(
    browserReport({
      via: 'away',
      device: 'phone',
      requests: [['action', 0.4, 0.1], ['action', 0.5, 0.2], ['action', 0.6, null], ['action', 0.3, 0.4], ['load', 0.2, 0.15], ['delete', 1, 0], ['action', -1, 0], ['action', 500, 0], 'x'],
      page: { firstByte: 0.3, shown: 1.2 },
      responses: [0.05, 'slow', 300],
      quickResponses: 2,
    }),
    true,
  );
  const line = (start: string) => perf.prometheus().split('\n').find((l) => l.startsWith(start));
  assert.equal(line('slopkeeper_browser_request_seconds_count{via="away",device="phone",kind="action"}')?.split(' ')[1], '2', 'only the two that make sense, with the network’s part known and no more than the whole');
  assert.equal(line('slopkeeper_browser_request_seconds_count{via="away",device="phone",kind="load"}')?.split(' ')[1], '1');
  assert.equal(line('slopkeeper_browser_network_seconds_sum{via="away",device="phone",kind="action"}')?.split(' ')[1], '0.3');
  assert.equal(line('slopkeeper_browser_page_seconds_count{via="away",device="phone",step="shown"}')?.split(' ')[1], '1');
  assert.equal(line('slopkeeper_browser_response_seconds_count{via="away",device="phone"}')?.split(' ')[1], '3', 'one timed, two quick');
  assert.equal(browserReport({ via: 'home', device: 'computer', quickResponses: 1e9 }), true);
  assert.equal(line('slopkeeper_browser_response_seconds_count{via="home",device="computer"}')?.split(' ')[1], '500', 'no more than a report may hold');
  for (let n = 0; n < 200; n++) browserReport({ via: 'home', device: 'phone', quickResponses: 1 });
  assert.equal(line('slopkeeper_browser_response_seconds_count{via="home",device="phone"}')?.split(' ')[1], String(120 - 2), 'no more than 120 reports a minute are kept, two of them sent above');
});

test('waits people expect are kept by what they were for, apart from taps', (t) => {
  // A minute of its own, as the test before used up this one's reports
  t.mock.timers.enable({ apis: ['Date'], now: NOW + MINUTE });
  perf.keep(true);
  browserReport({
    via: 'away',
    device: 'computer',
    requests: [['wait', 4.2, 0.1, 'chat'], ['wait', 9, 0.1, 'music'], ['wait', 1, 0.1], ['wait', 1, 0.1, 'nap'], ['action', 0.2, 0.1, 'chat']],
  });
  const line = (start: string) => perf.prometheus().split('\n').find((l) => l.startsWith(start));
  assert.equal(line('slopkeeper_browser_request_seconds_count{via="away",device="computer",kind="wait",what="chat"}')?.split(' ')[1], '1');
  assert.equal(line('slopkeeper_browser_request_seconds_count{via="away",device="computer",kind="wait",what="music"}')?.split(' ')[1], '1');
  assert.equal(line('slopkeeper_browser_request_seconds_count{via="away",device="computer",kind="action"}')?.split(' ')[1], '1', 'a tap, with what it says left out');
  assert.equal(perf.prometheus().split('\n').filter((l) => l.startsWith('slopkeeper_browser_request_seconds_count')).length, 3, 'a wait without a known reason is left out');
});

test('a slow opening of the web UI is kept with its steps, a few a minute', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW + 2 * MINUTE });
  perf.keep(true);
  browserReport({ via: 'away', device: 'phone', page: { firstByte: 0.4, scripts: 1.1, shown: 4.5, tab: 'board' } });
  browserReport({ via: 'home', device: 'computer', page: { firstByte: 0.01, shown: 1.2 } });
  // Steps out of order are left out, and a tab that isn't a word isn't kept
  browserReport({ via: 'home', device: 'computer', page: { firstByte: 9, scripts: 2, shown: 6, tab: '<b>' } });
  for (let n = 0; n < 10; n++) browserReport({ via: 'home', device: 'phone', page: { shown: 5 } });
  store(true);
  const rows = db.prepare('SELECT guild_id, what, seconds, steps, detail FROM perf_slow ORDER BY id').all() as { guild_id: string | null; what: string; seconds: number; steps: string; detail: string }[];
  assert.equal(rows.length, 5, 'no more than 5 a minute');
  assert.deepEqual(
    rows.slice(0, 2).map((r) => [r.guild_id, r.what, r.seconds, JSON.parse(r.steps), JSON.parse(r.detail)]),
    [
      [null, 'Web UI: opening', 4.5, [['reaching the web UI', 0.4], ['loading its scripts', 0.7], ['drawing the page', 3.4]], { via: 'away', device: 'phone', tab: 'board' }],
      [null, 'Web UI: opening', 6, [['loading its scripts', 2], ['drawing the page', 4]], { via: 'home', device: 'computer' }],
    ],
  );
});

test('slow openings of the web UI are kept apart, so they can’t push the bot’s own out', () => {
  const slow = db.prepare('INSERT INTO perf_slow (at, guild_id, what, seconds, steps, detail) VALUES (?, ?, ?, ?, ?, ?)');
  slow.run(at(30), GUILD, 'Music', 12, '[]', '{}');
  for (let n = 0; n < 60; n++) slow.run(at(20), null, 'Web UI: opening', 5, '[]', '{}');
  rollUp(NOW);
  const count = (what: string) => (db.prepare('SELECT COUNT(*) AS n FROM perf_slow WHERE what = ?').get(what) as { n: number }).n;
  assert.deepEqual([count('Music'), count('Web UI: opening')], [1, 50]);
});

test('waits people expect are judged each on its own, once there are enough', () => {
  const where = { via: 'away', device: 'computer' };
  minute(at(2), 'browser_request_seconds', { ...where, kind: 'wait', what: 'chat' }, FEWEST_TO_JUDGE, 200, 12, bucketed(30, FEWEST_TO_JUDGE));
  minute(at(2), 'browser_request_seconds', { ...where, kind: 'wait', what: 'speech' }, 5, 40, 30, bucketed(30, 5));
  minute(at(2), 'browser_request_seconds', { ...where, kind: 'action' }, 30, 3, 0.2, bucketed(0.25, 30));
  const { waits, browser } = healthReport(GUILD, '1h', NOW);
  assert.equal(browser.taps.count, 30, 'taps leave the waits out');
  assert.equal(waits.count, FEWEST_TO_JUDGE + 5);
  assert.deepEqual(
    waits.kinds.map((w) => [w.what, w.count, w.status]),
    [
      ['chat', FEWEST_TO_JUDGE, 'slow'],
      ['speech', 5, 'few'],
    ],
  );
  assert.equal(waits.status, 'slow', 'chat’s answers took 12 s, and the few slow speech waits aren’t judged');
  db.exec('DELETE FROM perf_minutes');
  minute(at(2), 'browser_request_seconds', { ...where, kind: 'wait', what: 'links' }, 2, 4, 2, bucketed(2.5, 2));
  assert.equal(healthReport(GUILD, '1h', NOW).waits.status, 'few');
  db.exec('DELETE FROM perf_minutes');
  assert.deepEqual(healthReport(GUILD, '1h', NOW).waits, { count: 0, kinds: [], fewest: FEWEST_TO_JUDGE, status: 'quiet' });
});

test('the web UI as people see it is judged by taps, opening and reacting', () => {
  const where = (via: string, device: string, extra = {}) => ({ via, device, ...extra });
  minute(at(2), 'browser_request_seconds', where('home', 'computer', { kind: 'action' }), 10, 1, 0.2, bucketed(0.25, 10));
  minute(at(2), 'browser_request_seconds', where('away', 'phone', { kind: 'action' }), 10, 8, 0.9, bucketed(1, 10));
  minute(at(2), 'browser_network_seconds', where('away', 'phone', { kind: 'action' }), 10, 6, 0.8, bucketed(1, 10));
  minute(at(2), 'browser_page_seconds', where('away', 'phone', { step: 'shown' }), 1, 2, 2, bucketed(2.5, 1));
  const { browser } = healthReport(GUILD, '1h', NOW);
  assert.equal(browser.taps.count, 20);
  assert.ok(browser.home.taps! < 0.25 && browser.away.taps! > 0.5);
  assert.equal(browser.phone, browser.away.taps);
  assert.equal(browser.networkShare, 0.667, 'the network’s 6 of the 9 seconds');
  assert.equal(browser.shown.p95, 2);
  assert.equal(browser.status, 'slow', 'away taps took over half a second, and the one slow opening is too few to count');
  assert.equal(browser.away.tapSeries.at(-2), browser.away.taps);
  db.exec('DELETE FROM perf_minutes');
  assert.equal(healthReport(GUILD, '1h', NOW).browser.status, 'quiet');
  // A few very slow taps: measured, but too few to judge
  minute(at(2), 'browser_request_seconds', where('away', 'phone', { kind: 'action' }), FEWEST_TO_JUDGE - 1, 60, 5, bucketed(5, FEWEST_TO_JUDGE - 1));
  const few = healthReport(GUILD, '1h', NOW).browser;
  assert.deepEqual([few.taps.count, few.status], [FEWEST_TO_JUDGE - 1, 'few']);
});

/** A reading of the machine `seconds` in, with running totals as given */
const reading = (seconds: number, { busy = 0, idle = 0, io = 0, available = 8e9 } = {}): MachineReading => ({
  at: seconds * 1000,
  cpu: { total: busy + idle, idle, iowait: 0, steal: 0, cores: 4 },
  memory: { total: 10e9, available, swapTotal: 2e9, swapFree: 2e9 },
  swapPages: 0,
  stall: { cpu: 0, memory: 0, io },
  disk: { free: 30e9, total: 100e9 },
});

test('the machine’s numbers are kept, and the disk keeping things waiting is the verdict', () => {
  perf.keep(true);
  sampleMachine(reading(0));
  // Fifteen seconds later: half the CPU busy, and something waiting on the disk 6 of the 15 seconds
  sampleMachine(reading(15, { busy: 750, idle: 750, io: 6e6, available: 7e9 }));
  store(true);
  const { machine, verdict } = healthReport(GUILD, '1h', NOW + 2 * MINUTE);
  assert.equal(machine.cpus, 4);
  assert.equal(machine.cpu.busyWorst, 0.5);
  assert.equal(machine.stall.worst.io, 0.4);
  assert.equal(machine.memory.usedWorst, 0.25, 'the minute’s average of its two samples');
  assert.equal(machine.memory.total, 10e9);
  assert.deepEqual(
    verdict.causes.map((c) => [c.cause, c.status]),
    [['vm-disk', 'bad']],
  );
  assert.equal(verdict.status, 'bad');
});

test('a container’s stall times are shares of the time between reports, its CPU limit of the periods, and a restart counts from nothing', () => {
  perf.keep(true);
  const usage = (cpu: number, io: number, periods: number, throttled: number, oom = 0) => ({ memoryBytes: 1, memoryLimitBytes: 10, cpuSeconds: cpu, stallSeconds: { cpu: 0, memory: 0, io }, cpuPeriods: periods, throttledPeriods: throttled, oomKills: oom });
  containerSeen('music', usage(1, 1, 100, 0), 0);
  // 300 periods in 30 seconds means it wanted the CPU the whole time; its limit held it back in 30 of them
  containerSeen('music', usage(16, 4, 400, 30, 1), 30_000);
  assert.equal(perf.gaugeValue('container_cpu_cores', { container: 'music' }), 0.5);
  assert.equal(perf.gaugeValue('container_stall_ratio', { container: 'music', resource: 'io' }), 0.1);
  assert.equal(perf.gaugeValue('container_throttled_ratio', { container: 'music' }), 0.1);
  assert.match(perf.prometheus(), /container_oom_kills_total\{container="music"\} 1/);
  containerSeen('music', usage(0.5, 0.1, 0, 0), 60_000);
  assert.equal(perf.gaugeValue('container_cpu_cores', { container: 'music' }), 0.5, 'a restart leaves the last share as it was');
});

test('slow things with nothing short of resources point at the code; a limit or memory kill is named with its container', () => {
  const machine = healthReport(GUILD, '1h', NOW).machine;
  const fine = { status: 'fine' as const };
  const quiet = { memoryShareWorst: null, throttledWorst: null, oomKills: 0, status: 'fine' as const };
  const slowCommands = verdictOf({ machine, containers: [{ name: 'bot', ...quiet }], gc: { worst: 0 }, slowed: { commands: { status: 'slow' }, sounds: fine } });
  assert.deepEqual(slowCommands.causes, [{ cause: 'code', status: 'slow', value: null, parts: ['commands'] }]);
  const limited = verdictOf({
    machine,
    containers: [
      { name: 'voice', ...quiet, throttledWorst: 0.3 },
      { name: 'music', ...quiet, oomKills: 2 },
    ],
    gc: { worst: 0 },
    slowed: { commands: { status: 'slow' } },
  });
  assert.deepEqual(
    limited.causes.map((c) => [c.cause, c.container, c.status]),
    [
      ['cpu-limit', 'voice', 'bad'],
      ['out-of-memory', 'music', 'bad'],
    ],
    'with a cause found, slow commands are put down to it',
  );
  assert.equal(verdictOf({ machine, containers: [], gc: { worst: null }, slowed: {} }).status, 'quiet');
  // How full the disk is is known only now, so it's judged only for a stretch up to now
  const full = { ...machine, disk: { free: 4e9, total: 100e9, used: 0.96 } };
  assert.deepEqual(verdictOf({ machine: { ...full, current: true }, containers: [], gc: { worst: null }, slowed: {} }).causes.map((c) => c.cause), ['disk-space']);
  assert.deepEqual(verdictOf({ machine: { ...full, current: false }, containers: [], gc: { worst: null }, slowed: {} }).causes, []);
});

test('a custom range picks the finest step that keeps it to 240 points, within what’s kept', () => {
  const HOUR = 60 * MINUTE;
  const day = customWindow(NOW - 24 * HOUR, NOW, NOW);
  assert.ok(typeof day !== 'string');
  assert.equal(day.step, 15 * MINUTE);
  const hour = customWindow(NOW - HOUR, NOW, NOW);
  assert.ok(typeof hour !== 'string');
  assert.equal(hour.step, MINUTE);
  const old = customWindow(NOW - 5 * 24 * HOUR, NOW - 5 * 24 * HOUR + HOUR, NOW);
  assert.ok(typeof old !== 'string');
  assert.equal(old.step, 15 * MINUTE, 'minutes are only kept for two days');
  const month = customWindow(0, NOW, NOW);
  assert.ok(typeof month !== 'string');
  assert.ok(month.start >= NOW - 30 * 24 * HOUR - 6 * HOUR && month.points <= 240, 'cut to the 30 days kept');
  assert.equal(customWindow(NOW, NOW - HOUR, NOW), 'Pick a start before the end.');
  assert.equal(customWindow(NOW - 5 * MINUTE, NOW, NOW), 'Pick at least 10 minutes.');
  assert.equal(customWindow(0, 1000, NOW), 'Health keeps the last 30 days.');
});

test('the Health route takes a custom range', async () => {
  const hour = await ok(`/guilds/${GUILD}/health?from=${Date.now() - 3_600_000}&to=${Date.now()}`);
  assert.equal(hour.range, 'custom');
  assert.equal(hour.step, 60_000);
  assert.ok(hour.verdict && hour.machine);
  await refused(400, `/guilds/${GUILD}/health?from=${Date.now()}&to=${Date.now() - 3_600_000}`);
});

test('event loop delays kept before the sampler’s own 20 ms was taken out are corrected once', () => {
  setKv('loop_delay_corrected', '');
  minute(at(10), 'event_loop_delay_seconds', {}, 4, 0.1, 0.05);
  minute(at(9), 'event_loop_delay_seconds', {}, 4, 0.04, 0.01);
  minute(at(9), 'heap_used_bytes', {}, 4, 400, 100);
  minute(at(0), 'event_loop_delay_seconds', {}, 4, 0, 0);
  correctLoopDelays(at(5));
  correctLoopDelays(at(0));
  const rows = db.prepare('SELECT at, name, sum, max FROM perf_minutes ORDER BY at, name').all() as { at: number; name: string; sum: number; max: number }[];
  assert.deepEqual(
    rows.map((r) => [r.name, Math.round(r.sum * 1000) / 1000, Math.round(r.max * 1000) / 1000]),
    [
      ['event_loop_delay_seconds', 0.02, 0.03],
      ['event_loop_delay_seconds', 0, 0],
      ['heap_used_bytes', 400, 100],
      ['event_loop_delay_seconds', 0, 0],
    ],
    'only before it, only once, and never below nothing',
  );
});
