import './helpers.ts';
import { PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { candidatesFor } from '../src/features/games.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { noteGame } from '../src/gameNames.ts';
import { activity, stats } from '../src/features/gamestats.ts';
import { steam, unlinkSteam } from '../src/features/steam.ts';
import { setSetting } from '../src/settings.ts';
import { GUILD, HOUR, account, accounts, activityText, as, base, call, discordCdn, discordSounds, guild, heldRoles, hours, library, me, member, ok, pick, refused, role, roles, save, sent, setFake } from './apiFixture.ts';

// Games, Steam accounts, picking and voting, stats, sales, free games and game pings

test('says when the free game list can’t be read', async (t) => {
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response('', { status: 500 })));
  const res = await call(`/guilds/${GUILD}/free-games`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'The free game list couldn’t be read just now.');
});

test('lists the current free games with why each is or isn’t posted', async (t) => {
  const real = fetch;
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    asked.push(String(url));
    if (String(url).includes('gamerpower')) {
      return new Response(JSON.stringify([{ id: 1, title: 'Great Game (Steam) Giveaway', worth: '$9.99', image: '', description: '', open_giveaway_url: 'https://example.com/g', platforms: 'PC, Steam', end_date: 'N/A', status: 'Active' }]));
    }
    return new Response(JSON.stringify({ items: [] }));
  });
  const { games } = await ok(`/guilds/${GUILD}/free-games`);
  assert.deepEqual(games, [{ title: 'Great Game', url: 'https://example.com/g', worth: '$9.99', platforms: 'Steam', show: false, reason: 'Not on Steam, so it can’t be rated' }]);
});

test('lists what’s on sale with the reasons in plain names', async (t) => {
  db.prepare(`INSERT INTO games (id, guild_id, name, steam_appid, added_by) VALUES (9001, ?, 'Discounted', 9001, 'x')`).run(GUILD);
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (9001, 'u1')`).run();
  db.prepare(`INSERT INTO sale_prices (country, appid, discount, was, price, final) VALUES ('us', 9001, 50, '$20.00', '$10.00', 1000)`).run();
  t.after(() => db.exec('DELETE FROM games WHERE id = 9001; DELETE FROM sale_prices'));
  const { games } = await ok(`/guilds/${GUILD}/sales`);
  assert.deepEqual(games, [
    { name: 'Discounted', url: 'https://store.steampowered.com/app/9001', discount: 50, was: '$20.00', price: '$10.00', why: 'Wanted by Ana' },
  ]);
});

function addPlay(user: string, game: string, hoursAgo: number, hours: number, guildId = GUILD) {
  const start = Date.now() - hoursAgo * HOUR;
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(guildId, user, game, start, start + hours * HOUR);
}

function addSession(members: [string, number][], hoursAgo: number) {
  const start = Date.now() - hoursAgo * HOUR;
  const id = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '701', ?, ?)").run(GUILD, start, start + HOUR).lastInsertRowid;
  for (const [user, seconds] of members) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(id, user, seconds);
}

function seedStats() {
  addPlay('u1', 'Halo', 10, 3);
  addPlay('u2', 'Halo', 9, 1);
  addPlay('u1', 'Doom', 5, 2);
  addPlay('gone', 'Doom', 5, 4);
  addPlay('u1', 'Halo', 24 * 20, 1);
  addPlay('u1', 'Other server', 3, 1, 'other');
  addSession([['u1', 3600], ['u2', 1800], ['gone', 7200]], 12);
}

test('stats match what /gamestats works from, leaving out people who’ve left', async () => {
  seedStats();
  const data = await ok(`/guilds/${GUILD}/stats?period=week`);
  const direct = stats(GUILD, Date.now() - 7 * 24 * HOUR, 'none', 'user_id');
  assert.equal(data.players[0].ms, direct.find((r) => r.key === 'u1')!.ms);
  assert.deepEqual(data.players.map((p: any) => [p.id, p.name, Math.round(p.ms / HOUR), p.games]), [['u1', 'Ana', 5, 2], ['u2', 'Ben', 1, 1]]);
  assert.deepEqual(data.games.map((g: any) => [g.name, g.people]), [['Doom', 2], ['Halo', 2]]);
  assert.deepEqual(data.voice.map((p: any) => [p.name, p.ms, p.nights]), [['Ana', 3_600_000, 1], ['Ben', 1_800_000, 1]]);
  // Halo was on for 3h and Doom for 4h, some of that by someone who's since left
  assert.equal(Math.round(data.totals.gameMs / HOUR), 7);
  assert.equal(Math.round(data.totals.playerMs / HOUR), 6);
  assert.equal(data.totals.voiceMs, 5_400_000);
  assert.equal(data.totals.people, 2);
});

test('the period decides what counts', async () => {
  seedStats();
  const hoursFor = async (period: string) => Math.round((await ok(`/guilds/${GUILD}/stats?period=${period}`)).players[0].ms / HOUR);
  assert.equal(await hoursFor('week'), 5);
  assert.equal(await hoursFor('month'), 6);
  assert.equal(await hoursFor('all'), 6);
  for (const period of ['decade', 'constructor']) await refused(400, `/guilds/${GUILD}/stats?period=${period}`);
});

test('filters by person, by game and by both', async () => {
  seedStats();
  const byUser = await ok(`/guilds/${GUILD}/stats?period=week&user=u1`);
  assert.deepEqual(byUser.user, { id: 'u1', name: 'Ana' });
  assert.deepEqual(byUser.games.map((g: any) => g.name), ['Halo', 'Doom']);
  assert.deepEqual(byUser.voice.map((p: any) => p.id), ['u1']);

  const byGame = await ok(`/guilds/${GUILD}/stats?period=week&game=${encodeURIComponent('halo')}`);
  assert.deepEqual(byGame.players.map((p: any) => p.id), ['u1', 'u2']);
  assert.deepEqual(byGame.voice, []);

  const both = await ok(`/guilds/${GUILD}/stats?period=week&user=u2&game=Halo`);
  assert.equal(Math.round(both.totals.gameMs / HOUR), 1);
});

test('a picked game shows how long it was played, a picked person their own time', async () => {
  seedStats();
  const halo = await ok(`/guilds/${GUILD}/stats?period=week&game=Halo`);
  assert.equal(Math.round(halo.totals.gameMs / HOUR), 3);
  assert.equal(Math.round(halo.totals.playerMs / HOUR), 4);
  assert.deepEqual(halo.players.map((p: any) => [p.name, Math.round(p.ms / HOUR)]), [['Ana', 3], ['Ben', 1]]);
  const ben = await ok(`/guilds/${GUILD}/stats?period=week&user=u2`);
  assert.equal(Math.round(ben.totals.gameMs / HOUR), 1);
  assert.equal(Math.round(ben.activity.buckets.reduce((sum: number, b: any) => sum + b.ms, 0) / HOUR), 1);
});

test('game time over time adds up to the total, by day for a short period', async () => {
  seedStats();
  const data = await ok(`/guilds/${GUILD}/stats?period=week`);
  assert.equal(data.activity.step, 'day');
  assert.ok(data.activity.buckets.length >= 7);
  const total = data.activity.buckets.reduce((sum: number, b: any) => sum + b.ms, 0);
  assert.ok(Math.abs(total - data.totals.gameMs) < 2000, `${total} vs ${data.totals.gameMs}`);
});

test('stats are empty for a quiet server', async () => {
  const data = await ok(`/guilds/${GUILD}/stats`);
  assert.deepEqual(data.activity, { step: 'day', buckets: [] });
  assert.equal(data.totals.gameMs, 0);
});

test('longer periods are grouped by week, then by month from the 1st', () => {
  const now = Date.parse('2026-06-15T17:00:00Z');
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(GUILD, 'u1', 'Halo', now - 500 * 24 * HOUR, now - 500 * 24 * HOUR + HOUR);
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(GUILD, 'u1', 'Halo', now - 50 * 24 * HOUR, now - 50 * 24 * HOUR + HOUR);
  assert.equal(activity(GUILD, now - 100 * 24 * HOUR, now, 'UTC').step, 'week');
  const months = activity(GUILD, 0, now, 'UTC');
  assert.equal(months.step, 'month');
  assert.equal(new Date(months.buckets[1].start).getUTCDate(), 1);
  assert.equal(months.buckets.reduce((sum, b) => sum + b.ms, 0), 2 * HOUR);
});

test('games added and hidden from the web are put down to whoever did it', async (t) => {
  // Steam is faked, as a real search makes the test as slow and unreliable as Steam is
  fakeSteam(t);
  await ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'Valheim' }, headers: as('chuck@example.com', 'Chuck') });
  assert.equal((db.prepare('SELECT added_by FROM games WHERE guild_id = ?').get(GUILD) as any).added_by, 'web:chuck@example.com');
});

test('games can be merged and separated, and it shows in the stats and activity', async () => {
  addPlay('u1', 'Halo Infinite', 10, 2);
  addPlay('u2', 'haloinfinite', 9, 2);
  addPlay('u1', 'Halo 6', 5, 1);
  noteGame(GUILD, 'Halo Infinite');
  noteGame(GUILD, 'haloinfinite');
  noteGame(GUILD, 'Halo 6');
  const before = (await ok(`/guilds/${GUILD}/game-names`)).games;
  assert.deepEqual(before.map((g: any) => [g.name, Math.round(g.ms / HOUR), g.spellings]), [['Halo Infinite', 3, ['haloinfinite']], ['Halo 6', 1, []]]);

  await ok(`/guilds/${GUILD}/game-names/merge`, { method: 'POST', json: { names: ['Halo Infinite', 'Halo 6'], into: 'Halo Infinite' } });
  const merged = await ok(`/guilds/${GUILD}/stats?period=week&game=Halo Infinite`);
  assert.equal(Math.round(merged.totals.gameMs / HOUR), 4);
  assert.deepEqual(merged.spellings, ['Halo 6', 'haloinfinite']);
  assert.deepEqual((await ok(`/guilds/${GUILD}/stats?period=week`)).spellings, []);

  await ok(`/guilds/${GUILD}/game-names/separate`, { method: 'POST', json: { name: 'Halo 6' } });
  assert.deepEqual((await ok(`/guilds/${GUILD}/game-names`)).games.map((g: any) => g.name), ['Halo Infinite', 'Halo 6']);
  const actions = (await ok(`/guilds/${GUILD}/activity`)).entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes('Merged Halo Infinite, Halo 6 into Halo Infinite'), actions.join(', '));
  assert.ok(actions.includes('Separated Halo 6'), actions.join(', '));
});

test('bad game name changes are refused', async () => {
  for (const [path, json, why] of [
    ['merge', { names: 'Halo', into: 'Halo' }, /Pick the games/],
    ['merge', { names: [1, 2], into: 'Halo' }, /Pick the games/],
    ['merge', { names: ['A', 'B'] }, /Pick the games/],
    ['merge', { names: ['A', 'B'], into: 'A' }, /no game called A/],
    ['separate', {}, /Pick a spelling/],
    ['separate', { name: 'Nothing' }, /no game called/],
  ] as [string, unknown, RegExp][]) {
    const res = await call(`/guilds/${GUILD}/game-names/${path}`, { method: 'POST', json });
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.match(((await res.json()) as { error: string }).error, why);
  }
  assert.equal((await call(`/guilds/${GUILD}/game-names/other`, { method: 'POST', json: {} })).status, 404);
});

test('names saved from Discord fit the library', async (t) => {
  discordCdn(t);
  const names = [
    ['a', 'Air Horn!', 'air-horn'],
    ['b', 'Été fou', 'ete-fou'],
    ['c', '  --spaced--  ', 'spaced'],
    ['1234567890', '🔊🔊', 'sound-567890'],
    ['0000000001', 'x', 'sound-000001'],
    ['f', 'y'.repeat(32), 'y'.repeat(32)],
    ['g', 'y'.repeat(32), `${'y'.repeat(30)}-2`],
    ['h', 'AIR HORN', 'air-horn-2'],
    ['i', 'air horn', 'air-horn-3'],
  ];
  for (const [id, name, saved] of names) {
    discordSounds.set(id, { name });
    assert.equal((await save(id)).name, saved);
  }
});

const addGame = (name: string) => ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { name } });

const gameCalled = async (name: string) => ((await library()).games as any[]).find((g) => g.name === name);

const insertGame = (name: string, appid: number | null = null) => Number(db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, 'u1')`).run(GUILD, name, appid).lastInsertRowid);

