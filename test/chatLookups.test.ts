import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { ago, lookUp, lookupTools } from '../src/features/chatLookups.ts';

const GUILD = 'g-lookups';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

// Robin and Sam are in voice; Sasha and Alex aren't
const members = new Map<string, unknown>();
const guild = { id: GUILD, name: 'Test Server', members: { cache: members, me: { id: '100' } }, channels: { cache: new Map() }, roles: { cache: new Map() } };
const voice = { id: 'v1', name: 'General', guild, members: new Map<string, unknown>() };
function person(id: string, name: string, inVoice = false) {
  const member = { id, displayName: name, guild, user: { bot: false, username: name.toLowerCase() }, voice: { channel: inVoice ? voice : null } };
  members.set(id, member);
  if (inVoice) voice.members.set(id, member);
  return member as never;
}
members.set('100', { id: '100', displayName: 'Slopkeeper', user: { bot: true } });
const robin = person('201', 'Robin', true);
person('202', 'Sam', true);
const sasha = person('203', 'Sasha');
person('204', 'Alex');

const ask = (who: never, name: string, input: Record<string, unknown>) => lookUp(who, name, input) as Promise<string>;
const stats = (input: Partial<Record<'period' | 'person' | 'game' | 'compare_with', string>>) => ask(robin, 'play_stats', { period: 'month', person: '', game: '', compare_with: '', ...input });

function addGame(name: string, appid: number | null = null, owners: string[] = [], wanted: string[] = []) {
  const id = Number(db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, '201')`).run(GUILD, name, appid).lastInsertRowid);
  for (const user of owners) db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)').run(id, user);
  for (const user of wanted) db.prepare('INSERT INTO game_wants (game_id, user_id) VALUES (?, ?)').run(id, user);
}
const played = (user: string, game: string, daysAgo: number, hours: number) =>
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'v1', ?, ?)`).run(GUILD, user, game, now - daysAgo * DAY, now - daysAgo * DAY + hours * HOUR);

/** Steam's store and news, answering only the URLs a test gives, so nothing reaches the internet */
function fakeWeb(t: TestContext, answers: Record<string, unknown>) {
  return t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = String(input);
    const found = Object.keys(answers).find((part) => url.includes(part));
    if (!found) throw new Error(`Not faked: ${url}`);
    return new Response(JSON.stringify(answers[found]));
  });
}

beforeEach((t) => {
  db.exec('DELETE FROM games; DELETE FROM game_plays; DELETE FROM sale_prices; DELETE FROM music_plays; DELETE FROM patch_posts; DELETE FROM steam_links; DELETE FROM app_info;');
  fakeWeb(t as TestContext, {});
});

test('the lookup tools: achievements need a Steam key, and songs played before need music', (t) => {
  const keys = { steam: config.steamApiKey, music: config.musicUrl };
  t.after(() => Object.assign(config, { steamApiKey: keys.steam, musicUrl: keys.music }));
  Object.assign(config, { steamApiKey: null, musicUrl: null });
  assert.deepEqual(lookupTools().map((tool) => tool.name), ['games_for', 'game_info', 'play_stats', 'deals', 'patch_notes']);
  Object.assign(config, { steamApiKey: 'key', musicUrl: 'http://music' });
  assert.deepEqual(lookupTools().map((tool) => tool.name), ['games_for', 'game_info', 'play_stats', 'deals', 'music_history', 'patch_notes', 'achievements']);
  assert.equal(lookUp(robin, 'queue_music', {}) instanceof Promise, true);
});

