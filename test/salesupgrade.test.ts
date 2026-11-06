import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('sales already announced are carried over, so they aren’t announced again', async () => {
  const old = new DatabaseSync(`${process.env.DATA_DIR}/bot.db`);
  old.exec(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, steam_appid INTEGER,
      max_players INTEGER, added_by TEXT NOT NULL, UNIQUE (guild_id, name)
    );
    CREATE TABLE sale_state (game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE, discount INTEGER NOT NULL);
    INSERT INTO games (id, guild_id, name, steam_appid, added_by) VALUES (1, 'g', 'On sale', 10, 'x'), (2, 'g', 'Sale over', 11, 'x'), (3, 'h', 'On sale', 10, 'x'), (4, 'g', 'No app', NULL, 'x');
    INSERT INTO sale_state VALUES (1, 50), (2, 0), (3, 30), (4, 20);
    PRAGMA user_version = 3;
  `);
  old.close();

  const { db } = await import('../src/db.ts');
  const rows = db.prepare('SELECT guild_id, appid, discount FROM sale_alerts ORDER BY guild_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { guild_id: 'g', appid: 10, discount: 50 },
    { guild_id: 'h', appid: 10, discount: 30 },
  ]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sale_state'").get(), undefined);
});
