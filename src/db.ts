import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'bot.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    channel_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_members (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    PRIMARY KEY (session_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS session_games (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    game TEXT NOT NULL,
    PRIMARY KEY (session_id, game)
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    steam_appid INTEGER,
    max_players INTEGER,
    added_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS game_owners (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (game_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sale_state (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    discount INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS steam_links (
    user_id TEXT PRIMARY KEY,
    steam_id TEXT NOT NULL,
    private INTEGER NOT NULL DEFAULT 0,
    refreshed_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS steam_owned (
    steam_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    name TEXT,
    playtime INTEGER NOT NULL,
    PRIMARY KEY (steam_id, appid)
  );
  CREATE TABLE IF NOT EXISTS app_info (
    appid INTEGER PRIMARY KEY,
    name TEXT,
    multiplayer INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hidden_apps (
    appid INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    hidden_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sound_emoji (
    name TEXT PRIMARY KEY,
    emoji TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discord_sounds (
    name TEXT PRIMARY KEY,
    sound_id TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS sound_panels (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getKv(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
