import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { checkSales } from '../src/features/sales.ts';
import { setSetting } from '../src/settings.ts';

test('a sale post that fails is tried again, and doesn’t hold up other servers', async () => {
  mock.method(console, 'error', () => {});
  const price = { discount_percent: 40, initial_formatted: '$30', final_formatted: '$18' };
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ 10: { success: true, data: { price_overview: price } } })));

  const members = { cache: new Map() };
  const guilds = ['a', 'b'].map((id) => ({ id, name: id.toUpperCase(), members }));
  for (const { id } of guilds) {
    setSetting(id, 'announceChannel', `channel-${id}`);
    db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, 'Game', 10, 'x')`).run(id);
  }

  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient(guilds, async (guildId) => {
    if (guildId === 'a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await checkSales(client);
  assert.deepEqual(sent, ['b']);
  aWorks = true;
  await checkSales(client);
  assert.deepEqual(sent, ['b', 'a'], 'b isn’t told about the same sale twice');
});
