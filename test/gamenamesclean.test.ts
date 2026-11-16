import './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db, setKv } from '../src/db.ts';

// Game names as Discord on Linux sends them: escape codes, program names, and programs that aren't games

const HOUR = 3_600_000;
const t = Date.now();
const add = (guildId: string, raw: string, from: number, to: number) =>
  db.prepare("INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'a', ?, 'voice', ?, ?)").run(guildId, raw, t - from * HOUR, t - to * HOUR);

// Here before the bot starts
const GARBLED = 'STAR WARS Zero Company\u001b$(C"b\u001b(B  ';
add('linux', GARBLED, 10, 9);
add('linux', 'Streets of Rogue', 9, 8);
add('linux', 'streetsofroguelinux.x86_64', 8, 7);
add('linux', 'doomthedarkages', 7, 6);
add('linux', 'launcher', 6, 5);
add('linux', 'Moonlight', 5, 4);
add('linux', 'PEAK', 4, 3);
add('elsewhere', 'launcher', 3, 2);
const session = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES ('linux', 'voice', ?, ?)").run(t - 2 * HOUR, t - HOUR).lastInsertRowid;
db.prepare("INSERT INTO session_games (session_id, game) VALUES (?, 'crashpad_handler'), (?, ?)").run(session, session, GARBLED);
db.prepare("INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s1', 1, 'DOOM: The Dark Ages', 10), ('s1', 2, 'Hades II™ ', 5)").run();
setKv('not_games_marked', '');
// A garbled name someone chose for two spellings, and a program's spelling going by a garbled name
const OUTLAWS = 'STAR WARS Outlaws\u001b$(C"b\u001b(B';
db.prepare("INSERT INTO game_aliases (guild_id, raw, key, name, manual) VALUES ('kept', ?, 'x', 'Outlaws Pick', 1), ('kept', 'swoutlaws', 'y', 'Outlaws Pick', 1), ('named', ?, 'x', ?, 0), ('named', 'starwarsoutlaws', 'z', ?, 0)").run(OUTLAWS, OUTLAWS, OUTLAWS, OUTLAWS);

mock.method(console, 'log', () => {});
const { cleanGameName, gameKey, gameName, notGames, markNotAGame, isNotAGame, isProgramName, learnFromSteam, mergeGames, noteGame, countAsGame } = await import('../src/gameNames.ts');
const { stats } = await import('../src/features/gamestats.ts');
const { playingGames } = await import('../src/util.ts');
const names = (guildId: string) => stats(guildId, 0, 'none', 'game').map((g) => g.key);

test('a name loses escape codes, what they switched to, and control characters', () => {
  assert.equal(cleanGameName(GARBLED), 'STAR WARS Zero Company');
  assert.equal(cleanGameName('\u001b[1mBold\u001b[0m  Game\u0000'), 'Bold Game');
  assert.equal(cleanGameName('Zero​Width'), 'ZeroWidth');
  assert.equal(cleanGameName('Rocket League®'), 'Rocket League®', 'symbols that came through fine stay');
  assert.equal(cleanGameName('\u001b'), '');
});

test('names stored before cleaning are cleaned, in plays and session lists', () => {
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE game = ?').get(GARBLED) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM game_plays WHERE game = 'STAR WARS Zero Company'").get() as { n: number }).n, 1);
  assert.deepEqual((db.prepare('SELECT game FROM session_games WHERE session_id = ? ORDER BY game').all(session) as { game: string }[]).map((r) => r.game), ['STAR WARS Zero Company', 'crashpad_handler']);
  assert.ok(names('linux').includes('STAR WARS Zero Company'));
});

test('a stored spelling is cleaned without losing a merge, and a game going by a garbled name goes by the clean one', () => {
  assert.equal(gameName('kept', 'STAR WARS Outlaws'), 'Outlaws Pick');
  assert.equal((db.prepare("SELECT manual FROM game_aliases WHERE guild_id = 'kept' AND raw = 'STAR WARS Outlaws'").get() as { manual: number }).manual, 1);
  assert.equal(gameName('named', 'starwarsoutlaws'), 'STAR WARS Outlaws');
  assert.equal(gameName('named', 'STAR WARS Outlaws'), 'STAR WARS Outlaws');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM game_aliases WHERE raw LIKE '%' || char(27) || '%' OR name LIKE '%' || char(27) || '%'").get() as { n: number }).n, 0);
});

test('only a name that looks like a file loses a platform', () => {
  assert.equal(gameKey('foo-linux'), 'foo');
  assert.equal(gameKey('Foo_Win64.exe'), 'foo');
  assert.equal(gameKey('foolinux'), 'foolinux');
  assert.equal(gameKey('Mail Shipping'), 'mailshipping');
});

