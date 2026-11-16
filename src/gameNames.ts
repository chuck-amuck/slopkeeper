import { db, getKv, setKv, transaction } from './db.ts';
import { cleanGameName, gameKey, isProgramName, isProgramNotGame, steamName } from './gameText.ts';

export { cleanGameName, gameKey, isProgramName, isProgramNotGame } from './gameText.ts';

interface Alias {
  raw: string;
  name: string;
  manual: number;
}

/** Steam's titles for the games members own or the bot has looked up, by key, read again every so often */
let steamTitles: { at: number; byKey: Map<string, string> } | null = null;
const STEAM_TITLES_MS = 10 * 60_000;
export function steamTitle(key: string): string | undefined {
  if (!steamTitles || Date.now() - steamTitles.at > STEAM_TITLES_MS) {
    const byKey = new Map<string, string>();
    const rows = db.prepare('SELECT name FROM app_info WHERE name IS NOT NULL UNION SELECT DISTINCT name FROM steam_owned WHERE name IS NOT NULL').all() as { name: string }[];
    for (const { name } of rows) {
      const title = steamName(name);
      if (title) byKey.set(gameKey(title), title);
    }
    steamTitles = { at: Date.now(), byKey };
  }
  return steamTitles.byKey.get(key);
}
export const forgetSteamTitles = () => void (steamTitles = null);

/** The name a spelling starts with: a program's goes by Steam's title for it, when Steam has one */
const firstName = (raw: string, key: string) => (isProgramName(raw) && steamTitle(key)) || raw;

/** How much a spelling looks like a proper title, so a name someone typed beats a program's */
const titleScore = (name: string) => (/\s/.test(name) ? 2 : 0) + (/\p{Lu}/u.test(name) && /\p{Ll}/u.test(name) ? 1 : 0);

const best = (names: string[]) => names.reduce((top, name) => (titleScore(name) > titleScore(top) ? name : top));

const inGroup = (guildId: string, key: string) => db.prepare('SELECT raw, name, manual FROM game_aliases WHERE guild_id = ? AND key = ?').all(guildId, key) as unknown as Alias[];

/** The name a spelling goes by. One that's new still finds a match, so it reads right before it's first recorded */
export function gameName(guildId: string, raw: string): string {
  const known = db.prepare('SELECT name FROM game_aliases WHERE guild_id = ? AND raw = ?').get(guildId, raw) as { name: string } | undefined;
  if (known) return known.name;
  const key = gameKey(raw);
  const matches = inGroup(guildId, key);
  return (matches.find((m) => !m.manual) ?? matches[0])?.name ?? firstName(raw, key);
}

