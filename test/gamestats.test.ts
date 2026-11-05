import './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { sharedGames } from '../src/features/games.ts';
import { gameStats, playedTogether, resync, stats, voiceTogether } from '../src/features/gamestats.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t = Date.now();
const play = db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)');
play.run('g', 'a', 'Valheim', t - 3 * HOUR, t - HOUR);
play.run('g', 'b', 'Valheim', t - 2 * HOUR, t - HOUR);
play.run('g', 'a', 'Valheim', t - 8 * DAY - HOUR, t - 8 * DAY + HOUR);
play.run('g', 'a', 'Lethal Company', t - 40 * DAY, t - 40 * DAY + HOUR);
play.run('other', 'a', 'Valheim', t - HOUR, t);

const hours = (rows: { key: string; ms: number; n: number }[]) => rows.map((r) => [r.key, Math.round(r.ms / HOUR), r.n]);

test('adds up the server’s games over a period', () => {
  assert.deepEqual(hours(stats('g', t - 7 * DAY, 'none', 'game')), [['Valheim', 3, 2]]);
  assert.deepEqual(hours(stats('g', t - 30 * DAY, 'none', 'game')), [['Valheim', 5, 2]]);
  assert.deepEqual(hours(stats('g', 0, 'none', 'game')), [['Valheim', 5, 2], ['Lethal Company', 1, 1]]);
});

test('breaks down per person and per game', () => {
  assert.deepEqual(hours(stats('g', 0, 'user', 'game', 'a')), [['Valheim', 4, 1], ['Lethal Company', 1, 1]]);
  assert.deepEqual(hours(stats('g', 0, 'game', 'user_id', undefined, 'Valheim')), [['a', 4, 1], ['b', 1, 1]]);
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
  const member = { id: 'p', user: { bot: false }, guild, get presence() { return presences.cache.get('p') ?? null; } };
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
