import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getKv, setKv } from '../src/db.ts';
import { due, every, once, stopTimers, WEEKLY } from '../src/schedule.ts';
import { setSetting } from '../src/settings.ts';

const MINUTE = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a repeating job never runs twice at once, and a stuck one is overtaken after 10 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const errors = t.mock.method(console, 'error', () => {});
  let started = 0;
  let finish = () => {};
  const job = every('Slow job', MINUTE, () => {
    started++;
    return new Promise<void>((resolve) => (finish = resolve));
  });
  t.after(() => job.stop());
  t.mock.timers.tick(MINUTE);
  t.mock.timers.tick(MINUTE);
  t.mock.timers.tick(MINUTE);
  assert.equal(started, 1, 'the later ticks skip while it runs');
  finish();
  await flush();
  t.mock.timers.tick(MINUTE);
  assert.equal(started, 2, 'and the next goes once it’s done');
  t.mock.timers.tick(10 * MINUTE);
  assert.equal(started, 3);
  assert.match(String(errors.mock.calls[0].arguments[0]), /Slow job: the last run never finished/);
});

test('a job that fails is logged under its name and runs again next time', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const errors = t.mock.method(console, 'error', () => {});
  let runs = 0;
  const job = every('Failing job', MINUTE, () => {
    runs++;
    throw new Error('nope');
  });
  t.after(() => job.stop());
  t.mock.timers.tick(MINUTE);
  await flush();
  t.mock.timers.tick(MINUTE);
  await flush();
  assert.equal(runs, 2);
  assert.equal(errors.mock.calls[0].arguments[0], 'Failing job failed:');
});

test('a job can wait before its first run or run at once, and stops', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const runs: string[] = [];
  const later = every('Later', 10 * MINUTE, () => void runs.push('later'), { first: MINUTE });
  every('Now', 10 * MINUTE, () => void runs.push('now'), { now: true });
  assert.deepEqual(runs, ['now']);
  t.mock.timers.tick(MINUTE);
  assert.deepEqual(runs, ['now', 'later']);
  t.mock.timers.tick(10 * MINUTE);
  assert.deepEqual(runs, ['now', 'later', 'now', 'later']);
  later.stop();
  t.mock.timers.tick(10 * MINUTE);
  assert.deepEqual(runs, ['now', 'later', 'now', 'later', 'now']);
  stopTimers();
  t.mock.timers.tick(10 * MINUTE);
  assert.equal(runs.length, 5, 'nothing runs once the bot is exiting');
});

const at = (iso: string) => Date.parse(iso);

test('a day’s post is due from its hour, in the server’s time zone', () => {
  setSetting('tz', 'timezone', 'America/Chicago');
  assert.equal(due('tz', 'day', 18, { now: at('2026-11-16T23:59:00Z') }), null, '17:59 in Chicago');
  assert.deepEqual(due('tz', 'day', 18, { now: at('2026-11-17T00:00:00Z') }), { period: '2026-11-16', at: at('2026-11-17T00:00:00Z') });
  assert.equal(due('tz', 'day', 18, { now: at('2026-11-17T06:00:00Z') }), null, 'midnight there starts the next day');
  assert.equal(due('tz', 'day', 18, { now: at('2026-11-18T00:30:00Z') })!.period, '2026-11-17');
});

test('a week’s post is due from its day’s hour until the next, so a missed one still goes out', () => {
  setSetting('tz', 'timezone', 'America/Chicago');
  // Mondays at 20:00. 2026-11-16 is a Monday
  const week = (iso: string) => due('tz', 'week', 20, { weekday: 1, now: at(iso) });
  assert.deepEqual(week('2026-11-17T02:00:00Z'), { period: '2026-11-16', at: at('2026-11-17T02:00:00Z') }, 'Monday 20:00');
  assert.equal(week('2026-11-17T01:59:00Z')!.period, '2026-11-9', 'before the hour, it’s still last week');
  assert.equal(week('2026-11-20T18:00:00Z')!.period, '2026-11-16', 'Friday');
  assert.equal(week('2026-11-24T01:00:00Z')!.period, '2026-11-16', 'next Monday before the hour');
});

