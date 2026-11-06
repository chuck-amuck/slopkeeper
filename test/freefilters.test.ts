import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { factsFor, lookups } from '../src/features/gamefacts.ts';
import { check, freeGames, reviewGiveaways, taste, verdict, type Giveaway } from '../src/features/freegames.ts';
import { setSetting } from '../src/settings.ts';

const HOUR = 3_600_000;
lookups.gapMs = 0;

interface Listed {
  id: number;
  positive: number;
  negative: number;
  tags: Record<string, number> | never[];
}
const catalog = new Map<string, Listed>();
const asked: string[] = [];
let down = false;
let errorJson = false;
let nextId = 1;

const feedEntry = (title: string, id: number) => ({ id, title: `${title} (Steam) Giveaway`, worth: '$9.99', image: 'https://example.com/i.jpg', description: 'Free', open_giveaway_url: 'https://example.com/open', platforms: 'PC, Steam', end_date: 'N/A', status: 'Active' });
const feed = [
  feedEntry('Feed Bad', 1),
  ...Array.from({ length: 7 }, (_, i) => feedEntry(`Feed Good ${i}`, i + 2)),
];

mock.method(console, 'error', () => {});
mock.method(globalThis, 'fetch', async (url: string) => {
  const link = new URL(url);
  asked.push(link.hostname);
  if (link.hostname === 'www.gamerpower.com') return new Response(JSON.stringify(feed));
  if (down) return new Response('nope', { status: 503 });
  if (errorJson) return new Response('{"items":[]}', { status: 500 });
  if (link.hostname === 'store.steampowered.com') {
    const term = link.searchParams.get('term')!;
    const found = catalog.get(term);
    return new Response(JSON.stringify({ items: found ? [{ id: found.id + 1000, name: `${term}: The Expansion` }, { id: found.id, name: term }] : [] }));
  }
  const appid = Number(link.searchParams.get('appid'));
  const [, game] = [...catalog].find(([, g]) => g.id === appid)!;
  return new Response(JSON.stringify({ positive: game.positive, negative: game.negative, tags: game.tags }));
});

const list = (title: string, positive: number, negative: number, tags: string[] = []) => {
  const entries = tags.map((tag, i) => [tag, 1000 - i]);
  catalog.set(title, { id: nextId++, positive, negative, tags: tags.length ? Object.fromEntries(entries) : [] });
  return catalog.get(title)!;
};
const giveaway = (title: string) => ({ id: 0, title, worth: '', image: '', description: '', url: '', platforms: 'Steam', endDate: null }) as Giveaway;
const guild = (id: string, members: string[] = []) => ({ id, name: id, members: { cache: new Map(members.map((m) => [m, {}])) } }) as never;
const judge = (id: string, title: string, theirs: Awaited<ReturnType<typeof taste>> = null) => verdict(guild(id), giveaway(title), theirs);

