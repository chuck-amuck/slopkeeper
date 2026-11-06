import './helpers.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test, type TestContext } from 'node:test';
import { Events } from 'discord.js';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { sharedGames } from '../src/features/games.ts';
import { gameName, gameSpellings, noteGame } from '../src/gameNames.ts';
import { activity, checkpoint, gameStats, playedTogether, resync, stats, voiceTogether } from '../src/features/gamestats.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t = Date.now();
const play = db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`);
play.run('g', 'a', 'Valheim', t - 3 * HOUR, t - HOUR);
play.run('g', 'b', 'Valheim', t - 2 * HOUR, t - HOUR);
play.run('g', 'a', 'Valheim', t - 8 * DAY - HOUR, t - 8 * DAY + HOUR);
play.run('g', 'a', 'Lethal Company', t - 40 * DAY, t - 40 * DAY + HOUR);
play.run('other', 'a', 'Valheim', t - HOUR, t);

const hours = (rows: { key: string; ms: number; n: number }[]) => rows.map((r) => [r.key, Math.round(r.ms / HOUR), r.n]);

test('adds up the server’s games over a period', () => {
  // a played 2h and b played 1h of that, so the game was on for 2h
  assert.deepEqual(hours(stats('g', t - 7 * DAY, 'none', 'game')), [['Valheim', 2, 2]]);
  assert.deepEqual(hours(stats('g', t - 30 * DAY, 'none', 'game')), [['Valheim', 4, 2]]);
  assert.deepEqual(hours(stats('g', 0, 'none', 'game')), [['Valheim', 4, 2], ['Lethal Company', 1, 1]]);
});

test('breaks down per person and per game', () => {
  assert.deepEqual(hours(stats('g', 0, 'user', 'game', 'a')), [['Valheim', 4, 1], ['Lethal Company', 1, 1]]);
  assert.deepEqual(hours(stats('g', 0, 'game', 'user_id', undefined, 'Valheim')), [['a', 4, 1], ['b', 1, 1]]);
});

test('a game’s time is how long anyone was playing it', () => {
  const add = (game: string, user: string, from: number, to: number, channel = 'voice') =>
    db.prepare('INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run('length', user, game, channel, t - from * HOUR, t - to * HOUR);
  add('Overlap', 'a', 10, 8);
  add('Overlap', 'b', 9, 7);
  add('Apart', 'a', 10, 9);
  add('Apart', 'b', 8, 7);
  add('Inside', 'a', 10, 6);
  add('Inside', 'b', 9, 8);
  add('Touching', 'a', 10, 9);
  add('Touching', 'b', 9, 8);
  add('Two rooms', 'a', 10, 8, 'v1');
  add('Two rooms', 'b', 10, 8, 'v2');
  add('Crowded', 'a', 3, 2);
  add('Crowded', 'b', 3, 2);
  add('Crowded', 'c', 3, 2);
  add('Crowded', 'd', 3, 2);
  // Old rows aren't counted, even where they'd add time
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES ('length', 'e', 'Crowded', ?, ?)`).run(t - 5 * HOUR, t - 4 * HOUR);

  assert.deepEqual(
    hours(stats('length', 0, 'none', 'game')).sort(),
    [['Apart', 2, 2], ['Crowded', 1, 4], ['Inside', 4, 2], ['Overlap', 3, 2], ['Touching', 2, 2], ['Two rooms', 2, 2]],
  );
  // Ranked by that, not by everyone's time: Crowded has 4h of that but was only on for 1h
  assert.equal(stats('length', 0, 'none', 'game').at(-1)!.key, 'Crowded');
  // Cut off at the period, partly through Overlap's second person
  assert.deepEqual(hours(stats('length', 0, 'game', 'game', undefined, 'Overlap', t - 8 * HOUR)), [['Overlap', 2, 2]]);
  assert.deepEqual(hours(stats('length', t - 9 * HOUR, 'game', 'game', undefined, 'Overlap')), [['Overlap', 2, 2]]);
  // Each person's own time stays their own
  assert.deepEqual(hours(stats('length', 0, 'game', 'user_id', undefined, 'Overlap')).sort(), [['a', 2, 1], ['b', 2, 1]]);
  assert.deepEqual(hours(stats('length', 0, 'user', 'game', 'a')).find((r) => r[0] === 'Overlap'), ['Overlap', 2, 1]);
  assert.deepEqual(hours(stats('length', 0, 'both', 'game', 'b', 'Overlap')), [['Overlap', 2, 1]]);
});