test('a week across a clock change keeps its day and hour', () => {
  setSetting('tz', 'timezone', 'America/Chicago');
  // Clocks went forward on Sunday 2027-03-14; Monday 00:30 is 23 hours after Sunday 00:30
  assert.deepEqual(due('tz', 'week', 20, { weekday: 0, now: at('2027-03-15T05:30:00Z') }), { period: '2027-3-14', at: at('2027-03-15T01:00:00Z') });
  // And back on Sunday 2026-11-01
  assert.deepEqual(due('tz', 'week', 20, { weekday: 0, now: at('2026-11-02T06:30:00Z') }), { period: '2026-11-1', at: at('2026-11-02T02:00:00Z') });
});

test('a month’s post is due from the 1st at its hour', () => {
  setSetting('tz', 'timezone', 'America/Chicago');
  assert.equal(due('tz', 'month', 20, { now: at('2026-12-02T01:59:00Z') }), null, 'the 1st before 20:00');
  assert.deepEqual(due('tz', 'month', 20, { now: at('2026-12-02T02:00:00Z') }), { period: '2026-12', at: at('2026-12-02T02:00:00Z') });
  assert.equal(due('tz', 'month', 20, { now: at('2026-12-20T12:00:00Z') })!.period, '2026-12');
});

test('a post is marked once it’s made, and not when it fails or asks to wait', async () => {
  const when = { period: 'p1', at: 0 };
  let calls = 0;
  await once('once-test', null, async () => void calls++);
  assert.equal(calls, 0, 'nothing before it’s due');
  await once('once-test', when, async () => (calls++, false));
  assert.equal(getKv('once-test'), undefined);
  await assert.rejects(once('once-test', when, async () => {
    calls++;
    throw new Error('Missing Permissions');
  }));
  assert.equal(getKv('once-test'), undefined);
  await once('once-test', when, async () => void calls++);
  await once('once-test', when, async () => void calls++);
  assert.equal(calls, 3, 'the last finds it done');
  assert.equal(getKv('once-test'), 'p1');
  setKv('once-test', '');
});

test('a weekly post catches up within a day, and never comes twice in six days', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at('2026-11-17T12:00:00Z') });
  const made: string[] = [];
  const post = (label: string) => async () => void made.push(label);
  // Due Monday 2026-11-16 20:00 Chicago, 10 hours ago: it goes out
  await once('weekly-test', { period: '2026-11-16', at: at('2026-11-17T02:00:00Z') }, post('late'), WEEKLY);
  // The post day moved to Tuesday: today's would come a day after the last one, so it's taken as made
  await once('weekly-test', { period: '2026-11-17', at: at('2026-11-17T02:00:00Z') }, post('moved'), WEEKLY);
  assert.equal(getKv('weekly-test'), '2026-11-17');
  // A week due 3 days ago, as for a server that just turned it on: too late, and marked so it isn't asked again
  await once('weekly-test-2', { period: '2026-11-14', at: at('2026-11-14T12:00:00Z') }, post('too late'), WEEKLY);
  assert.equal(getKv('weekly-test-2'), '2026-11-14');
  // A week later, as usual
  await once('weekly-test', { period: '2026-11-24', at: at('2026-11-17T11:00:00Z') }, post('next week'), WEEKLY);
  assert.deepEqual(made, ['late', 'next week']);
});

test('a stuck run is overtaken sooner when a job says so', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  t.mock.method(console, 'error', () => {});
  let started = 0;
  const job = every('Votes', 5_000, () => (started++, new Promise(() => {})), { stuck: 60_000 });
  t.after(() => job.stop());
  // Step by step, so each tick sees its own time
  const wait = (ms: number) => {
    for (let i = 0; i < ms; i += 5_000) t.mock.timers.tick(5_000);
  };
  wait(60_000);
  assert.equal(started, 1, 'a minute after it started, it’s still waited on');
  wait(5_000);
  assert.equal(started, 2);
});
