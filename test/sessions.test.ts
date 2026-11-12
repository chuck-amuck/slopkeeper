import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db, getKv } from '../src/db.ts';
import { carryOn, join, leave, maybePostWeekly, resync, sessions } from '../src/features/sessions.ts';
import { setSetting } from '../src/settings.ts';
import { zonedParts } from '../src/util.ts';

test('a weekly post that fails is tried again, and doesn’t hold up other servers', async () => {
  mock.method(console, 'error', () => {});
  const now = zonedParts(Date.now(), 'America/Chicago');
  for (const id of ['a', 'b']) {
    setSetting(id, 'announceChannel', `channel-${id}`);
    setSetting(id, 'timezone', 'America/Chicago');
    setSetting(id, 'weeklyPostDay', now.weekday);
    setSetting(id, 'weeklyPostHour', 0);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, 'voice', ?, ?)`)
      .run(id, Date.now() - 7_200_000, Date.now() - 3_600_000);
    db.prepare(`INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, 'u', 3600)`).run(lastInsertRowid);
  }

  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], async (guildId) => {
    if (guildId === 'a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await maybePostWeekly(client);
  assert.deepEqual(sent, ['b']);
  assert.equal(getKv('weekly_post:a'), undefined);
  aWorks = true;
  await maybePostWeekly(client);
  await maybePostWeekly(client);
  assert.deepEqual(sent, ['b', 'a'], 'each server gets one post');
});

test('a server that turned the weekly leaderboard off gets no post', async () => {
  const now = zonedParts(Date.now(), 'America/Chicago');
  setSetting('quiet', 'announceChannel', 'channel-quiet');
  setSetting('quiet', 'timezone', 'America/Chicago');
  setSetting('quiet', 'weeklyPostDay', now.weekday);
  setSetting('quiet', 'weeklyPostHour', 0);
  setSetting('quiet', 'weeklyLeaderboard', false);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES ('quiet', 'voice', ?, ?)`)
    .run(Date.now() - 7_200_000, Date.now() - 3_600_000);
  db.prepare(`INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, 'u', 3600)`).run(lastInsertRowid);

  const sent: string[] = [];
  const client = fakeClient([{ id: 'quiet', name: 'Quiet' }], async (guildId) => {
    sent.push(guildId);
  });
  await maybePostWeekly(client);
  assert.deepEqual(sent, []);
  setSetting('quiet', 'weeklyLeaderboard', true);
  await maybePostWeekly(client);
  assert.deepEqual(sent, ['quiet'], 'it posts again once it’s back on');
});

const voice = (guildId: string, id: string) => ({ id, guild: { id: guildId, afkChannelId: null } }) as never;
const person = (id: string) => ({ id, presence: null }) as never;
const seconds = (guildId: string) =>
  db
    .prepare('SELECT m.user_id AS user, m.seconds AS secs FROM session_members m JOIN sessions s ON s.id = m.session_id WHERE s.guild_id = ? ORDER BY m.user_id')
    .all(guildId) as { user: string; secs: number }[];

test('a session is recapped when it ends, unless the server turned recaps off, and is counted either way', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts: string[] = [];
  const client = fakeClient(
    [
      { id: 'with-recaps', name: 'With recaps' },
      { id: 'no-recaps', name: 'No recaps' },
    ],
    async (guildId) => posts.push(guildId),
  );
  setSetting('no-recaps', 'sessionRecap', false);
  for (const guildId of ['with-recaps', 'no-recaps']) {
    setSetting(guildId, 'announceChannel', `channel-${guildId}`);
    const started = Date.now() - 3_600_000;
    join(voice(guildId, `v-${guildId}`), person('a'), started);
    join(voice(guildId, `v-${guildId}`), person('b'), started);
    leave(client, `v-${guildId}`, 'a', Date.now());
    leave(client, `v-${guildId}`, 'b', Date.now());
  }
  t.mock.timers.tick(5 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts, ['with-recaps']);
  assert.deepEqual(seconds('no-recaps').map((r) => r.user), ['a', 'b'], 'still counted in stats');
});

test('a session still going when the bot stops is saved', () => {
  const started = Date.now() - 3_600_000;
  join(voice('stop', 'v1'), person('a'), started);
  join(voice('stop', 'v1'), person('b'), started + 1_800_000);
  sessions.shutdown!();
  const saved = seconds('stop');
  assert.deepEqual(saved.map((r) => r.user), ['a', 'b']);
  assert.ok(Math.abs(saved[0].secs - 3600) < 5);
  assert.ok(Math.abs(saved[1].secs - 1800) < 5);
});