const mark = (id: number, user: string, json: unknown) => ok(`/guilds/${GUILD}/games/${id}/members/${user}`, { method: 'PATCH', json });

function fakeSteam(t: TestContext, found: Record<string, number> = {}, down = false) {
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    if (down) return new Response('', { status: 503 });
    if (String(url).includes('GetItems')) return new Response(JSON.stringify({ response: {} }));
    const term = new URL(url).searchParams.get('term')!;
    const match = Object.keys(found).find((name) => name.toLowerCase() === term.toLowerCase());
    return new Response(JSON.stringify({ items: match ? [{ id: found[match], name: match }] : [] }));
  });
}

test('adds a game by name, using Steam’s name and app ID when it has one', async (t) => {
  fakeSteam(t, { 'Deep Rock Galactic': 548430 });
  assert.deepEqual(await addGame('  deep rock galactic '), { name: 'Deep Rock Galactic', added: true });
  const game = await gameCalled('Deep Rock Galactic');
  assert.equal(game.appid, 548430);
  assert.equal(game.url, 'https://store.steampowered.com/app/548430');
  assert.deepEqual(activityText(), ['Added **Deep Rock Galactic** to the game library']);
  assert.deepEqual(await addGame('Deep Rock Galactic'), { name: 'Deep Rock Galactic', added: false });
  assert.equal((await library()).games.length, 1);
  assert.equal(activityText().length, 1);
});

test('a game Steam doesn’t know is added as typed, once', async (t) => {
  fakeSteam(t);
  assert.deepEqual(await addGame('Tabletop Night'), { name: 'Tabletop Night', added: true });
  assert.deepEqual(await addGame('tabletop night'), { name: 'Tabletop Night', added: false });
  const game = await gameCalled('Tabletop Night');
  assert.equal(game.appid, null);
  assert.equal(game.url, null);
});

