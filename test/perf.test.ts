import './helpers.ts';
import { Status } from 'discord.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { containerSeen, poll, rollUp, sample, store, timeInteraction, webReport } from '../src/features/health.ts';
import * as perf from '../src/perf.ts';

// Measuring how the bot and its containers are doing, keeping it, and answering in Prometheus's format

let clock = Date.UTC(2026, 10, 13, 12, 0, 5);
const minute = (n: number) => Date.UTC(2026, 10, 13, 12, n);

beforeEach(() => {
  clock = Date.UTC(2026, 10, 13, 12, 0, 5);
  perf.testing(() => clock);
  db.exec('DELETE FROM perf_minutes; DELETE FROM perf_slow');
});

/** A line of the Prometheus answer, without the HELP and TYPE ones */
const line = (start: string) => perf.prometheus().split('\n').find((l) => l.startsWith(start));

test('timings fall in their buckets, and Prometheus gets them added up', () => {
  perf.time('api_request_seconds', 0.004, { area: 'sounds' });
  perf.time('api_request_seconds', 0.3, { area: 'sounds' });
  perf.time('api_request_seconds', 120, { area: 'sounds' });
  perf.time('api_request_seconds', -1, { area: 'sounds' });
  const text = perf.prometheus();
  assert.match(text, /^# HELP slopkeeper_api_request_seconds /m);
  assert.match(text, /^# TYPE slopkeeper_api_request_seconds histogram$/m);
  assert.equal(line('slopkeeper_api_request_seconds_bucket{area="sounds",le="0.005"}'), 'slopkeeper_api_request_seconds_bucket{area="sounds",le="0.005"} 1');
  assert.equal(line('slopkeeper_api_request_seconds_bucket{area="sounds",le="0.25"}'), 'slopkeeper_api_request_seconds_bucket{area="sounds",le="0.25"} 1');
  assert.equal(line('slopkeeper_api_request_seconds_bucket{area="sounds",le="0.5"}'), 'slopkeeper_api_request_seconds_bucket{area="sounds",le="0.5"} 2');
  assert.equal(line('slopkeeper_api_request_seconds_bucket{area="sounds",le="60"}'), 'slopkeeper_api_request_seconds_bucket{area="sounds",le="60"} 2');
  assert.equal(line('slopkeeper_api_request_seconds_bucket{area="sounds",le="+Inf"}'), 'slopkeeper_api_request_seconds_bucket{area="sounds",le="+Inf"} 3', 'a negative time is left out');
  assert.equal(line('slopkeeper_api_request_seconds_sum{area="sounds"}'), 'slopkeeper_api_request_seconds_sum{area="sounds"} 120.304');
  assert.equal(line('slopkeeper_api_request_seconds_count{area="sounds"}'), 'slopkeeper_api_request_seconds_count{area="sounds"} 3');
});

test('counters add up and gauges keep the latest, with label values escaped', () => {
  perf.count('api_requests_total', { area: 'say', status: '2xx' });
  perf.count('api_requests_total', { status: '2xx', area: 'say' }, 2);
  perf.gauge('container_memory_bytes', 100, { container: 'we"b\\\n' });
  perf.gauge('container_memory_bytes', 200, { container: 'we"b\\\n' });
  perf.gauge('discord_gateway_ping_seconds', NaN);
  assert.equal(line('slopkeeper_api_requests_total'), 'slopkeeper_api_requests_total{area="say",status="2xx"} 3', 'the same labels in any order are one series');
  assert.equal(line('slopkeeper_container_memory_bytes'), 'slopkeeper_container_memory_bytes{container="we\\"b\\\\\\n"} 200');
  assert.equal(line('slopkeeper_discord_gateway_ping_seconds'), undefined, 'a value that isn’t a number is left out');
  assert.match(perf.prometheus(), /^# TYPE slopkeeper_api_requests_total counter$/m);
});

test('each minute is set aside once it’s over, only while something keeps them', () => {
  perf.count('mixer_frames_total');
  assert.deepEqual(perf.take(true), { minutes: [], slow: [] }, 'nothing is gathered until asked');
  perf.keep(true);
  perf.gauge('discord_gateway_ping_seconds', 0.04);
  perf.gauge('discord_gateway_ping_seconds', 0.08);
  perf.time('speech_seconds', 1.2);
  perf.count('mixer_frames_total', {}, 50);
  assert.deepEqual(perf.take().minutes, [], 'the minute is still going');
  clock = minute(1) + 1000;
  perf.count('mixer_frames_total', {}, 7);
  const { minutes } = perf.take();
  const byName = Object.fromEntries(minutes.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ['discord_gateway_ping_seconds', 'mixer_frames_total', 'speech_seconds']);
  assert.ok(minutes.every((m) => m.at === minute(0)));
  assert.deepEqual([byName.discord_gateway_ping_seconds.count, byName.discord_gateway_ping_seconds.sum.toFixed(2), byName.discord_gateway_ping_seconds.max], [2, '0.12', 0.08]);
  assert.equal(byName.mixer_frames_total.count, 50);
  assert.equal(byName.speech_seconds.buckets![perf.BUCKETS.indexOf(2.5)], 1);
  const rest = perf.take(true).minutes;
  assert.deepEqual(rest.map((m) => [m.name, m.at, m.count]), [['mixer_frames_total', minute(1), 7]], 'shutting down keeps the minute still going');
});

test('minutes are written, added up every 15 minutes, and let go once past keeping', () => {
  perf.keep(true);
  for (let n = 0; n < 16; n++) {
    clock = minute(n) + 1000;
    perf.time('speech_seconds', n < 15 ? 1 : 9);
    perf.gauge('heap_used_bytes', 100 + n);
  }
  store();
  rollUp(minute(16));
  const rows = db.prepare('SELECT span, at, name, count, sum, max, buckets FROM perf_minutes ORDER BY span, name, at').all() as any[];
  assert.equal(rows.filter((r) => r.span === 1).length, 30, 'a minute per row for the 15 that are over');
  const rolled = rows.filter((r) => r.span === 15);
  assert.deepEqual(
    rolled.map((r) => [r.at, r.name, r.count, r.max]),
    [
      [minute(0), 'heap_used_bytes', 15, 114],
      [minute(0), 'speech_seconds', 15, 1],
    ],
  );
  assert.equal(JSON.parse(rolled[1].buckets)[perf.BUCKETS.indexOf(1)], 15);
  rollUp(minute(16));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_minutes WHERE span = 15').get() as any).n, 2, 'a block is added up once');

  // Two days on the minutes go; the 15-minute rows stay for 30
  rollUp(minute(16) + 2 * 86_400_000);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_minutes WHERE span = 1').get() as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_minutes WHERE span = 15').get() as any).n, 2);
  rollUp(minute(0) + 31 * 86_400_000);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_minutes').get() as any).n, 0);
});

