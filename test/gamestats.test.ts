import './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { gameStats, resync, stats } from '../src/features/gamestats.ts';

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