test('adds a game by its store link, and turns down a link that leads nowhere', async (t) => {
  fakeSteam(t);
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer) VALUES (620, 'Portal 2', 1)`).run();
  assert.equal((await addGame('https://store.steampowered.com/app/620/Portal_2/')).name, 'Portal 2');
  assert.equal((await gameCalled('Portal 2')).appid, 620);
  assert.match(await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'https://store.steampowered.com/app/99999999/' } }), /doesn’t know/);
  assert.match(await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'https://example.com/nope' } }), /doesn’t know/);
  assert.equal((await library()).games.length, 1);
});

test('turns down a bad name, and says when Steam can’t be asked rather than adding it wrongly', async (t) => {
  for (const name of ['', '   ', 5, 'x'.repeat(101), `https://store.steampowered.com/${'x'.repeat(200)}`]) await refused(400, `/guilds/${GUILD}/games`, { method: 'POST', json: { name } });
  fakeSteam(t, {}, true);
  mock.method(console, 'error', () => {});
  assert.match(await refused(502, `/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'Valheim' } }), /couldn’t be reached/);
  assert.deepEqual((await library()).games, []);
});

test('lists who has a game, who needs it, who wants it and any sale', async () => {
  const id = insertGame('Valheim', 892970);
  insertGame('Other', 1);
  db.prepare(`INSERT INTO game_owners (game_id, user_id) VALUES (?, 'u1')`).run(id);
  db.prepare(`INSERT INTO game_owners (game_id, user_id) SELECT id, 'u2' FROM games WHERE name = 'Other'`).run();
  db.prepare(`INSERT INTO game_owners (game_id, user_id) VALUES (?, 'gone')`).run(id);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u3', 's3')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, playtime) VALUES ('s3', 892970, 5)`).run();
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (?, 'u2')`).run(id);
  db.prepare(`INSERT INTO sale_prices (country, appid, discount, was, price, final) VALUES ('us', 892970, 40, '$20.00', '$12.00', 1200), ('de', 1, 90, '20€', '2€', 200)`).run();
  const { games, members } = await library();
  const [other, valheim] = games;
  assert.deepEqual(valheim.owners, [{ id: 'u1', name: 'Ana', steam: false }, { id: 'u3', name: 'Cy', steam: true }]);
  assert.deepEqual(valheim.needs, [{ id: 'u2', name: 'Ben' }]);
  assert.deepEqual(valheim.wanted, [{ id: 'u2', name: 'Ben' }]);
  assert.deepEqual(valheim.sale, { discount: 40, price: '$12.00', was: '$20.00' });
  assert.equal(other.sale, null, 'another region’s sale');
  assert.deepEqual(members.map((m: { name: string }) => m.name), ['Ana', 'Ben', 'Cy']);
});

test('sets a game’s player limit and Steam link, leaving the other as it was', async () => {
  const id = insertGame('Valheim');
  insertGame('Taken', 7);
  const url = `/guilds/${GUILD}/games/${id}`;
  await ok(url, { method: 'PATCH', json: { maxPlayers: 10 } });
  assert.equal((await gameCalled('Valheim')).maxPlayers, 10);
  await ok(url, { method: 'PATCH', json: { steam: 'https://store.steampowered.com/app/892970/Valheim/' } });
  assert.equal((await gameCalled('Valheim')).appid, 892970);
  assert.equal((await gameCalled('Valheim')).maxPlayers, 10);
  await ok(url, { method: 'PATCH', json: { maxPlayers: null, steam: '' } });
  assert.equal((await gameCalled('Valheim')).maxPlayers, null);
  assert.equal((await gameCalled('Valheim')).appid, null);

  for (const maxPlayers of [0, 101, 2.5, '4']) await refused(400, url, { method: 'PATCH', json: { maxPlayers } });
  await ok(url, { method: 'PATCH', json: { maxPlayers: 1 } });
  await ok(url, { method: 'PATCH', json: { maxPlayers: 100 } });
  assert.match(await refused(400, url, { method: 'PATCH', json: { steam: 'not a link' } }), /Steam app ID/);
  assert.match(await refused(409, url, { method: 'PATCH', json: { steam: '7' } }), /Taken already has/);
  await refused(404, `/guilds/${GUILD}/games/9999`, { method: 'PATCH', json: {} });
  await refused(405, `/guilds/${GUILD}/games/${id}`, { method: 'PUT', json: {} });
  await refused(405, `/guilds/${GUILD}/games/${id}/members/u1`, { method: 'DELETE' });
});

test('marks who owns and wants a game, and owning ends wanting', async () => {
  const id = insertGame('Valheim', 892970);
  await mark(id, 'u1', { wants: true });
  assert.deepEqual((await gameCalled('Valheim')).wanted.map((w: { id: string }) => w.id), ['u1']);
  await mark(id, 'u1', { wants: false });
  assert.deepEqual((await gameCalled('Valheim')).wanted, []);
  await mark(id, 'u1', { wants: true });
  await mark(id, 'u1', { owns: true });
  await mark(id, 'u1', { owns: true });
  const owned = await gameCalled('Valheim');
  assert.deepEqual(owned.owners, [{ id: 'u1', name: 'Ana', steam: false }]);
  assert.deepEqual(owned.wanted, []);
  assert.match(await refused(409, `/guilds/${GUILD}/games/${id}/members/u1`, { method: 'PATCH', json: { wants: true } }), /Ana already owns Valheim/);
  await mark(id, 'u1', { owns: false });
  assert.deepEqual((await gameCalled('Valheim')).owners, []);
  assert.equal(activityText().at(-1), 'Marked Ana as not owning **Valheim**');
});

test('Steam ownership can’t be changed by hand, and only Steam games can be wanted', async () => {
  const id = insertGame('Valheim', 892970);
  const noSteam = insertGame('Tabletop');
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u3', 's3')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, playtime) VALUES ('s3', 892970, 5)`).run();
  const url = `/guilds/${GUILD}/games/${id}/members`;
  assert.match(await refused(409, `${url}/u3`, { method: 'PATCH', json: { owns: false } }), /owns it on Steam/);
  assert.match(await refused(409, `${url}/u3`, { method: 'PATCH', json: { owns: true } }), /owns it on Steam/);
  assert.equal((await gameCalled('Valheim')).owners[0].steam, true);
  assert.match(await refused(409, `/guilds/${GUILD}/games/${noSteam}/members/u1`, { method: 'PATCH', json: { wants: true } }), /needs a Steam link/);
  await refused(404, `${url}/nobody`, { method: 'PATCH', json: { owns: true } });
  await refused(400, `${url}/u1`, { method: 'PATCH', json: {} });
  await refused(400, `${url}/u1`, { method: 'PATCH', json: { owns: 'yes' } });
});

test('removing a game clears its marks, and a game in another server can’t be touched', async () => {
  const id = insertGame('Valheim', 892970);
  await mark(id, 'u1', { owns: true });
  await mark(id, 'u2', { wants: true });
  const { lastInsertRowid } = db.prepare(`INSERT INTO games (guild_id, name, added_by) VALUES ('elsewhere', 'Theirs', 'x')`).run();
  await refused(404, `/guilds/${GUILD}/games/${lastInsertRowid}`, { method: 'DELETE' });
  await refused(404, `/guilds/${GUILD}/games/${lastInsertRowid}`, { method: 'PATCH', json: { maxPlayers: 2 } });
  await refused(404, `/guilds/${GUILD}/games/${lastInsertRowid}/members/u1`, { method: 'PATCH', json: { owns: true } });

  await ok(`/guilds/${GUILD}/games/${id}`, { method: 'DELETE' });
  assert.deepEqual((await library()).games, []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM game_owners WHERE game_id = ?').get(id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM game_wants WHERE game_id = ?').get(id) as { n: number }).n, 0);
  assert.equal(activityText().at(-1), 'Removed **Valheim** from the game library');
  db.prepare(`DELETE FROM games WHERE guild_id = 'elsewhere'`).run();
});

function linkSteam(user: string, games: [number, string | null][]) {
  db.prepare('INSERT INTO steam_links (user_id, steam_id) VALUES (?, ?)').run(user, `steam-${user}`);
  for (const [appid, name] of games) db.prepare('INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES (?, ?, ?, 1)').run(`steam-${user}`, appid, name);
}

const owned = async () => (await ok(`/guilds/${GUILD}/games/owned`)).games as { appid: number; name: string; owners: string[] }[];

