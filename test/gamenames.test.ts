import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test, type TestContext } from 'node:test';
import { Events } from 'discord.js';
import { db } from '../src/db.ts';

const HOUR = 3_600_000;
const t = Date.now();
const add = (guildId: string, user: string, raw: string, from: number, to: number, channel: string | null = 'voice') =>
  db.prepare('INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(guildId, user, raw, channel, t - from * HOUR, t - to * HOUR);

// Here before the bot starts: the most played spelling is first in line, but a proper title still wins
add('start', 'a', 'slaythespire2', 20, 10);
add('start', 'b', 'Slay the Spire 2', 12, 11);
add('start', 'a', 'SLAY THE SPIRE 2', 12, 11.5);
add('start', 'a', 'Slay the Spire II', 12, 11);
add('elsewhere', 'a', 'slaythespire2', 3, 1);
add('ties', 'a', 'Deep rock galactic', 10, 9);
add('ties', 'a', 'Deep Rock Galactic', 9, 5);
const session = db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES ('start', 'voice', ?, ?)`).run(t - 2 * HOUR, t - HOUR).lastInsertRowid;
db.prepare(`INSERT INTO session_games (session_id, game) VALUES (?, 'Only In A Session')`).run(session);

const log = mock.method(console, 'log', () => {});
const { gameKey, gameName, gameSpellings, mergeGames, noteGame, separateGame } = await import('../src/gameNames.ts');
const { activity, gameStats, playedTogether, stats } = await import('../src/features/gamestats.ts');
const { rolesForGames } = await import('../src/features/gameroles.ts');
const { hopOn } = await import('../src/features/hopon.ts');
const { buildRecap } = await import('../src/features/recap.ts');
const { sessions } = await import('../src/features/sessions.ts');
const { setSetting } = await import('../src/settings.ts');

const hours = (rows: { key: string; ms: number }[]) => rows.map((r) => [r.key, Math.round(r.ms / HOUR)]);

test('a key ignores case, spaces and punctuation, in any alphabet', () => {
  assert.equal(gameKey('Slay the Spire 2'), 'slaythespire2');
  assert.equal(gameKey('SLAY-THE: SPIRE_2™'), 'slaythespire2');
  assert.equal(gameKey('Ведьмак 3'), 'ведьмак3');
  assert.equal(gameKey('原神'), '原神');
  assert.notEqual(gameKey('Slay the Spire 2'), gameKey('Slay the Spire II'));
});

test('a name with nothing but symbols only matches itself', () => {
  assert.equal(gameKey('!!!'), '!!!');
  noteGame('symbols', '!!!');
  noteGame('symbols', '???');
  assert.equal(gameName('symbols', '???'), '???');
  assert.equal(gameName('symbols', '!!!'), '!!!');
});

test('names already in the stats are matched at the first start, by proper title', () => {
  assert.equal(gameName('start', 'slaythespire2'), 'Slay the Spire 2');
  assert.equal(gameName('start', 'SLAY THE SPIRE 2'), 'Slay the Spire 2');
  assert.equal(gameName('start', 'Slay the Spire II'), 'Slay the Spire II', 'too risky to match by itself');
  assert.equal(gameName('start', 'Only In A Session'), 'Only In A Session');
  assert.ok(gameSpellings('start').has('Only In A Session'), 'seen in a session but never as a play');
  assert.equal(log.mock.calls[0].arguments[0], 'Matched 3 game spellings to the same game');
});

test('between equally good titles, the first start keeps the most played', () => {
  assert.equal(gameName('ties', 'Deep rock galactic'), 'Deep Rock Galactic');
});

test('spaces beat mixed case', () => {
  noteGame('spaces', 'SlayTheSpire');
  noteGame('spaces', 'slay the spire');
  assert.equal(gameName('spaces', 'SlayTheSpire'), 'slay the spire');
});

test('a game goes by the last time any spelling was played', () => {
  add('last', 'a', 'Foo Game', 10, 9);
  add('last', 'a', 'foogame', 5, 4);
  noteGame('last', 'Foo Game');
  noteGame('last', 'foogame');
  assert.equal(stats('last', 0, 'none', 'game')[0].last, t - 4 * HOUR);
});

test('a separated spelling stays out of what matches it later', () => {
  noteGame('apart', 'Slay the Spire');
  noteGame('apart', 'slaythespire');
  noteGame('apart', 'slay_the_spire');
  assert.equal(separateGame('apart', 'Slay the Spire'), null);
  assert.equal(gameName('apart', 'SLAY-THE-SPIRE'), gameName('apart', 'slaythespire'), 'not yet seen, so it goes with the ones still matched');
  noteGame('apart', 'Slay The Spire');
  assert.equal(gameName('apart', 'slaythespire'), 'Slay The Spire', 'a better title takes over what’s still matched');
  assert.equal(gameName('apart', 'Slay the Spire'), 'Slay the Spire');
});

test('spellings that join a hand-picked name can’t take it over later', () => {
  noteGame('picked', 'slaythespire');
  noteGame('picked', 'StS');
  assert.equal(mergeGames('picked', ['slaythespire', 'StS'], 'slaythespire'), null);
  noteGame('picked', 'slay the spire');
  noteGame('picked', 'Slay The Spire');
  for (const raw of ['StS', 'slay the spire', 'Slay The Spire']) assert.equal(gameName('picked', raw), 'slaythespire');
});

test('another server’s names are its own', () => {
  assert.equal(gameName('elsewhere', 'slaythespire2'), 'slaythespire2');
  assert.deepEqual(hours(stats('elsewhere', 0, 'none', 'game')), [['slaythespire2', 2]]);
});

test('the title goes to spaces, then mixed case, then whoever was first', () => {
  noteGame('title', 'deeprock');
  assert.equal(gameName('title', 'deeprock'), 'deeprock');
  noteGame('title', 'deep rock');
  assert.equal(gameName('title', 'deeprock'), 'deep rock');
  noteGame('title', 'DEEP ROCK');
  assert.equal(gameName('title', 'deeprock'), 'deep rock', 'capitals aren’t better');
  noteGame('title', 'Deep Rock');
  assert.equal(gameName('title', 'DEEP ROCK'), 'Deep Rock');
  noteGame('title', 'Deep-Rock');
  assert.equal(gameName('title', 'deeprock'), 'Deep Rock', 'a tie stays put');
});

test('a spelling not seen yet still reads as the game it matches', () => {
  noteGame('unseen', 'Lethal Company');
  assert.equal(gameName('unseen', 'lethalcompany'), 'Lethal Company');
  assert.equal(gameName('unseen', 'Something New'), 'Something New');
  assert.equal(gameSpellings('unseen').has('Something New'), false, 'reading doesn’t record it');
});

test('a merge joins everything up, counting overlaps once', () => {
  for (const raw of ['Slay the Spire 2', 'Slay the Spire II', 'slaythespire2']) noteGame('merged', raw);
  add('merged', 'a', 'Slay the Spire 2', 10, 8);
  add('merged', 'b', 'Slay the Spire II', 9, 7);
  add('merged', 'a', 'slaythespire2', 8.5, 6); // Overlaps a's other spelling too
  add('merged', 'c', 'Slay the Spire II', 8, 7, 'other');
  add('merged', 'a', 'Valheim', 5, 4);
  noteGame('merged', 'Valheim');
  assert.deepEqual(stats('merged', 0, 'none', 'game').map((r) => r.key).sort(), ['Slay the Spire 2', 'Slay the Spire II', 'Valheim'], 'II stands alone until it’s merged');

  assert.equal(mergeGames('merged', ['Slay the Spire 2', 'Slay the Spire II'], 'Slay the Spire 2'), null);
  assert.deepEqual(hours(stats('merged', 0, 'none', 'game')), [['Slay the Spire 2', 4], ['Valheim', 1]]);
  // a's own 2h and 2.5h overlap, so 4h plus an hour of Valheim, not 5.5h
  assert.deepEqual(hours(stats('merged', 0, 'none', 'user_id')).sort(), [['a', 5], ['b', 2], ['c', 1]]);
  assert.deepEqual(hours(stats('merged', 0, 'user', 'game', 'a')), [['Slay the Spire 2', 4], ['Valheim', 1]]);
  assert.equal(stats('merged', 0, 'none', 'user_id').find((r) => r.key === 'a')!.n, 2);
  assert.equal(stats('merged', 0, 'none', 'game')[0].n, 3);
  assert.equal(Math.round(activity('merged', t - 20 * HOUR, t, 'UTC').buckets.reduce((sum, b) => sum + b.ms, 0) / HOUR), 5);
  // Different spellings, same game, same channel
  assert.deepEqual(playedTogether('merged', 'a', 'b').map((r) => r.game), ['Slay the Spire 2']);
  assert.deepEqual(playedTogether('merged', 'a', 'c'), [], 'c was in another channel');
  const embed = buildRecap({ id: 'merged', members: { cache: new Map([['a', {}], ['b', {}], ['c', {}]]) } } as never, t - 20 * HOUR, t)!.toJSON();
  assert.match(embed.fields!.find((f) => f.name === 'Most played')!.value, /Slay the Spire 2\*\* · 4h/);
  assert.doesNotMatch(embed.fields!.find((f) => f.name === 'Most played')!.value, /II/);
});

test('a spelling seen after a merge goes to the merged game, and the name stays', () => {
  assert.equal(noteGame('merged', 'SLAYTHESPIRE2'), true);
  assert.equal(gameName('merged', 'SLAYTHESPIRE2'), 'Slay the Spire 2');
  noteGame('kept', 'Foo');
  noteGame('kept', 'Foo 2');
  mergeGames('kept', ['Foo', 'Foo 2'], 'Foo');
  noteGame('kept', 'Foo  2');
  assert.equal(gameName('kept', 'Foo  2'), 'Foo', 'a better title doesn’t replace one someone chose');
});

test('merging takes every spelling of a game with it', () => {
  noteGame('whole', 'bar');
  noteGame('whole', 'Bar');
  noteGame('whole', 'Baz');
  assert.equal(mergeGames('whole', ['Bar', 'Baz'], 'Baz'), null);
  assert.equal(gameName('whole', 'bar'), 'Baz');
});

test('a merge can keep any spelling of the games in it', () => {
  noteGame('pick', 'qux');
  noteGame('pick', 'Qux');
  noteGame('pick', 'Other');
  assert.equal(mergeGames('pick', ['Qux', 'Other'], 'qux'), null);
  assert.equal(gameName('pick', 'Other'), 'qux');
});

test('bad merges are refused and change nothing', () => {
  noteGame('bad', 'One');
  noteGame('bad', 'Two');
  assert.match(mergeGames('bad', ['One'], 'One')!, /at least two/);
  assert.match(mergeGames('bad', ['One', 'One'], 'One')!, /at least two/);
  assert.match(mergeGames('bad', ['One', 'Nope'], 'One')!, /no game called Nope/);
  assert.match(mergeGames('bad', ['One', 'Two'], 'Three')!, /names to keep|one of those/);
  assert.equal(gameName('bad', 'Two'), 'Two');
  assert.match(separateGame('bad', 'One')!, /isn’t merged/);
  assert.match(separateGame('bad', 'Nope')!, /no game called/);
});

test('separating puts the numbers back, and stays that way', () => {
  add('apart', 'a', 'Rock Galactic', 4, 2);
  add('apart', 'b', 'rockgalactic', 3, 1);
  noteGame('apart', 'Rock Galactic');
  noteGame('apart', 'rockgalactic');
  assert.deepEqual(hours(stats('apart', 0, 'none', 'game')), [['Rock Galactic', 3]]);
  assert.equal(separateGame('apart', 'rockgalactic'), null);
  assert.deepEqual(hours(stats('apart', 0, 'none', 'game')), [['Rock Galactic', 2], ['rockgalactic', 2]]);
  assert.equal(noteGame('apart', 'rockgalactic'), false);
  assert.equal(gameName('apart', 'rockgalactic'), 'rockgalactic');
  noteGame('apart', 'ROCK GALACTIC');
  assert.equal(gameName('apart', 'ROCK GALACTIC'), 'Rock Galactic', 'new spellings join the game, not the one taken out');
});

test('separating the name a game goes by leaves the rest with the best of theirs', () => {
  for (const raw of ['Main Title', 'maintitle', 'Main-Title']) noteGame('renamed', raw);
  assert.equal(separateGame('renamed', 'Main Title'), null);
  assert.equal(gameName('renamed', 'Main Title'), 'Main Title');
  assert.equal(gameName('renamed', 'maintitle'), 'Main-Title');
  assert.equal(gameName('renamed', 'Main-Title'), 'Main-Title');
});

test('spellings are listed under the game, title first', () => {
  assert.deepEqual(gameSpellings('renamed').get('Main-Title'), ['Main-Title', 'maintitle']);
  noteGame('order', 'Order Game');
  noteGame('order', 'ORDERGAME');
  assert.deepEqual(gameSpellings('order').get('Order Game'), ['Order Game', 'ORDERGAME'], 'even when it sorts later');
});

test('plays from before voice tracking stay out under a merged name too', () => {
  add('oldrows', 'a', 'Old Game', 5, 4, null);
  add('oldrows', 'a', 'oldgame', 3, 2);
  noteGame('oldrows', 'Old Game');
  noteGame('oldrows', 'oldgame');
  assert.deepEqual(hours(stats('oldrows', 0, 'none', 'game')), [['Old Game', 1]]);
});

test('stored plays aren’t changed by any of it', () => {
  const names = db.prepare(`SELECT game FROM game_plays WHERE guild_id = 'merged' ORDER BY id`).all() as { game: string }[];
  assert.deepEqual(names.map((n) => n.game), ['Slay the Spire 2', 'Slay the Spire II', 'slaythespire2', 'Slay the Spire II', 'Valheim']);
});

test('a ping role reaches anyone showing any spelling, once', () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('sts', 'merged', 'Slay the Spire 2'), ('val', 'merged', 'Valheim')`).run();
  assert.deepEqual(rolesForGames('merged', ['slaythespire2']), ['sts']);
  assert.deepEqual(rolesForGames('merged', ['Slay the Spire II', 'SLAY THE SPIRE 2']), ['sts']);
  assert.deepEqual(rolesForGames('merged', ['Nothing']), []);
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('typed', 'early', 'Foo Bar'), ('other', 'early', 'Merged Name')`).run();
  assert.deepEqual(rolesForGames('early', ['foobar']), ['typed'], 'matches before anyone’s played it');
  noteGame('early', 'Baz');
  noteGame('early', 'Merged Name');
  mergeGames('early', ['Baz', 'Merged Name'], 'Merged Name');
  assert.deepEqual(rolesForGames('early', ['Baz']), ['other']);
});

test('a role named with a merged-away spelling still matches', () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('ii', 'merged', 'Slay the Spire II')`).run();
  assert.deepEqual(rolesForGames('merged', ['Slay the Spire 2']).sort(), ['ii', 'sts']);
});

