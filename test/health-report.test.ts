import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { healthOf } from '../src/api/health.ts';
import { feeds } from '../src/changes.ts';
import { db } from '../src/db.ts';
import { store } from '../src/features/health.ts';
import { healthReport, quantile } from '../src/features/healthReport.ts';
import * as perf from '../src/perf.ts';
import { GUILD, ok, refused } from './apiFixture.ts';

// The Health view's numbers: each range at its own grain, percentiles from buckets, and each server's own slow list

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
  slow.run(at(10), GUILD, 'Speech', 33, JSON.stringify([['waiting', 32.8], ['making', 0.2]]), JSON.stringify({ voice: 'glados', characters: 40 }));
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
  assert.equal(listed[2].detail.voice, 'GLaDOS');
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