let plays = 0;
const played = (guildId: string, game: string, hours: number) => db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'u1', ?, 'voice', ?, ?)`).run(guildId, game, Date.now() - (hours + 1) * HOUR - ++plays, Date.now() - HOUR - plays);

test('a server that hasn’t turned free games on gets none', async () => {
  const sent: unknown[] = [];
  await check(fakeClient([{ id: 'never-on', name: 'never-on' }], async (_, message) => void sent.push(message)));
  assert.deepEqual(sent, []);
});

test('a Steam error isn’t remembered as a game that isn’t on Steam', async () => {
  errorJson = true;
  await assert.rejects(factsFor('Error Page'));
  errorJson = false;
  list('Error Page', 80, 20);
  assert.notEqual((await factsFor('Error Page')).appid, null);
});

test('a game SteamSpy has no numbers for counts as no reviews', async () => {
  const game = list('No Numbers', 0, 0);
  Object.assign(game, { positive: undefined, negative: undefined });
  const facts = await factsFor('No Numbers');
  assert.deepEqual([facts.positive, facts.negative], [0, 0]);
});

test('a game needs enough reviews, and enough of them positive', async () => {
  setSetting('rating', 'freeGamesTaste', false);
  list('Rated 70', 70, 30);
  list('Rated 69', 6999, 3001);
  list('Few reviews', 49, 0);
  list('Enough reviews', 50, 0);
  assert.deepEqual(await judge('rating', 'Rated 70'), { show: true, reason: '70% positive' });
  assert.deepEqual(await judge('rating', 'Rated 69'), { show: false, reason: '69% positive, needs 70%' });
  assert.deepEqual(await judge('rating', 'Few reviews'), { show: false, reason: '49 Steam reviews, needs 50' });
  assert.equal((await judge('rating', 'Enough reviews')).show, true);
});

test('a rating of 0 turns that filter off', async () => {
  setSetting('norating', 'freeGamesTaste', false);
  setSetting('norating', 'freeGamesMinRating', 0);
  list('Awful', 1, 99);
  list('Unreviewed', 0, 0);
  assert.equal((await judge('norating', 'Awful')).show, true);
  assert.deepEqual(await judge('norating', 'Unreviewed'), { show: true, reason: '' });
});

test('a server can ask for a different rating, and others keep theirs', async () => {
  setSetting('picky', 'freeGamesTaste', false);
  setSetting('picky', 'freeGamesMinRating', 90);
  setSetting('relaxed', 'freeGamesTaste', false);
  list('Eighty', 80, 20);
  assert.deepEqual(await judge('picky', 'Eighty'), { show: false, reason: '80% positive, needs 90%' });
  assert.equal((await judge('relaxed', 'Eighty')).show, true);
});

test('multiplayer only needs a multiplayer tag', async () => {
  setSetting('group', 'freeGamesTaste', false);
  setSetting('group', 'freeGamesMultiplayer', true);
  list('Solo', 90, 10, ['Singleplayer', 'Puzzle']);
  list('Together', 90, 10, ['Puzzle', 'Online Co-Op']);
  assert.deepEqual(await judge('group', 'Solo'), { show: false, reason: 'No multiplayer' });
  assert.equal((await judge('group', 'Together')).show, true);
});

test('a game with no Steam page follows the setting', async () => {
  assert.deepEqual(await judge('unlisted', 'Nowhere'), { show: false, reason: 'Not on Steam, so it can’t be rated' });
  setSetting('unlisted', 'freeGamesUnlisted', true);
  assert.equal((await judge('unlisted', 'Nowhere')).show, true);
});

test('a game is hidden only if everyone linked owns it', async () => {
  setSetting('owned', 'freeGamesTaste', false);
  const { id } = list('Owned Game', 90, 10);
  const owns = db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES (?, ?, 'x', 0)`);
  const link = db.prepare('INSERT INTO steam_links (user_id, steam_id) VALUES (?, ?)');
  assert.equal((await verdict(guild('owned'), giveaway('Owned Game'), null)).show, true, 'nobody linked');
  link.run('own1', 'steam1');
  link.run('own2', 'steam2');
  link.run('elsewhere', 'steam3');
  owns.run('steam1', id);
  assert.equal((await verdict(guild('owned', ['own1', 'own2']), giveaway('Owned Game'), null)).show, true, 'only some own it');
  owns.run('steam2', id);
  assert.deepEqual(await verdict(guild('owned', ['own1', 'own2']), giveaway('Owned Game'), null), { show: false, reason: 'Everyone with a linked Steam account owns it' });
  assert.equal((await verdict(guild('owned', ['own1', 'own2', 'other']), giveaway('Owned Game'), null)).show, false, 'someone not linked doesn’t count');
  assert.equal((await verdict(guild('owned', ['elsewhere']), giveaway('Owned Game'), null)).show, true, 'only people on this server count');
});

const server = (id: string) => {
  list(`${id} Shooter`, 90, 10, ['FPS', 'Co-op', 'Roguelite', 'Mining']);
  list(`${id} Crawler`, 90, 10, ['Roguelite', 'Dungeon Crawler', 'Singleplayer']);
  list(`${id} Tower`, 90, 10, ['Tower Defense', 'Strategy']);
  played(id, `${id} Shooter`, 30);
  played(id, `${id} Crawler`, 20);
  played(id, `${id} Tower`, 10);
};