test('plays stored out of time order still join up, as ones from the upgrade are', () => {
  const add = (user: string, from: number, to: number) =>
    db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES ('shuffled', ?, 'Valheim', 'voice', ?, ?)`).run(user, t - from * HOUR, t - to * HOUR);
  add('b', 5, 4);
  add('a', 10, 6);
  add('c', 7, 3);
  assert.deepEqual(hours(stats('shuffled', 0, 'none', 'game')), [['Valheim', 7, 3]]);
  assert.equal(Math.round(activity('shuffled', t - 20 * HOUR, t, 'UTC').buckets.reduce((sum, b) => sum + b.ms, 0) / HOUR), 7);
});

test('the chart shows how long games were played, or one person’s own time', () => {
  const total = (buckets: { ms: number }[]) => buckets.reduce((sum, b) => sum + b.ms, 0);
  const everyone = activity('length', t - 20 * HOUR, t, 'UTC');
  assert.equal(Math.round(total(everyone.buckets) / HOUR), 14);
  assert.equal(Math.round(total(activity('length', t - 20 * HOUR, t, 'UTC', undefined, 'Overlap').buckets) / HOUR), 3);
  // Two games on at once are both counted, for a person as for the server
  assert.equal(Math.round(total(activity('length', t - 20 * HOUR, t, 'UTC', 'a').buckets) / HOUR), 11);
});

test('only counts the part of a play inside the period', () => {
  play.run('g', 'c', 'Deep Rock', t - 7 * DAY - HOUR, t - 7 * DAY + HOUR);
  assert.equal(stats('g', t - 7 * DAY, 'none', 'game').find((r) => r.key === 'Deep Rock')!.ms > HOUR - 60_000, true);
  assert.equal(stats('g', t - 7 * DAY, 'none', 'game').find((r) => r.key === 'Deep Rock')!.ms < HOUR + 60_000, true);
});

test('game names match without caring about case', () => {
  assert.deepEqual(hours(stats('g', 0, 'game', 'user_id', undefined, 'valheim')), [['a', 4, 1], ['b', 1, 1]]);
});

/** Runs /gamestats and returns the embed it replies with */
async function gamestats(options: { user?: { id: string; displayName: string; displayAvatarURL(): string }; nickname?: string; game?: string }) {
  let reply: { embeds?: { toJSON(): { title: string; description: string; fields?: { value: string }[] } }[] } = {};
  const interaction = {
    inCachedGuild: () => true,
    guildId: 'g',
    guild: { members: { cache: new Map(['a', 'b', 'c'].map((id) => [id, {}])) } },
    options: {
      getString: (name: string) => (name === 'game' ? (options.game ?? null) : 'all'),
      getUser: () => options.user ?? null,
      getMember: () => (options.nickname ? { displayName: options.nickname } : null),
    },
    reply: async (r: typeof reply) => (reply = r),
  };
  await gameStats.commands![0].run(interaction as never);
  return reply.embeds![0].toJSON();
}

test('says people, not persons', async () => {
  assert.match((await gamestats({})).description, /by 3 people/);
  assert.match((await gamestats({ game: 'Valheim' })).description, /by 2 people/);
  assert.match((await gamestats({ game: 'Deep Rock' })).description, /by 1 person/);
});

test('/gamestats shows how long games were played, and each person’s own time for one game', async () => {
  const overall = await gamestats({});
  assert.match(overall.fields![0].value, /Valheim\*\* · 4h/);
  const one = await gamestats({ game: 'Valheim' });
  assert.match(one.description, /^\*\*4h\*\* played by 2 people/);
  assert.match(one.description, /<@a> · 4h/);
  assert.match(one.description, /<@b> · 1h/);
});

test('uses the server nickname', async () => {
  const title = (await gamestats({ user: { id: 'a', displayName: 'Global', displayAvatarURL: () => 'https://example.com/a.png' }, nickname: 'Nick' })).title;
  assert.match(title, /Nick/);
});

test('a very long game name still fits', async () => {
  for (let n = 0; n < 12; n++) play.run('long', 'a', `${n} ${'x'.repeat(120)}`, t - HOUR, t);
  const embed = await (async () => {
    let reply: { embeds: { toJSON(): { fields: { value: string }[] } }[] };
    await gameStats.commands![0].run({
      inCachedGuild: () => true,
      guildId: 'long',
      guild: { members: { cache: new Map([['a', {}]]) } },
      options: { getString: (name: string) => (name === 'game' ? null : 'all'), getUser: () => null, getMember: () => null },
      reply: async (r: typeof reply) => (reply = r),
    } as never);
    return reply!.embeds[0].toJSON();
  })();
  assert.ok(embed.fields[0].value.length <= 1024, `${embed.fields[0].value.length} characters`);
});

test('after a long disconnect, someone who went offline stops counting as playing', async () => {
  mock.method(console, 'error', () => {});
  const activity = { type: 0, name: 'Stale Game' };
  const presences = { cache: new Map<string, unknown>([['p', { activities: [activity] }]]) };
  const guild = { id: 'gap', name: 'Gap', presences, members: { cache: new Map(), fetch: async (): Promise<unknown> => undefined } };
  const member = { id: 'p', user: { bot: false }, guild, voice: { channelId: 'v' }, get presence() { return presences.cache.get('p') ?? null; } };
  guild.members.cache.set('p', member);
  const client = { guilds: { cache: new Map([['gap', guild]]) } } as never;

  // Discord sends this person's presence back, so they're still playing
  guild.members.fetch = async () => presences.cache.set('p', { activities: [activity] });
  await resync(client);
  const open = () => (db.prepare(`SELECT COUNT(*) AS n FROM game_plays WHERE guild_id = 'gap'`).get() as { n: number }).n;
  assert.equal(open(), 1);

  // Now it doesn't. The play is under a minute here, so closing it drops the row
  guild.members.fetch = async () => undefined;
  await resync(client);
  assert.equal(open(), 0);
  assert.equal(presences.cache.size, 0);
});

test('time together is the overlap in the same game, not just both playing it', () => {
  play.run('c', 'a', 'Valheim', t - 10 * HOUR, t - 6 * HOUR);
  play.run('c', 'b', 'Valheim', t - 8 * HOUR, t - 4 * HOUR);
  play.run('c', 'b', 'Valheim', t - 100 * HOUR, t - 90 * HOUR);
  play.run('c', 'a', 'Deep Rock', t - 3 * HOUR, t - 2 * HOUR);
  play.run('c', 'b', 'Lethal Company', t - 3 * HOUR, t - 2 * HOUR);
  play.run('elsewhere', 'b', 'Deep Rock', t - 3 * HOUR, t - 2 * HOUR);
  assert.deepEqual(playedTogether('c', 'a', 'b').map((r) => [r.game, r.ms / HOUR]), [['Valheim', 2]]);
  assert.deepEqual(playedTogether('c', 'b', 'a').map((r) => [r.game, r.ms / HOUR]), [['Valheim', 2]]);
  assert.deepEqual(playedTogether('c', 'a', 'nobody'), []);
});

test('the same game in different voice channels isn’t time together', () => {
  const inChannel = db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES ('split', ?, 'Valheim', ?, ?, ?)`);
  inChannel.run('a', 'v1', t - 3 * HOUR, t);
  inChannel.run('b', 'v2', t - 3 * HOUR, t);
  inChannel.run('c', 'v1', t - HOUR, t);
  assert.deepEqual(playedTogether('split', 'a', 'b'), []);
  assert.deepEqual(playedTogether('split', 'a', 'c').map((r) => [r.game, r.ms / HOUR]), [['Valheim', 1]]);
});