test('something slow keeps its steps, and only the newest 500 are kept', () => {
  perf.keep(true);
  const quick = new perf.Trace('speech_seconds', 'Speech', 'g1', 60);
  quick.step('waiting');
  quick.end();
  const slow = new perf.Trace('speech_seconds', 'Speech', 'g1', 0, {});
  Object.assign(slow.detail, { voice: 'hal', characters: 12 });
  slow.step('waiting');
  slow.part('saying it', 0.81234567, 'making');
  slow.step('making');
  slow.end();
  slow.end();
  store();
  const rows = db.prepare('SELECT guild_id, what, seconds, steps, detail FROM perf_slow').all() as any[];
  assert.equal(rows.length, 1, 'only the slow one, once');
  assert.deepEqual([rows[0].guild_id, rows[0].what, JSON.parse(rows[0].detail)], ['g1', 'Speech', { voice: 'hal', characters: 12 }]);
  assert.deepEqual(JSON.parse(rows[0].steps).map((s: unknown[]) => [s[0], s[2]]), [['waiting', undefined], ['saying it', 'making'], ['making', undefined]]);
  assert.equal(JSON.parse(rows[0].steps)[1][1], 0.8123);
  assert.equal(line('slopkeeper_speech_seconds_count'), 'slopkeeper_speech_seconds_count 2');

  for (let n = 0; n < 510; n++) perf.slow({ guildId: null, what: `x${n}`, seconds: 3, steps: [], detail: {} });
  store();
  rollUp(clock + 15 * 60_000);
  const kept = db.prepare('SELECT what FROM perf_slow ORDER BY id').all() as any[];
  assert.equal(kept.length, 500);
  assert.equal(kept[0].what, 'x10');
});

test('reads a Server-Timing header', () => {
  assert.deepEqual([...perf.serverTiming('load;dur=850.6, phonemize;dur=15.3, synth;dur=62.8;desc="x", bad;dur=-1, odd, total;dur=929.2')], [
    ['load', 0.8506],
    ['phonemize', 0.0153],
    ['synth', 0.0628],
    ['total', 0.9292],
  ]);
  assert.equal(perf.serverTiming(null).size, 0);
});