test('lists what members own, most shared first, without the library or people from other servers', async () => {
  insertGame('Already Listed', 1);
  linkSteam('u1', [[1, 'Already Listed'], [2, 'Zebra Game'], [3, 'Shared Game'], [4, 'Alpha Game']]);
  linkSteam('u2', [[3, 'Shared Game'], [5, null]]);
  linkSteam('stranger', [[6, 'Not From Here'], [3, 'Shared Game']]);
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer) VALUES (5, 'Named By Steam', 0), (3, 'Other Spelling', 0)`).run();
  assert.deepEqual(await owned(), [
    { appid: 3, name: 'Shared Game', owners: ['Ana', 'Ben'] },
    { appid: 4, name: 'Alpha Game', owners: ['Ana'] },
    { appid: 5, name: 'Named By Steam', owners: ['Ben'] },
    { appid: 2, name: 'Zebra Game', owners: ['Ana'] },
  ]);
  db.prepare('DELETE FROM app_info WHERE appid IN (3, 5)').run();
});

test('a game nobody has a name for is left off', async () => {
  linkSteam('u1', [[8, null]]);
  db.prepare('DELETE FROM app_info WHERE appid = 8').run();
  assert.deepEqual(await owned(), []);
});

test('adds a game from the owned list, once, with its app ID', async () => {
  linkSteam('u1', [[3, 'Shared Game']]);
  assert.deepEqual(await ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { appid: 3 } }), { name: 'Shared Game', added: true });
  const game = await gameCalled('Shared Game');
  assert.equal(game.appid, 3);
  assert.deepEqual(game.owners, [{ id: 'u1', name: 'Ana', steam: true }]);
  assert.deepEqual(await owned(), []);
  assert.deepEqual(activityText(), ['Added **Shared Game** to the game library']);
  assert.match(await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { appid: 3 } }), /isn’t on the list/);
});

test('picking a game already listed without Steam links it instead of adding it twice', async () => {
  insertGame('shared game');
  linkSteam('u1', [[3, 'Shared Game']]);
  assert.deepEqual(await ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { appid: 3 } }), { name: 'shared game', added: false });
  const { games } = await library();
  assert.equal(games.length, 1);
  assert.equal(games[0].appid, 3);
});

test('only games on the list can be picked', async () => {
  linkSteam('stranger', [[6, 'Not From Here']]);
  for (const appid of [6, 999, 'abc', 1.5, null]) await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { appid } });
  assert.deepEqual((await library()).games, []);
});

test('the owned list only takes GET', async () => {
  await refused(404, `/guilds/${GUILD}/games/owned`, { method: 'DELETE' });
});

const VALVE = '76561197960287930';

const OTHER_STEAM = '76561197960287931';

const linkUrl = (user: string) => `/guilds/${GUILD}/steam-links/${user}`;

const linkTo = (user: string, profile: unknown) => ok(linkUrl(user), { method: 'PUT', json: { profile } });

function steamApi(t: TestContext, state = { down: false, ownedDown: false }) {
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (String(input).startsWith(base)) return real(input, init);
    if (state.down) throw new Error('offline');
    const url = new URL(input);
    if (url.pathname.includes('ResolveVanityURL')) {
      return new Response(JSON.stringify({ response: url.searchParams.get('vanityurl') === 'gaben' ? { success: 1, steamid: VALVE } : { success: 42 } }));
    }
    if (url.pathname.includes('GetOwnedGames')) {
      if (state.ownedDown) return new Response('', { status: 503 });
      const games = [{ appid: 10, name: 'Game One', playtime_forever: 1 }, { appid: 20, name: 'Game Two', playtime_forever: 2 }];
      return new Response(JSON.stringify({ response: url.searchParams.get('steamid') === VALVE ? { game_count: 2, games } : {} }));
    }
    return new Response(JSON.stringify({ response: {} }));
  });
  mock.method(console, 'error', () => {});
  return state;
}

test('lists this server’s members, linked first, without bots or other servers’ people', async (t) => {
  steamApi(t);
  linkSteam('u2', [[1, 'One'], [2, 'Two']]);
  linkSteam('stranger', [[3, 'Three']]);
  const { configured, members } = await accounts();
  assert.equal(configured, true);
  assert.deepEqual(members.map((m) => m.name), ['Ben', 'Ana', 'Cy']);
  assert.deepEqual(members[0].steam, { url: 'https://steamcommunity.com/profiles/steam-u2', private: false, games: 2 });
  assert.equal(members[1].steam, null);
});

test('links someone by profile link, custom URL name or ID, and reads their library', async (t) => {
  steamApi(t);
  assert.deepEqual(await linkTo('u1', `https://steamcommunity.com/profiles/${VALVE}/`), { games: 2 });
  assert.deepEqual(await account('u1'), { url: `https://steamcommunity.com/profiles/${VALVE}`, private: false, games: 2 });
  assert.deepEqual(await linkTo('u2', 'https://steamcommunity.com/id/gaben'), { games: 2 });
  assert.deepEqual(await linkTo('u3', 'gaben'), { games: 2 });
  assert.deepEqual(await linkTo('u3', VALVE), { games: 2 });
  assert.equal(activityText().at(-1), 'Linked Cy’s Steam account');
  for (const line of activityText()) assert.doesNotMatch(line, /7656/);
});

test('changing a link replaces the old library, and a private one says so', async (t) => {
  steamApi(t);
  await linkTo('u1', VALVE);
  assert.deepEqual(await linkTo('u1', OTHER_STEAM), { games: null });
  assert.deepEqual(await account('u1'), { url: `https://steamcommunity.com/profiles/${OTHER_STEAM}`, private: true, games: 0 });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM steam_owned').get() as { n: number }).n, 0);
});