test('taste needs three games Steam knows', async () => {
  list('Known One', 90, 10, ['FPS']);
  list('Known Two', 90, 10, ['Puzzle']);
  played('tasteless', 'Known One', 5);
  played('tasteless', 'Known Two', 5);
  played('tasteless', 'Not On Steam', 5);
  assert.equal(await taste('tasteless'), null);
  list('Known Three', 90, 10, ['Racing']);
  played('tasteless', 'Known Three', 5);
  assert.deepEqual([...(await taste('tasteless'))!.tags].sort(), ['FPS', 'Puzzle', 'Racing']);
});

test('a game has to share two tags with what the server plays, and generic ones don’t count', async () => {
  server('liked');
  const theirs = await taste('liked');
  assert.ok(!theirs!.tags.has('Co-op') && !theirs!.tags.has('Singleplayer'));
  list('Shares two', 90, 10, ['FPS', 'Roguelite', 'Horror']);
  list('Shares one', 90, 10, ['FPS', 'Horror']);
  list('Only generic', 90, 10, ['Singleplayer', 'Indie', 'Co-op', 'Action', 'FPS']);
  assert.deepEqual(await judge('liked', 'Shares two', theirs), { show: true, reason: '90% positive · Like liked Shooter (FPS, Roguelite)' });
  assert.deepEqual(await judge('liked', 'Shares one', theirs), { show: false, reason: 'Not much like what you play' });
  assert.equal((await judge('liked', 'Only generic', theirs)).show, false);
  setSetting('liked', 'freeGamesTaste', false);
  assert.equal((await judge('liked', 'Shares one', theirs)).show, true);
});

test('the reason names the closest game', async () => {
  server('closest');
  list('Crawly', 90, 10, ['Roguelite', 'Dungeon Crawler']);
  assert.match((await judge('closest', 'Crawly', await taste('closest'))).reason, /Like closest Crawler/);
});

test('taste uses only the last six months and voice time', async () => {
  server('old');
  db.prepare(`UPDATE game_plays SET started_at = started_at - ?, ended_at = ended_at - ? WHERE guild_id = 'old'`).run(181 * 24 * HOUR, 181 * 24 * HOUR);
  assert.equal(await taste('old'), null);
});

test('facts are kept, a game not on Steam is remembered, and old facts are refreshed', async (t) => {
  list('Cached', 90, 10);
  asked.length = 0;
  await factsFor('Cached');
  await factsFor('CACHED!');
  assert.deepEqual(asked, ['store.steampowered.com', 'steamspy.com']);
  asked.length = 0;
  await factsFor('Missing');
  await factsFor('Missing');
  assert.deepEqual(asked, ['store.steampowered.com']);

  catalog.get('Cached')!.positive = 500;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 24 * HOUR });
  assert.equal((await factsFor('Cached')).positive, 500);
});

test('asking twice at once looks a game up once', async () => {
  list('Twice', 90, 10);
  asked.length = 0;
  const [a, b] = await Promise.all([factsFor('Twice'), factsFor('Twice')]);
  assert.deepEqual(a, b);
  assert.equal(asked.length, 2);
});

test('lookups go out one at a time, spaced apart', async () => {
  lookups.gapMs = 40;
  for (const title of ['Spaced A', 'Spaced B', 'Spaced C']) list(title, 90, 10);
  const started = Date.now();
  await Promise.all(['Spaced A', 'Spaced B', 'Spaced C'].map((title) => factsFor(title)));
  lookups.gapMs = 0;
  assert.ok(Date.now() - started >= 60, 'three lookups have two gaps at least');
});

test('tags come back most voted first, and a game with none is fine', async () => {
  catalog.set('Voted', { id: nextId++, positive: 1, negative: 0, tags: { Low: 1, High: 9, Mid: 5 } });
  assert.deepEqual((await factsFor('Voted')).tags, ['High', 'Mid', 'Low']);
  list('Untagged', 90, 10);
  assert.deepEqual((await factsFor('Untagged')).tags, []);
});