/** Records a spelling the first time it's seen. A better one takes over the name, unless someone chose that name */
export function noteGame(guildId: string, raw: string): boolean {
  if (db.prepare('SELECT 1 FROM game_aliases WHERE guild_id = ? AND raw = ?').get(guildId, raw)) return false;
  const key = gameKey(raw);
  const matches = inGroup(guildId, key);
  const match = matches.find((m) => !m.manual) ?? matches[0];
  const takesOver = match && titleScore(raw) > titleScore(match.name);
  db.prepare('INSERT INTO game_aliases (guild_id, raw, key, name, manual) VALUES (?, ?, ?, ?, ?)').run(guildId, raw, key, match?.name ?? firstName(raw, key), match?.manual ?? 0);
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
  // A spelling Discord showed, or a name one of them goes by already, like Steam's title for a program
  if (!rows.some((r) => r.raw === into || r.name === into)) return 'Pick one of those names to keep.';
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

/**
 * A program name Discord showed while that person's Steam said they were playing `title`: the program is that game.
 * Only for a program with no proper name yet, and never over a name someone chose. Says whether it learned anything
 */
export function learnFromSteam(guildId: string, raw: string, title: string): boolean {
  const settledKey = `${guildId}\n${raw}`;
  if (settled.has(settledKey) || !isProgramName(raw) || isProgramNotGame(raw)) return false;
  noteGame(guildId, raw);
  const row = db.prepare('SELECT key, name, manual FROM game_aliases WHERE guild_id = ? AND raw = ?').get(guildId, raw) as { key: string; name: string; manual: number };
  // Has a proper name, or one someone chose, so there's nothing more to learn
  if (row.manual || !isProgramName(row.name)) return !!settled.add(settledKey) && false;
  const steam = steamName(title);
  // Steam's reading can be a minute old, so the program's letters have to be in the title, in order: swzerocompany is
  // STAR WARS Zero Company, and a program started after quitting a Steam game isn't that game
  if (!steam || isProgramName(steam) || !spells(gameKey(raw), gameKey(steam))) return false;
  // A game already known by those letters keeps the name it goes by, so the two are one
  const known = inGroup(guildId, gameKey(steam));
  const name = known.length ? (known.find((m) => !m.manual) ?? known[0]).name : steam;
  db.prepare('UPDATE game_aliases SET name = ? WHERE guild_id = ? AND key = ? AND manual = 0').run(name, guildId, row.key);
  settled.add(settledKey);
  return true;
}

/** Programs already named, so presence updates don't look again */
const settled = new Set<string>();

/** Whether every letter of a program's key is in a title's key, in order and from the first */
function spells(program: string, title: string) {
  if (program[0] !== title[0]) return false;
  let at = 0;
  for (const letter of title) if (letter === program[at]) at++;
  return at === program.length;
}

/**
 * Why a game can't be marked as not a game, or null once it is. Every spelling of it is, so the whole game goes,
 * and anything later merged into it, or a spelling of it named something else later
 */
export function markNotAGame(guildId: string, name: string): string | null {
  const raws = db.prepare('SELECT raw FROM game_aliases WHERE guild_id = ? AND name = ?').all(guildId, name) as { raw: string }[];
  if (!raws.length) return `There’s no game called ${name}.`;
  const hide = db.prepare('INSERT OR REPLACE INTO not_games (guild_id, raw, name, hidden_at) VALUES (?, ?, ?, ?)');
  transaction(() => raws.forEach(({ raw }) => hide.run(guildId, raw, name, Date.now())));
  return null;
}

/** Why a game can't be counted again, or null once it is */
export function countAsGame(guildId: string, name: string): string | null {
  const { changes } = db.prepare('DELETE FROM not_games WHERE guild_id = ? AND name = ?').run(guildId, name);
  return changes ? null : `${name} isn’t marked as not a game.`;
}

/** What's marked as not a game, newest first */
export const notGames = (guildId: string) =>
  (db.prepare('SELECT name, MAX(hidden_at) AS at FROM not_games WHERE guild_id = ? GROUP BY name ORDER BY at DESC').all(guildId) as { name: string }[]).map((r) => r.name);

/** Whether a spelling is of something marked as not a game */
export const isNotAGame = (guildId: string, raw: string) =>
  !!db.prepare('SELECT 1 FROM not_games WHERE guild_id = ? AND (raw = ? OR name = ?)').get(guildId, raw, gameName(guildId, raw));

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
  const matched = transaction(() => seen.filter((s) => noteGame(s.guildId, s.raw)).length);
  if (matched) console.log(`Matched ${matched} game spellings to the same game`);
}

/** Matching can improve after spellings are recorded, so ones that now match join up, leaving hand-picked names alone */
function refreshKeys() {
  const rows = db.prepare('SELECT guild_id AS guildId, raw, key FROM game_aliases').all() as { guildId: string; raw: string; key: string }[];
  const stale = rows.filter((r) => r.key !== gameKey(r.raw));
  if (!stale.length) return;
  transaction(() => {
    for (const { guildId, raw } of stale) {
      const key = gameKey(raw);
      db.prepare('UPDATE game_aliases SET key = ? WHERE guild_id = ? AND raw = ?').run(key, guildId, raw);
      const names = inGroup(guildId, key).filter((m) => !m.manual).map((m) => m.name);
      if (names.length) db.prepare('UPDATE game_aliases SET name = ? WHERE guild_id = ? AND key = ? AND manual = 0').run(best(names), guildId, key);
    }
  });
}