test('unlinking forgets a library, unless someone else still has that account', async (t) => {
  steamApi(t);
  await linkTo('u1', VALVE);
  await linkTo('u2', VALVE);
  await ok(linkUrl('u1'), { method: 'DELETE' });
  assert.equal(await account('u1'), null);
  assert.equal((await account('u2'))!.games, 2);
  await ok(linkUrl('u2'), { method: 'DELETE' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM steam_owned').get() as { n: number }).n, 0);
  assert.equal(activityText().at(-1), 'Unlinked Ben’s Steam account');
  assert.match(await refused(404, linkUrl('u2'), { method: 'DELETE' }), /don’t have a linked/);
});

test('turns down a bad profile, someone not in the server and other methods', async (t) => {
  steamApi(t);
  for (const profile of ['', '   ', 5, null, 'x'.repeat(201)]) assert.match(await refused(400, linkUrl('u1'), { method: 'PUT', json: { profile } }), /Paste their/);
  assert.match(await refused(400, linkUrl('u1'), { method: 'PUT', json: { profile: 'nobody-here' } }), /Couldn’t find/);
  assert.match(await refused(400, linkUrl('u1'), { method: 'PUT', json: { profile: 'not a profile!' } }), /Couldn’t find/);
  assert.match(await refused(404, linkUrl('stranger'), { method: 'PUT', json: { profile: VALVE } }), /aren’t in this server/);
  await refused(404, linkUrl('stranger'), { method: 'DELETE' });
  await refused(405, linkUrl('u1'), { method: 'POST' });
  assert.equal(await account('u1'), null);
  assert.deepEqual(activityText(), []);
});

test('with Steam down, nothing changes', async (t) => {
  const state = steamApi(t);
  await linkTo('u1', VALVE);
  state.ownedDown = true;
  assert.match(await refused(502, linkUrl('u1'), { method: 'PUT', json: { profile: OTHER_STEAM } }), /couldn’t be reached/);
  assert.match(await refused(502, linkUrl('u2'), { method: 'PUT', json: { profile: VALVE } }), /couldn’t be reached/);
  assert.equal(await account('u2'), null);
  assert.deepEqual(await account('u1'), { url: `https://steamcommunity.com/profiles/${VALVE}`, private: false, games: 2 });
  state.ownedDown = false;
  state.down = true;
  assert.match(await refused(502, linkUrl('u3'), { method: 'PUT', json: { profile: 'gaben' } }), /couldn’t be reached/);
  assert.equal(await account('u3'), null);
});

test('without an API key, it says so instead of trying', async () => {
  const key = config.steamApiKey;
  config.steamApiKey = null;
  linkSteam('u1', [[1, 'One']]);
  assert.equal((await accounts()).configured, false);
  assert.match(await refused(409, linkUrl('u2'), { method: 'PUT', json: { profile: VALVE } }), /STEAM_API_KEY/);
  assert.match(await refused(409, linkUrl('u1'), { method: 'DELETE' }), /STEAM_API_KEY/);
  assert.match(await refused(409, `/guilds/${GUILD}/steam-refresh`, { method: 'POST' }), /STEAM_API_KEY/);
  config.steamApiKey = key;
});

test('refreshes libraries', async (t) => {
  steamApi(t);
  await linkTo('u1', VALVE);
  db.prepare('DELETE FROM steam_owned').run();
  await ok(`/guilds/${GUILD}/steam-refresh`, { method: 'POST' });
  assert.equal((await account('u1'))!.games, 2);
  assert.equal(activityText().at(-1), 'Refreshed Steam libraries');
  await refused(404, `/guilds/${GUILD}/steam-refresh`);
});

test('/steam link, list and unlink work as they did', async (t) => {
  steamApi(t);
  const run = async (sub: string, values: Record<string, unknown>) => {
    let reply: any;
    const answer = async (r: unknown) => void (reply = r);
    await steam.commands![0].run({
      inCachedGuild: () => true,
      guild,
      guildId: GUILD,
      user: { id: 'u1', toString: () => '<@u1>' },
      options: { getSubcommand: () => sub, getUser: () => null, getString: (name: string) => values[name] },
      deferReply: async () => {},
      editReply: answer,
      reply: answer,
    } as never);
    return reply;
  };
  assert.match((await run('link', { profile: 'nobody-here' })) as string, /Couldn't find/);
  assert.equal((await run('link', { profile: VALVE })).content, '🔗 Linked <@u1> (2 games).');
  assert.match((await run('link', { profile: OTHER_STEAM })).content, /Linked <@u1>, but: .*private/);
  assert.match((await run('list', {})).embeds[0].toJSON().description, new RegExp(`<@u1> · \\[profile\\]\\(https://steamcommunity.com/profiles/${OTHER_STEAM}\\) · 🔒`));
  assert.equal((await run('unlink', {})).content, 'Unlinked <@u1>.');
  assert.equal(await account('u1'), null);
  const empty = await run('list', {});
  assert.match(empty.content, /Nobody here has linked/);
  assert.equal(empty.components[0].toJSON().components[0].custom_id, 'steam:link');
});

test('the Link my Steam button opens a form that links whoever fills it in', async (t) => {
  steamApi(t);
  let modal: any;
  await steam.onButton!({ customId: 'steam:link', showModal: async (m: unknown) => void (modal = m) } as never);
  assert.equal(modal.toJSON().components[0].components[0].custom_id, 'profile');
  const submit = async (profile: string) => {
    let answer: string | undefined;
    let flags: unknown;
    await steam.onModal!({
      customId: 'steam:link',
      guildId: GUILD,
      user: { id: 'u2' },
      fields: { getTextInputValue: () => profile },
      deferReply: async (o: { flags: unknown }) => void (flags = o.flags),
      editReply: async (r: string) => void (answer = r),
    } as never);
    assert.ok(flags, 'answered privately');
    return answer!;
  };
  assert.match(await submit('nobody-here'), /Couldn’t find that Steam profile/);
  assert.equal(await submit(`  ${VALVE} `), '🔗 Linked (2 games). Picks and sale alerts count your library now.');
  assert.equal((await account('u2'))!.games, 2);
  assert.equal(activityText().at(-1), 'Linked their Steam account');
  unlinkSteam('u2');
});

const pingsUrl = `/guilds/${GUILD}/game-pings`;

const addPing = (json: unknown) => ok(pingsUrl, { method: 'POST', json });

const pingRows = () => db.prepare('SELECT role_id, guild_id, name, created FROM game_roles ORDER BY name').all() as any[];

test('makes a role for a game, and removing it deletes the role', async () => {
  assert.deepEqual(await addPing({ game: '  Valheim ' }), { warning: null });
  const [ping] = (await ok(pingsUrl)).pings;
  assert.deepEqual(ping, { id: ping.id, game: 'Valheim', role: 'Valheim', people: 0, made: true });
  assert.equal(roles.get(ping.id)!.mentionable, true);
  assert.equal(activityText().at(-1), 'Added game pings for **Valheim**');

  await ok(`${pingsUrl}/${ping.id}`, { method: 'DELETE' });
  assert.equal(roles.has(ping.id), false);
  assert.deepEqual(pingRows(), []);
  assert.equal(activityText().at(-1), 'Removed game pings for **Valheim**');
});

test('uses a role that’s picked, and leaves it in place when removed', async () => {
  const gamers = roles.get('r1')!;
  gamers.members = new Map([['u1', {}], ['u2', {}]]);
  await addPing({ game: 'Halo', roleId: 'r1' });
  assert.deepEqual((await ok(pingsUrl)).pings, [{ id: 'r1', game: 'Halo', role: 'Gamers', people: 2, made: false }]);
  await ok(`${pingsUrl}/r1`, { method: 'DELETE' });
  assert.equal(roles.has('r1'), true);
  assert.deepEqual(pingRows(), []);
  gamers.members = new Map();
});

test('only offers games and roles that can still be added', async () => {
  insertGame('Valheim');
  insertGame('Halo');
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'u1', 'Played Game', 'voice', 0, 1)`).run(GUILD);
  let data = await ok(pingsUrl);
  assert.deepEqual(data.games, ['Halo', 'Played Game', 'Valheim']);
  assert.deepEqual(data.roles, [{ id: 'r1', name: 'Gamers' }]);
  await addPing({ game: 'VALHEIM', roleId: 'r1' });
  data = await ok(pingsUrl);
  assert.deepEqual(data.games, ['Halo', 'Played Game']);
  assert.deepEqual(data.roles, []);
});

test('refuses roles the bot can’t hand out, and nothing is saved', async () => {
  for (const roleId of [GUILD, 'r2']) assert.match(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Halo', roleId } }), /^I can’t hand out /);
  assert.equal(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Halo', roleId: '333' } }), 'I can’t hand out @Mods. Pick a normal role below my role (Slopkeeper), or leave the role out and I’ll make one.');
  assert.deepEqual(pingRows(), []);
});

test('a game has one role, and a role is for one game', async () => {
  roles.set('555', role('555', 'Shooters', 1, { guild: { members: { me } } }));
  await addPing({ game: 'Halo', roleId: '555' });
  assert.equal(await refused(409, pingsUrl, { method: 'POST', json: { game: 'halo' } }), 'halo already pings @Shooters.');
  assert.equal(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Valheim', roleId: '555' } }), '@Shooters already pings for Halo.');
  assert.equal(pingRows().length, 1);
  roles.delete('555');
});

test('refuses a bad game ping', async () => {
  for (const game of ['', '   ', 'x'.repeat(101), 5, undefined]) await refused(400, pingsUrl, { method: 'POST', json: { game } });
  await refused(404, pingsUrl, { method: 'POST', json: { game: 'Halo', roleId: 'no-such-role' } });
  assert.deepEqual(pingRows(), []);
});

test('needs Manage Roles to add game pings', async () => {
  setFake({ manageRoles: false });
  const sizeBefore = roles.size;
  assert.match(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Halo' } }), /Manage Roles/);
  assert.equal(roles.size, sizeBefore);
});

test('says so when Discord won’t make the role', async () => {
  setFake({ refuseDiscord: new Error('Missing Permissions') });
  assert.match(await refused(502, pingsUrl, { method: 'POST', json: { game: 'Halo' } }), /Manage Roles/);
  assert.deepEqual(pingRows(), []);
  assert.deepEqual(activityText(), []);
});

test('warns about a role pings can’t reach', async () => {
  setFake({ mentionEveryone: false });
  roles.set('556', role('556', 'Quiet', 1, { mentionable: false, guild: { members: { me } } }));
  const { warning } = await addPing({ game: 'Halo', roleId: '556' });
  assert.equal(warning, '⚠️ Pings for @Quiet won’t notify anyone yet. Turn on Allow anyone to @mention this role in Server Settings → Roles.');
  roles.delete('556');
});

test('shows a role deleted while the bot was away, and it can still be cleared', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name, created) VALUES ('gone', ?, 'Halo', 1)`).run(GUILD);
  assert.deepEqual((await ok(pingsUrl)).pings, [{ id: 'gone', game: 'Halo', role: null, people: 0, made: true }]);
  await ok(`${pingsUrl}/gone`, { method: 'DELETE' });
  assert.deepEqual(pingRows(), []);
});

test('game pings stay within their server', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name, created) VALUES ('theirs', 'other', 'Halo', 1)`).run();
  assert.deepEqual((await ok(pingsUrl)).pings, []);
  await refused(404, `${pingsUrl}/theirs`, { method: 'DELETE' });
  assert.equal(pingRows().length, 1);
  await addPing({ game: 'Halo' });
  assert.equal(pingRows().length, 2);
});

const hiddenUrl = `/guilds/${GUILD}/hidden-games`;

const hiddenNames = async () => ((await ok(hiddenUrl)).games as any[]).map((g) => g.name);

test('a game hidden or let back in changes what’s suggested', async (t) => {
  fakeSteam(t);
  const id = insertGame('Portal 2', 620);
  await mark(id, 'u1', { owns: true });
  const suggested = async () => (await candidatesFor(guild as never, ['u1']))!.candidates.map((c) => c.name);
  assert.deepEqual(await suggested(), ['Portal 2']);

  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  assert.deepEqual((await ok(hiddenUrl)).games, [{ appid: 620, name: 'Portal 2' }]);
  assert.deepEqual(await suggested(), []);
  assert.equal(activityText().at(-1), 'Hid **Portal 2** from suggestions');

  await ok(`${hiddenUrl}/620`, { method: 'DELETE' });
  assert.deepEqual(await hiddenNames(), []);
  assert.deepEqual(await suggested(), ['Portal 2']);
  assert.equal(activityText().at(-1), 'Let **Portal 2** be suggested again');
  await refused(404, `${hiddenUrl}/620`, { method: 'DELETE' });
});

test('hiding twice changes nothing', async () => {
  insertGame('Portal 2', 620);
  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  assert.deepEqual(await hiddenNames(), ['Portal 2']);
});

test('only a library game with a Steam link can be hidden', async () => {
  insertGame('Board Game');
  for (const id of ['620', '0', 'abc', 'null']) await refused(404, `${hiddenUrl}/${id}`, { method: 'PUT' });
  assert.deepEqual(await hiddenNames(), []);
});

test('hidden games stay within their server', async () => {
  db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES ('other', 'Theirs', 620, 'u1')`).run();
  db.prepare(`INSERT INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES ('other', 730, 'Also Theirs', 'u1')`).run();
  assert.deepEqual(await hiddenNames(), []);
  await refused(404, `${hiddenUrl}/620`, { method: 'PUT' });
  await refused(404, `${hiddenUrl}/730`, { method: 'DELETE' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hidden_apps').get() as { n: number }).n, 1);
});