const channelled = (id: string) => {
  setSetting(id, 'announceChannel', `channel-${id}`);
  setSetting(id, 'freeGames', true);
};
const posted = (id: string) => (db.prepare('SELECT giveaway_id FROM free_game_posts WHERE guild_id = ? ORDER BY giveaway_id').all(id) as { giveaway_id: number }[]).map((r) => r.giveaway_id);
const sentTo = () => {
  const sent: Record<string, any>[] = [];
  return { sent, send: async (_: string, message: Record<string, unknown>) => void sent.push(message) };
};

for (let i = 0; i < 7; i++) list(`Feed Good ${i}`, 90, 10, ['Puzzle', 'Horror']);
list('Feed Bad', 10, 90);

test('only games that pass are posted, each with why, and the hidden ones don’t use up the limit', async () => {
  channelled('posts');
  const { sent, send } = sentTo();
  const client = fakeClient([{ id: 'posts', name: 'Posts', members: { cache: new Map() } } as never], send);
  await check(client);
  assert.equal(sent.length, 5);
  assert.deepEqual(posted('posts'), [2, 3, 4, 5, 6]);
  assert.equal(sent[0].embeds[0].data.footer.text, '90% positive');
  await check(client);
  assert.equal(sent.length, 7);
  await check(client);
  assert.equal(sent.length, 7, 'nothing posts twice');
});

test('a game that was filtered out is posted once a filter loosens', async () => {
  channelled('loosen');
  setSetting('loosen', 'freeGamesMinRating', 95);
  setSetting('loosen', 'freeGamesMultiplayer', true);
  const { sent, send } = sentTo();
  const client = fakeClient([{ id: 'loosen', name: 'Loosen', members: { cache: new Map() } } as never], send);
  await check(client);
  assert.equal(sent.length, 0);
  assert.deepEqual(posted('loosen'), []);
  setSetting('loosen', 'freeGamesMinRating', 0);
  setSetting('loosen', 'freeGamesMultiplayer', false);
  await check(client);
  assert.deepEqual(posted('loosen'), [1, 2, 3, 4, 5]);
});

test('when Steam can’t be asked nothing is posted or marked, and the next check tries again', async () => {
  channelled('outage');
  list('Fresh Pick', 90, 10);
  db.exec('DELETE FROM game_facts');
  down = true;
  const { sent, send } = sentTo();
  const client = fakeClient([{ id: 'outage', name: 'Outage', members: { cache: new Map() } } as never], send);
  await check(client);
  assert.equal(sent.length, 0);
  assert.deepEqual(posted('outage'), []);
  down = false;
  await check(client);
  assert.equal(sent.length, 5);
});

const askFor = async (id: string, all: boolean | null) => {
  let reply: any;
  await freeGames.commands![0].run({
    deferReply: async () => {},
    inCachedGuild: () => true,
    guild: guild(id),
    options: { getBoolean: () => all },
    editReply: async (r: unknown) => void (reply = r),
  } as never);
  return reply;
};

test('/freegames shows what passes, says what’s hidden, and all shows the lot', async () => {
  const shown = await askFor('asks', null);
  assert.equal(shown.embeds.length, 7);
  assert.match(shown.content, /^1 more is hidden/);
  const all = await askFor('asks', true);
  assert.equal(all.embeds.length, 8);
  assert.equal(all.content, '');
});

test('/freegames says so when everything’s hidden', async () => {
  setSetting('hidesall', 'freeGamesMinRating', 100);
  const reply = await askFor('hidesall', null);
  assert.match(reply, /Nothing that’s free right now passes.*8 more are hidden/);
});

test('every current giveaway comes with its verdict', async () => {
  const reviewed = await reviewGiveaways(guild('review'));
  assert.equal(reviewed.length, 8);
  assert.deepEqual([reviewed[0].title, reviewed[0].show, reviewed[0].reason], ['Feed Bad', false, '10% positive, needs 70%']);
  assert.equal(reviewed[1].show, true);
});
