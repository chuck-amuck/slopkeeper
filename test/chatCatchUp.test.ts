import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchUp } from '../src/features/chat.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 18, 20, 0);

const names: Record<string, string> = { '100': 'Slopkeeper', '201': 'Robin', '202': 'Sam', '203': 'Alex' };
const members = new Map(Object.entries(names).map(([id, displayName]) => [id, { id, displayName }]));
const guild = { id: 'g-catch-up', members: { cache: members }, roles: { cache: new Map() }, channels: { cache: new Map() } };
const robin = { id: '201', displayName: 'Robin', guild, client: { user: { id: '100' } } } as never;

/** A channel with these messages, [who, minutes ago, text], that pages back as Discord does, newest first */
function channelWith(said: [string, number, string][], { failing = false } = {}) {
  let calls = 0;
  const messages = said
    .map(([who, ago, content], i) => ({
      id: String(1_000_000 + i),
      createdTimestamp: NOW - ago * MINUTE,
      author: { id: who, displayName: names[who] },
      member: { displayName: names[who] },
      content,
      attachments: new Map(),
    }))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m, i) => ({ ...m, id: String(1_000_000 + i) }));
  const channel = {
    name: 'general',
    permissionsFor: (who: { id: string }) => ({ has: () => !noHistory.has(who.id) }),
    messages: {
      fetch: async ({ limit, before }: { limit: number; before: string }) => {
        calls++;
        if (failing) throw new Error('Missing Access');
        const older = messages.filter((m) => BigInt(m.id) < BigInt(before)).reverse().slice(0, limit);
        return new Map(older.map((m) => [m.id, m]));
      },
    },
  };
  return { channel: channel as never, calls: () => calls };
}
const ASKING = '9999999';
/** People who can't read the channel's history */
const noHistory = new Set<string>();
const read = (said: [string, number, string][], hours = 0) => catchUp(robin, channelWith(said).channel, ASKING, hours, NOW);

test('it reads back to when the asker last wrote, not counting what they said as they asked', async () => {
  const text = await read([
    ['202', 600, 'from before'],
    ['201', 300, 'heading out'],
    ['202', 240, 'deep rock at 9? <@201>'],
    ['100', 200, 'Planned it.'],
    ['203', 60, 'in'],
    ['201', 2, 'back!'],
  ]);
  const lines = text.split('\n');
  assert.match(lines[0]!, /^4 messages in #general since Robin last wrote here \(\w{3} \d+:\d\d [AP]M\), oldest first:$/);
  assert.deepEqual(
    lines.slice(1).map((l) => l.replace(/^\[[^\]]+\] /, '')),
    ['Sam: deep rock at 9? @Robin', 'You: Planned it.', 'Alex: in', 'Robin: back!'],
  );
});

test('it reads the last hours asked for, or the last day for someone who hasn’t been here in 3 days', async () => {
  const said: [string, number, string][] = [
    ['202', 2000, 'three days ago'],
    ['202', 600, 'this morning'],
    ['203', 90, 'an hour and a half ago'],
    ['203', 30, 'half an hour ago'],
  ];
  assert.match(await read(said, 2), /^2 messages in #general from the last 2 hours, oldest first:\n.*an hour and a half ago\n.*half an hour ago$/);
  assert.match(await read(said, 500), /^4 messages in #general from the last 72 hours/);
  assert.match(await read(said), /^3 messages in #general from the last 24 hours, as Robin hasn’t written here in the last 3 days, oldest first:\n.*this morning/);
  assert.match(await read([['201', 30, 'me']]), /^Nothing was said here since Robin last wrote here \(\w{3} \d+:\d\d [AP]M\)\.$/);
});

test('it pages back up to 500 messages, and sends the newest when they don’t all fit', async () => {
  const many: [string, number, string][] = Array.from({ length: 700 }, (_, i) => ['202', 700 - i, `message ${i} ${'x'.repeat(i % 2 ? 10 : 100)}`]);
  const { channel, calls } = channelWith(many);
  const text = await catchUp(robin, channel, ASKING, 72, NOW);
  assert.equal(calls(), 5);
  assert.match(text, /^500 messages in #general from the last 72 hours, the last 500, the most it reads at once, oldest first:\n/);
  assert.match(text, /\] Sam: message 699 x+$/);
  assert.ok(text.length <= 40_000 + 200, String(text.length));

  const long: [string, number, string][] = Array.from({ length: 200 }, (_, i) => ['202', 200 - i, `long ${i} ${'y'.repeat(400)}`]);
  const cut = await read(long, 24);
  const [head, note, first] = cut.split('\n');
  assert.match(head!, /^200 messages in #general from the last 24 hours, oldest first:$/);
  const left = Number(/^\(…(\d+) earlier, too many to show\)$/.exec(note!)![1]);
  assert.ok(left > 100 && left < 200, String(left));
  assert.match(first!, new RegExp(`\\] Sam: long ${left} y+$`));
  assert.ok(cut.length <= 40_000 + 200);
});

test('someone who can’t read the channel’s history isn’t caught up on it', async () => {
  noHistory.add('201');
  const { channel, calls } = channelWith([['201', 30, 'hi']]);
  assert.equal(await catchUp(robin, channel, ASKING, 0, NOW), 'Robin can’t read this channel’s history, so don’t sum it up for them.');
  assert.equal(calls(), 0);
  noHistory.delete('201');
});

test('a channel it can’t read back in says so', async () => {
  assert.equal(await catchUp(robin, channelWith([], { failing: true }).channel, ASKING, 0, NOW), 'It can’t read this channel’s history (it needs Read Message History here).');
});