test('letting a game back in here leaves it hidden in another server', async () => {
  insertGame('Portal 2', 620);
  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  db.prepare(`INSERT INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES ('other', 620, 'Portal 2', 'u1')`).run();
  await ok(`${hiddenUrl}/620`, { method: 'DELETE' });
  assert.deepEqual((db.prepare('SELECT guild_id FROM hidden_apps').all() as { guild_id: string }[]).map((r) => r.guild_id), ['other']);
});

const playedIn = (user: string, game: string, start: number, end: number) =>
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, '702', ?, ?)`).run(GUILD, user, game, start, end);

async function ownedGames(t: TestContext) {
  fakeSteam(t);
  const [halo, valheim, hades] = [insertGame('Halo'), insertGame('Valheim', 892970), insertGame('Hades', 1145360)];
  for (const id of [halo, valheim, hades]) await mark(id, 'u1', { owns: true });
  for (const id of [halo, valheim]) await mark(id, 'u2', { owns: true });
  return { halo, valheim, hades };
}

test('picks from a voice channel’s people, splitting what fits from what’s one purchase away', async (t) => {
  await ownedGames(t);
  const data = await pick('channel=702');
  assert.equal(data.counted, 2);
  assert.deepEqual(data.ready.map((g: any) => g.name).sort(), ['Halo', 'Valheim']);
  assert.deepEqual(data.almost.map((g: any) => [g.name, g.missing]), [['Hades', ['Ben']]]);
  assert.equal(data.ready.find((g: any) => g.name === 'Valheim').url, 'https://store.steampowered.com/app/892970');
});

test('picks from people chosen by hand, and matches what /whatdoweplay works from', async (t) => {
  await ownedGames(t);
  const data = await pick('users=u1,u2,u1');
  const direct = await candidatesFor(guild as never, ['u1', 'u2']);
  assert.deepEqual(data.ready.map((g: any) => g.name).sort(), direct!.candidates.filter((c) => !c.missing.length).map((c) => c.name).sort());
  assert.equal(data.people, 2);
});

test('compares what each person has put into a game', async (t) => {
  await ownedGames(t);
  const now = Date.now();
  playedIn('u1', 'Halo', now - hours(5), now - hours(3));
  playedIn('u2', 'Halo', now - hours(4), now - hours(1));
  const { ready } = await pick('users=u1,u2');
  const halo = ready.find((g: any) => g.name === 'Halo');
  assert.equal(halo.playedMs, hours(5));
  assert.equal(halo.last, now - hours(1));
  assert.deepEqual(halo.players.map((p: any) => [p.name, p.playedMs]), [['Ana', hours(2)], ['Ben', hours(3)]]);
  assert.equal(ready.find((g: any) => g.name === 'Valheim').playedMs, 0);
});

test('adds Steam hours per person, and leaves out what’s hidden or too full', async (t) => {
  const { halo } = await ownedGames(t);
  await ok(`/guilds/${GUILD}/games/${halo}`, { method: 'PATCH', json: { maxPlayers: 1 } });
  await ok(`/guilds/${GUILD}/hidden-games/892970`, { method: 'PUT' });
  assert.deepEqual((await pick('users=u1,u2')).ready, []);
  assert.deepEqual((await pick('users=u1')).ready.map((g: any) => g.name).sort(), ['Hades', 'Halo']);
});

test('leaves Steam hours blank for someone with no Steam copy, rather than zero', async (t) => {
  await ownedGames(t);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime, recent) VALUES ('s1', 892970, 'Valheim', 120, 30)`).run();
  const valheim = (await pick('users=u1,u2')).ready.find((g: any) => g.name === 'Valheim');
  assert.deepEqual(valheim.players.map((p: any) => [p.name, p.steamMinutes, p.recentMinutes]), [['Ana', 120, 30], ['Ben', null, 0]]);
  assert.deepEqual([valheim.steamMinutes, valheim.recentMinutes], [120, 30]);
});

test('finds time played under another spelling of a game', async (t) => {
  await ownedGames(t);
  playedIn('u1', 'HALO', Date.now() - hours(2), Date.now() - hours(1));
  assert.equal((await pick('users=u1,u2')).ready.find((g: any) => g.name === 'Halo').playedMs, hours(1));
});

test('shows a game’s kind and who’s on a family copy', async (t) => {
  await ownedGames(t);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s1', 620, 'Portal 2', 1)`).run();
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer, coop, pvp, deck, shareable) VALUES (620, 'Portal 2', 1, 1, 0, 3, 1)`).run();
  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'PUT', json: { with: 'u3' } });
  await ok(`/guilds/${GUILD}/steam-links/u1/family`, { method: 'PUT', json: { with: 'u3' } });
  await ok(`/guilds/${GUILD}/steam-links/u1/family`, { method: 'DELETE' });
  assert.equal((await pick('users=u1,u2')).almost.find((g: any) => g.name === 'Portal 2').missing[0], 'Ben');
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u3', 's3')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s3', 620, 'Portal 2', 1)`).run();
  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'DELETE' });
  await refused(404, `/guilds/${GUILD}/steam-links/u2/family`, { method: 'DELETE' });
  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'PUT', json: { with: 'u3' } });
  const game = (await pick('users=u1,u2')).ready.find((g: any) => g.name === 'Portal 2');
  assert.deepEqual([game.borrowed, game.coop, game.pvp, game.deck], [['Ben'], true, false, 3]);
});

