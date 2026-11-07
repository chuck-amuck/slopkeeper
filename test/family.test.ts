import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { candidatesFor, familyPlayersOf, games, sharedGames, type GameRow } from '../src/features/games.ts';
import { appInfo, currentPlayers, ensureAppInfo, familiesOf, familyOf, FAMILY_SIZE, joinFamily, leaveFamily, ownedSteamGames, refreshAll, steam } from '../src/features/steam.ts';

const GAME = 100;

const NO_KEY = config.steamApiKey;

function useKey(t: TestContext) {
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = NO_KEY));
}

const member = (id: string) => [id, { id }] as const;
const guild = { id: 'g', members: { cache: new Map(['a', 'b', 'c', 'd'].map(member)) } } as never;

const own = (user: string, appid = GAME, playtime = 60, recent = 0) => {
  db.prepare('INSERT OR IGNORE INTO steam_links (user_id, steam_id) VALUES (?, ?)').run(user, `s-${user}`);
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime, recent) VALUES (?, ?, 'Deep Rock', ?, ?)`).run(`s-${user}`, appid, playtime, recent);
};
const facts = (appid: number, shareable: number, extra: { coop?: number; pvp?: number; deck?: number } = {}) =>
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer, shareable, coop, pvp, deck, read_at) VALUES (?, 'Deep Rock', 1, ?, ?, ?, ?, ?)`).run(appid, shareable, extra.coop ?? 0, extra.pvp ?? 0, extra.deck ?? 0, Date.now());
const family = (...people: string[]) => {
  for (const id of people.slice(1)) assert.equal(joinFamily(id, people[0]), null);
};
const candidate = async (here: string[], appid = GAME) => (await candidatesFor(guild, here))?.candidates.find((c) => c.appid === appid);

beforeEach(() => {
  db.exec('DELETE FROM steam_links; DELETE FROM steam_owned; DELETE FROM steam_family; DELETE FROM app_info; DELETE FROM game_owners; DELETE FROM games;');
  facts(GAME, 1);
});

test('someone without a game plays it on a family member’s copy when the owner isn’t playing', async () => {
  own('a');
  own('b', 200);
  family('a', 'b');
  own('c');
  const c = await candidate(['b', 'c']);
  assert.deepEqual([c!.missing, c!.borrowed], [[], ['b']]);
});

test('a family with one copy can’t all play at once', async () => {
  own('a');
  family('a', 'b');
  const c = await candidate(['a', 'b']);
  assert.deepEqual([c!.missing, c!.borrowed], [['b'], []]);
});

test('each person needs a copy, so a second copy lets a second person in', async () => {
  own('a');
  own('b', 200);
  own('c', 200);
  family('a', 'b', 'c');
  const one = await candidate(['b', 'c']);
  assert.deepEqual([one!.missing, one!.borrowed], [['c'], ['b']]);
  own('d');
  family('a', 'd');
  const two = await candidate(['b', 'c']);
  assert.deepEqual([two!.missing, two!.borrowed], [[], ['b', 'c']]);
});

test('a family member marked as owning a game by hand is using a copy', async () => {
  own('a');
  own('b', 200);
  own('c', 200);
  family('a', 'b', 'c');
  const { lastInsertRowid } = db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES ('g', 'Deep Rock', ?, 'a')`).run(GAME);
  db.prepare(`INSERT INTO game_owners (game_id, user_id) VALUES (?, 'b')`).run(lastInsertRowid);
  const c = await candidate(['b', 'c']);
  assert.deepEqual([c!.missing, c!.borrowed], [['c'], []]);
});

test('more people on a game than copies leaves everyone else short', async () => {
  own('a');
  for (const id of ['b', 'c', 'd', 'e']) own(id, 200);
  family('a', 'b', 'c', 'd', 'e');
  const { lastInsertRowid } = db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES ('g', 'Deep Rock', ?, 'a')`).run(GAME);
  for (const id of ['b', 'c']) db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)').run(lastInsertRowid, id);
  const found = await candidatesFor(guild, ['b', 'c', 'd', 'e']);
  assert.equal(found!.candidates.find((c) => c.appid === GAME), undefined, 'two short is too many to list');
});

test('a game Steam doesn’t let families share doesn’t count', async () => {
  facts(GAME, 0);
  own('a');
  own('b', 200);
  own('c');
  family('a', 'b');
  assert.deepEqual((await candidate(['b', 'c']))!.missing, ['b']);
});

