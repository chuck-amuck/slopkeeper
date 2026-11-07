import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { db, getKv } from '../src/db.ts';
import { achievementProgress, achievements } from '../src/features/achievements.ts';
import { maybePostPatches, playedApps } from '../src/features/patchnotes.ts';
import { setSetting } from '../src/settings.ts';
import { fakeClient } from './helpers.ts';

const DAY = 86_400_000;
const NO_KEY = config.steamApiKey;
const now = Date.now();

function useKey(t: TestContext) {
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = NO_KEY));
}

const played = (guildId: string, game: string, daysAgo = 1) =>
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'u', ?, 'v', ?, ?)`).run(guildId, game, now - daysAgo * DAY - 3_600_000, now - daysAgo * DAY);
const named = (appid: number, name: string) => db.prepare('INSERT OR REPLACE INTO app_info (appid, name, multiplayer) VALUES (?, ?, 1)').run(appid, name);
const note = (gid: string, daysAgo = 1, title = `Patch ${gid}`) => ({ gid, title, url: `https://steam.test/${gid}`, date: Math.floor((now - daysAgo * DAY) / 1000), contents: '[h1]Fixes[/h1] {STEAM_CLAN_IMAGE}/a.png  Fixed   the [b]thing[/b]' });

let news: Record<number, unknown[]> = {};
function fakeNews(t: TestContext) {
  return t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.searchParams.get('tags'), 'patchnotes');
    return new Response(JSON.stringify({ appnews: { newsitems: news[Number(url.searchParams.get('appid'))] ?? [] } }));
  });
}

/** A server that records what's posted, and in which channel */
function server(id: string) {
  setSetting(id, 'announceChannel', `channel-${id}`);
  const sent: { embeds: { toJSON(): { title: string; url?: string; description?: string } }[] }[] = [];
  const guild = { id, name: id, channels: { cache: new Map() } };
  const client = fakeClient([guild], async (_guild, message) => sent.push(message as never));
  return { client, sent, titles: () => sent.map((m) => m.embeds[0].toJSON().title) };
}

/** A new app id each time, as what Steam said is remembered for a while */
let nextApp = 1000;
function game(guildId: string, name: string, notes: unknown[]) {
  const appid = nextApp++;
  named(appid, name);
  played(guildId, name);
  news[appid] = notes;
  return appid;
}

beforeEach(() => {
  news = {};
  db.exec('DELETE FROM patch_posts; DELETE FROM game_plays; DELETE FROM guild_settings; DELETE FROM app_info; DELETE FROM games; DELETE FROM kv;');
});