test('shows families on Steam accounts, and on the game list', async (t) => {
  fakeSteam(t);
  insertGame('Portal 2', 620);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s1', 620, 'Portal 2', 1)`).run();
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer, shareable) VALUES (620, 'Portal 2', 1, 1)`).run();
  await mark(insertGame('Linked Ben'), 'u2', { owns: true });
  const before = (await ok(`/guilds/${GUILD}/games`)).games.find((g: any) => g.name === 'Portal 2');
  assert.deepEqual([before.family, before.needs.map((p: any) => p.name)], [[], ['Ben']]);

  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'PUT', json: { with: 'u1' } });
  const after = (await ok(`/guilds/${GUILD}/games`)).games.find((g: any) => g.name === 'Portal 2');
  assert.deepEqual([after.family.map((p: any) => p.name), after.needs], [['Ben'], []]);
  const { members } = await ok(`/guilds/${GUILD}/steam-links`);
  assert.deepEqual(members.find((m: any) => m.name === 'Ana').family, ['Ben']);
  assert.deepEqual(members.find((m: any) => m.name === 'Cy').family, []);
  assert.deepEqual(activityText().at(-1), 'Put Ben in a Steam family with Ana');
});

test('refuses a family with someone who isn’t here, a bot, or themselves', async () => {
  const url = `/guilds/${GUILD}/steam-links/u1/family`;
  await refused(404, url, { method: 'PUT', json: { with: 'nobody' } });
  await refused(404, url, { method: 'PUT', json: {} });
  await refused(404, url, { method: 'PUT', json: { with: 'b1' } });
  await refused(404, `/guilds/${GUILD}/steam-links/nobody/family`, { method: 'PUT', json: { with: 'u1' } });
  assert.equal(await refused(400, url, { method: 'PUT', json: { with: 'u1' } }), 'Pick two different people.');
  await refused(405, url, { method: 'POST', json: { with: 'u2' } });
});

test('says how each person is getting on with a game’s achievements', async (t) => {
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    const path = new URL(url).pathname;
    if (path.includes('GetSchemaForGame')) return new Response(JSON.stringify({ game: { availableGameStats: { achievements: [{ name: 'A', displayName: 'First', hidden: 0 }, { name: 'B', displayName: 'Second', hidden: 0 }] } } }));
    if (path.includes('GetGlobal')) return new Response(JSON.stringify({ achievementpercentages: { achievements: [] } }));
    return new Response(JSON.stringify({ playerstats: { achievements: [{ apiname: 'A', achieved: 1 }, { apiname: 'B', achieved: 0 }] } }));
  });
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  const data = await ok(`/guilds/${GUILD}/achievements?appid=620&users=u1,u2`);
  assert.deepEqual(data, { total: 2, goals: [{ name: 'Second', description: null, percent: null }], people: [{ name: 'Ana', done: 1 }], skipped: ['Ben'] });
  await refused(400, `/guilds/${GUILD}/achievements?appid=abc&users=u1`);
  await refused(400, `/guilds/${GUILD}/achievements?appid=620`);
  await refused(404, `/guilds/${GUILD}/achievements?appid=620&users=nobody`);
  await refused(404, `/guilds/${GUILD}/achievements?appid=620&users=b1`);
});

test('a comparison lists the Steam games two people share', async (t) => {
  await ownedGames(t);
  const { steamGames, shared } = await ok(`/guilds/${GUILD}/compare?a=u1&b=u2`);
  assert.deepEqual(steamGames, [{ name: 'Valheim', appid: 892970 }]);
  assert.deepEqual(shared.toSorted(), ['Halo', 'Valheim']);
});

test('lists joinable lobbies by name, and has none without Steam', async (t) => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/lobbies`), { lobbies: [] });
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  const real = fetch;
  const fake = t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) =>
    String(url).startsWith(base) ? real(url, init) : new Response(JSON.stringify({ response: { players: [{ steamid: 's1', gameid: '10', gameextrainfo: 'Valheim', lobbysteamid: '999' }] } })),
  );
  assert.deepEqual(await ok(`/guilds/${GUILD}/lobbies`), { lobbies: [{ name: 'Ana', game: 'Valheim', join: 'steam://joinlobby/10/999/s1' }] });
  fake.mock.mockImplementation(async (url: URL | string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response('', { status: 503 })));
  const quiet = t.mock.method(console, 'error', () => {});
  assert.match(await refused(502, `/guilds/${GUILD}/lobbies`), /Steam couldn’t be reached/);
  assert.equal(quiet.mock.callCount(), 1);
});

test('says how many are playing a game on Steam, and refuses nonsense', async (t) => {
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response(JSON.stringify({ response: { player_count: 42 } }))));
  assert.deepEqual(await ok(`/guilds/${GUILD}/steam-apps/620`), { players: 42, patch: null });
  await refused(404, `/guilds/${GUILD}/steam-apps/abc`);
});

test('bots can’t be picked, compared or given pings', async (t) => {
  await ownedGames(t);
  await refused(404, `/guilds/${GUILD}/pick?users=u1,b1`);
  await refused(404, `/guilds/${GUILD}/compare?a=u1&b=b1`);
  await refused(404, `/guilds/${GUILD}/members/b1/pings`);
});

test('says who isn’t counted, by name', async (t) => {
  await ownedGames(t);
  guild.members.cache.set('777', member('777', 'Numeric Ned')[1] as never);
  const { notes, people, counted } = await pick('users=u1,777');
  guild.members.cache.delete('777');
  assert.deepEqual(notes, ['Not counted (no Steam linked): Numeric Ned']);
  assert.deepEqual([people, counted], [2, 1]);
});

test('says so when nobody picked can be counted', async (t) => {
  fakeSteam(t);
  const data = await pick('users=u3');
  assert.deepEqual([data.counted, data.ready], [0, []]);
  assert.match(data.notes[0], /Nobody here has linked Steam/);
  assert.doesNotMatch(data.notes[0], /`/);
});

test('refuses a pick with nobody to pick for', async () => {
  await refused(400, `/guilds/${GUILD}/pick`);
  await refused(400, `/guilds/${GUILD}/pick?users=`);
  await refused(404, `/guilds/${GUILD}/pick?users=u1,nobody`);
  await refused(400, `/guilds/${GUILD}/pick?channel=703`);
  await refused(400, `/guilds/${GUILD}/pick?channel=c2`);
});

test('offers the people and channels to choose from', async () => {
  setSetting(GUILD, 'announceChannel', '111');
  const data = await ok(`/guilds/${GUILD}/pick/options`);
  assert.deepEqual(data.members.map((m: any) => m.name), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(data.voice.map((c: any) => c.name), ['Gaming', 'General']);
  assert.deepEqual(data.channels.map((c: any) => c.id), ['111', 'c2']);
  assert.equal(data.announceChannel, '111');
});

const startVote = (json: unknown) => ok(`/guilds/${GUILD}/votes`, { method: 'POST', json });

const voteRows = () => db.prepare('SELECT * FROM game_votes').all() as any[];

test('posts a vote in the channel picked, for the people in the voice channel', async (t) => {
  await ownedGames(t);
  await startVote({ voiceChannelId: '702', channelId: '111', minutes: 3 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111');
  assert.match(sent[0].message.embeds[0].toJSON().description, /Everyone in <#702> gets one vote/);
  const [vote] = voteRows();
  assert.deepEqual([vote.channel_id, vote.voice_channel_id, vote.message_id], ['111', '702', 'posted-1']);
  assert.ok(Math.abs(vote.closes_at - Date.now() - 180_000) < 5000);
  assert.deepEqual(JSON.parse(vote.options).map((o: any) => o.name).sort(), ['Halo', 'Valheim']);
  assert.equal(activityText().at(-1), 'Started a game vote for <#702> in <#111>');
});

test('a vote from the web offers only the games it names, if they still fit everyone', async (t) => {
  await ownedGames(t);
  await startVote({ voiceChannelId: '702', channelId: '111', games: ['Valheim', 'Halo', 'Not a game'] });
  assert.deepEqual(JSON.parse(voteRows()[0].options).map((o: any) => o.name).sort(), ['Halo', 'Valheim']);
  db.exec('DELETE FROM game_votes');
  const refusal = await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111', games: ['Halo'] } });
  assert.equal(refusal, 'Halo is the only game that fits, so there’s nothing to vote on.');
  assert.equal(await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111', games: 'Halo' } }), 'games has to be a list of up to 2000 game names.');
});

test('a vote runs one at a time per voice channel', async (t) => {
  await ownedGames(t);
  await startVote({ voiceChannelId: '702', channelId: '111' });
  assert.equal(await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111' } }), 'There’s already a vote going in #Gaming.');
  assert.equal(voteRows().length, 1);
});

test('won’t start a vote with nothing to vote on', async (t) => {
  fakeSteam(t);
  await mark(insertGame('Halo'), 'u1', { owns: true });
  const refusal = await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '701', channelId: '111' } });
  assert.equal(refusal, 'Halo is the only game that fits, so there’s nothing to vote on.');
  assert.deepEqual(voteRows(), []);
  assert.equal(sent.length, 0);
});

test('refuses a bad vote', async () => {
  const url = `/guilds/${GUILD}/votes`;
  for (const minutes of [0, 11, 1.5, 'two']) assert.equal(await refused(400, url, { method: 'POST', json: { voiceChannelId: '702', channelId: '111', minutes } }), 'A vote lasts from 1 to 10 minutes.');
  await refused(400, url, { method: 'POST', json: { voiceChannelId: 'c2', channelId: '111' } });
  await refused(400, url, { method: 'POST', json: { voiceChannelId: '703', channelId: '111' } });
  setFake({ permitted: [] });
  assert.match(await refused(400, url, { method: 'POST', json: { voiceChannelId: '702', channelId: '111' } }), /^I can’t post in #first/);
});

test('a vote that can’t be posted doesn’t block the next one', async (t) => {
  await ownedGames(t);
  setFake({ failSend: true });
  await refused(502, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111' } });
  assert.deepEqual(voteRows(), []);
  setFake({ failSend: false });
  await startVote({ voiceChannelId: '702', channelId: '111' });
  assert.equal(voteRows().length, 1);
});

const compared = (a: string, b: string) => `/guilds/${GUILD}/compare?a=${a}&b=${b}`;

test('compares two people', async (t) => {
  await ownedGames(t);
  const now = Date.now();
  playedIn('u1', 'Halo', now - hours(5), now - hours(2));
  playedIn('u2', 'Halo', now - hours(4), now - hours(1));
  playedIn('u2', 'Solo Game', now - hours(9), now - hours(8));
  const session = Number(db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', 0, 9000)`).run(GUILD).lastInsertRowid);
  for (const [user, seconds] of [['u1', 3600], ['u2', 7200]] as const) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(session, user, seconds);

  const data = await ok(compared('u1', 'u2'));
  assert.deepEqual(data.people.map((p: any) => [p.name, p.ms]), [['Ana', hours(3)], ['Ben', hours(4)]]);
  assert.equal(data.togetherMs, hours(2));
  assert.deepEqual(data.games, [{ name: 'Halo', ms: hours(2) }]);
  assert.deepEqual(data.voice, { sessions: 1, ms: hours(1) });
  assert.deepEqual([...data.shared].sort(), ['Halo', 'Valheim']);
});