test('a container’s usage comes from its cgroup, as docker stats counts it, or the process outside one', () => {
  const dir = mkdtempSync(path.join(process.env.DATA_DIR!, 'cgroup-'));
  writeFileSync(path.join(dir, 'memory.current'), '300000000\n');
  writeFileSync(path.join(dir, 'memory.max'), '536870912\n');
  writeFileSync(path.join(dir, 'memory.stat'), 'anon 1\nactive_file 5\ninactive_file 100000000\n');
  writeFileSync(path.join(dir, 'cpu.stat'), 'usage_usec 2500000\nuser_usec 2000000\n');
  assert.deepEqual(perf.containerUsage(dir), { memoryBytes: 200000000, memoryLimitBytes: 536870912, cpuSeconds: 2.5 });
  writeFileSync(path.join(dir, 'memory.max'), 'max\n');
  assert.equal(perf.containerUsage(dir).memoryLimitBytes, null);
  const outside = perf.containerUsage(path.join(dir, 'none'));
  assert.ok(outside.memoryBytes > 0 && outside.cpuSeconds > 0 && outside.memoryLimitBytes === null);
});

test('CPU is worked out from the time used between two reports, and a restart starts again', (t) => {
  let now = 1_000_000;
  t.mock.method(performance, 'now', () => now);
  containerSeen('cpu-test', { memoryBytes: 5, memoryLimitBytes: null, cpuSeconds: 10 });
  assert.equal(perf.gaugeValue('container_cpu_cores', { container: 'cpu-test' }), undefined, 'one report isn’t enough');
  assert.equal(perf.gaugeValue('container_up', { container: 'cpu-test' }), 1);
  now += 30_000;
  containerSeen('cpu-test', { memoryBytes: 5, memoryLimitBytes: null, cpuSeconds: 25 });
  assert.equal(perf.gaugeValue('container_cpu_cores', { container: 'cpu-test' }), 0.5, 'half a core');
  now += 30_000;
  containerSeen('cpu-test', { memoryBytes: 5, memoryLimitBytes: 1000, cpuSeconds: 1 });
  assert.equal(perf.gaugeValue('container_cpu_cores', { container: 'cpu-test' }), 0.5, 'a restarted container’s count isn’t a negative');
  assert.equal(perf.gaugeValue('container_memory_limit_bytes', { container: 'cpu-test' }), 1000);
});

test('one report a moment after another isn’t enough to tell its CPU', (t) => {
  let now = 1_000_000;
  t.mock.method(performance, 'now', () => now);
  containerSeen('quick', { memoryBytes: 5, memoryLimitBytes: null, cpuSeconds: 10 });
  now += 10;
  containerSeen('quick', { memoryBytes: 5, memoryLimitBytes: null, cpuSeconds: 10.1 });
  assert.equal(perf.gaugeValue('container_cpu_cores', { container: 'quick' }), undefined);
});

test('asks the voice, music and loop containers how they are, and marks one that doesn’t answer as down', async (t) => {
  const saved = { ...config };
  t.after(() => Object.assign(config, saved));
  Object.assign(config, { voiceUrl: 'http://voice.test', musicUrl: 'http://music.test', musicToken: 'm', loopBotUrl: null, apiToken: 'a' });
  const asked: [string, string | undefined][] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    asked.push([url, (init.headers as Record<string, string>).authorization]);
    if (url.startsWith('http://music')) throw new TypeError('fetch failed');
    return Response.json({ memoryBytes: 2e8, memoryLimitBytes: 2e9, cpuSeconds: 3, modelsLoaded: 2 });
  });
  await poll();
  assert.deepEqual(asked.sort(), [
    ['http://music.test/stats', 'Bearer m'],
    ['http://voice.test/stats', undefined],
  ]);
  assert.equal(perf.gaugeValue('container_up', { container: 'voice' }), 1);
  assert.equal(perf.gaugeValue('container_memory_bytes', { container: 'voice' }), 2e8);
  assert.equal(perf.gaugeValue('voice_models_loaded'), 2);
  assert.equal(perf.gaugeValue('container_up', { container: 'music' }), 0);
  assert.equal(perf.gaugeValue('container_up', { container: 'loop' }), undefined, 'one that isn’t set up isn’t asked');
  assert.equal(perf.gaugeValue('container_up', { container: 'web' }), 0, 'a web UI that never reported is down');
});