test('only games played here lately count, whatever they’re called', () => {
  named(1, 'Deep Rock Galactic');
  named(2, 'Old Game');
  named(3, 'Never Played');
  db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES ('p', 'Valheim', 4, 'u')`).run();
  played('p', 'deep rock galactic');
  played('p', 'Valheim');
  played('p', 'Old Game', 40);
  played('elsewhere', 'Never Played');
  played('p', 'Not On Steam');
  assert.deepEqual([...playedApps('p').keys()].sort(), [1, 4]);
});

test('off asks Steam nothing and posts nothing', async (t) => {
  const fetcher = fakeNews(t);
  const { client, sent } = server('off');
  game('off', 'Valheim', [note('a')]);
  await maybePostPatches(client);
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(sent.length, 0);
});

test('turning it on posts nothing old, then each new one once', async (t) => {
  fakeNews(t);
  const { client, sent, titles } = server('each');
  setSetting('each', 'patchNotes', 'each');
  const appid = game('each', 'Valheim', [note('a'), note('b', 2)]);
  await maybePostPatches(client);
  assert.equal(sent.length, 0);

  db.prepare(`INSERT INTO patch_posts (guild_id, gid, appid, game, title, url, date, text, posted) VALUES ('each', 'c', ?, 'Valheim', 'New one', 'https://steam.test/c', ?, 'Fixed it', 0)`).run(appid, now);
  await maybePostPatches(client);
  await maybePostPatches(client);
  assert.deepEqual(titles(), ['🩹 Valheim: New one']);
  assert.equal(sent[0].embeds[0].toJSON().description, 'Fixed it');
  assert.equal('allowedMentions' in sent[0], false);
});

test('a post from the next check is noticed, and Steam’s markup is cleaned up', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  fakeNews(t);
  const { client, sent } = server('later');
  setSetting('later', 'patchNotes', 'each');
  const appid = game('later', 'Valheim', [note('a')]);
  await maybePostPatches(client);
  news[appid] = [note('b', 0), note('a')];
  t.mock.timers.tick(21 * 60_000);
  await maybePostPatches(client);
  assert.equal(sent.length, 1);
  const { title, url, description } = sent[0].embeds[0].toJSON();
  assert.deepEqual([title, url, description], ['🩹 Valheim: Patch b', 'https://steam.test/b', 'Fixes Fixed the thing']);
});

test('a new post from weeks ago isn’t news', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  fakeNews(t);
  const { client, sent } = server('stale');
  setSetting('stale', 'patchNotes', 'each');
  const appid = game('stale', 'Valheim', [note('a')]);
  await maybePostPatches(client);
  news[appid] = [note('old', 30), note('a')];
  t.mock.timers.tick(21 * 60_000);
  await maybePostPatches(client);
  assert.equal(sent.length, 0);
});

test('goes to its own channel if one’s set, or else the announce channel', async (t) => {
  fakeNews(t);
  const appid = game('chan', 'Valheim', [note('a')]);
  const posted: string[] = [];
  setSetting('chan', 'announceChannel', 'channel-chan');
  setSetting('chan', 'patchNotes', 'each');
  setSetting('chan', 'patchNotesChannel', 'patches');
  const send = (name: string) => async (id: string) => (id === name ? { isSendable: () => true, send: async () => posted.push(id) } : null);
  const client = (name: string) => ({ guilds: { cache: new Map([['chan', { id: 'chan', name: 'chan' }]]) }, channels: { fetch: send(name) } }) as never;
  const quiet = t.mock.method(console, 'error', () => {});
  await maybePostPatches(client('patches'));
  const pending = `INSERT INTO patch_posts (guild_id, gid, appid, game, title, url, date, text, posted) VALUES ('chan', ?, ${appid}, 'Valheim', 'x', 'https://steam.test/x', 1, '', 0)`;
  db.prepare(pending).run('p1');
  await maybePostPatches(client('patches'));
  assert.deepEqual(posted, ['patches']);
  db.prepare(pending).run('p2');
  await maybePostPatches(client('channel-chan'));
  assert.deepEqual(posted, ['patches', 'channel-chan'], 'a channel that’s gone falls back');
  assert.equal(quiet.mock.callCount(), 1);
});

test('a post that fails is tried again', async (t) => {
  fakeNews(t);
  game('retry', 'Valheim', [note('a')]);
  setSetting('retry', 'announceChannel', 'channel-retry');
  setSetting('retry', 'patchNotes', 'each');
  let works = false;
  let sent = 0;
  const guild = { id: 'retry', name: 'retry' };
  const client = fakeClient([guild], async () => {
    if (!works) throw new Error('nope');
    sent++;
  });
  await maybePostPatches(client);
  db.prepare(`INSERT INTO patch_posts (guild_id, gid, appid, game, title, url, date, text, posted) VALUES ('retry', 'p', 1, 'Valheim', 'x', 'https://steam.test/x', 1, '', 0)`).run();
  t.mock.method(console, 'error', () => {});
  await maybePostPatches(client);
  works = true;
  await maybePostPatches(client);
  await maybePostPatches(client);
  assert.equal(sent, 1);
});

function digestDay(id: string, hour: number) {
  const date = new Date(now);
  setSetting(id, 'timezone', 'UTC');
  setSetting(id, 'weeklyPostDay', date.getUTCDay());
  setSetting(id, 'weeklyPostHour', hour);
}

const pendingNote = (id: string, gid: string, game: string) =>
  db.prepare(`INSERT INTO patch_posts (guild_id, gid, appid, game, title, url, date, text, posted) VALUES (?, ?, 1, ?, ?, ?, ?, '', 0)`).run(id, gid, game, `Fix [${gid}]`, `https://steam.test/${gid}`, now);

test('a digest waits for its day, then posts everything together once', async (t) => {
  fakeNews(t);
  const { client, sent } = server('digest');
  setSetting('digest', 'patchNotes', 'digest');
  digestDay('digest', 25);
  pendingNote('digest', 'a', 'Valheim');
  pendingNote('digest', 'b', 'Hades');
  await maybePostPatches(client);
  assert.equal(sent.length, 0, 'not the hour yet');

  digestDay('digest', 0);
  await maybePostPatches(client);
  assert.equal(sent.length, 1);
  const { title, description } = sent[0].embeds[0].toJSON();
  assert.equal(title, '🩹 Patch notes this week');
  assert.match(description!, /\*\*Valheim\*\*: \[Fix a\]\(https:\/\/steam\.test\/a\)/);
  assert.match(description!, /\*\*Hades\*\*: \[Fix b\]/);
  assert.ok(getKv('patch_digest:digest'));

  pendingNote('digest', 'c', 'Hades');
  await maybePostPatches(client);
  assert.equal(sent.length, 1, 'one a day');
  const left = db.prepare(`SELECT gid FROM patch_posts WHERE guild_id = 'digest' AND posted = 0`).all() as { gid: string }[];
  assert.deepEqual(left.map((p) => p.gid), ['c'], 'what went out isn’t in next week’s');
});

// Achievements. Steam, with { apps: { appid: schema }, players: { steam id: achievements or an error status } }
function fakeAchievements(t: TestContext, schema: unknown[], players: Record<string, string[] | number>, percents: Record<string, string> = {}) {
  return t.mock.method(globalThis, 'fetch', async (url: URL) => {
    if (url.pathname.includes('GetSchemaForGame')) return new Response(JSON.stringify({ game: { availableGameStats: { achievements: schema } } }));
    if (url.pathname.includes('GetGlobalAchievement')) return new Response(JSON.stringify({ achievementpercentages: { achievements: Object.entries(percents).map(([name, percent]) => ({ name, percent })) } }));
    const has = players[url.searchParams.get('steamid')!];
    if (typeof has === 'number') return new Response('', { status: has });
    return new Response(JSON.stringify({ playerstats: { achievements: [...schema.map((a) => (a as { name: string }).name)].map((apiname) => ({ apiname, achieved: has.includes(apiname) ? 1 : 0 })) } }));
  });
}

const link = (user: string) => db.prepare('INSERT OR IGNORE INTO steam_links (user_id, steam_id) VALUES (?, ?)').run(user, `s-${user}`);
const SCHEMA = [
  { name: 'A', displayName: 'Rare', description: 'Hard', hidden: 0 },
  { name: 'B', displayName: 'Common', description: 'Easy', hidden: 0 },
  { name: 'C', displayName: 'Secret', hidden: 1 },
  { name: 'D', displayName: 'Done', hidden: 0 },
];

test('shows progress, and goals nobody has, easiest first', async (t) => {
  useKey(t);
  for (const id of ['a1', 'a2']) link(id);
  fakeAchievements(t, SCHEMA, { 's-a1': ['D', 'C'], 's-a2': [] }, { A: '4.2', B: '92.2', C: '1', D: '50' });
  const progress = await achievementProgress(nextApp++, ['a1', 'a2']);
  assert.equal(progress.total, 4);
  assert.deepEqual(progress.people, [{ id: 'a1', done: 2 }, { id: 'a2', done: 0 }]);
  assert.deepEqual(progress.goals, [{ name: 'Common', description: 'Easy', percent: 92 }, { name: 'Rare', description: 'Hard', percent: 4 }]);
  assert.deepEqual(progress.skipped, []);
});

test('a goal isn’t one if anyone has it, and hidden ones aren’t named', async (t) => {
  useKey(t);
  for (const id of ['b1', 'b2']) link(id);
  fakeAchievements(t, SCHEMA, { 's-b1': ['A'], 's-b2': ['B'] });
  const { goals } = await achievementProgress(nextApp++, ['b1', 'b2']);
  assert.deepEqual(goals.map((g) => g.name), ['Done']);
});

test('skips private profiles, those who don’t have it, and the unlinked', async (t) => {
  useKey(t);
  for (const id of ['c1', 'c2', 'c3']) link(id);
  fakeAchievements(t, SCHEMA, { 's-c1': ['A'], 's-c2': 403, 's-c3': 400 });
  const { people, skipped } = await achievementProgress(nextApp++, ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(people.map((p) => p.id), ['c1']);
  assert.deepEqual(skipped, ['c2', 'c3', 'c4']);
});

test('no goals if nobody can be read', async (t) => {
  useKey(t);
  fakeAchievements(t, SCHEMA, {});
  assert.deepEqual((await achievementProgress(nextApp++, ['nobody'])).goals, []);
});

test('Steam being down isn’t taken for a private profile', async (t) => {
  useKey(t);
  link('d1');
  fakeAchievements(t, SCHEMA, { 's-d1': 503 });
  await assert.rejects(achievementProgress(nextApp++, ['d1']), /HTTP 503/);
});

test('a game with no achievements has none, rather than failing', async (t) => {
  useKey(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 400 }));
  t.mock.method(console, 'error', () => {});
  const { total, goals } = await achievementProgress(nextApp++, ['nobody']);
  assert.deepEqual([total, goals], [0, []]);
});

async function runAchievements(t: TestContext, game: string, options: { other?: { id: string; bot?: boolean }; voice?: string[] } = {}) {
  useKey(t);
  db.prepare(`INSERT OR IGNORE INTO games (guild_id, name, steam_appid, added_by) VALUES ('cmd', 'Valheim', 892970, 'u')`).run();
  const members = new Map((options.voice ?? []).map((id) => [id, { id, user: { bot: false } }]));
  let reply: { content?: string; flags?: number; embeds?: { toJSON(): { title: string; description: string; fields?: { name: string; value: string }[] } }[] } | string | undefined;
  await achievements.commands![0].run({
    inCachedGuild: () => true,
    user: { id: 'me' },
    guild: { id: 'cmd', members: { cache: new Map() } },
    member: { voice: { channel: options.voice ? { members } : null } },
    options: { getString: () => game, getUser: () => options.other ?? null },
    reply: async (r: typeof reply) => (reply = r),
    deferReply: async () => {},
    editReply: async (r: typeof reply) => (reply = r),
  } as never);
  return reply as Exclude<typeof reply, string | undefined>;
}

test('/achievements covers your voice channel, or who you pick', async (t) => {
  for (const id of ['me', 'friend', 'e1']) link(id);
  fakeAchievements(t, SCHEMA, { 's-me': ['A'], 's-friend': [], 's-e1': ['B', 'D'] }, { B: '50' });
  const voice = (await runAchievements(t, 'Valheim', { voice: ['friend', 'e1'] })).embeds![0].toJSON();
  assert.equal(voice.title, '🏆 Valheim · 4 achievements');
  assert.equal(voice.description, '<@e1> · 2 of 4\n<@friend> · 0 of 4');
  assert.equal(voice.fields![0].name, 'Goals: nobody here has these');
  const picked = (await runAchievements(t, '892970', { other: { id: 'friend' }, voice: ['e1'] })).embeds![0].toJSON();
  assert.equal(picked.description, '<@me> · 1 of 4\n<@friend> · 0 of 4');
  const alone = (await runAchievements(t, 'valheim')).embeds![0].toJSON();
  assert.equal(alone.description, '<@me> · 1 of 4');
  assert.equal(alone.fields![0].name, 'Next goals');
});

test('/achievements refuses a bot, or a game it doesn’t know', async (t) => {
  assert.equal((await runAchievements(t, 'Valheim', { other: { id: 'b', bot: true } })).content, 'Bots don’t have achievements.');
  assert.equal((await runAchievements(t, 'Nope')).content, 'Pick a game from the list.');
});