/**
 * Names kept before they were cleaned, as with an escape code in them, are cleaned wherever they're stored. A spelling
 * keeps its alias, and with it any merge someone made, and a game that went by the old name goes by the clean one
 */
function cleanStoredNames() {
  const stored = db
    .prepare('SELECT game AS name FROM game_plays UNION SELECT game FROM session_games UNION SELECT raw FROM game_aliases UNION SELECT name FROM game_aliases UNION SELECT raw FROM not_games UNION SELECT name FROM not_games')
    .all() as { name: string }[];
  const dirty = stored.map(({ name }) => [name, cleanGameName(name)] as const).filter(([was, clean]) => was !== clean && clean);
  if (!dirty.length) return;
  transaction(() => {
    for (const [was, clean] of dirty) {
      db.prepare('UPDATE game_plays SET game = ? WHERE game = ?').run(clean, was);
      db.prepare('UPDATE OR IGNORE session_games SET game = ? WHERE game = ?').run(clean, was);
      db.prepare('DELETE FROM session_games WHERE game = ?').run(was);
      for (const old of db.prepare('SELECT guild_id AS guildId, name, manual FROM game_aliases WHERE raw = ?').all(was) as unknown as (Alias & { guildId: string })[]) {
        const has = db.prepare('SELECT manual FROM game_aliases WHERE guild_id = ? AND raw = ?').get(old.guildId, clean) as { manual: number } | undefined;
        if (!has) {
          db.prepare('UPDATE game_aliases SET raw = ? WHERE guild_id = ? AND raw = ?').run(clean, old.guildId, was);
          continue;
        }
        // Both were seen: the clean one stays, with the choice someone made for the other if it had none
        if (old.manual && !has.manual) db.prepare('UPDATE game_aliases SET name = ?, manual = 1 WHERE guild_id = ? AND raw = ?').run(old.name, old.guildId, clean);
        db.prepare('DELETE FROM game_aliases WHERE guild_id = ? AND raw = ?').run(old.guildId, was);
      }
      db.prepare('UPDATE game_aliases SET name = ? WHERE name = ?').run(clean, was);
      db.prepare('UPDATE OR IGNORE not_games SET raw = ? WHERE raw = ?').run(clean, was);
      db.prepare('DELETE FROM not_games WHERE raw = ?').run(was);
      db.prepare('UPDATE not_games SET name = ? WHERE name = ?').run(clean, was);
    }
  });
  console.log(`Cleaned ${dirty.length} game names`);
}

/** Games known only by a program's name go by Steam's title for it, once Steam has one, unless someone chose a name */
function nameProgramsFromSteam() {
  const programs = (db.prepare('SELECT DISTINCT guild_id AS guildId, key, name FROM game_aliases WHERE manual = 0').all() as { guildId: string; key: string; name: string }[]).filter((r) => isProgramName(r.name));
  const titled = programs.map((r) => ({ ...r, title: steamTitle(r.key) })).filter((r) => r.title);
  if (!titled.length) return;
  transaction(() => {
    for (const { guildId, key, title } of titled) db.prepare('UPDATE game_aliases SET name = ? WHERE guild_id = ? AND key = ? AND manual = 0').run(title!, guildId, key);
  });
}

/** Programs that aren't games, recorded before they were left out, are marked as not a game where they were seen, once */
function hideKnownPrograms() {
  if (getKv('not_games_marked')) return;
  const seen = (db.prepare('SELECT guild_id AS guildId, name, raw FROM game_aliases').all() as { guildId: string; name: string; raw: string }[]).filter((r) => isProgramNotGame(r.raw));
  transaction(() => {
    for (const { guildId, raw, name } of seen) db.prepare('INSERT OR IGNORE INTO not_games (guild_id, raw, name, hidden_at) VALUES (?, ?, ?, ?)').run(guildId, raw, name, Date.now());
    setKv('not_games_marked', String(Date.now()));
  });
}

cleanStoredNames();
refreshKeys();
fillAliases();
nameProgramsFromSteam();
hideKnownPrograms();