test('the web UI’s report counts its answers, and one that isn’t a report is refused', () => {
  assert.equal(webReport({ memoryBytes: 'lots' }), false);
  assert.equal(webReport(null), false);
  assert.equal(webReport({ memoryBytes: 1e7, memoryLimitBytes: null, cpuSeconds: 1, requests: { '2xx': 40, '5xx': 2, evil: 9, '4xx': -3 }, botUnreachable: 1 }), true);
  assert.equal(perf.gaugeValue('container_memory_bytes', { container: 'web' }), 1e7);
  assert.equal(line('slopkeeper_web_requests_total{status="2xx"}'), 'slopkeeper_web_requests_total{status="2xx"} 40');
  assert.equal(line('slopkeeper_web_requests_total{status="5xx"}'), 'slopkeeper_web_requests_total{status="5xx"} 2');
  assert.doesNotMatch(perf.prometheus(), /evil|4xx/);
  assert.equal(line('slopkeeper_web_bot_unreachable_total'), 'slopkeeper_web_bot_unreachable_total 1');
});

test('samples the gateway, voice, event loop and memory', () => {
  sample({ ws: { status: Status.Ready, ping: 42 } } as never);
  assert.equal(perf.gaugeValue('discord_connected'), 1);
  assert.equal(perf.gaugeValue('discord_gateway_ping_seconds'), 0.042);
  assert.equal(perf.gaugeValue('voice_connections'), 0);
  assert.ok(perf.gaugeValue('heap_used_bytes')! > 0);
  assert.ok(perf.gaugeValue('container_memory_bytes', { container: 'bot' })! > 0);
  sample({ ws: { status: Status.Reconnecting, ping: -1 } } as never);
  assert.equal(perf.gaugeValue('discord_connected'), 0);
  assert.equal(perf.gaugeValue('discord_gateway_ping_seconds'), 0.042, 'an unknown ping leaves the last one');
});

/** Enough of a slash command for the timer */
function command(reply: () => Promise<unknown>) {
  return {
    guildId: 'g1',
    commandName: 'music',
    options: { getSubcommandGroup: () => null, getSubcommand: () => 'play' },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    reply,
    followUp: async () => 'followed',
  } as never as import('discord.js').ChatInputCommandInteraction & { reply: () => Promise<unknown>; followUp: () => Promise<unknown> };
}

test('times a command’s first answer, and counts how it went', async () => {
  perf.keep(true);
  const i = command(async () => (await sleep(20), 'sent'));
  const handled = timeInteraction(i);
  assert.equal(await i.reply(), 'sent', 'the answer still goes as it would');
  await i.followUp();
  handled(false);
  // Counted once the answer has settled
  await sleep(1);
  assert.equal(line('slopkeeper_discord_interaction_answer_seconds_count'), 'slopkeeper_discord_interaction_answer_seconds_count{kind="command",name="/music play"} 1');
  assert.equal(line('slopkeeper_discord_interactions_total'), 'slopkeeper_discord_interactions_total{kind="command",name="/music play",outcome="ok"} 1');
  assert.deepEqual(perf.take(true).slow, []);

  // Too late: Discord no longer knows the interaction
  const late = command(async () => {
    throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
  });
  const lateHandled = timeInteraction(late);
  await assert.rejects(late.reply());
  lateHandled(true);
  await sleep(1);
  assert.match(perf.prometheus(), /^slopkeeper_discord_interactions_total\{kind="command",name="\/music play",outcome="expired"\} 1$/m);

  const broken = command(async () => 'sent');
  const brokenHandled = timeInteraction(broken);
  brokenHandled(true);
  await sleep(1);
  assert.match(perf.prometheus(), /outcome="failed"\} 1$/m);

  // A handler that doesn't wait for its answer is counted once Discord has said no
  const unwaited = command(async () => {
    await sleep(20);
    throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
  });
  const unwaitedHandled = timeInteraction(unwaited);
  void unwaited.reply().catch(() => {});
  unwaitedHandled(false);
  await sleep(40);
  assert.match(perf.prometheus(), /outcome="expired"\} 2$/m);
  assert.doesNotMatch(perf.prometheus(), /outcome="ok"\} 2$/m);
});

test('a command that takes 2 seconds or more to answer is kept for a look', async (t) => {
  perf.keep(true);
  const i = command(async () => 'sent');
  const handled = timeInteraction(i);
  // Discord takes the answer two and a half seconds later, as the clock sees it
  const real = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => real() + 2500);
  await i.reply();
  handled(false);
  const { slow } = perf.take(true);
  assert.deepEqual(slow.map((s) => [s.guildId, s.what, s.detail]), [['g1', '/music play', { kind: 'command' }]]);
});