test('someone alone in voice when the bot stops is saved', () => {
  join(voice('solo', 'v9'), person('a'), Date.now() - 3_600_000);
  sessions.shutdown!();
  assert.deepEqual(seconds('solo').map((r) => r.user), ['a']);
});

test('a short session isn’t saved when the bot stops', () => {
  join(voice('brief', 'v2'), person('a'), Date.now() - 60_000);
  join(voice('brief', 'v2'), person('b'), Date.now() - 60_000);
  sessions.shutdown!();
  assert.deepEqual(seconds('brief'), []);
});

test('after a long disconnect, people who left stop gaining time and people who joined are picked up', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const started = Date.now() - 3_600_000;
  join(voice('gap', 'v3'), person('left'), started);
  join(voice('gap', 'v3'), person('stayed'), started);

  const members = new Map([
    ['stayed', { id: 'stayed', user: { bot: false }, presence: null }],
    ['joined', { id: 'joined', user: { bot: false }, presence: null }],
  ]);
  const channel = { id: 'v3', guild: { id: 'gap', afkChannelId: null }, isVoiceBased: () => true, members };
  const guild = { id: 'gap', name: 'Gap', channels: { cache: new Map([['v3', channel]]) } };
  const client = { guilds: { cache: new Map([['gap', guild]]) }, channels: { cache: new Map([['v3', channel]]) } } as never;
  resync(client);
  t.mock.timers.tick(60_000);
  sessions.shutdown!();
  assert.deepEqual(seconds('gap').map((r) => [r.user, r.secs]), [
    ['joined', 60],
    ['left', 3600],
    ['stayed', 3660],
  ]);
});

/** A server whose voice channel has these people in it, for picking up after a restart */
function restarted(guildId: string, channelId: string, here: string[], posts: string[] = []) {
  const members = new Map(here.map((id) => [id, { id, user: { bot: false }, presence: null }]));
  const channel = { id: channelId, guild: { id: guildId, afkChannelId: null }, isVoiceBased: () => true, members };
  setSetting(guildId, 'announceChannel', `channel-${guildId}`);
  return fakeClient([{ id: guildId, name: guildId, channels: { cache: new Map([[channelId, channel]]) } } as never], async (id) => void posts.push(id));
}

test('a session carries on over a restart, counting the time in between, and is recapped once it ends', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const started = Date.now() - 3_600_000;
  join(voice('restart', 'v4'), person('stayed'), started);
  join(voice('restart', 'v4'), person('left'), started);
  sessions.saveForRestart!();
  sessions.shutdown!();
  assert.deepEqual(seconds('restart'), [], 'kept for the restart rather than recorded as over');

  t.mock.timers.tick(120_000);
  const posts: string[] = [];
  const client = restarted('restart', 'v4', ['stayed', 'new'], posts);
  carryOn(client, Date.now());
  t.mock.timers.tick(60_000);
  for (const id of ['stayed', 'new']) leave(client, 'v4', id, Date.now());
  t.mock.timers.tick(5 * 60_000);
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posts, ['restart'], 'one recap for the whole night');
  assert.deepEqual(seconds('restart').map((r) => [r.user, r.secs]), [
    ['left', 3600],
    ['new', 60],
    ['stayed', 3780],
  ]);
  assert.equal(getKv('voiceSessions'), '');
});

test('an empty session kept over a restart ends after what’s left of its grace period', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const started = Date.now() - 3_600_000;
  join(voice('emptied', 'v5'), person('a'), started);
  join(voice('emptied', 'v5'), person('b'), started);
  const client = restarted('emptied', 'v5', []);
  for (const id of ['a', 'b']) leave(client, 'v5', id, Date.now());
  t.mock.timers.tick(60_000);
  sessions.saveForRestart!();
  sessions.shutdown!();
  t.mock.timers.tick(60_000);
  carryOn(client, Date.now());
  t.mock.timers.tick(2 * 60_000);
  assert.deepEqual(seconds('emptied'), [], 'still in its grace period');
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seconds('emptied').map((r) => [r.user, r.secs]), [
    ['a', 3600],
    ['b', 3600],
  ]);
});

test('sessions kept for a restart that came too late are recorded as they were when the bot stopped', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  join(voice('late', 'v6'), person('a'), Date.now() - 3_600_000);
  sessions.saveForRestart!();
  sessions.shutdown!();
  t.mock.timers.tick(30 * 60_000);
  carryOn(restarted('late', 'v6', ['a']), Date.now());
  assert.deepEqual(seconds('late').map((r) => [r.user, r.secs]), [['a', 3600]]);
  sessions.shutdown!();
  assert.equal(seconds('late').length, 1, 'not carried on as well');
});
