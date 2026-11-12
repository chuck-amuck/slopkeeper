import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('favourites from before groups become a Favourites group at the top, most played first, and the bin keeps its stars', async () => {
  const old = new DatabaseSync(`${process.env.DATA_DIR}/bot.db`);
  old.exec(`
    CREATE TABLE sound_favourites (guild_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (guild_id, name));
    CREATE TABLE sound_plays (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, played_at INTEGER NOT NULL);
    CREATE TABLE deleted_sounds (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT, favourite INTEGER NOT NULL, gain_db REAL, percent INTEGER NOT NULL, deleted_at INTEGER NOT NULL);
    -- Run on an older version after groups existed: its stars join the Favourites group that's there
    CREATE TABLE sound_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, pos REAL NOT NULL);
    CREATE TABLE sound_places (guild_id TEXT NOT NULL, name TEXT NOT NULL, group_id INTEGER NOT NULL, pos REAL NOT NULL, PRIMARY KEY (guild_id, name));
    INSERT INTO sound_groups (guild_id, name, pos) VALUES ('b', 'Favourites', 0);
    INSERT INTO sound_places VALUES ('b', 'kept', 1, 0);
    INSERT INTO sound_favourites VALUES ('a', 'quiet'), ('a', 'loud'), ('a', 'bee'), ('b', 'horn');
    INSERT INTO sound_plays VALUES ('a', 'u', 'loud', 1), ('a', 'u', 'loud', 2), ('a', 'u', 'bee', 3), ('b', 'u', 'quiet', 4);
    INSERT INTO deleted_sounds (guild_id, name, favourite, percent, deleted_at) VALUES ('a', 'gone', 1, 100, 0);
  `);
  old.close();
  const { db } = await import('../src/db.ts');
  const { soundGroups } = await import('../src/features/soundLibrary.ts');
  const all = new Set(['quiet', 'loud', 'bee', 'horn', 'kept']);
  assert.deepEqual(soundGroups('a', all).map((g) => [g.name, g.sounds]), [['Favourites', ['loud', 'bee', 'quiet']]]);
  assert.deepEqual(soundGroups('b', all).map((g) => [g.name, g.sounds]), [['Favourites', ['kept', 'horn']]]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sound_favourites').get() as { n: number }).n, 0, 'carried over once');
  assert.deepEqual({ ...(db.prepare('SELECT favourite, group_id, place FROM deleted_sounds').get() as object) }, { favourite: 1, group_id: null, place: null });
});