test('voice time together counts shared sessions, at the shorter person’s time', () => {
  const session = (guildId: string, people: [string, number][]) => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, 'v', 0, 1)`).run(guildId);
    for (const [id, seconds] of people) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(lastInsertRowid, id, seconds);
  };
  session('c', [['a', 3600], ['b', 1800]]);
  session('c', [['a', 600], ['b', 1200]]);
  session('c', [['a', 9999]]);
  session('elsewhere', [['a', 9999], ['b', 9999]]);
  assert.deepEqual({ ...voiceTogether('c', 'a', 'b') }, { n: 2, seconds: 2400 });
  assert.deepEqual({ ...voiceTogether('c', 'a', 'nobody') }, { n: 0, seconds: 0 });
});

test('shared games are library games plus multiplayer Steam games both own', () => {
  const add = db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES ('c', ?, ?, 'x')`);
  const manual = Number(add.run('Jackbox', null).lastInsertRowid);
  const steamOne = Number(add.run('Deep Rock', 10).lastInsertRowid);
  const half = Number(add.run('Half', null).lastInsertRowid);
  for (const [game, user] of [[manual, 'a'], [manual, 'b'], [steamOne, 'b'], [half, 'a']] as [number, string][]) {
    db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)').run(game, user);
  }
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('a', 'sa'), ('b', 'sb')`).run();
  const own = db.prepare('INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES (?, ?, ?, ?)');
  own.run('sa', 10, 'Deep Rock Galactic', 60);
  for (const [steam, minutes] of [['sa', 300], ['sb', 100]] as [string, number][]) {
    own.run(steam, 20, 'Helldivers', minutes);
    own.run(steam, 30, 'Solo Game', 9000);
  }
  own.run('sa', 40, 'Only Mine', 5);
  db.prepare('INSERT INTO app_info (appid, name, multiplayer) VALUES (20, ?, 1), (30, ?, 0), (40, ?, 1)').run('Helldivers', 'Solo Game', 'Only Mine');
  assert.deepEqual(sharedGames('c', 'a', 'b'), [
    { name: 'Helldivers', minutes: 400 },
    { name: 'Deep Rock', minutes: 60 },
    { name: 'Jackbox', minutes: 0 },
  ]);
});

async function compare(user: { id: string; bot?: boolean; displayName?: string }, other?: { id: string; bot?: boolean; displayName?: string }) {
  let reply: { content?: string; embeds?: { toJSON(): { title: string; description: string; fields: { name: string; value: string }[] } }[] } = {};
  await gameStats.commands![1].run({
    inCachedGuild: () => true,
    guildId: 'c',
    user: { id: 'a', displayName: 'Alex' },
    guild: { members: { cache: new Map([['a', { displayName: 'Alex' }], ['b', { displayName: 'Sam' }]]) } },
    options: { getUser: (name: string) => (name === 'user' ? user : (other ?? null)) },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  return reply;
}

test('/compare sums it all up, against you by default', async () => {
  const embed = (await compare({ id: 'b', displayName: 'Sam' })).embeds![0].toJSON();
  assert.equal(embed.title, '🤝 Alex and Sam');
  assert.match(embed.description, /\*\*2h\*\* in the same game/);
  assert.match(embed.description, /\*\*2 voice sessions\*\* together, up to 40m/);
  assert.match(embed.fields[0].value, /Valheim/);
  assert.equal(embed.fields[1].name, 'Both own (3)');
  assert.match(embed.fields[1].value, /^Helldivers, Deep Rock, Jackbox$/);
});

test('/compare takes two other people, and says when there’s nothing yet', async () => {
  const embed = (await compare({ id: 'b', displayName: 'Sam' }, { id: 'nobody', displayName: 'Pat' })).embeds![0].toJSON();
  assert.equal(embed.title, '🤝 Pat and Sam');
  assert.match(embed.description, /No time together/);
  assert.match(embed.fields[0].value, /\/steam link/);
});

test('/compare refuses one person or a bot', async () => {
  assert.match((await compare({ id: 'a' })).content!, /two different/);
  assert.match((await compare({ id: 'b' }, { id: 'b' })).content!, /two different/);
  assert.match((await compare({ id: 'robot', bot: true })).content!, /Bots/);
});

const MINUTE = 60_000;

/** A server the feature is watching, with its members in and out of voice */
function voiceServer(t: TestContext, id: string, afkChannelId: string | null = null) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const guild = {
    id,
    name: id,
    afkChannelId,
    presences: { cache: new Map() },
    members: { cache: new Map<string, unknown>(), fetch: async (): Promise<unknown> => undefined },
  };
  const client = Object.assign(new EventEmitter(), { guilds: { cache: new Map([[id, guild]]) } });
  gameStats.setup!(client as never);

  const member = (userId: string, bot = false) => {
    const person = { id: userId, user: { bot }, guild, voice: { channelId: null as string | null }, presence: { activities: [] as { type: number; name: string }[] } };
    guild.members.cache.set(userId, person);
    return person;
  };
  type Member = ReturnType<typeof member>;
  return {
    client,
    member,
    moveTo(person: Member, channelId: string | null) {
      const oldState = { channelId: person.voice.channelId };
      person.voice = { channelId };
      client.emit(Events.VoiceStateUpdate, oldState, { channelId, member: person, guild });
    },
    /** A mute or deafen: Discord sends a voice update, but the channel stays the same */
    mute(person: Member) {
      const { channelId } = person.voice;
      client.emit(Events.VoiceStateUpdate, { channelId }, { channelId, member: person, guild });
    },
    play(person: Member, ...games: string[]) {
      person.presence = { activities: games.map((name) => ({ type: 0, name })) };
      client.emit(Events.PresenceUpdate, null, { member: person, guild });
    },
    /** Everything recorded so far, as [person, game, channel, minutes] */
    plays() {
      checkpoint();
      const rows = db
        .prepare('SELECT user_id AS userId, game, channel_id AS channelId, ended_at - started_at AS ms FROM game_plays WHERE guild_id = ? ORDER BY id')
        .all(id) as { userId: string; game: string; channelId: string; ms: number }[];
      return rows.map((r) => [r.userId, r.game, r.channelId, r.ms / MINUTE]);
    },
  };
}

test('a game counts in voice, even alone', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'alone');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'Valheim');
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 5]]);
});

test('a game out of voice isn’t recorded at all', (t) => {
  const { member, play, plays } = voiceServer(t, 'solo');
  play(member('sam'), 'Valheim');
  t.mock.timers.tick(30 * MINUTE);
  assert.deepEqual(plays(), []);
});

test('the AFK channel doesn’t count, and going there stops the clock', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'afk', 'away');
  const sam = member('sam');
  moveTo(sam, 'away');
  play(sam, 'Valheim');
  t.mock.timers.tick(30 * MINUTE);
  assert.deepEqual(plays(), []);
  moveTo(sam, 'v1');
  t.mock.timers.tick(5 * MINUTE);
  moveTo(sam, 'away');
  t.mock.timers.tick(30 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 5]]);
});

test('a game started before joining counts from the join, and leaving stops it', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'joining');
  const sam = member('sam');
  play(sam, 'Valheim');
  t.mock.timers.tick(20 * MINUTE);
  moveTo(sam, 'v1');
  t.mock.timers.tick(10 * MINUTE);
  moveTo(sam, null);
  t.mock.timers.tick(20 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 10]]);
});

test('closing the game in voice stops it, and others in the channel carry on', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'closing');
  const [sam, alex] = [member('sam'), member('alex')];
  for (const person of [sam, alex]) {
    moveTo(person, 'v1');
    play(person, 'Valheim');
  }
  t.mock.timers.tick(5 * MINUTE);
  play(sam);
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 5], ['alex', 'Valheim', 'v1', 10]]);
});

test('moving channel starts a new play in the new channel', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'moving');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'Valheim');
  t.mock.timers.tick(5 * MINUTE);
  moveTo(sam, 'v2');
  t.mock.timers.tick(3 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 5], ['sam', 'Valheim', 'v2', 3]]);
});

test('muting doesn’t split a play', (t) => {
  const { member, moveTo, mute, play, plays } = voiceServer(t, 'muting');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'Valheim');
  t.mock.timers.tick(5 * MINUTE);
  mute(sam);
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 10]]);
});

test('two spellings of a game showing at once are one play', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'spellings');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'Slay the Spire 2', 'slaythespire2');
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Slay the Spire 2', 'v1', 5]]);
  play(sam, 'slaythespire2');
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Slay the Spire 2', 'v1', 10]], 'the same play carries on under its other spelling');
});

test('a play keeps the spelling it was seen under, so it can be separated later', (t) => {
  const { member, moveTo, play } = voiceServer(t, 'stored');
  noteGame('stored', 'Lethal Company');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'lethalcompany');
  assert.deepEqual(db.prepare(`SELECT game FROM game_plays WHERE guild_id = 'stored'`).all().map((r) => r.game), ['lethalcompany']);
});

test('a new spelling is recorded as it’s first played', (t) => {
  const { member, moveTo, play } = voiceServer(t, 'spotted');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'Lethal Company');
  play(sam, 'Lethal Company', 'lethalcompany');
  assert.equal(gameName('spotted', 'lethalcompany'), 'Lethal Company');
  assert.deepEqual([...gameSpellings('spotted').keys()], ['Lethal Company']);
  assert.deepEqual(gameSpellings('spotted').get('Lethal Company'), ['Lethal Company', 'lethalcompany']);
});

test('bots aren’t recorded', (t) => {
  const { member, moveTo, play, plays } = voiceServer(t, 'bots');
  const robot = member('robot', true);
  moveTo(robot, 'v1');
  play(robot, 'Valheim');
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), []);
});

test('a server that isn’t allowed isn’t recorded', (t) => {
  Object.assign(config, { allowedGuildIds: ['somewhere-else'] });
  t.after(() => Object.assign(config, { allowedGuildIds: undefined }));
  const { member, moveTo, plays } = voiceServer(t, 'barred');
  const sam = member('sam');
  sam.presence = { activities: [{ type: 0, name: 'Valheim' }] };
  moveTo(sam, 'v1');
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), []);
});

test('a resync closes the play of someone who left voice during the gap', async (t) => {
  const { client, member, moveTo, play, plays } = voiceServer(t, 'dropped');
  const sam = member('sam');
  moveTo(sam, 'v1');
  play(sam, 'Valheim');
  t.mock.timers.tick(5 * MINUTE);
  sam.voice = { channelId: null }; // no event: it happened while the bot was disconnected
  await resync(client as never);
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(plays(), [['sam', 'Valheim', 'v1', 5]]);
});

test('plays from before voice tracking aren’t counted anywhere', async (t) => {
  const old = db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES ('old', ?, 'Old Game', ?, ?)`);
  old.run('a', t2(4), t2(1));
  old.run('b', t2(4), t2(1));
  assert.deepEqual(stats('old', 0, 'none', 'game'), []);
  assert.deepEqual(activity('old', 0, Date.now(), 'UTC').buckets, []);
  assert.deepEqual(playedTogether('old', 'a', 'b'), []);

  let names: { name: string }[] = [];
  await gameStats.commands![0].autocomplete!({ inGuild: () => true, guildId: 'old', options: { getFocused: () => '' }, respond: async (r: typeof names) => (names = r) } as never);
  assert.deepEqual(names, []);

  // A counted play of the same game, so only the session count can tell old rows apart
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES ('old', 'a', 'Old Game', 'v', ?, ?)`).run(t2(1), t2(0));
  let reply: { embeds: { toJSON(): { description: string } }[] };
  await gameStats.commands![0].run({
    inCachedGuild: () => true,
    guildId: 'old',
    guild: { members: { cache: new Map([['a', {}]]) } },
    options: { getString: (name: string) => (name === 'game' ? 'Old Game' : 'all'), getUser: () => ({ id: 'a', displayName: 'A' }), getMember: () => null },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  assert.match(reply!.embeds[0].toJSON().description, /over 1 session,/);
});

function t2(hoursAgo: number) {
  return t - hoursAgo * HOUR;
}