test('a family’s copy counts even if its owner isn’t in this server', async () => {
  own('outsider');
  own('a', 200);
  family('outsider', 'a');
  own('b');
  const c = await candidate(['a', 'b']);
  assert.deepEqual([c!.missing, c!.borrowed], [[], ['a']]);
});

test('a game nobody in the group owns can come from family outside it', async () => {
  own('d');
  own('a', 200);
  own('b', 200);
  family('d', 'a');
  assert.deepEqual((await candidate(['a', 'b']))!.missing, ['b']);
});

test('finds the name of a game only an absent family member owns', async () => {
  db.exec('DELETE FROM app_info');
  db.prepare(`INSERT INTO app_info (appid, name, multiplayer, shareable) VALUES (?, NULL, 1, 1)`).run(GAME);
  own('d');
  own('a', 200);
  family('d', 'a');
  assert.equal((await candidate(['a']))!.name, 'Deep Rock');
});

test('someone in a family counts without a Steam link of their own', async () => {
  own('a');
  own('c');
  family('a', 'b');
  const found = await candidatesFor(guild, ['b', 'c']);
  assert.deepEqual(found!.counted, ['b', 'c']);
  assert.deepEqual(found!.candidates.find((c) => c.appid === GAME)!.borrowed, ['b']);
});

test('nobody in a family changes nothing', async () => {
  own('a');
  own('b', 200);
  assert.deepEqual((await candidate(['a', 'b']))!.missing, ['b']);
});

test('adds up the last two weeks, and leaves out those who aren’t here', async () => {
  own('a', GAME, 500, 30);
  own('b', GAME, 500, 20);
  own('c', GAME, 500, 1000);
  assert.equal((await candidate(['a', 'b']))!.recent, 50);
});

test('comparing two people counts a copy one can borrow', () => {
  own('a');
  own('b', 200);
  family('a', 'd');
  assert.deepEqual(sharedGames('g', 'a', 'b'), []);
  own('c');
  family('c', 'b');
  assert.deepEqual(sharedGames('g', 'a', 'b').map((g) => g.name), ['Deep Rock']);
});

test('comparing two people in a family needs a copy for each', () => {
  own('a');
  family('a', 'b');
  assert.deepEqual(sharedGames('g', 'a', 'b'), []);
  own('c');
  family('a', 'c');
  assert.deepEqual(sharedGames('g', 'a', 'b').map((g) => g.name), ['Deep Rock']);
});

test('comparing two people needs a copy for both, not just one of them', () => {
  own('c');
  family('c', 'a', 'b');
  assert.deepEqual(sharedGames('g', 'a', 'b'), []);
});

test('comparing doesn’t borrow an unshareable game', () => {
  facts(GAME, 0);
  own('a');
  own('c');
  family('c', 'b');
  assert.deepEqual(sharedGames('g', 'a', 'b'), []);
});

test('the library shows who has a game through family, not its owners', () => {
  own('a');
  family('a', 'b');
  const game = { id: 1, name: 'Deep Rock', steam_appid: GAME, max_players: null } as GameRow;
  assert.deepEqual([...familyPlayersOf(game, guild, new Set(['a']))], ['b']);
  assert.deepEqual([...familyPlayersOf({ ...game, steam_appid: null }, guild, new Set())], []);
  facts(GAME, 0);
  assert.deepEqual([...familyPlayersOf(game, guild, new Set(['a']))], []);
});

test('a family is limited to six, and someone can move to another', () => {
  const people = Array.from({ length: FAMILY_SIZE }, (_, n) => `p${n}`);
  family(...people);
  assert.equal(familyOf('p0').length, FAMILY_SIZE);
  assert.equal(joinFamily('p6', 'p0'), 'A Steam family holds 6 people at most.');
  assert.deepEqual(familyOf('p6'), []);
  assert.equal(joinFamily('p0', 'p0'), 'Pick two different people.');
  assert.equal(joinFamily('p1', 'p0'), null);
  assert.equal(familyOf('p0').length, FAMILY_SIZE);

  family('x', 'y');
  assert.equal(joinFamily('p5', 'x'), null);
  assert.deepEqual(familyOf('x'), ['p5', 'x', 'y']);
  assert.equal(familyOf('p0').length, FAMILY_SIZE - 1);
});

test('joining a full family leaves someone where they were', () => {
  family(...Array.from({ length: FAMILY_SIZE }, (_, n) => `p${n}`));
  family('x', 'y');
  assert.match(joinFamily('x', 'p0')!, /at most/);
  assert.deepEqual(familyOf('x'), ['x', 'y']);
});

