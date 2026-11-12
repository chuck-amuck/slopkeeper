import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db.ts';
import { board, link, reconcile, remove } from '../src/discordSounds.ts';

function fakeGuild(id: string) {
  const fetched: number[] = [];
  const live = new Map([['s1', { name: 'horn', volume: 1, url: 'https://cdn.test/s1' }]]);
  const guild = {
    id,
    premiumTier: 0,
    client: { user: { id: 'bot' } },
    members: { me: null },
    emojis: { cache: new Map() },
    soundboardSounds: {
      // The gateway keeps this current between fetches
      cache: live,
      fetch: async () => {
        fetched.push(Date.now());
        return live;
      },
      delete: async () => {},
    },
  };
  return { guild: guild as never, fetched, live };
}

test('the soundboard is fetched once, then read from what the gateway keeps current, and fetched again after 5 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { guild, fetched, live } = fakeGuild('board-cache');
  assert.equal((await board(guild)).used, 1);
  live.set('s2', { name: 'bell', volume: 1, url: 'https://cdn.test/s2' });
  t.mock.timers.tick(4 * 60_000);
  assert.deepEqual((await board(guild)).sounds.map((s) => s.name), ['horn', 'bell']);
  assert.equal(fetched.length, 1);
  t.mock.timers.tick(60_000);
  await board(guild);
  assert.equal(fetched.length, 2);

  // reconcile fetches anyway, and counts as a fetch
  await reconcile(guild);
  await board(guild);
  assert.equal(fetched.length, 3);
});

test('taking a sound off Discord drops it from the cached soundboard straight away', async () => {
  const { guild, live } = fakeGuild('board-remove');
  link('board-remove', 'horn', 's1');
  await board(guild);
  await remove(guild, 'horn');
  assert.equal(live.has('s1'), false);
  assert.deepEqual((await board(guild)).sounds, []);
  assert.equal(db.prepare('SELECT 1 FROM discord_sounds WHERE guild_id = ?').get('board-remove'), undefined);
});
