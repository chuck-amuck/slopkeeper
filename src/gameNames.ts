import { db } from './db.ts';

interface Alias {
  raw: string;
  name: string;
  manual: number;
}

/** What's left of a name once case, spaces and punctuation are gone. A name with nothing left only matches itself */
export const gameKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || name;

/** How much a spelling looks like a proper title, so a name someone typed beats a program's */
const titleScore = (name: string) => (/\s/.test(name) ? 2 : 0) + (/\p{Lu}/u.test(name) && /\p{Ll}/u.test(name) ? 1 : 0);

const best = (names: string[]) => names.reduce((top, name) => (titleScore(name) > titleScore(top) ? name : top));

const inGroup = (guildId: string, key: string) => db.prepare('SELECT raw, name, manual FROM game_aliases WHERE guild_id = ? AND key = ?').all(guildId, key) as unknown as Alias[];

/** The name a spelling goes by. One that's new still finds a match, so it reads right before it's first recorded */
export function gameName(guildId: string, raw: string): string {
  const known = db.prepare('SELECT name FROM game_aliases WHERE guild_id = ? AND raw = ?').get(guildId, raw) as { name: string } | undefined;
  if (known) return known.name;
  const matches = inGroup(guildId, gameKey(raw));
  return (matches.find((m) => !m.manual) ?? matches[0])?.name ?? raw;
}

/** Records a spelling the first time it's seen. A better one takes over the name, unless someone chose that name */
export function noteGame(guildId: string, raw: string): boolean {
  if (db.prepare('SELECT 1 FROM game_aliases WHERE guild_id = ? AND raw = ?').get(guildId, raw)) return false;
  const key = gameKey(raw);
  const matches = inGroup(guildId, key);
  const match = matches.find((m) => !m.manual) ?? matches[0];
  const takesOver = match && !match.manual && titleScore(raw) > titleScore(match.name);
  db.prepare('INSERT INTO game_aliases (guild_id, raw, key, name, manual) VALUES (?, ?, ?, ?, ?)').run(guildId, raw, key, match?.name ?? raw, match?.manual ?? 0);
  if (takesOver) db.prepare('UPDATE game_aliases SET name = ? WHERE guild_id = ? AND key = ? AND manual = 0').run(raw, guildId, key);
  return !!match;
}

/** Why these games can't be merged, or null once they have been */
export function mergeGames(guildId: string, names: string[], into: string): string | null {
  const unique = [...new Set(names)];
  if (unique.length < 2) return 'Pick at least two games.';
  const marks = unique.map(() => '?').join();
  const rows = db.prepare(`SELECT raw, name FROM game_aliases WHERE guild_id = ? AND name IN (${marks})`).all(guildId, ...unique) as unknown as Alias[];
  const missing = unique.find((name) => !rows.some((r) => r.name === name));
  if (missing) return `There’s no game called ${missing}.`;
  if (!rows.some((r) => r.raw === into)) return 'Pick one of those names to keep.';
  db.prepare(`UPDATE game_aliases SET name = ?, manual = 1 WHERE guild_id = ? AND name IN (${marks})`).run(into, guildId, ...unique);
  return null;
}

/** Why a spelling can't go back to being its own game, or null once it has */
export function separateGame(guildId: string, raw: string): string | null {
  const row = db.prepare('SELECT raw, name, manual FROM game_aliases WHERE guild_id = ? AND raw = ?').get(guildId, raw) as unknown as Alias | undefined;
  if (!row) return `There’s no game called ${raw}.`;
  const others = (db.prepare('SELECT raw FROM game_aliases WHERE guild_id = ? AND name = ? AND raw != ?').all(guildId, row.name, raw) as unknown as Alias[]).map((r) => r.raw);
  if (!others.length) return `${raw} isn’t merged with anything.`;
  db.prepare('UPDATE game_aliases SET name = ?, manual = 1 WHERE guild_id = ? AND raw = ?').run(raw, guildId, raw);
  // It was the name the others went by, so they need another
  if (row.name === raw) db.prepare('UPDATE game_aliases SET name = ? WHERE guild_id = ? AND name = ? AND raw != ?').run(best(others), guildId, raw, raw);
  return null;
}

/** Every game's spellings, by the name it goes by, title first */
export function gameSpellings(guildId: string): Map<string, string[]> {
  const games = new Map<string, string[]>();
  for (const { name, raw } of db.prepare('SELECT name, raw FROM game_aliases WHERE guild_id = ? ORDER BY raw != name, raw').all(guildId) as unknown as Alias[]) {
    games.set(name, [...(games.get(name) ?? []), raw]);
  }
  return games;
}

/** Spellings already in the stats, most played first so ties keep the one people see most */
function fillAliases() {
  const seen = db
    .prepare(
      `SELECT guild_id AS guildId, game AS raw, SUM(ms) AS ms FROM (
         SELECT guild_id, game, ended_at - started_at AS ms FROM game_plays
         UNION ALL SELECT s.guild_id, sg.game, 0 FROM session_games sg JOIN sessions s ON s.id = sg.session_id
       ) GROUP BY guild_id, game ORDER BY ms DESC`,
    )
    .all() as { guildId: string; raw: string }[];
  db.exec('BEGIN');
  try {
    const matched = seen.filter((s) => noteGame(s.guildId, s.raw)).length;
    db.exec('COMMIT');
    if (matched) console.log(`Matched ${matched} game spellings to the same game`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

fillAliases();
