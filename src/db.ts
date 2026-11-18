import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

export const DB_FILE = path.join(config.dataDir, 'bot.db');
// 2: every per-server table has a guild_id. 3: guild_settings is key/value
const SCHEMA_VERSION = 3;

export const db = new DatabaseSync(DB_FILE);
// With WAL, NORMAL only risks the last moments of writes if the machine itself loses power, and makes each commit far cheaper
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

/** Runs `fn` in one transaction, undone if it throws. Inside another transaction it's simply part of that one. Not for async work */
export function transaction<T>(fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
  -- The music queue. The first row is the song playing, while music is on
  CREATE TABLE IF NOT EXISTS music_queue (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    pos REAL NOT NULL,
    uri TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    cover TEXT,
    duration_ms INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS music_queue_order ON music_queue (guild_id, pos);
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
  CREATE INDEX IF NOT EXISTS game_plays_by_user ON game_plays (guild_id, user_id, started_at);
  -- Stats ask for plays that ended after the start of a period
  CREATE INDEX IF NOT EXISTS game_plays_by_end ON game_plays (guild_id, ended_at);

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

  -- Games someone said aren't a game: each spelling it had then, and its name, so a spelling merged in later goes too
  CREATE TABLE IF NOT EXISTS not_games (
    guild_id TEXT NOT NULL,
    raw TEXT NOT NULL,
    name TEXT NOT NULL,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, raw)
  );
  CREATE INDEX IF NOT EXISTS not_games_name ON not_games (guild_id, name);

  -- game_plays under the name each game goes by, so stored plays never need rewriting, leaving out what isn't a game.
  -- A view keeps nothing, so it's made again each start, as its definition changes
  DROP VIEW IF EXISTS named_plays;
  CREATE VIEW named_plays AS
    SELECT p.id, p.guild_id, p.user_id, COALESCE(a.name, p.game) AS game, p.game AS raw, p.channel_id, p.started_at, p.ended_at
    FROM game_plays p LEFT JOIN game_aliases a ON a.guild_id = p.guild_id AND a.raw = p.game
    WHERE NOT EXISTS (SELECT 1 FROM not_games n WHERE n.guild_id = p.guild_id AND (n.raw = p.game OR n.name = COALESCE(a.name, p.game)));

  CREATE TABLE IF NOT EXISTS sound_favourites (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );
  -- Groups people sort sounds into, in their order. Sounds in none come after them, most played first
  CREATE TABLE IF NOT EXISTS sound_groups (
    -- Never reused, as the bin remembers each deleted sound's group by its id
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    pos REAL NOT NULL
  );
  -- Which group each sound is in, and where in it
  CREATE TABLE IF NOT EXISTS sound_places (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    group_id INTEGER NOT NULL,
    pos REAL NOT NULL,
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
  -- How long each sound file is, as measured when it last changed, so a restart doesn't measure every sound again
  CREATE TABLE IF NOT EXISTS sound_lengths (
    file TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    mtime_ms REAL NOT NULL,
    seconds REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sound_lengths_by_guild ON sound_lengths (guild_id);
  -- The video or track a sound was cut from, and the part picked, so another part can be picked later
  CREATE TABLE IF NOT EXISTS sound_links (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    start_s REAL NOT NULL,
    end_s REAL NOT NULL,
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
    -- A user id, 'web:<email>' for someone signed in to the web UI through Pangolin, or 'web' for anyone else on it
    actor TEXT NOT NULL,
    action TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_by_guild ON activity (guild_id, id);

  -- People signed in to the web UI through Pangolin, by their sign-in email, and who they said they are in Discord
  CREATE TABLE IF NOT EXISTS web_users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT UNIQUE,
    seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- How the bot and its containers did (see perf.ts): a minute per row (span 1) for 2 days, and 15 minutes per row
  -- (span 15) for 30. Counters add up count; a gauge's average is sum / count. A minute cut short by a restart may
  -- have two rows, so read them added up
  CREATE TABLE IF NOT EXISTS perf_minutes (
    at INTEGER NOT NULL,
    span INTEGER NOT NULL,
    name TEXT NOT NULL,
    labels TEXT NOT NULL,
    count REAL NOT NULL,
    sum REAL NOT NULL,
    max REAL NOT NULL,
    -- A timing's count in each of perf.ts's BUCKETS, as JSON
    buckets TEXT
  );
  CREATE INDEX IF NOT EXISTS perf_minutes_by_name ON perf_minutes (span, name, at);
  CREATE INDEX IF NOT EXISTS perf_minutes_by_time ON perf_minutes (span, at);

  -- Things people waited on that took a while, with how long each step took. Speech keeps its voice and length, never its words
  CREATE TABLE IF NOT EXISTS perf_slow (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    guild_id TEXT,
    what TEXT NOT NULL,
    seconds REAL NOT NULL,
    steps TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS perf_slow_by_time ON perf_slow (at);

  -- Songs as they started, for Stats: what, from where, who added it (or 'autoplay'), and how far it got. played_ms
  -- stays NULL while it plays, and when the music stopped or paused for good part way
  CREATE TABLE IF NOT EXISTS music_plays (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    uri TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    source TEXT,
    duration_ms INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    played_ms INTEGER,
    skipped INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS music_plays_by_guild ON music_plays (guild_id, at);

  -- Lines said aloud, for Stats: who asked (NULL for announcements), the voice, how long and how it came, never the words
  CREATE TABLE IF NOT EXISTS speech_lines (
    guild_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    user_id TEXT,
    voice TEXT NOT NULL,
    characters INTEGER NOT NULL,
    -- say (the command or the web UI), message (read out from the speech channel) or announcement
    kind TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS speech_lines_by_guild ON speech_lines (guild_id, at);

  -- Each time someone was in a voice channel (not the AFK one), for when people are on. left_at moves up while
  -- they're still there, so a crash loses at most a few minutes
  CREATE TABLE IF NOT EXISTS voice_stints (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS voice_stints_by_guild ON voice_stints (guild_id, left_at);
  CREATE INDEX IF NOT EXISTS voice_stints_by_start ON voice_stints (guild_id, joined_at);

  PRAGMA user_version = ${SCHEMA_VERSION};
`);

// Alerts used to be kept per library game. Moved over so sales already announced aren't announced again
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sale_state'").get()) {
  transaction(() =>
    db.exec(`
      INSERT OR IGNORE INTO sale_alerts (guild_id, appid, discount)
      SELECT g.guild_id, g.steam_appid, s.discount FROM sale_state s JOIN games g ON g.id = s.game_id
      WHERE g.steam_appid IS NOT NULL AND s.discount > 0;
      DROP TABLE sale_state;
    `),
  );
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
  transaction(() => {
    db.exec('ALTER TABLE game_plays ADD COLUMN channel_id TEXT');
    keepVoicePlays();
  });
}

// A deleted sound comes back to the group it was in
if (!db.prepare("SELECT 1 FROM pragma_table_info('deleted_sounds') WHERE name = 'group_id'").get()) {
  db.exec('ALTER TABLE deleted_sounds ADD COLUMN group_id INTEGER');
  db.exec('ALTER TABLE deleted_sounds ADD COLUMN place REAL');
}

// And still knows the link it was cut from, as JSON, so it can be picked again
if (!db.prepare("SELECT 1 FROM pragma_table_info('deleted_sounds') WHERE name = 'link'").get()) {
  db.exec('ALTER TABLE deleted_sounds ADD COLUMN link TEXT');
}

// Another official store selling a Steam copy for less than Steam: its price in cents of Steam's currency, how far
// under Steam's normal price, its link and name. Then the cheapest key reseller, when it's cheaper still, and the
// lowest a Steam key has ever sold for, from IsThereAnyDeal, in the same money
for (const [column, type] of [
  ['store', 'INTEGER'],
  ['store_off', 'INTEGER'],
  ['store_url', 'TEXT'],
  ['currency', 'TEXT'],
  ['store_name', 'TEXT'],
  ['keyshop', 'INTEGER'],
  ['keyshop_url', 'TEXT'],
  ['lowest', 'INTEGER'],
]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('sale_prices') WHERE name = ?").get(column)) db.exec(`ALTER TABLE sale_prices ADD COLUMN ${column} ${type}`);
}

db.exec(`
  -- IsThereAnyDeal's id for each Steam app, null when it has none, which is asked again after a while
  CREATE TABLE IF NOT EXISTS itad_apps (
    appid INTEGER PRIMARY KEY,
    itad_id TEXT,
    checked_at INTEGER NOT NULL
  );
  -- Bundles each server has been told about
  CREATE TABLE IF NOT EXISTS bundle_posts (
    guild_id TEXT NOT NULL,
    bundle_id INTEGER NOT NULL,
    posted_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, bundle_id)
  );
`);

// Favourites were a star on each sound before groups, and become a Favourites group at the top, most played first as they showed
transaction(() => {
  const starred = db
    .prepare(
      `SELECT f.guild_id, f.name FROM sound_favourites f
       LEFT JOIN (SELECT guild_id, name, COUNT(*) AS plays FROM sound_plays GROUP BY guild_id, name) p ON p.guild_id = f.guild_id AND p.name = f.name
       ORDER BY f.guild_id, COALESCE(p.plays, 0) DESC, f.name`,
    )
    .all() as { guild_id: string; name: string }[];
  const groups = new Map<string, number>();
  for (const { guild_id: guildId, name } of starred) {
    if (!groups.has(guildId)) {
      // Stars only come back after running an older version, and then join the Favourites group that's there
      const there = db.prepare("SELECT id FROM sound_groups WHERE guild_id = ? AND lower(name) = 'favourites'").get(guildId) as { id: number } | undefined;
      const top = db.prepare('SELECT MIN(pos) AS pos FROM sound_groups WHERE guild_id = ?').get(guildId) as { pos: number | null };
      groups.set(guildId, there?.id ?? Number(db.prepare("INSERT INTO sound_groups (guild_id, name, pos) VALUES (?, 'Favourites', ?)").run(guildId, (top.pos ?? 1) - 1).lastInsertRowid));
    }
    const at = db.prepare('SELECT COALESCE(MAX(pos) + 1, 0) AS n FROM sound_places WHERE group_id = ?').get(groups.get(guildId)!) as { n: number };
    db.prepare('INSERT OR IGNORE INTO sound_places (guild_id, name, group_id, pos) VALUES (?, ?, ?, ?)').run(guildId, name, groups.get(guildId)!, at.n);
  }
  db.exec('DELETE FROM sound_favourites');
});

// The effect a line was said with, besides its voice: null for none, and for lines from before effects were their own pick
if (!db.prepare("SELECT 1 FROM pragma_table_info('speech_lines') WHERE name = 'effect'").get()) {
  db.exec('ALTER TABLE speech_lines ADD COLUMN effect TEXT');
}

db.exec(`
  -- How much each effect is turned up or down on each voice, so it's as loud as that voice without it. Measured for each
  -- pair, as an effect changes some voices' loudness far more than others'. voice_key is what the voice sounds by (its
  -- model, speaker and settings) and chain the effect's ffmpeg filters, so a change to either measures it again
  CREATE TABLE IF NOT EXISTS effect_gains (
    voice_key TEXT NOT NULL,
    effect TEXT NOT NULL,
    chain TEXT NOT NULL,
    gain REAL NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (voice_key, effect)
  );

  -- What answering in chat cost each day (in the server's time zone), from the tokens each answer reports
  CREATE TABLE IF NOT EXISTS chat_usage (
    guild_id TEXT NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    replies INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, day, model)
  );
  -- What the bot remembers about someone when they talk to it in chat, at their asking, in a few words
  CREATE TABLE IF NOT EXISTS chat_notes (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    note TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  -- Reminders set in chat, deleted once they're posted
  CREATE TABLE IF NOT EXISTS chat_reminders (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    -- JSON list of the user ids it pings
    people TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_reminders_due ON chat_reminders (due_at);
  CREATE INDEX IF NOT EXISTS chat_reminders_guild ON chat_reminders (guild_id, due_at);
`);

// Added with web search, after chat_usage came out
if (!db.prepare("SELECT 1 FROM pragma_table_info('chat_usage') WHERE name = 'web_searches'").get()) {
  db.exec('ALTER TABLE chat_usage ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0');
}

export function getKv(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
