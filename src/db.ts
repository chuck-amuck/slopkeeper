import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

const DB_FILE = path.join(config.dataDir, 'bot.db');
// 2: every per-server table has a guild_id. 3: guild_settings is key/value
const SCHEMA_VERSION = 3;

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');

const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const hasTable = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
// Older databases were converted by earlier releases; that code is gone, so don't start on one and misread it
if (version < SCHEMA_VERSION && hasTable('games')) {
  throw new Error(`This database is from schema ${version}, too old for this version. Run commit 198e3d8 once to convert it, then upgrade.`);
}

db.exec(`
  PRAGMA foreign_keys = ON;

  -- Only values changed with /setup; anything missing uses the default in settings.ts
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
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
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    steam_appid INTEGER,
    max_players INTEGER,
    added_by TEXT NOT NULL,
    UNIQUE (guild_id, name)
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
  CREATE TABLE IF NOT EXISTS hidden_apps (
    guild_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    name TEXT NOT NULL,
    hidden_by TEXT NOT NULL,
    PRIMARY KEY (guild_id, appid)
  );

  -- Steam data belongs to people, not servers, so it's shared by every server the bot is in
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

  CREATE TABLE IF NOT EXISTS sound_emoji (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS discord_sounds (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sound_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS sound_panels (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS free_game_posts (
    guild_id TEXT NOT NULL,
    giveaway_id INTEGER NOT NULL,
    PRIMARY KEY (guild_id, giveaway_id)
  );

  CREATE TABLE IF NOT EXISTS game_roles (
    role_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    -- 1 when the bot made the role, so removing the game deletes it too
    created INTEGER NOT NULL DEFAULT 0,
    UNIQUE (guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS game_nights (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    event_id TEXT,
    game TEXT NOT NULL,
    details TEXT,
    voice_channel_id TEXT,
    starts_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    reminded INTEGER NOT NULL DEFAULT 0,
    -- Discord event: 0 scheduled, 1 started, 2 ended
    event_stage INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    series_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS game_night_rsvps (
    night_id INTEGER NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (night_id, user_id)
  );

  -- A repeating game night: when its next card is due, and what goes on it
  CREATE TABLE IF NOT EXISTS game_night_series (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    game TEXT NOT NULL,
    details TEXT,
    voice_channel_id TEXT,
    created_by TEXT NOT NULL,
    every_days INTEGER NOT NULL,
    next_at INTEGER NOT NULL,
    post_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_votes (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    voice_channel_id TEXT NOT NULL,
    -- JSON list of { name, appid }; a ballot's choice is an index into it
    options TEXT NOT NULL,
    note TEXT,
    closes_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS game_vote_ballots (
    vote_id INTEGER NOT NULL REFERENCES game_votes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    choice INTEGER NOT NULL,
    PRIMARY KEY (vote_id, user_id)
  );

  -- Time spent playing each game, from Discord activity status
  CREATE TABLE IF NOT EXISTS game_plays (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    game TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS game_plays_by_guild ON game_plays (guild_id, started_at);

  CREATE TABLE IF NOT EXISTS sound_favourites (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS sound_plays (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    played_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sound_plays_by_guild ON sound_plays (guild_id, played_at);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  PRAGMA user_version = ${SCHEMA_VERSION};
`);

// Added after schema 3 came out, so a database from then won't have it yet
if (!db.prepare("SELECT 1 FROM pragma_table_info('game_nights') WHERE name = 'series_id'").get()) {
  db.exec('ALTER TABLE game_nights ADD COLUMN series_id INTEGER');
}

export function getKv(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
