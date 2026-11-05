import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db, getKv, setKv } from '../src/db.ts';
import { buildRecap, maybePostMonthly, monthBounds, recap } from '../src/features/recap.ts';
import { setSetting } from '../src/settings.ts';
import { zonedParts } from '../src/util.ts';

const zone = 'America/Chicago';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const { start, end } = monthBounds(2026, 10, zone);
const members = (...ids: string[]) => ({ cache: new Map(ids.map((id) => [id, {}])) });
const guild = (id: string, ...ids: string[]) => ({ id, members: members(...ids) }) as never;

function session(guildId: string, startedAt: number, hours: number, people: Record<string, number>) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, 'v', ?, ?)`).run(guildId, startedAt, startedAt + hours * HOUR);
  for (const [id, h] of Object.entries(people)) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(lastInsertRowid, id, h * 3600);
}
const play = db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)');
const sound = db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)');
const field = (embed: { fields?: { name: string; value: string }[] }, name: string) => embed.fields?.find((f) => f.name === name)?.value;

test('month bounds follow the server’s calendar, across the new year', () => {
  assert.equal(new Date(start).toISOString(), '2026-10-01T05:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(new Date(monthBounds(2026, 12, zone).end).toISOString(), '2027-01-01T06:00:00.000Z');
  assert.equal(new Date(monthBounds(2027, 0, zone).start).toISOString(), '2026-12-01T06:00:00.000Z');
});

test('a month with nothing in it has no recap', () => {
  assert.equal(buildRecap(guild('empty', 'a'), start, end), null);
});

test('counts only that month, only this server and only current members', () => {
  play.run('r', 'a', 'Valheim', start + DAY, start + DAY + 3 * HOUR);
  play.run('r', 'b', 'Valheim', start + DAY, start + DAY + HOUR);
  play.run('r', 'a', 'Deep Rock', start + 2 * DAY, start + 2 * DAY + 2 * HOUR);
  play.run('r', 'gone', 'Deep Rock', start + 2 * DAY, start + 2 * DAY + 9 * HOUR);
  // Runs across the end of the month: only the first hour belongs to it
  play.run('r', 'a', 'Lethal Company', end - HOUR, end + 5 * HOUR);
  play.run('r', 'a', 'September Game', start - 2 * DAY, start - DAY);
  play.run('elsewhere', 'a', 'Other', start + DAY, start + 2 * DAY);
  session('r', start + DAY, 5, { a: 5, b: 2, gone: 1 });
  session('r', start + 2 * DAY, 1, { a: 1, b: 1 });
  session('r', end + DAY, 9, { a: 9, b: 9 });
  for (let n = 0; n < 3; n++) sound.run('r', 'b', 'bruh', start + DAY);
  sound.run('r', 'a', 'airhorn', start + DAY);
  sound.run('r', 'gone', 'airhorn', start + DAY);
  sound.run('r', 'gone', 'airhorn', start + DAY);
  sound.run('r', 'gone', 'airhorn', start + DAY);
  sound.run('r', 'gone', 'airhorn', start + DAY);
  sound.run('r', 'a', 'old', start - DAY);
  const night = (game: string, cancelled: number, people: number) => {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO game_nights (guild_id, channel_id, game, starts_at, created_by, cancelled) VALUES ('r', 'c', ?, ?, 'a', ?)`)
      .run(game, start + 3 * DAY, cancelled);
    for (let n = 0; n < people; n++) db.prepare(`INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, 'in')`).run(lastInsertRowid, `u${n}`);
  };
  night('Valheim', 0, 2);
  night('Jackbox', 0, 4);
  night('Cancelled', 1, 9);

  const embed = buildRecap(guild('r', 'a', 'b'), start, end)!.toJSON();
  assert.equal(embed.title, '🗓️ October 2026 recap');
  assert.match(embed.description!, /3 games/);
  assert.match(embed.description!, /2 voice sessions/);
  assert.match(field(embed, 'Most played')!, /Deep Rock.*11h/);
  assert.match(field(embed, 'Most played')!, /Valheim.*4h/);
  assert.match(field(embed, 'Most played')!, /Lethal Company.*1h/);
  assert.doesNotMatch(field(embed, 'Most played')!, /September/);
  assert.match(field(embed, 'Biggest gamers')!, /🥇 <@a> · 6h/);
  assert.doesNotMatch(field(embed, 'Biggest gamers')!, /gone/);
  assert.match(field(embed, 'Most time in voice')!, /🥇 <@a> · 6h/);
  assert.match(field(embed, 'Most time in voice')!, /🥈 <@b> · 3h/);
  assert.doesNotMatch(field(embed, 'Most time in voice')!, /gone/);
  assert.match(field(embed, 'Longest session')!, /\*\*5h\*\*.*<@a> <@b>$/);
  assert.match(field(embed, 'Top sounds')!, /🥇 \*\*airhorn\*\* · 5 plays/);
  assert.match(field(embed, 'Top sounds')!, /trigger-happy: <@b> · 3 plays/);
  assert.equal(field(embed, 'Game nights'), '2 nights, best turnout Jackbox with 4 in');
});

