import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';

const HOUR = 3_600_000;

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
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
    CREATE TABLE session_members (session_id INTEGER NOT NULL, user_id TEXT NOT NULL, seconds INTEGER NOT NULL, PRIMARY KEY (session_id, user_id));
    CREATE TABLE game_plays (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, game TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
    PRAGMA user_version = 3;
  `);
  const play = (guildId: string, userId: string, game: string, start: number, end: number) =>
    old.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(guildId, userId, game, start * HOUR, end * HOUR);
  const session = (guildId: string, channelId: string, start: number, end: number, people: Record<string, number>) => {
    const { lastInsertRowid } = old.prepare('INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?)').run(guildId, channelId, start * HOUR, end * HOUR);
    for (const [userId, hours] of Object.entries(people)) old.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(lastInsertRowid, userId, hours * 3600);
  };
  // Clipped to the session, and what's outside any session goes
  play('clip', 'a', 'Valheim', 1, 5);
  play('clip', 'a', 'Valheim', 10, 11);
  session('clip', 'v', 2, 4, { a: 2 });
  // Sessions don't say when someone was there, so their time there is the most a game can get
  play('cap', 'a', 'Valheim', 0, 4);
  play('cap', 'a', 'Deep Rock', 0, 4);
  session('cap', 'v', 0, 4, { a: 1 });
  // Two plays of a game share that limit
  play('shared', 'a', 'Valheim', 0, 1);
  play('shared', 'a', 'Valheim', 2, 3);
  session('shared', 'v', 0, 4, { a: 1.5 });
  // Two sessions at once only count once
  play('twice', 'a', 'Valheim', 0, 3);
  session('twice', 'v1', 0, 2, { a: 2 });
  session('twice', 'v2', 1, 3, { a: 2 });
  // Two people in one session don't use up each other's time
  play('pair', 'a', 'Valheim', 0, 2);
  play('pair', 'b', 'Valheim', 0, 2);
  session('pair', 'v', 0, 2, { a: 2, b: 2 });
  // Being in voice doesn't count for someone else's game, or in another server
  play('others', 'a', 'Valheim', 0, 4);
  session('others', 'v', 0, 4, { b: 4 });
  play('here', 'a', 'Valheim', 0, 4);
  session('there', 'v', 0, 4, { a: 4 });
  // Too short a piece to keep
  play('short', 'a', 'Valheim', 0, 4);
  session('short', 'v', 1, 1.01, { a: 1 });
  old.close();

  const log = mock.method(console, 'log', () => {});
  const { db } = await import('../src/db.ts');
  const kept = () =>
    (db.prepare('SELECT guild_id AS guildId, user_id AS userId, game, channel_id AS channelId, started_at AS start, ended_at AS end FROM game_plays WHERE channel_id IS NOT NULL ORDER BY id').all() as Record<string, string | number>[]).map(
      (r) => [r.guildId, r.userId, r.game, r.channelId, Number(r.start) / HOUR, Number(r.end) / HOUR],
    );
  const expected = [
    ['cap', 'a', 'Valheim', 'v', 0, 1],
    ['cap', 'a', 'Deep Rock', 'v', 0, 1],
    ['shared', 'a', 'Valheim', 'v', 0, 1],
    ['shared', 'a', 'Valheim', 'v', 2, 2.5],
    ['twice', 'a', 'Valheim', 'v1', 0, 2],
    ['pair', 'a', 'Valheim', 'v', 0, 2],
    ['pair', 'b', 'Valheim', 'v', 0, 2],
    ['twice', 'a', 'Valheim', 'v2', 2, 3],
    ['clip', 'a', 'Valheim', 'v', 2, 4],
  ];
  assert.deepEqual(kept(), expected);
  assert.equal(log.mock.calls[0].arguments[0], 'Kept 9 game plays from inside voice sessions');

  const originals = () => (db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE channel_id IS NULL').get() as { n: number }).n;
  assert.equal(originals(), 12);

  const secondStart = '../src/db.ts?second-start';
  await import(secondStart);
  assert.deepEqual(kept(), expected);
  assert.equal(originals(), 12);
  assert.equal(log.mock.callCount(), 1);

  assert.deepEqual({ ...(db.prepare('SELECT game, series_id FROM game_nights').get() as object) }, { game: 'Valheim', series_id: null });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'game_night_series'").get());
});
