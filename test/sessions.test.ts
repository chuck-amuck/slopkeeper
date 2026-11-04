import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db, getKv } from '../src/db.ts';
import { maybePostWeekly } from '../src/features/sessions.ts';
import { setSetting } from '../src/settings.ts';
import { zonedParts } from '../src/util.ts';

test('a weekly post that fails is tried again, and doesn’t hold up other servers', async () => {
  mock.method(console, 'error', () => {});
  const now = zonedParts(Date.now(), 'America/Chicago');
  for (const id of ['a', 'b']) {
    setSetting(id, 'announceChannel', `channel-${id}`);
    setSetting(id, 'timezone', 'America/Chicago');
    setSetting(id, 'weeklyPostDay', now.weekday);
    setSetting(id, 'weeklyPostHour', 0);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, 'voice', ?, ?)`)
      .run(id, Date.now() - 7_200_000, Date.now() - 3_600_000);
    db.prepare(`INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, 'u', 3600)`).run(lastInsertRowid);
  }

  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], async (guildId) => {
    if (guildId === 'a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await maybePostWeekly(client);
  assert.deepEqual(sent, ['b']);
  assert.equal(getKv('weekly_post:a'), undefined);
  aWorks = true;
  await maybePostWeekly(client);
  await maybePostWeekly(client);
  assert.deepEqual(sent, ['b', 'a'], 'each server gets one post');
});