/** Discord events and a channel the announcements land in, under a clock the test controls */
function server(t: TestContext, id: string) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  setSetting(id, 'announceChannel', `channel-${id}`);
  const sent: { content?: string; embeds?: { toJSON(): { fields?: { name: string; value: string }[] } }[] }[] = [];
  const guild = { id, name: id, afkChannelId: null, channels: { cache: new Map() } };
  const client: EventEmitter = Object.assign(new EventEmitter(), fakeClient([guild], async (_guild, message) => sent.push(message)));
  const members: unknown[] = [];
  const channel = { id: 'v', guild, members: new Map(), toString: () => '#voice' };
  const join = (userId: string, ...games: string[]) => {
    const member = { id: userId, displayName: userId, user: { bot: false }, presence: { activities: games.map((name) => ({ type: 0, name })) } };
    members.push(member);
    channel.members.set(userId, member);
    client.emit(Events.VoiceStateUpdate, { channelId: null }, { channelId: 'v', channel, guild, member });
  };
  const leave = (userId: string) => {
    const member = channel.members.get(userId);
    channel.members.delete(userId);
    client.emit(Events.VoiceStateUpdate, { channelId: 'v', channel }, { channelId: null, channel: null, guild, member });
  };
  return { client, sent, join, leave };
}

test('a hop-on post names a game once, whatever it’s called', async (t) => {
  for (const raw of ['Deep Rock Galactic', 'deeprockgalactic']) noteGame('hopon', raw);
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('drg', 'hopon', 'Deep Rock Galactic')`).run();
  const { client, sent, join } = server(t, 'hopon');
  hopOn.setup!(client as never);
  join('sam', 'deeprockgalactic');
  join('alex', 'Deep Rock Galactic');
  join('pat', 'deeprockgalactic');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal((sent[0].content!.match(/Deep Rock Galactic/g) ?? []).length, 1);
  assert.doesNotMatch(sent[0].content!, /deeprockgalactic/);
  assert.match(sent[0].content!, /<@&drg>/);
});

test('a session recap lists a game once, under the name it goes by', async (t) => {
  for (const raw of ['Lethal Company', 'lethalcompany']) noteGame('recapped', raw);
  const { client, sent, join, leave } = server(t, 'recapped');
  sessions.setup!(client as never);
  join('sam', 'lethalcompany');
  join('alex', 'Lethal Company');
  t.mock.timers.tick(2 * HOUR);
  leave('sam');
  leave('alex');
  t.mock.timers.tick(HOUR);
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].embeds![0].toJSON().fields!.find((f) => f.name === 'Played')!.value, 'Lethal Company');
});

test('the leaderboard’s Most played counts a session once per game', async () => {
  for (const raw of ['Halo', 'halo!']) noteGame('board', raw);
  const row = db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES ('board', 'v', ?, ?)`);
  const first = row.run(t - HOUR, t).lastInsertRowid;
  const second = row.run(t - 3 * HOUR, t - 2 * HOUR).lastInsertRowid;
  db.prepare(`INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, 'a', 3600)`).run(first);
  const game = db.prepare('INSERT INTO session_games (session_id, game) VALUES (?, ?)');
  game.run(first, 'Halo');
  game.run(first, 'halo!');
  game.run(second, 'halo!');
  game.run(first, 'Unknown Elsewhere');
  let reply: { embeds: { toJSON(): { fields: { value: string }[] } }[] };
  await sessions.commands![0].run({
    inGuild: () => true,
    guildId: 'board',
    options: { getString: () => 'all' },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  assert.match(reply!.embeds[0].toJSON().fields[0].value, /^Halo \(2 sessions\)\nUnknown Elsewhere \(1 session\)$/);
});

test('/gamestats finds a merged game by any name it’s picked with', async () => {
  let names: { name: string }[] = [];
  await gameStats.commands![0].autocomplete!({ inGuild: () => true, guildId: 'merged', options: { getFocused: () => 'slay' }, respond: async (r: typeof names) => (names = r) } as never);
  assert.deepEqual(names.map((n) => n.name), ['Slay the Spire 2']);
});