test('it finds people and games by name, and asks which one when a name fits more than one', async () => {
  addGame('Deep Rock Galactic');
  addGame('Deeper Down');
  played('201', 'Valheim', 2, 1);
  assert.equal(await stats({ person: 'sa' }), 'More than one person here matches “sa”: Sam and Sasha. Ask which one.');
  assert.equal(await stats({ person: 'Nobody' }), 'Nobody here is called “Nobody”.');
  assert.match(await stats({ person: '@sam' }), /^Sam \(past month/);
  assert.match(await stats({ person: 'me' }), /^Robin \(past month/);
  assert.equal(await stats({ person: 'Slopkeeper' }), 'Nobody here is called “Slopkeeper”.');
  assert.equal(await ask(robin, 'game_info', { game: 'deep' }), 'More than one game here matches “deep”: Deep Rock Galactic and Deeper Down. Ask which one.');
  assert.match(await ask(robin, 'game_info', { game: 'rock galactic' }), /^Deep Rock Galactic\. It’s in the server’s game library\./);
  // A game only played, not in the library
  assert.match(await ask(robin, 'game_info', { game: 'VALHEIM' }), /^Valheim\. It isn’t in the server’s game library\./);
  assert.equal(await ask(robin, 'game_info', { game: 'Halo' }), 'Nobody here has or has played a game called “Halo”.');
});

test('games_for: what the people in voice, or those named, can play together, and what’s one purchase away', async () => {
  addGame('Valheim', null, ['201', '202']);
  addGame('Lethal Company', null, ['201']);
  played('201', 'Valheim', 2, 2);
  played('202', 'Valheim', 2, 1);
  const any = { kind: 'any', steam_deck: 'any' };
  assert.equal(
    await ask(robin, 'games_for', { people: [], ...any }),
    [
      'For Robin and Sam: 2 of 2 have games the bot knows about.',
      'Games they all have, most played here first:',
      '- Valheim: 3h played here between them, last 2 days ago',
      'One purchase away:',
      '- Lethal Company: not played here yet; Sam doesn’t have it',
    ].join('\n'),
  );
  // Alex has no games the bot knows of, so isn't counted
  assert.match(await ask(robin, 'games_for', { people: ['Alex', 'me'], ...any }), /^For Alex and Robin: 1 of 2 have games the bot knows about\.\nNot counted \(no Steam linked\): Alex\n/);
  assert.match(await ask(robin, 'games_for', { people: [], kind: 'coop', steam_deck: 'any' }), /No multiplayer game like that is owned by all of them and fits 2 players\./);
  assert.equal(await ask(sasha, 'games_for', { people: [], ...any }), 'They aren’t in a voice channel and didn’t say who’s playing, so ask who it’s for.');
});

test('game_info: who owns it, needs it and wants it, its sale, and who has played it', async () => {
  addGame('Deep Rock Galactic', 548430, ['201', '202'], ['203']);
  addGame('Other', null, ['203']);
  db.prepare(`INSERT INTO sale_prices (country, appid, discount, was, price, final) VALUES ('us', 548430, 50, '$20.00', '$10.00', 1000)`).run();
  played('201', 'Deep Rock Galactic', 2, 2);
  played('202', 'Deep Rock Galactic', 3, 1);
  assert.equal(
    await ask(robin, 'game_info', { game: 'drg deep rock galactic'.slice(4) }),
    [
      'Deep Rock Galactic. It’s in the server’s game library.',
      'Owned by Robin and Sam.',
      'Still needs it: Sasha.',
      'Wanted by Sasha.',
      'On sale: 50% off, $10.00, was $20.00.',
      'Played in voice here for 3h in all, last 2 days ago.',
      'Most played by: Robin 2h, Sam 1h.',
    ].join('\n'),
  );
});

test('play_stats: the server, a person, a game, both, and two people compared', async () => {
  played('201', 'Valheim', 2, 2);
  played('202', 'Valheim', 5, 1);
  played('201', 'Deep Rock Galactic', 40, 1);
  assert.equal(
    await stats({}),
    'The server (past month, games played in voice): 3h across 1 game by 2 people.\nMost played games: Valheim 3h.\nBiggest players: Robin 2h, Sam 1h.',
  );
  assert.equal(await stats({ person: 'me', period: 'year' }), 'Robin (past year, games played in voice):\nNot in voice.\nGames: Valheim 2h, Deep Rock Galactic 1h.');
  assert.equal(await stats({ game: 'valheim' }), 'Valheim (past month, games played in voice): played for 3h by 2 people: Robin 2h, Sam 1h.');
  assert.equal(await stats({ person: 'Sam', game: 'Valheim' }), 'Sam played Valheim for 1h over 1 session, last 5 days ago: number 2 of 2 players here (past month, games played in voice).');
  assert.equal(await stats({ person: 'Sam', game: 'Deep Rock Galactic' }), 'Sam hasn’t played Deep Rock Galactic in voice in the past month.');
  assert.match(await stats({ compare_with: 'Sam' }), /^Robin and Sam, over all time:\nGames played together in voice: 0m\.\nIn voice together 0 times, for 0m\.\nGames played in voice in all: Robin 3h, Sam 1h\./);
  assert.equal(await stats({ compare_with: 'me' }), 'Pick two different people.');
});

test('deals: what’s on sale here, a price check of any game, and why bundles or free games can’t be listed', async (t) => {
  addGame('Discounted', 9001, [], ['203']);
  db.prepare(`INSERT INTO sale_prices (country, appid, discount, was, price, final) VALUES ('us', 9001, 50, '$20.00', '$10.00', 1000)`).run();
  assert.equal(await ask(robin, 'deals', { kind: 'sales', game: '' }), 'On sale at the last price check, most wanted first:\n- Discounted: 50% off, $10.00, was $20.00. Wanted by Sasha');

  const fetched = fakeWeb(t, {
    'storesearch/?term=hades': { items: [{ id: 1145360, name: 'Hades' }, { id: 1145350, name: 'Hades II' }] },
    'appdetails?appids=1145360': { 1145360: { success: true, data: { price_overview: { currency: 'USD', initial: 2499, final: 1249, discount_percent: 50, initial_formatted: '$24.99', final_formatted: '$12.49' } } } },
  });
  assert.equal(await ask(robin, 'deals', { kind: 'price', game: 'hades' }), 'Hades on Steam: 50% off, $12.49, normally $24.99.\nNobody here owns it, that the bot knows of.');
  assert.match(String(fetched.mock.calls.at(-1)!.arguments[0]), /&cc=us&/);

  // Steam's game of that very name, not one here with the name in it; and a guess is said to be one
  addGame('Portal 2', 620, ['201']);
  fakeWeb(t, {
    'storesearch/?term=portal': { items: [{ id: 400, name: 'Portal' }, { id: 620, name: 'Portal 2' }] },
    'appdetails?appids=400': { 400: { success: true, data: { price_overview: { currency: 'USD', initial: 999, final: 999, discount_percent: 0, initial_formatted: '$9.99', final_formatted: '$9.99' } } } },
    'storesearch/?term=hades%20silk': { items: [{ id: 1145360, name: 'Hades' }] },
    'appdetails?appids=1145360': { 1145360: { success: true, data: [] } },
  });
  assert.equal(await ask(robin, 'deals', { kind: 'price', game: 'portal' }), 'Portal on Steam: $9.99, not on sale.\nNobody here owns it, that the bot knows of.');
  assert.equal(
    await ask(robin, 'deals', { kind: 'price', game: 'hades silk' }),
    'Steam has no game called exactly “hades silk”. Its closest match is Hades:\nHades isn’t sold on Steam right now, or it’s free.\nNobody here owns it, that the bot knows of.',
  );

  assert.equal(await ask(robin, 'deals', { kind: 'bundles', game: '' }), 'Bundles need an IsThereAnyDeal key on the bot.');
  assert.equal(await ask(robin, 'deals', { kind: 'free_games', game: '' }), 'The free game list couldn’t be read just now.');
});

test('music_history: the latest songs or the most played, by words or by who added them, with refs to play them again', async (t) => {
  const music = config.musicUrl;
  t.after(() => void (config.musicUrl = music));
  config.musicUrl = null;
  assert.equal(await ask(robin, 'music_history', { search: '', person: '', most_played: false }), 'Music isn’t set up on this bot.');
  config.musicUrl = 'http://music';
  const add = db.prepare('INSERT INTO music_plays (guild_id, at, uri, title, artist, source, duration_ms, added_by, skipped) VALUES (?, ?, ?, ?, ?, NULL, 1000, ?, ?)');
  add.run(GUILD, now - 3 * HOUR, 'spotify:track:aaa', 'Reptilia', 'The Strokes', '201', 0);
  add.run(GUILD, now - 2 * HOUR, 'upload:song.mp3', 'My Song', 'Me', '202', 1);
  add.run(GUILD, now - HOUR, 'spotify:track:aaa', 'Reptilia', 'The Strokes', 'autoplay', 0);
  const history = (input: Record<string, unknown>) => ask(robin, 'music_history', { search: '', person: '', most_played: false, ...input });
  assert.equal(
    await history({}),
    [
      'Played here, newest first:',
      '- “Reptilia” by The Strokes, added by Autoplay, 60 minutes ago (ref spotify:track:aaa)',
      '- “My Song” by Me, added by Sam, 2 hours ago, skipped',
      '- “Reptilia” by The Strokes, added by Robin, 3 hours ago (ref spotify:track:aaa)',
    ].join('\n'),
  );
  assert.equal(await history({ most_played: true }), 'Most played here:\n- “Reptilia” by The Strokes: 2 times, last 60 minutes ago (ref spotify:track:aaa)\n- “My Song” by Me: 1 time, last 2 hours ago');
  assert.equal(await history({ search: 'strokes', person: 'me' }), 'Played here, newest first:\n- “Reptilia” by The Strokes, added by Robin, 3 hours ago (ref spotify:track:aaa)');
  // Words from the title and the artist together
  assert.match(await history({ search: 'strokes  REPTILIA', person: 'me' }), /added by Robin/);
  assert.equal(await history({ search: 'strokes song' }), 'Nothing like that has been played here.');
  assert.equal(await history({ search: '100%' }), 'Nothing like that has been played here.');
});

test('patch_notes: Steam’s latest for any game, or what the server’s patch notes kept while Steam is down', async (t) => {
  addGame('Valheim', 892970);
  db.prepare(`INSERT INTO patch_posts (guild_id, gid, appid, game, title, url, date, text, posted) VALUES (?, '1', 892970, 'Valheim', 'Patch 0.219', 'https://steam.test/1', ?, 'Fixed the boats.', 1)`).run(GUILD, Date.UTC(2026, 10, 10, 18));
  assert.equal(await ask(robin, 'patch_notes', { game: 'valheim' }), 'Valheim’s latest patch notes, newest first:\n- “Patch 0.219”, November 10, 2026 (https://steam.test/1): Fixed the boats.');
  assert.equal(await ask(robin, 'patch_notes', { game: 'Halo' }), 'Steam couldn’t be reached just now. Try again in a bit.');

  fakeWeb(t, {
    'storesearch/?term=other%20game': { items: [{ id: 4242, name: 'Other Game' }] },
    GetNewsForApp: { appnews: { newsitems: [{ gid: '9', title: 'Update 2', url: 'https://steam.test/9', date: Date.UTC(2026, 10, 12, 18) / 1000, contents: '[b]New[/b] maps' }] } },
  });
  assert.equal(await ask(robin, 'patch_notes', { game: 'other game' }), 'Other Game’s latest patch notes, newest first:\n- “Update 2”, November 12, 2026 (https://steam.test/9): New maps');
});

test('achievements: how the people in voice are getting on, and what none of them has yet', async (t) => {
  const key = config.steamApiKey;
  t.after(() => void (config.steamApiKey = key));
  config.steamApiKey = null;
  assert.equal(await ask(robin, 'achievements', { game: 'valheim', people: [] }), 'Steam isn’t set up on this bot, so achievements can’t be looked up.');
  config.steamApiKey = 'key';
  addGame('Valheim', 777001);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('201', 's1')`).run();
  const schema = [
    { name: 'A', displayName: 'Rare', description: 'Hard', hidden: 0 },
    { name: 'B', displayName: 'Common', description: 'Easy', hidden: 0 },
    { name: 'C', displayName: 'Done', hidden: 0 },
  ];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes('GetSchemaForGame')) return new Response(JSON.stringify({ game: { availableGameStats: { achievements: schema } } }));
    if (url.pathname.includes('GetGlobalAchievement')) return new Response(JSON.stringify({ achievementpercentages: { achievements: [{ name: 'A', percent: '4.2' }, { name: 'B', percent: '92.2' }] } }));
    return new Response(JSON.stringify({ playerstats: { achievements: schema.map((a) => ({ apiname: a.name, achieved: a.name === 'C' ? 1 : 0 })) } }));
  });
  assert.equal(
    await ask(robin, 'achievements', { game: 'valheim', people: [] }),
    [
      'Valheim has 3 achievements.',
      'Unlocked: Robin 1.',
      'Can’t see Sam: no linked Steam account, or their game details are private.',
      'None of them has these yet, most common first: Common (Easy), 92% of players; Rare (Hard), 4% of players.',
    ].join('\n'),
  );
});

test('how long ago, in words', () => {
  assert.deepEqual(
    [0, 30 * 60_000, 5 * HOUR, 3 * DAY, 90 * DAY, 800 * DAY].map((ms) => ago(now - ms, now)),
    ['just now', '30 minutes ago', '5 hours ago', '3 days ago', '3 months ago', '2 years ago'],
  );
});
