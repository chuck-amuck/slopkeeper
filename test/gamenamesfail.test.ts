import './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';

test('a failed fill of game names leaves nothing half done, and the next start finishes it', async () => {
  mock.method(console, 'log', () => {});
  const add = db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES ('g', 'a', ?, 'v', ?, 2)`);
  add.run('First Game', 0);
  add.run('Second Game', 1);
  // The longest goes first, so one row is in when the other fails
  db.exec(`CREATE TRIGGER stop BEFORE INSERT ON game_aliases WHEN NEW.raw = 'Second Game' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;`);
  const firstStart = '../src/gameNames.ts?first-start';
  await assert.rejects(import(firstStart), /disk on fire/);
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM game_aliases').get() as { n: number }).n;
  assert.equal(count(), 0);
  db.exec('DROP TRIGGER stop');
  const secondStart = '../src/gameNames.ts?second-start';
  await import(secondStart);
  assert.equal(count(), 2);
  const thirdStart = '../src/gameNames.ts?third-start';
  await import(thirdStart);
  assert.equal(count(), 2);
});