test('lists everything two people both own, past what Discord can fit', async (t) => {
  fakeSteam(t);
  for (let n = 0; n < 20; n++) {
    const id = insertGame(`Game ${n}`);
    await mark(id, 'u1', { owns: true });
    await mark(id, 'u2', { owns: true });
  }
  assert.equal((await ok(compared('u1', 'u2'))).shared.length, 20);
});

test('refuses to compare anyone but two people here', async () => {
  await refused(400, compared('u1', 'u1'));
  await refused(404, compared('u1', 'nobody'));
  await refused(404, `/guilds/${GUILD}/compare?a=u1`);
});

test('shows a month’s recap as plain text', async () => {
  guild.members.cache.set('777', member('777', 'Numeric Ned')[1] as never);
  guild.members.cache.set('778', member('778', 'Numeric Nia')[1] as never);
  const now = Date.now();
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, '777', 'Halo', '702', ?, ?)`).run(GUILD, now - 60_000, now);
  const session = Number(db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)`).run(GUILD, now - 60_000, now).lastInsertRowid);
  for (const user of ['777', '778']) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, 60)').run(session, user);

  const { recap } = await ok(`/guilds/${GUILD}/recap?month=this`);
  guild.members.cache.delete('777');
  guild.members.cache.delete('778');
  assert.match(recap.title, /recap$/);
  const text = JSON.stringify(recap);
  assert.match(text, /Numeric Ned/);
  assert.match(recap.fields.find((f: any) => f.name === 'Longest session').value, /on \w+ \d+, \d{4} with Numeric/);
  assert.doesNotMatch(text, /<@|<t:|\*\*/);
});

test('says when there’s no recap, and refuses a month it doesn’t know', async () => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/recap`), { recap: null });
  await refused(400, `/guilds/${GUILD}/recap?month=march`);
});

test('adds sessions, rank and last played to the stats', async () => {
  const now = Date.now();
  playedIn('u1', 'Halo', now - hours(5), now - hours(4));
  playedIn('u1', 'Halo', now - hours(3), now - hours(2));
  playedIn('u2', 'Halo', now - hours(9), now - hours(1));
  const both = await ok(`/guilds/${GUILD}/stats?period=all&user=u1&game=Halo`);
  assert.deepEqual(both.place, { rank: 2, of: 2, sessions: 2 });
  assert.equal(both.games[0].last, now - hours(2));
  const one = await ok(`/guilds/${GUILD}/stats?period=all&game=Halo`);
  assert.equal(one.place, null);
  assert.equal(one.players[0].last, now - hours(1));
  assert.equal((await ok(`/guilds/${GUILD}/stats?period=all&user=u3&game=Halo`)).place, null);
});

const pings = (user: string) => `/guilds/${GUILD}/members/${user}/pings`;

const setPing = (user: string, json: unknown) => ok(pings(user), { method: 'PUT', json });

test('shows and changes anyone’s pings', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('333', ?, 'Halo')`).run(GUILD);
  heldRoles.add('u2:333');
  assert.deepEqual((await ok(pings('u2'))).pings, [{ id: 'r1', label: 'Hop-on pings', on: false }, { id: '333', label: 'Halo', on: true }]);
  await setPing('u2', { roleId: 'r1', on: true });
  await setPing('u2', { roleId: '333', on: false });
  assert.deepEqual((await ok(pings('u2'))).pings.map((p: any) => p.on), [true, false]);
  assert.deepEqual([...heldRoles], ['u2:r1']);
  assert.deepEqual(activityText().slice(-2), ['Turned Hop-on pings on for Ben', 'Turned Halo off for Ben']);
});

test('only hop-on and game roles can be changed', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  for (const roleId of ['333', 'r2', GUILD, undefined]) await refused(400, pings('u1'), { method: 'PUT', json: { roleId, on: true } });
  await refused(400, pings('u1'), { method: 'PUT', json: { roleId: 'r1', on: 'yes' } });
  assert.deepEqual([...heldRoles], []);
});

test('doesn’t offer a role from another server, or one that’s gone', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('r1', 'other', 'Halo'), ('gone', ?, 'Valheim')`).run(GUILD);
  assert.deepEqual((await ok(pings('u1'))).pings, []);
});

test('lists a role used for hop-ons and a game once', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('r1', ?, 'Halo')`).run(GUILD);
  assert.deepEqual((await ok(pings('u1'))).pings.map((p: any) => p.label), ['Hop-on pings']);
});

test('says so when the bot can’t change someone’s roles', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  setFake({ failRoles: true });
  assert.match(await refused(409, pings('u1'), { method: 'PUT', json: { roleId: 'r1', on: true } }), /Manage Roles and has to be above @Gamers/);
  assert.deepEqual(activityText().filter((a) => a.startsWith('Turned')), []);
});

test('pings are only for people here', async () => {
  await refused(404, pings('nobody'));
  await refused(405, pings('u1'), { method: 'DELETE' });
});

test('posts the Choose games button', async () => {
  await ok(`/guilds/${GUILD}/game-pings/menu`, { method: 'POST', json: { channelId: 'c2' } });
  assert.equal(sent[0].channelId, 'c2');
  assert.equal(sent[0].message.components[0].toJSON().components[0].custom_id, 'gr:open');
  assert.equal(activityText().at(-1), 'Posted the game pings button in <#c2>');
});

test('won’t post in a channel it can’t, or say it did when Discord refused', async () => {
  for (const url of [`/guilds/${GUILD}/sound-panels`, `/guilds/${GUILD}/game-pings/menu`]) {
    await refused(400, url, { method: 'POST', json: { channelId: 'nope' } });
    await refused(400, url, { method: 'POST', json: {} });
    setFake({ permitted: [] });
    assert.match(await refused(400, url, { method: 'POST', json: { channelId: '111' } }), /^I can’t post in #first/);
    setFake({ permitted: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] });
    setFake({ failSend: true });
    await refused(502, url, { method: 'POST', json: { channelId: '111' } });
    setFake({ failSend: false });
  }
  assert.deepEqual(activityText(), []);
});

test('hides a Steam game outside the library, by the name it’s given', async () => {
  await ok(`${hiddenUrl}/620`, { method: 'PUT', json: { name: 'Portal 2' } });
  assert.deepEqual(await hiddenNames(), ['Portal 2']);
  await refused(404, `${hiddenUrl}/730`, { method: 'PUT', json: { name: 'x'.repeat(101) } });
  await refused(404, `${hiddenUrl}/730`, { method: 'PUT', json: { name: 5 } });
  await refused(404, `${hiddenUrl}/abc`, { method: 'PUT', json: { name: 'Portal 2' } });
});