test('a family of one stops being a family', () => {
  family('a', 'b', 'c');
  assert.equal(leaveFamily('c'), true);
  assert.deepEqual(familyOf('a'), ['a', 'b']);
  assert.equal(leaveFamily('b'), true);
  assert.deepEqual(familyOf('a'), []);
  assert.equal(leaveFamily('a'), false);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM steam_family').get() as { n: number }).n, 0);
});

test('lists each family once', () => {
  family('a', 'b');
  family('c', 'd');
  assert.deepEqual(familiesOf(['a', 'b', 'c', 'z']), [['a', 'b'], ['c', 'd']]);
});

function fakeStore(t: TestContext, items: unknown[] = []) {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ response: { store_items: items } }));
  });
  return asked;
}

const item = (appid: number, supported: number[], feature: number[], deck = 0) => ({
  appid,
  success: 1,
  name: `Game ${appid}`,
  categories: { supported_player_categoryids: supported, feature_categoryids: feature },
  platforms: { steam_deck_compat_category: deck },
});

test('reads co-op, PvP, Steam Deck and family sharing from the store', async (t) => {
  fakeStore(t, [item(1, [2, 1, 9, 38], [22, 62], 3), item(2, [1, 49], [63], 2), item(3, [2], [], 0)]);
  await ensureAppInfo([1, 2, 3]);
  const info = appInfo();
  assert.deepEqual(info.get(1), { name: 'Game 1', multiplayer: true, coop: true, pvp: false, deck: 3, shareable: true });
  assert.deepEqual(info.get(2), { name: 'Game 2', multiplayer: true, coop: false, pvp: true, deck: 2, shareable: false });
  assert.deepEqual(info.get(3), { name: 'Game 3', multiplayer: false, coop: false, pvp: false, deck: 0, shareable: false });
});

test('re-reads old facts, and only old ones', async (t) => {
  db.exec('DELETE FROM app_info');
  const old = Date.now() - 31 * 86_400_000;
  db.prepare(`INSERT INTO app_info (appid, name, multiplayer, read_at) VALUES (1, 'Old', 1, ?), (2, 'Fresh', 1, ?)`).run(old, Date.now());
  const asked = fakeStore(t, [item(1, [1], [], 3)]);
  await refreshAll();
  assert.equal(appInfo().get(1)!.deck, 3);
  assert.equal(asked.length, 1);
  const ids = JSON.parse(new URL(asked[0]).searchParams.get('input_json')!).ids;
  assert.deepEqual(ids, [{ appid: 1 }]);
});

test('a game the store stops answering for keeps its facts', async (t) => {
  db.exec('DELETE FROM app_info');
  db.prepare(`INSERT INTO app_info (appid, name, multiplayer, deck, shareable, read_at) VALUES (1, 'Old', 1, 3, 1, 0)`).run();
  fakeStore(t, [{ appid: 1, success: 2 }]);
  await refreshAll();
  assert.deepEqual(appInfo().get(1), { name: 'Old', multiplayer: true, coop: false, pvp: false, deck: 3, shareable: true });
  assert.ok((db.prepare('SELECT read_at FROM app_info WHERE appid = 1').get() as { read_at: number }).read_at > 0);
});

test('an app the store has never heard of isn’t asked about again', async (t) => {
  db.exec('DELETE FROM app_info');
  const asked = fakeStore(t, []);
  await ensureAppInfo([7]);
  await ensureAppInfo([7]);
  assert.equal(asked.length, 1);
  assert.equal(appInfo().get(7)!.multiplayer, false);
});

test('keeps last-two-weeks playtime from a Steam library', async (t) => {
  own('a');
  db.prepare(`UPDATE steam_links SET refreshed_at = 0 WHERE user_id = 'a'`).run();
  useKey(t);
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    new Response(JSON.stringify({ response: String(url).includes('GetOwnedGames') ? { game_count: 2, games: [{ appid: 5, name: 'X', playtime_forever: 90, playtime_2weeks: 40 }, { appid: 6, name: 'Y', playtime_forever: 9 }] } : {} })),
  );
  await refreshAll();
  const owned = ownedSteamGames('a');
  assert.deepEqual([owned.get(5)!.recent, owned.get(6)!.recent], [40, 0]);
});

