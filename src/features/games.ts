import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type Guild,
} from 'discord.js';
import { db } from '../db.ts';
import type { Feature } from '../types.ts';
import { humansIn, paginate } from '../util.ts';
import { findOnSteam } from './gamefacts.ts';
import { appInfo, DECK_PLAYABLE, DECK_VERIFIED, ensureAppInfo, familiesOf, familyOf, linkFor, ownedSteamGames, refreshStale, type OwnedGame } from './steam.ts';

export interface GameRow {
  id: number;
  name: string;
  steam_appid: number | null;
  max_players: number | null;
}

export function allGames(guildId: string): GameRow[] {
  return db.prepare('SELECT id, name, steam_appid, max_players FROM games WHERE guild_id = ? ORDER BY name').all(guildId) as unknown as GameRow[];
}

/** The same for a Steam app that may not be in the library */
export function ownersOfApp(guild: Guild, appid: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT o.user_id FROM game_owners o JOIN games g ON g.id = o.game_id WHERE g.guild_id = ? AND g.steam_appid = ?
       UNION
       SELECT l.user_id FROM steam_links l JOIN steam_owned o ON o.steam_id = l.steam_id WHERE o.appid = ?`,
    )
    .all(guild.id, appid, appid) as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id).filter((id) => guild.members.cache.has(id)));
}

/** Owners from manual /game own marks plus linked Steam libraries, among the server's members */
export function ownersOf(game: GameRow, guild: Guild): Set<string> {
  const rows = db
    .prepare(
      `SELECT user_id FROM game_owners WHERE game_id = ?
       UNION
       SELECT l.user_id FROM steam_links l JOIN steam_owned o ON o.steam_id = l.steam_id WHERE o.appid = ?`,
    )
    .all(game.id, game.steam_appid) as { user_id: string }[];
  // Steam links are shared between servers, so owners elsewhere have to be filtered out
  return new Set(rows.map((r) => r.user_id).filter((id) => guild.members.cache.has(id)));
}

/** The group is the server's members who have linked Steam or marked at least one of its games as owned */
export function groupMembers(guild: Guild): string[] {
  const rows = db
    .prepare('SELECT o.user_id FROM game_owners o JOIN games g ON g.id = o.game_id WHERE g.guild_id = ? UNION SELECT user_id FROM steam_links')
    .all(guild.id) as { user_id: string }[];
  return rows.map((r) => r.user_id).filter((id) => guild.members.cache.has(id));
}

/** Those who own a game through a linked Steam library, so it can't be taken back by hand */
export function steamOwnersOf(game: GameRow): Set<string> {
  if (game.steam_appid === null) return new Set();
  const rows = db.prepare('SELECT l.user_id FROM steam_links l JOIN steam_owned o ON o.steam_id = l.steam_id WHERE o.appid = ?').all(game.steam_appid) as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

/** Those in a server who don't own a game but could play it on a family member's copy, leaving aside who else wants that copy */
export function familyPlayersOf(game: GameRow, guild: Guild, owners: Set<string>): Set<string> {
  if (game.steam_appid === null || !appInfo().get(game.steam_appid)?.shareable) return new Set();
  const family = [...steamOwnersOf(game)].flatMap(familyOf);
  return new Set(family.filter((id) => guild.members.cache.has(id) && !owners.has(id)));
}

/**
 * Who of those without a game can play it on a family member's copy. Each person playing at once needs a copy, so
 * only copies nobody in the group is using count. Whether the owners are using them can't be seen.
 */
function borrowers(appid: number, families: string[][], group: string[], without: string[], libraries: Map<string, Map<number, OwnedGame>>) {
  return families.flatMap((family) => {
    const copies = family.filter((id) => libraries.get(id)?.has(appid)).length;
    const playing = family.filter((id) => group.includes(id) && !without.includes(id)).length;
    return family.filter((id) => without.includes(id)).slice(0, Math.max(copies - playing, 0));
  });
}

const librariesOf = (ids: string[]) => new Map(ids.map((id) => [id, ownedSteamGames(id)]));

function manualGameIds(userId: string, guildId: string): Set<number> {
  const rows = db
    .prepare('SELECT o.game_id FROM game_owners o JOIN games g ON g.id = o.game_id WHERE o.user_id = ? AND g.guild_id = ?')
    .all(userId, guildId) as { game_id: number }[];
  return new Set(rows.map((r) => r.game_id));
}

function findGame(guildId: string, name: string): GameRow | undefined {
  return db.prepare('SELECT id, name, steam_appid, max_players FROM games WHERE guild_id = ? AND name = ?').get(guildId, name) as
    | GameRow
    | undefined;
}

export const gameById = (guildId: string, id: number) => allGames(guildId).find((g) => g.id === id);

/** Games two people both own and could play together, most played first */
export function sharedGames(guildId: string, a: string, b: string) {
  const library = allGames(guildId);
  const marks = [manualGameIds(a, guildId), manualGameIds(b, guildId)];
  const steam = [ownedSteamGames(a), ownedSteamGames(b)];
  const pair = [a, b];
  const families = familiesOf(pair);
  const libraries = librariesOf([...pair, ...families.flat()]);
  const info = appInfo();
  const minutes = (appid: number | null) => (appid === null ? 0 : (steam[0].get(appid)?.playtime ?? 0) + (steam[1].get(appid)?.playtime ?? 0));
  const bothPlay = (appid: number, owns: (who: number) => boolean) => {
    const without = pair.filter((_, who) => !owns(who));
    return !without.length || (info.get(appid)?.shareable === true && borrowers(appid, families, pair, without, libraries).length === without.length);
  };

  const shared: { name: string; minutes: number }[] = [];
  for (const g of library) {
    const owns = (who: number) => marks[who].has(g.id) || (g.steam_appid !== null && steam[who].has(g.steam_appid));
    if (g.steam_appid === null ? owns(0) && owns(1) : bothPlay(g.steam_appid, owns)) shared.push({ name: g.name, minutes: minutes(g.steam_appid) });
  }
  const inLibrary = new Set(library.map((g) => g.steam_appid));
  for (const appid of new Set([...libraries.values()].flatMap((owned) => [...owned.keys()]))) {
    if (inLibrary.has(appid) || !info.get(appid)?.multiplayer || !bothPlay(appid, (who) => steam[who].has(appid))) continue;
    const name = [...libraries.values()].find((owned) => owned.get(appid)?.name)?.get(appid)?.name;
    shared.push({ name: name ?? info.get(appid)?.name ?? `App ${appid}`, minutes: minutes(appid) });
  }
  return shared.sort((x, y) => y.minutes - x.minutes);
}

/** The game someone asked for, added to the library if it's new. Null if Steam doesn't know it */
async function gameFromSteam(guildId: string, input: string, userId: string): Promise<GameRow | null> {
  const listed = findGame(guildId, input);
  if (listed?.steam_appid) return listed;

  let app: { id: number; name: string } | null;
  const linked = input.includes('/') ? parseSteamAppId(input) : null;
  if (linked) {
    await ensureAppInfo([linked]);
    const name = appInfo().get(linked)?.name;
    app = name ? { id: linked, name } : null;
  } else app = await findOnSteam(input);
  if (!app) return null;

  const already = allGames(guildId).find((g) => g.steam_appid === app.id) ?? listed ?? findGame(guildId, app.name);
  if (already) {
    db.prepare('UPDATE games SET steam_appid = ? WHERE id = ?').run(app.id, already.id);
    return { ...already, steam_appid: app.id };
  }
  db.prepare('INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, ?)').run(guildId, app.name, app.id, userId);
  return findGame(guildId, app.name)!;
}

export function parseSteamAppId(input: string): number | null {
  const match = input.match(/\/app\/(\d+)/) ?? input.trim().match(/^(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Adds a game from a name or Steam link, by Steam's name for it if Steam knows it. A name it doesn't know is
 * added as typed, for non-Steam games, but a link has to lead somewhere, so that's null. Throws if Steam can't be asked.
 */
export async function addGame(guildId: string, input: string, userId: string) {
  const had = new Set(allGames(guildId).map((g) => g.id));
  const game = await gameFromSteam(guildId, input, userId);
  if (game) return { game, added: !had.has(game.id) };
  if (input.includes('/')) return null;
  const listed = findGame(guildId, input);
  if (listed) return { game: listed, added: false };
  db.prepare('INSERT INTO games (guild_id, name, added_by) VALUES (?, ?, ?)').run(guildId, input, userId);
  return { game: findGame(guildId, input)!, added: true };
}

/** Steam games the server's members own that aren't in the library yet, those the most people have first */
export function memberGames(guild: Guild) {
  const rows = db
    .prepare(
      `SELECT l.user_id AS userId, o.appid, COALESCE(o.name, i.name) AS name
       FROM steam_links l JOIN steam_owned o ON o.steam_id = l.steam_id LEFT JOIN app_info i ON i.appid = o.appid`,
    )
    .all() as { userId: string; appid: number; name: string | null }[];
  const library = new Set(allGames(guild.id).map((g) => g.steam_appid));
  const found = new Map<number, { appid: number; name: string | null; owners: string[] }>();
  for (const { userId, appid, name } of rows) {
    // Steam links are shared between servers
    if (library.has(appid) || !guild.members.cache.has(userId)) continue;
    const game = found.get(appid) ?? { appid, name: null, owners: [] };
    game.name ??= name;
    game.owners.push(userId);
    found.set(appid, game);
  }
  return [...found.values()]
    .flatMap((g) => (g.name ? [{ ...g, name: g.name }] : []))
    .sort((a, b) => b.owners.length - a.owners.length || a.name.localeCompare(b.name));
}

/** Adds a game a member owns, or links it to a game of that name already listed without Steam. Null if it isn't one of memberGames */
export function addMemberGame(guild: Guild, appid: number, userId: string) {
  const owned = memberGames(guild).find((g) => g.appid === appid);
  if (!owned) return null;
  const listed = findGame(guild.id, owned.name);
  if (listed) db.prepare('UPDATE games SET steam_appid = ? WHERE id = ?').run(appid, listed.id);
  else db.prepare('INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, ?)').run(guild.id, owned.name, appid, userId);
  return { name: listed?.name ?? owned.name, added: !listed };
}

export function setGameDetails(game: GameRow, maxPlayers: number | null, appid: number | null) {
  db.prepare('UPDATE games SET max_players = ?, steam_appid = ? WHERE id = ?').run(maxPlayers, appid, game.id);
}

export const removeGame = (game: GameRow) => db.prepare('DELETE FROM games WHERE id = ?').run(game.id);

/** Owning a game is the end of wanting it */
export function setOwned(game: GameRow, userId: string, on: boolean) {
  if (!on) return db.prepare('DELETE FROM game_owners WHERE game_id = ? AND user_id = ?').run(game.id, userId);
  db.prepare('INSERT OR IGNORE INTO game_owners (game_id, user_id) VALUES (?, ?)').run(game.id, userId);
  setWanted(game, userId, false);
}

export function hiddenGames(guildId: string) {
  return db.prepare('SELECT appid, name FROM hidden_apps WHERE guild_id = ? ORDER BY name').all(guildId) as { appid: number; name: string }[];
}

export function hideGame(guildId: string, appid: number, name: string, userId: string) {
  db.prepare('INSERT OR IGNORE INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES (?, ?, ?, ?)').run(guildId, appid, name, userId);
}

/** Returns whether it was hidden */
export function unhideGame(guildId: string, appid: number): boolean {
  return db.prepare('DELETE FROM hidden_apps WHERE guild_id = ? AND appid = ?').run(guildId, appid).changes > 0;
}

export function setWanted(game: GameRow, userId: string, on: boolean) {
  if (on) db.prepare('INSERT OR IGNORE INTO game_wants (game_id, user_id) VALUES (?, ?)').run(game.id, userId);
  else db.prepare('DELETE FROM game_wants WHERE game_id = ? AND user_id = ?').run(game.id, userId);
}

async function autocomplete(i: AutocompleteInteraction) {
  const table = i.options.getSubcommand() === 'unhide' ? 'hidden_apps' : 'games';
  const rows = db
    .prepare(`SELECT name FROM ${table} WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25`)
    .all(i.guildId, `%${i.options.getFocused()}%`) as { name: string }[];
  return i.respond(rows.map((r) => ({ name: r.name, value: r.name })));
}

/** A random game, other than the one on screen when there's a choice */
export function choose<T extends { name: string }>(ready: T[], avoid?: string): T {
  const others = ready.filter((c) => c.name !== avoid);
  const from = others.length ? others : ready;
  return from[Math.floor(Math.random() * from.length)];
}

const mentions = (ids: Iterable<string>) => [...ids].map((id) => `<@${id}>`).join(' ');

export const NOBODY_COUNTED = 'Nobody here has linked Steam (`/steam link`) or marked games (`/game own`) yet.';

export interface Candidate {
  name: string;
  appid: number | null;
  missing: string[];
  /** combined minutes played by the people in voice */
  playtime: number;
  /** combined minutes they played in the last two weeks */
  recent: number;
  /** those who'd play on a family member's copy */
  borrowed: string[];
  coop: boolean;
  pvp: boolean;
  /** Steam's rating, from 0 for unknown to DECK_VERIFIED */
  deck: number;
}

export interface PickFilter {
  type?: 'coop' | 'pvp';
  deck?: number;
}

const passes = (c: Candidate, filter: PickFilter) => (!filter.type || c[filter.type]) && c.deck >= (filter.deck ?? 0);

/** What the people in voice could play, or null if nobody there has linked Steam or marked any games */
export async function candidatesFor(guild: Guild, here: string[]) {
  const families = familiesOf(here);
  await refreshStale([...new Set([...here, ...families.flat()])], 3_600_000);

  const library = allGames(guild.id);
  const libByApp = new Map(library.filter((g) => g.steam_appid !== null).map((g) => [g.steam_appid!, g]));
  const manual = new Map(here.map((id) => [id, manualGameIds(id, guild.id)]));
  // Family members who aren't here still lend their copies
  const steamLibs = librariesOf([...new Set([...here, ...families.flat()])]);

  // People with no Steam link and no manual marks would block every game, so leave them out and say so
  const inFamily = new Set(families.flat());
  const counted = here.filter((id) => linkFor(id) || manual.get(id)!.size > 0 || inFamily.has(id));
  const unknown = here.filter((id) => !counted.includes(id));
  const privateIds = counted.filter((id) => linkFor(id)?.private);
  if (!counted.length) return null;

  const ownsApp = (id: string, appid: number) => {
    const lib = libByApp.get(appid);
    return steamLibs.get(id)!.has(appid) || (lib !== undefined && manual.get(id)!.has(lib.id));
  };
  const fits = (lib: GameRow | undefined) => !lib?.max_players || lib.max_players >= here.length;

  const appids = new Set<number>(libByApp.keys());
  for (const lib of steamLibs.values()) for (const appid of lib.keys()) appids.add(appid);

  const maxMissing = counted.length >= 2 ? 1 : 0;
  // Who's missing a game depends on whether it can be shared, so a family's games have to be known first
  if (families.length) await ensureAppInfo([...appids]).catch(console.error);
  const shareable = appInfo();
  const steamCands: { appid: number; missing: string[]; borrowed: string[] }[] = [];
  for (const appid of appids) {
    const without = counted.filter((id) => !ownsApp(id, appid));
    const borrowed = shareable.get(appid)?.shareable ? borrowers(appid, families, counted, without, steamLibs) : [];
    const missing = without.filter((id) => !borrowed.includes(id));
    if (missing.length <= maxMissing) steamCands.push({ appid, missing, borrowed });
  }
  await ensureAppInfo(steamCands.map((c) => c.appid)).catch(console.error);

  const info = appInfo();
  const hidden = new Set((db.prepare('SELECT appid FROM hidden_apps WHERE guild_id = ?').all(guild.id) as { appid: number }[]).map((r) => r.appid));
  const candidates: Candidate[] = [];

  for (const { appid, missing, borrowed } of steamCands) {
    const lib = libByApp.get(appid);
    // Library entries count as group games even if Steam doesn't tag them multiplayer
    if (hidden.has(appid) || !fits(lib) || (!lib && !info.get(appid)?.multiplayer)) continue;
    let playtime = 0;
    let recent = 0;
    for (const id of counted) {
      const owned = steamLibs.get(id)!.get(appid);
      playtime += owned?.playtime ?? 0;
      recent += owned?.recent ?? 0;
    }
    const steamName = [...steamLibs.values()].find((owned) => owned.get(appid)?.name)?.get(appid)?.name;
    const { coop = false, pvp = false, deck = 0 } = info.get(appid) ?? {};
    candidates.push({ name: lib?.name ?? steamName ?? info.get(appid)?.name ?? `App ${appid}`, appid, missing, playtime, recent, borrowed, coop, pvp, deck });
  }
  for (const g of library) {
    if (g.steam_appid !== null || !fits(g)) continue;
    const missing = counted.filter((id) => !manual.get(id)!.has(g.id));
    if (missing.length <= maxMissing) candidates.push({ name: g.name, appid: null, missing, playtime: 0, recent: 0, borrowed: [], coop: false, pvp: false, deck: 0 });
  }

  const notes: string[] = [];
  if (unknown.length) notes.push(`Not counted (no Steam linked): ${mentions(unknown)}`);
  if (privateIds.length) notes.push(`🔒 Steam game details private: ${mentions(privateIds)}`);
  return { counted, candidates, notes };
}

async function buildPick(guild: Guild, here: string[], filter: PickFilter, avoid?: string) {
  const found = await candidatesFor(guild, here);
  if (!found) return { content: NOBODY_COUNTED, embeds: [], components: [] };
  const { counted, notes } = found;
  const candidates = found.candidates.filter((c) => passes(c, filter));

  const byPlaytime = (a: Candidate, b: Candidate) => b.playtime - a.playtime;
  const ready = candidates.filter((c) => c.missing.length === 0);
  const almost = candidates.filter((c) => c.missing.length === 1).sort(byPlaytime).slice(0, 8);

  const embed = new EmbedBuilder().setColor(0xeb459e);

  let pick: Candidate | undefined;
  if (ready.length) {
    pick = choose(ready, avoid);
    const sharing = pick.borrowed.length ? ` ${mentions(pick.borrowed)} through family sharing.` : '';
    embed.setTitle(`🎲 ${pick.name}`).setDescription([`All ${counted.length} of you can play it.${sharing}`, ...notes].join('\n'));
    if (pick.appid) embed.setURL(`https://store.steampowered.com/app/${pick.appid}`);
    const others = ready.filter((c) => c !== pick).sort(byPlaytime);
    if (others.length) {
      embed.addFields({ name: `Also works (${others.length})`, value: others.map((c) => c.name).join(', ').slice(0, 1024) });
    }
  } else {
    embed
      .setTitle('🤷 Nothing fits')
      .setDescription([`No multiplayer game${filter.type || filter.deck ? ' like that' : ''} is owned by all ${counted.length} of you and fits ${here.length} players.`, ...notes].join('\n'));
  }
  if (almost.length) {
    embed.addFields({ name: 'One purchase away', value: almost.map((c) => `${c.name} · needs ${mentions(c.missing)}`).join('\n').slice(0, 1024) });
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wdp:reroll:${filter.type ?? ''}:${filter.deck ?? 0}`).setLabel('Reroll').setEmoji('🎲').setStyle(ButtonStyle.Primary).setDisabled(ready.length < 2),
    new ButtonBuilder().setCustomId('vote:start').setLabel('Vote').setEmoji('🗳️').setStyle(ButtonStyle.Secondary).setDisabled(ready.length < 2),
  );
  if (pick?.appid) {
    buttons.addComponents(new ButtonBuilder().setCustomId(`wdp:hide:${pick.appid}:${filter.type ?? ''}:${filter.deck ?? 0}`).setLabel('Never suggest this').setStyle(ButtonStyle.Secondary));
  }
  return { content: '', embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}

const LIST_PAGE_CHARS = 4000; // embed descriptions stop at 4096

export function wantedBy(game: GameRow, guild: Guild) {
  const rows = db.prepare('SELECT user_id FROM game_wants WHERE game_id = ?').all(game.id) as { user_id: string }[];
  return rows.map((r) => r.user_id).filter((id) => guild.members.cache.has(id));
}

function libraryPage(guild: Guild, wanted: number) {
  const rows = allGames(guild.id);
  if (!rows.length) return { content: 'Library is empty. Add something with `/game add`.', embeds: [], components: [] };
  const group = groupMembers(guild);
  const lines = rows.map((g) => {
    const owners = ownersOf(g, guild);
    const family = familyPlayersOf(g, guild, owners);
    const missing = group.filter((id) => !owners.has(id) && !family.has(id));
    let line = `**${g.name}**${g.max_players ? ` · up to ${g.max_players}` : ''}`;
    if (owners.size) line += `\n  owned: ${mentions(owners)}`;
    if (family.size) line += `\n  through family: ${mentions(family)}`;
    if (missing.length) line += `\n  needs it: ${mentions(missing)}`;
    const wanted = wantedBy(g, guild);
    if (wanted.length) line += `\n  wanted: ${mentions(wanted)}`;
    return line;
  });
  const pages = paginate(lines, LIST_PAGE_CHARS);
  const page = Math.min(Math.max(wanted, 0), pages.length - 1);
  const embed = new EmbedBuilder().setTitle('📚 Game library').setDescription(pages[page].join('\n')).setColor(0x57f287);
  if (pages.length === 1) return { embeds: [embed], components: [] };
  embed.setFooter({ text: `Page ${page + 1} of ${pages.length}` });
  const turn = (target: number, emoji: string) =>
    new ButtonBuilder()
      .setCustomId(`wdp:list:${target}`)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(target < 0 || target >= pages.length);
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(turn(page - 1, '◀️'), turn(page + 1, '▶️'))] };
}

export const games: Feature = {
  title: 'Game library',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('game')
        .setDescription('Manage the group game library')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Add a game (wishlist for sale alerts, player cap, or non-Steam game)')
            .addStringOption((o) => o.setName('name').setDescription('Game name').setRequired(true).setMaxLength(100))
            .addStringOption((o) => o.setName('steam').setDescription('Steam store URL or app ID (enables sale alerts)'))
            .addIntegerOption((o) => o.setName('max_players').setDescription('Max players per lobby').setMinValue(1).setMaxValue(100)),
        )
        .addSubcommand((s) =>
          s
            .setName('own')
            .setDescription('Toggle ownership by hand (non-Steam games, Family Sharing)')
            .addStringOption((o) => o.setName('name').setDescription('Game').setRequired(true).setAutocomplete(true))
            .addUserOption((o) => o.setName('user').setDescription('Who owns it (default: you)')),
        )
        .addSubcommand((s) =>
          s
            .setName('want')
            .setDescription('Get pinged when a game goes on sale, or stop. Run it again to take it back')
            .addStringOption((o) => o.setName('name').setDescription('Game, or its Steam store link').setRequired(true).setAutocomplete(true).setMaxLength(200)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Show the library and who owns what'))
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Remove a game from the library')
            .addStringOption((o) => o.setName('name').setDescription('Game').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('unhide')
            .setDescription('Let /whatdoweplay suggest a hidden game again')
            .addStringOption((o) => o.setName('name').setDescription('Game').setRequired(true).setAutocomplete(true)),
        ),
      autocomplete,
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const sub = i.options.getSubcommand();

        if (sub === 'add') {
          const name = i.options.getString('name', true).trim();
          const steamInput = i.options.getString('steam');
          const appid = steamInput ? parseSteamAppId(steamInput) : null;
          if (steamInput && appid === null) {
            return i.reply({ content: "Couldn't find a Steam app ID in that. Paste the store URL or the number.", flags: MessageFlags.Ephemeral });
          }
          if (findGame(i.guildId, name)) return i.reply({ content: `**${name}** is already in the library.`, flags: MessageFlags.Ephemeral });
          db.prepare('INSERT INTO games (guild_id, name, steam_appid, max_players, added_by) VALUES (?, ?, ?, ?, ?)').run(
            i.guildId,
            name,
            appid,
            i.options.getInteger('max_players'),
            i.user.id,
          );
          return i.reply(`➕ Added **${name}**${appid ? ' (sale alerts on, Steam ownership detected automatically)' : ''}.`);
        }

        if (sub === 'unhide') {
          const name = i.options.getString('name', true);
          const hidden = hiddenGames(i.guildId).find((g) => g.name === name);
          if (!hidden) return i.reply({ content: 'That game is not hidden.', flags: MessageFlags.Ephemeral });
          unhideGame(i.guildId, hidden.appid);
          return i.reply(`👀 **${name}** can be suggested again.`);
        }

        if (sub === 'want') {
          await i.deferReply();
          const input = i.options.getString('name', true).trim();
          const wanted = await gameFromSteam(i.guildId, input, i.user.id).catch((err) => (console.error(err), undefined));
          if (wanted === undefined) return i.editReply('Steam couldn’t be reached just now. Try again in a bit.');
          if (!wanted) return i.editReply({ content: `Couldn’t find **${input}** on Steam. Paste its store link instead.`, allowedMentions: { parse: [] } });
          if (ownersOf(wanted, i.guild).has(i.user.id)) return i.editReply(`You already own **${wanted.name}**.`);
          const { changes } = db.prepare('DELETE FROM game_wants WHERE game_id = ? AND user_id = ?').run(wanted.id, i.user.id);
          if (changes) return i.editReply(`➖ You’ll no longer hear about **${wanted.name}**.`);
          db.prepare('INSERT INTO game_wants (game_id, user_id) VALUES (?, ?)').run(wanted.id, i.user.id);
          return i.editReply(`🛒 You’ll be pinged when **${wanted.name}** goes on sale.`);
        }

        const game = sub === 'list' ? undefined : findGame(i.guildId, i.options.getString('name', true));
        if (sub !== 'list' && !game) return i.reply({ content: 'No game by that name.', flags: MessageFlags.Ephemeral });

        if (sub === 'own' && game) {
          const user = i.options.getUser('user') ?? i.user;
          if (game.steam_appid !== null && ownedSteamGames(user.id).has(game.steam_appid)) {
            return i.reply({ content: `${user} already owns **${game.name}** on Steam.`, allowedMentions: { parse: [] } });
          }
          const owned = manualGameIds(user.id, i.guildId).has(game.id);
          setOwned(game, user.id, !owned);
          return i.reply({
            content: `${owned ? '➖' : '✅'} ${user} ${owned ? 'no longer owns' : 'owns'} **${game.name}**.`,
            allowedMentions: { parse: [] },
          });
        }

        if (sub === 'remove' && game) {
          removeGame(game);
          return i.reply(`🗑️ Removed **${game.name}**.`);
        }

        return i.reply(libraryPage(i.guild, 0));
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('whatdoweplay')
        .setDescription('Pick a multiplayer game everyone in your voice channel owns')
        .addStringOption((o) => o.setName('type').setDescription('Only this kind of game').addChoices({ name: 'Co-op', value: 'coop' }, { name: 'PvP', value: 'pvp' }))
        .addIntegerOption((o) =>
          o.setName('deck').setDescription('Only games that work on Steam Deck').addChoices({ name: 'Verified', value: DECK_VERIFIED }, { name: 'Playable or Verified', value: DECK_PLAYABLE }),
        ),
      async run(i) {
        if (!i.inCachedGuild() || !i.member.voice.channel) {
          return i.reply({ content: 'Join a voice channel first, then I can check what everyone owns.', flags: MessageFlags.Ephemeral });
        }
        await i.deferReply();
        const filter = { type: (i.options.getString('type') ?? undefined) as PickFilter['type'], deck: i.options.getInteger('deck') ?? undefined };
        return i.editReply(await buildPick(i.guild, humansIn(i.member.voice.channel).map((m) => m.id), filter));
      },
    },
  ],
  componentPrefix: 'wdp',
  async onButton(i) {
    const [, action, ...rest] = i.customId.split(':');
    const [target] = rest;
    if (i.inCachedGuild() && action === 'list') return i.update(libraryPage(i.guild, Number(target)));
    if (!i.inCachedGuild() || !i.member.voice.channel) {
      return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    const shown = i.message.embeds[0]?.title?.replace(/^🎲 /, '');
    if (action === 'hide') {
      hideGame(i.guildId, Number(target), shown ?? `App ${target}`, i.user.id);
    }
    // Buttons posted before filters existed have nothing here
    const [type, deck] = action === 'hide' ? rest.slice(1) : rest;
    const filter = { type: (type || undefined) as PickFilter['type'], deck: Number(deck ?? 0) };
    await i.deferUpdate();
    return i.editReply(await buildPick(i.guild, humansIn(i.member.voice.channel).map((m) => m.id), filter, shown));
  },
};
