import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { parseWhen, tick } from '../src/features/gamenight.ts';

const zone = 'America/Chicago';
const thursday3pm = Date.UTC(2026, 9, 29, 20, 0);
const local = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleString('sv-SE', { timeZone: zone }).slice(0, 16));

test('reads day and time phrases in the server’s time zone', () => {
  const cases: [string, string | null][] = [
    ['fri 8pm', '2026-10-30 20:00'],
    ['friday 8', '2026-10-30 20:00'],
    ['Thu 9pm', '2026-10-29 21:00'],
    ['thu 2pm', '2026-11-05 14:00'],
    ['next thu 9pm', '2026-11-05 21:00'],
    ['tomorrow 20:30', '2026-10-30 20:30'],
    ['tonight at 9', '2026-10-29 21:00'],
    ['9pm', '2026-10-29 21:00'],
    ['2pm', '2026-10-30 14:00'],
    ['nov 3 7pm', '2026-11-03 19:00'],
    ['November 3rd at 7:30 pm', '2026-11-03 19:30'],
    ['11/3 9', '2026-11-03 21:00'],
    ['2026-11-03 19:00', '2026-11-03 19:00'],
    ['sat noon', '2026-10-31 12:00'],
    ['8pm fri', '2026-10-30 20:00'],
    ['sun 10am', '2026-11-01 10:00'],
    ['jan 2 8pm', '2027-01-02 20:00'],
    ['sat at 11:30am', '2026-10-31 11:30'],
    ['blah', null],
    ['fri', null],
    ['25:00', null],
    ['fri 8pm with snacks', null],
  ];
  for (const [text, expected] of cases) assert.equal(local(parseWhen(text, thursday3pm, zone)), expected, text);
});

test('uses the offset on the day itself, across a daylight saving change', () => {
  assert.equal(new Date(parseWhen('nov 2 8pm', thursday3pm, zone)!).toISOString(), '2026-11-03T02:00:00.000Z');
  assert.equal(new Date(parseWhen('fri 8pm', thursday3pm, 'Europe/London')!).toISOString(), '2026-10-30T20:00:00.000Z');
});

function night(guildId: string, startsIn: number) {
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO game_nights (guild_id, channel_id, game, starts_at, created_by) VALUES (?, ?, 'Valheim', ?, 'host')`)
    .run(guildId, `channel-${guildId}`, Date.now() + startsIn);
  db.prepare(`INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, 'host', 'in')`).run(lastInsertRowid);
  return Number(lastInsertRowid);
}
const reminded = (id: number) => (db.prepare('SELECT reminded FROM game_nights WHERE id = ?').get(id) as { reminded: number }).reminded;

test('a reminder is a plain message, so it doesn’t need Read Message History', async () => {
  const id = night('plain', 600_000);
  db.prepare(`UPDATE game_nights SET message_id = 'card' WHERE id = ?`).run(id);
  const sent: Record<string, unknown>[] = [];
  await tick(
    fakeClient([{ id: 'plain', name: 'Plain' }], async (_guild, message) => {
      sent.push(message);
    }),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply, undefined);
  assert.match(String(sent[0].content), /<@host>/);
  assert.match(String(sent[0].content), /channels\/plain\/channel-plain\/card/);
});

test('a reminder that fails doesn’t hold up other servers, and is tried again', async () => {
  mock.method(console, 'error', () => {});
  const broken = night('a', 600_000);
  const fine = night('b', 600_000);
  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], async (guildId) => {
    if (guildId === 'a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await tick(client);
  assert.deepEqual(sent, ['b']);
  assert.equal(reminded(broken), 0);
  assert.equal(reminded(fine), 1);

  aWorks = true;
  await tick(client);
  assert.deepEqual(sent, ['b', 'a'], 'b isn’t reminded twice');
  assert.equal(reminded(broken), 1);
});