/** Sets the clock to a local date in the server's zone */
function at(year: number, month: number, day: number, hour: number) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(year, month - 1, day, hour + 6) });
}

test('posts last month on the 1st, once, starting from the month after a server first appears', async () => {
  setSetting('m', 'announceChannel', 'channel-m');
  setSetting('m', 'timezone', 'America/Chicago');
  setSetting('m', 'weeklyPostHour', 20);
  const { start: novStart } = monthBounds(2026, 11, zone);
  play.run('m', 'a', 'Valheim', novStart + DAY, novStart + DAY + HOUR);
  play.run('m', 'a', 'October Game', novStart - DAY, novStart - DAY + HOUR);
  const sent: string[] = [];
  const client = fakeClient([{ id: 'm', name: 'M', members: members('a') } as never], async (_g, message) => {
    sent.push((message.embeds as { toJSON(): { title: string } }[])[0].toJSON().title);
  });

  at(2026, 11, 20, 12);
  await maybePostMonthly(client);
  assert.equal(sent.length, 0, 'nothing posted right after an upgrade');
  assert.equal(getKv('monthly_post:m'), '2026-11');

  at(2026, 12, 1, 19);
  await maybePostMonthly(client);
  assert.equal(sent.length, 0, 'waits for the hour');

  at(2026, 12, 1, 20);
  await maybePostMonthly(client);
  await maybePostMonthly(client);
  assert.deepEqual(sent, ['🗓️ November 2026 recap']);
  mock.timers.reset();
});

test('a recap missed on the 1st goes out when the bot is back, and a failed post is tried again', async () => {
  mock.method(console, 'error', () => {});
  setSetting('n', 'announceChannel', 'channel-n');
  setSetting('n', 'timezone', 'America/Chicago');
  setKv('monthly_post:n', '2026-11');
  const { start: novStart } = monthBounds(2026, 11, zone);
  play.run('n', 'a', 'Valheim', novStart + DAY, novStart + DAY + HOUR);
  let works = false;
  const sent: unknown[] = [];
  const client = fakeClient([{ id: 'n', name: 'N', members: members('a') } as never], async (_g, message) => {
    if (!works) throw new Error('Missing Permissions');
    sent.push(message);
  });
  at(2026, 12, 3, 9);
  await maybePostMonthly(client);
  assert.equal(getKv('monthly_post:n'), '2026-11');
  works = true;
  await maybePostMonthly(client);
  assert.equal(sent.length, 1);
  assert.equal(getKv('monthly_post:n'), '2026-12');
  mock.timers.reset();
});

test('a server that turned it off gets no post, and an empty month is skipped quietly', async () => {
  setSetting('off', 'announceChannel', 'channel-off');
  setSetting('off', 'monthlyRecap', false);
  setKv('monthly_post:off', '2020-1');
  setSetting('quiet', 'announceChannel', 'channel-quiet');
  setKv('monthly_post:quiet', '2020-1');
  const sent: string[] = [];
  await maybePostMonthly(fakeClient([{ id: 'off', name: 'Off', members: members() } as never, { id: 'quiet', name: 'Quiet', members: members() } as never], async (g) => void sent.push(g)));
  assert.deepEqual(sent, []);
  assert.equal(getKv('monthly_post:off'), '2020-1');
  assert.notEqual(getKv('monthly_post:quiet'), '2020-1');
});

test('/recap can show this month so far', async () => {
  const now = zonedParts(Date.now(), zone);
  setSetting('live', 'timezone', zone);
  const { start: thisMonth } = monthBounds(now.year, now.month, zone);
  play.run('live', 'a', 'Valheim', thisMonth, thisMonth + 1000 * 60 * 90);
  let reply: { embeds?: { toJSON(): { title: string; fields: { value: string }[] } }[]; content?: string } | undefined;
  const run = (month: string | null) =>
    recap.commands![0].run({
      inCachedGuild: () => true,
      guildId: 'live',
      guild: guild('live', 'a'),
      options: { getString: () => month },
      reply: async (r: typeof reply) => (reply = r),
    } as never);
  await run('this');
  assert.match(reply!.embeds![0].toJSON().fields[0].value, /Valheim/);
  await run(null);
  assert.match(reply!.content!, /Nothing to recap for last month/);
});