test('a program’s name is told from a title', () => {
  for (const name of ['pratfall', 'streetsofroguelinux.x86_64', 'Game.exe', 'my_game']) assert.ok(isProgramName(name), name);
  for (const name of ['Pratfall', 'PEAK', 'RV There Yet?', 'Slay the Spire 2']) assert.ok(!isProgramName(name), name);
});

test('a program joins its game without its platform, or goes by Steam’s title for it', () => {
  assert.equal(gameName('linux', 'streetsofroguelinux.x86_64'), 'Streets of Rogue');
  assert.equal(gameName('linux', 'doomthedarkages'), 'DOOM: The Dark Ages');
  assert.ok(names('linux').includes('DOOM: The Dark Ages'));
  // Seen for the first time, it reads right straight away, with Steam's title cleaned too
  assert.equal(gameName('linux', 'hades2'), 'Hades II');
  noteGame('linux', 'hades2');
  assert.equal(gameName('linux', 'hades2'), 'Hades II');
});

test('programs that aren’t games are left out as they come, and those recorded before are marked, where they were seen', () => {
  const member = (...activities: string[]) => ({ id: 'm', guild: { id: 'linux' }, presence: { activities: activities.map((name) => ({ type: 0, name })) } }) as never;
  assert.deepEqual(playingGames(member('launcher', 'Moonlight', 'PEAK\u0007')), ['PEAK']);
  assert.deepEqual(notGames('linux').sort(), ['Moonlight', 'crashpad_handler', 'launcher']);
  assert.deepEqual(notGames('elsewhere'), ['launcher']);
  assert.ok(!names('linux').includes('launcher') && !names('linux').includes('Moonlight'));
  assert.ok(isNotAGame('linux', 'crashpad_handler'));
});

test('a program shown while Steam says what’s running becomes that game, but never over a title or a choice', () => {
  assert.ok(learnFromSteam('linux', 'swzerocompany', 'STAR WARS Zero Company™'));
  assert.equal(gameName('linux', 'swzerocompany'), 'STAR WARS Zero Company');
  // Already has a proper name
  assert.ok(!learnFromSteam('linux', 'doomthedarkages', 'Something Else'));
  assert.equal(gameName('linux', 'doomthedarkages'), 'DOOM: The Dark Ages');
  // Not a program's name, or a program that isn't a game
  assert.ok(!learnFromSteam('linux', 'PEAK', 'Another Game'));
  assert.ok(!learnFromSteam('linux', 'launcher', 'Another Game'));
  // Someone chose a name
  noteGame('linux', 'oddtool');
  noteGame('linux', 'Odd Tool Deluxe');
  assert.equal(mergeGames('linux', ['oddtool', 'Odd Tool Deluxe'], 'oddtool'), null);
  assert.ok(!learnFromSteam('linux', 'oddtool', 'Steam Game'));
  assert.equal(gameName('linux', 'oddtool'), 'oddtool');
});

test('a merge can keep a name from Steam', () => {
  noteGame('linux', 'zerocompanydemo');
  assert.equal(mergeGames('linux', ['STAR WARS Zero Company', 'zerocompanydemo'], 'STAR WARS Zero Company'), null);
  assert.equal(gameName('linux', 'zerocompanydemo'), 'STAR WARS Zero Company');
});

test('not a game takes every spelling out of the stats, and counting it again brings them back', () => {
  assert.ok(names('linux').includes('Streets of Rogue'));
  assert.equal(markNotAGame('linux', 'Streets of Rogue'), null);
  assert.ok(!names('linux').includes('Streets of Rogue'));
  assert.ok(isNotAGame('linux', 'streetsofroguelinux.x86_64'), 'its other spelling too');
  assert.equal(notGames('linux')[0], 'Streets of Rogue', 'newest first');
  assert.equal(countAsGame('linux', 'Streets of Rogue'), null);
  // A spelling merged in later stays out too
  noteGame('linux', 'Overlay App');
  noteGame('linux', 'Overlay Thing');
  add('linux', 'Overlay Thing', 2, 1);
  assert.equal(markNotAGame('linux', 'Overlay App'), null);
  assert.equal(mergeGames('linux', ['Overlay App', 'Overlay Thing'], 'Overlay App'), null);
  assert.ok(isNotAGame('linux', 'Overlay Thing'));
  assert.ok(!names('linux').includes('Overlay App') && !names('linux').includes('Overlay Thing'));
  assert.ok(names('linux').includes('Streets of Rogue'));
  assert.equal(markNotAGame('linux', 'No Such Game'), 'There’s no game called No Such Game.');
  assert.equal(countAsGame('linux', 'PEAK'), 'PEAK isn’t marked as not a game.');
});
