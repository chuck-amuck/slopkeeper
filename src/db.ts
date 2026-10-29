import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

const DB_FILE = path.join(config.dataDir, 'bot.db');
// 2: every per-server table has a guild_id
const SCHEMA_VERSION = 2;

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');

// Bodies of the tables that gained a guild_id, shared by the fresh schema and the migration that rebuilds them
const TABLES = {
  sessions: `(
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  )`,
  games: `(
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    steam_appid INTEGER,
    max_players INTEGER,
    added_by TEXT NOT NULL,
    UNIQUE (guild_id, name)
  )`,
  hidden_apps: `(
    guild_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    name TEXT NOT NULL,
    hidden_by TEXT NOT NULL,
    PRIMARY KEY (guild_id, appid)
  )`,
  sound_emoji: `(
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  )`,
  discord_sounds: `(
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sound_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (guild_id, name)
  )`,
  sound_panels: `(
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0
  )`,
};

const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const hasTable = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
if (version < 2 && hasTable('games')) migrateToMultiServer();

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    announce_channel_id TEXT,
    hopon_role_id TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions ${TABLES.sessions};
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

  CREATE TABLE IF NOT EXISTS games ${TABLES.games};
  CREATE TABLE IF NOT EXISTS game_owners (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (game_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sale_state (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    discount INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hidden_apps ${TABLES.hidden_apps};

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

  CREATE TABLE IF NOT EXISTS sound_emoji ${TABLES.sound_emoji};
  CREATE TABLE IF NOT EXISTS discord_sounds ${TABLES.discord_sounds};
  CREATE TABLE IF NOT EXISTS sound_panels ${TABLES.sound_panels};

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  PRAGMA user_version = ${SCHEMA_VERSION};
`);

/**
 * Single-server databases predate guild_id. Everything in them belonged to GUILD_ID, so tag it with that,
 * after saving a copy of the old database next to it.
 */
function migrateToMultiServer() {
  const legacyGuild = process.env.GUILD_ID;
  if (!legacyGuild) {
    throw new Error('This database is from before multi-server support. Set GUILD_ID to the server its data belongs to and start once.');
  }
  const backup = `${DB_FILE}.pre-multiserver`;
  if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  console.log(`Moving existing data to server ${legacyGuild} (backup: ${backup})`);

  // Off for the rebuild: dropping games would otherwise cascade into game_owners and sale_state
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    // Tables added after the first release may not exist yet
    db.exec(`
      CREATE TABLE IF NOT EXISTS hidden_apps (appid INTEGER PRIMARY KEY, name TEXT NOT NULL, hidden_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sound_emoji (name TEXT PRIMARY KEY, emoji TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discord_sounds (name TEXT PRIMARY KEY, sound_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sound_panels (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, page INTEGER NOT NULL DEFAULT 0);
    `);
    const rebuild = (table: keyof typeof TABLES, columns: string, select: string) => {
      db.exec(`CREATE TABLE ${table}_new ${TABLES[table]}`);
      db.prepare(`INSERT INTO ${table}_new (${columns}) SELECT ${select} FROM ${table}`).run(legacyGuild);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    };
    rebuild('sessions', 'id, guild_id, channel_id, started_at, ended_at', 'id, ?, channel_id, started_at, ended_at');
    rebuild('games', 'id, guild_id, name, steam_appid, max_players, added_by', 'id, ?, name, steam_appid, max_players, added_by');
    rebuild('hidden_apps', 'guild_id, appid, name, hidden_by', '?, appid, name, hidden_by');
    rebuild('sound_emoji', 'guild_id, name, emoji', '?, name, emoji');
    rebuild('discord_sounds', 'guild_id, name, sound_id', '?, name, sound_id');
    rebuild('sound_panels', 'message_id, guild_id, channel_id, page', 'message_id, ?, channel_id, page');
    db.prepare("UPDATE kv SET key = ? WHERE key = 'weekly_post'").run(`weekly_post:${legacyGuild}`);

    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`Migration left broken references: ${JSON.stringify(broken)}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Sounds move from sounds/ into sounds/<server id>/
  const soundDir = path.join(config.dataDir, 'sounds');
  if (!existsSync(soundDir)) return;
  const target = path.join(soundDir, legacyGuild);
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(soundDir)) {
    const from = path.join(soundDir, file);
    if (statSync(from).isFile()) renameSync(from, path.join(target, file));
  }
}

export function getKv(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
