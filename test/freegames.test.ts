import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { check, parseFeed } from '../src/features/freegames.ts';
import { setSetting } from '../src/settings.ts';

const entry = {
  id: '3834',
  title: 'Hexologic (Steam) Giveaway',
  worth: '$4.99',
  image: 'https://example.com/i.jpg',
  description: 'Free puzzles',
  open_giveaway_url: 'https://example.com/open',
  platforms: 'PC, Steam',
  end_date: '2026-10-31 23:59:00',
  status: 'Active',
};

test('cleans up what the feed sends', () => {
  const [game] = parseFeed([entry]);
  assert.equal(game.id, 3834);
  assert.equal(game.title, 'Hexologic');
  assert.equal(game.platforms, 'Steam');
  assert.equal(game.endDate, '2026-10-31 23:59:00');
});

test('handles missing values, ended offers and an empty feed', () => {
  const [game] = parseFeed([{ ...entry, worth: 'N/A', end_date: 'N/A' }]);
  assert.equal(game.worth, '');
  assert.equal(game.endDate, null);
  assert.deepEqual(parseFeed([{ ...entry, status: 'Expired' }]), []);
  assert.deepEqual(parseFeed({ status: 0, status_message: 'No active giveaways' }), []);
});

test('posts only to servers that turned it on, and a failed post is tried again', async () => {
  mock.method(console, 'error', () => {});
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([entry])));
  for (const id of ['a', 'b']) {
    setSetting(id, 'announceChannel', `channel-${id}`);
    setSetting(id, 'freeGames', true);
  }
  setSetting('off', 'announceChannel', 'channel-off');

  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'off', name: 'Off' }], async (guildId) => {
    if (guildId === 'a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await check(client);
  assert.deepEqual(sent, ['b']);
  aWorks = true;
  await check(client);
  assert.deepEqual(sent, ['b', 'a']);
  const posts = db.prepare('SELECT guild_id FROM free_game_posts ORDER BY guild_id').all() as { guild_id: string }[];
  assert.deepEqual(posts.map((p) => p.guild_id), ['a', 'b']);
});
