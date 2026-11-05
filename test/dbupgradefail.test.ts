import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';

test('a failed upgrade of game plays leaves nothing half done, and the next start finishes it', async () => {
  mock.method(console, 'log', () => {});
  const file = `${process.env.DATA_DIR}/bot.db`;
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
    CREATE TABLE session_members (session_id INTEGER NOT NULL, user_id TEXT NOT NULL, seconds INTEGER NOT NULL, PRIMARY KEY (session_id, user_id));
    CREATE TABLE game_plays (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, game TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
    INSERT INTO sessions (id, guild_id, channel_id, started_at, ended_at) VALUES (1, 'g', 'v', 0, 7200000);
    INSERT INTO session_members (session_id, user_id, seconds) VALUES (1, 'a', 7200);
    INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES ('g', 'a', 'Valheim', 0, 3600000), ('g', 'a', 'Deep Rock', 0, 3600000);
    -- The first piece goes in, then the second fails
    CREATE TRIGGER stop BEFORE INSERT ON game_plays WHEN NEW.game = 'Deep Rock' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;
  `);
  old.close();

  const firstStart = '../src/db.ts?first-start';
  await assert.rejects(import(firstStart), /disk on fire/);

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT 1 FROM pragma_table_info('game_plays') WHERE name = 'channel_id'").get(), undefined);
  assert.equal((check.prepare('SELECT COUNT(*) AS n FROM game_plays').get() as { n: number }).n, 2);
  check.exec('DROP TRIGGER stop');
  check.close();

  const { db } = await import('../src/db.ts');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE channel_id IS NOT NULL').get() as { n: number }).n, 2);
});
