import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('a database from before repeating nights keeps its nights and gains the new column', async () => {
  const old = new DatabaseSync(`${process.env.DATA_DIR}/bot.db`);
  old.exec(`
    CREATE TABLE games (id INTEGER PRIMARY KEY);
    CREATE TABLE game_nights (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, event_id TEXT, game TEXT NOT NULL,
      details TEXT, voice_channel_id TEXT, starts_at INTEGER NOT NULL, created_by TEXT NOT NULL,
      reminded INTEGER NOT NULL DEFAULT 0, event_stage INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO game_nights (guild_id, channel_id, game, starts_at, created_by) VALUES ('g', 'c', 'Valheim', 1, 'host');
    PRAGMA user_version = 3;
  `);
  old.close();
  const { db } = await import('../src/db.ts');
  assert.deepEqual({ ...(db.prepare('SELECT game, series_id FROM game_nights').get() as object) }, { game: 'Valheim', series_id: null });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'game_night_series'").get());
});
