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
  CREATE TABLE IF NOT EXISTS game_wants (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (game_id, user_id)
  );
  -- The discount each server was last told about
  CREATE TABLE IF NOT EXISTS sale_alerts (
    guild_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    discount INTEGER NOT NULL,
    PRIMARY KEY (guild_id, appid)
  );
  -- What was on sale at the last check, by store region
  CREATE TABLE IF NOT EXISTS sale_prices (
    country TEXT NOT NULL,
    appid INTEGER NOT NULL,
    discount INTEGER NOT NULL,
    was TEXT NOT NULL,
    price TEXT NOT NULL,
    final INTEGER NOT NULL,
    PRIMARY KEY (country, appid)
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
    recent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (steam_id, appid)
  );
  CREATE TABLE IF NOT EXISTS patch_posts (
    guild_id TEXT NOT NULL,
    gid TEXT NOT NULL,
    appid INTEGER NOT NULL,
    game TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    date INTEGER NOT NULL,
    text TEXT NOT NULL,
    posted INTEGER NOT NULL,
    PRIMARY KEY (guild_id, gid)
  );
  CREATE TABLE IF NOT EXISTS steam_family (
    user_id TEXT PRIMARY KEY,
    family INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_info (
    appid INTEGER PRIMARY KEY,
    name TEXT,
    multiplayer INTEGER NOT NULL,
    coop INTEGER NOT NULL DEFAULT 0,
    pvp INTEGER NOT NULL DEFAULT 0,
    deck INTEGER NOT NULL DEFAULT 0,
    shareable INTEGER NOT NULL DEFAULT 0,
    read_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS steam_wishlist (
    steam_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    PRIMARY KEY (steam_id, appid)
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
  CREATE TABLE IF NOT EXISTS saved_phrases (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    text TEXT NOT NULL,
    voice TEXT NOT NULL,
    UNIQUE (guild_id, text)
  );
  CREATE TABLE IF NOT EXISTS sound_panels (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS game_facts (
    key TEXT PRIMARY KEY,
    appid INTEGER,
    positive INTEGER NOT NULL,
    negative INTEGER NOT NULL,
    tags TEXT NOT NULL,
    checked_at INTEGER NOT NULL
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

  -- Time spent playing each game in a voice channel, from Discord activity status.
  -- No channel_id: from before game time was limited to voice, so it isn't counted
  CREATE TABLE IF NOT EXISTS game_plays (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    game TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    channel_id TEXT
  );
  CREATE INDEX IF NOT EXISTS game_plays_by_guild ON game_plays (guild_id, started_at);

  -- Every spelling Discord has shown for a game and the name it goes by. manual: someone chose this
  CREATE TABLE IF NOT EXISTS game_aliases (
    guild_id TEXT NOT NULL,
    raw TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, raw)
  );
  CREATE INDEX IF NOT EXISTS game_aliases_by_key ON game_aliases (guild_id, key);

  -- game_plays under the name each game goes by, so stored plays never need rewriting
  CREATE VIEW IF NOT EXISTS named_plays AS
    SELECT p.id, p.guild_id, p.user_id, COALESCE(a.name, p.game) AS game, p.game AS raw, p.channel_id, p.started_at, p.ended_at
    FROM game_plays p LEFT JOIN game_aliases a ON a.guild_id = p.guild_id AND a.raw = p.game;

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

  CREATE TABLE IF NOT EXISTS sound_levels (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    -- From measuring the file. NULL until it's been measured
    gain_db REAL,
    -- The volume someone picked on top of that
    percent INTEGER NOT NULL DEFAULT 100,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS join_sounds (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  -- What a deleted sound needs to come back. Its files wait in sounds/<server>/bin/<id>/
  CREATE TABLE IF NOT EXISTS deleted_sounds (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT,
    favourite INTEGER NOT NULL,
    gain_db REAL,
    percent INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    -- A user id, or 'web' for the web UI, which has one shared login
    actor TEXT NOT NULL,
    action TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_by_guild ON activity (guild_id, id);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  PRAGMA user_version = ${SCHEMA_VERSION};
`);

// Alerts used to be kept per library game. Moved over so sales already announced aren't announced again
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sale_state'").get()) {
  db.exec('BEGIN');
  try {
    db.exec(`
      INSERT OR IGNORE INTO sale_alerts (guild_id, appid, discount)
      SELECT g.guild_id, g.steam_appid, s.discount FROM sale_state s JOIN games g ON g.id = s.game_id
      WHERE g.steam_appid IS NOT NULL AND s.discount > 0;
      DROP TABLE sale_state;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Added after schema 3 came out, so a database from then won't have it yet
if (!db.prepare("SELECT 1 FROM pragma_table_info('game_nights') WHERE name = 'series_id'").get()) {
  db.exec('ALTER TABLE game_nights ADD COLUMN series_id INTEGER');
}

// So are these. Older rows get their facts on the next library refresh
if (!db.prepare("SELECT 1 FROM pragma_table_info('steam_owned') WHERE name = 'recent'").get()) {
  db.exec('ALTER TABLE steam_owned ADD COLUMN recent INTEGER NOT NULL DEFAULT 0');
}
for (const column of ['coop', 'pvp', 'deck', 'shareable', 'read_at']) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('app_info') WHERE name = ?").get(column)) {
    db.exec(`ALTER TABLE app_info ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}

/** Plays shorter than this (launchers, crashes) aren't kept */
export const MIN_PLAY = 60_000;

/**
 * Game time used to count everywhere. This keeps the part of each old play that fell inside a voice session the
 * person was in, as new rows, and leaves the originals uncounted. Sessions only saved each person's total, not when
 * they were there, so that total caps each game and the result is an estimate.
 */
function keepVoicePlays() {
  const people = db
    .prepare(
      `SELECT s.guild_id AS guildId, m.user_id AS userId, s.channel_id AS channelId, s.started_at AS start, s.ended_at AS end, m.seconds AS seconds
       FROM session_members m JOIN sessions s ON s.id = m.session_id
       ORDER BY s.started_at`,
    )
    .all() as { guildId: string; userId: string; channelId: string; start: number; end: number; seconds: number }[];
  const plays = db.prepare(
    `SELECT game, started_at AS start, ended_at AS end FROM game_plays
     WHERE guild_id = ? AND user_id = ? AND channel_id IS NULL AND ended_at > ? AND started_at < ?
     ORDER BY started_at`,
  );
  const keep = db.prepare('INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)');
  // How far each person's time in each game has got, so being in two sessions at once only counts once
  const reached = new Map<string, number>();
  let kept = 0;
  for (const p of people) {
    const left = new Map<string, number>();
    for (const play of plays.all(p.guildId, p.userId, p.start, p.end) as { game: string; start: number; end: number }[]) {
      const key = `${p.guildId}:${p.userId}:${play.game}`;
      const budget = left.get(play.game) ?? p.seconds * 1000;
      const start = Math.max(play.start, p.start, reached.get(key) ?? 0);
      const end = Math.min(play.end, p.end, start + budget);
      if (end - start < MIN_PLAY) continue;
      keep.run(p.guildId, p.userId, play.game, p.channelId, start, end);
      left.set(play.game, budget - (end - start));
      reached.set(key, end);
      kept++;
    }
  }
  console.log(`Kept ${kept} game plays from inside voice sessions`);
}

// Added after schema 3 came out too. In one transaction, so a failed start can run it again from the top
if (!db.prepare("SELECT 1 FROM pragma_table_info('game_plays') WHERE name = 'channel_id'").get()) {
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE game_plays ADD COLUMN channel_id TEXT');
    keepVoicePlays();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getKv(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