test('remembers a player count for a while, and doesn’t mind Steam having none', async (t) => {
  const fetcher = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ response: { player_count: 3997, result: 1 } })));
  assert.equal(await currentPlayers(548430), 3997);
  assert.equal(await currentPlayers(548430), 3997);
  assert.equal(fetcher.mock.callCount(), 1);
  fetcher.mock.mockImplementation(async () => new Response('', { status: 404 }));
  const quiet = t.mock.method(console, 'error', () => {});
  assert.equal(await currentPlayers(1), null);
  assert.equal(quiet.mock.callCount(), 1);
});

async function runSteam(t: TestContext, sub: string, options: Record<string, { id: string; bot?: boolean } | undefined>) {
  useKey(t);
  let reply: { content: string; flags?: number } | undefined;
  await steam.commands![0].run({
    options: { getSubcommand: () => sub, getUser: (name: string) => options[name] ?? null },
    user: { id: 'me' },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  return reply!;
}

test('/steam family and unfamily change who shares, and for someone else too', async (t) => {
  assert.match((await runSteam(t, 'family', { with: { id: 'a' } })).content, /<@a> and <@me>|<@me> and <@a>/);
  assert.deepEqual(familyOf('a'), ['a', 'me']);
  await runSteam(t, 'family', { with: { id: 'a' }, user: { id: 'b' } });
  assert.deepEqual(familyOf('a'), ['a', 'b', 'me']);
  assert.ok((await runSteam(t, 'unfamily', { user: { id: 'b' } })).content.startsWith('Took'));
  assert.deepEqual(familyOf('a'), ['a', 'me']);
  assert.ok((await runSteam(t, 'unfamily', { user: { id: 'b' } })).flags, 'only they see it');
});

test('/steam family refuses bots and yourself', async (t) => {
  assert.equal((await runSteam(t, 'family', { with: { id: 'bot', bot: true } })).content, 'Bots don’t have Steam families.');
  assert.equal((await runSteam(t, 'family', { with: { id: 'me' } })).content, 'Pick two different people.');
  assert.deepEqual(familyOf('me'), []);
});

/** Runs /whatdoweplay, or presses a button on its card, and returns the card's title and buttons */
async function pickCard(customId: string | null, type: string | null = null, deck: number | null = null) {
  const voice = { members: new Map(['a', 'c'].map((id) => [id, { id, user: { bot: false } }])) };
  let card: { embeds: { toJSON(): { title: string } }[]; components: { toJSON(): { components: { custom_id: string }[] } }[] } | undefined;
  const shared = { inCachedGuild: () => true, guildId: 'g', guild, user: { id: 'a' }, member: { voice: { channel: voice } }, deferReply: async () => {}, deferUpdate: async () => {}, editReply: async (r: typeof card) => (card = r) };
  if (customId) await games.onButton!({ ...shared, customId, message: { embeds: [] } } as never);
  else await games.commands![1].run({ ...shared, options: { getString: () => type, getInteger: () => deck } } as never);
  return { title: card!.embeds[0].toJSON().title, ids: card!.components[0].toJSON().components.map((b) => b.custom_id) };
}

test('/whatdoweplay only picks what fits, and rerolling keeps to that', async () => {
  for (const user of ['a', 'c']) {
    own(user, 1);
    own(user, 2);
  }
  facts(1, 0, { coop: 1, deck: 3 });
  facts(2, 0, { pvp: 1, deck: 2 });
  db.prepare(`UPDATE steam_owned SET name = 'Co-op Game' WHERE appid = 1`).run();
  db.prepare(`UPDATE steam_owned SET name = 'PvP Game' WHERE appid = 2`).run();

  const coop = await pickCard(null, 'coop');
  assert.equal(coop.title, '🎲 Co-op Game');
  assert.equal(coop.ids[0], 'wdp:reroll:coop:0');
  for (let n = 0; n < 10; n++) assert.equal((await pickCard('wdp:reroll:coop:0')).title, '🎲 Co-op Game');
  assert.equal((await pickCard(null, null, 3)).title, '🎲 Co-op Game');
  assert.equal((await pickCard(null, 'pvp', 3)).title, '🤷 Nothing fits');
  assert.ok(['🎲 Co-op Game', '🎲 PvP Game'].includes((await pickCard(null, null, 2)).title));
});

test('a reroll button from before filters still works', async () => {
  for (const user of ['a', 'c']) own(user);
  assert.equal((await pickCard('wdp:reroll')).title, '🎲 Deep Rock');
});

test('Never suggest this keeps the filters too', async () => {
  for (const user of ['a', 'c']) own(user, 1);
  facts(1, 0, { coop: 1 });
  assert.equal((await pickCard(null, 'coop')).ids.at(-1), 'wdp:hide:1:coop:0');
});
