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
import { appInfo, ensureAppInfo, linkFor, ownedSteamGames, refreshStale, type OwnedGame } from './steam.ts';

export interface GameRow {
  id: number;
  name: string;
  steam_appid: number | null;
  max_players: number | null;
}

export function allGames(guildId: string): GameRow[] {
  return db.prepare('SELECT id, name, steam_appid, max_players FROM games WHERE guild_id = ? ORDER BY name').all(guildId) as unknown as GameRow[];
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

/** Games two people both own and could play together, most played first */
export function sharedGames(guildId: string, a: string, b: string) {
  const library = allGames(guildId);
  const marks = [manualGameIds(a, guildId), manualGameIds(b, guildId)];
  const steam = [ownedSteamGames(a), ownedSteamGames(b)];
  const info = appInfo();
  const minutes = (appid: number | null) => (appid === null ? 0 : (steam[0].get(appid)?.playtime ?? 0) + (steam[1].get(appid)?.playtime ?? 0));

  const shared: { name: string; minutes: number }[] = [];
  for (const g of library) {
    const owns = (who: number) => marks[who].has(g.id) || (g.steam_appid !== null && steam[who].has(g.steam_appid));
    if (owns(0) && owns(1)) shared.push({ name: g.name, minutes: minutes(g.steam_appid) });
  }
  const inLibrary = new Set(library.map((g) => g.steam_appid));
  for (const [appid, game] of steam[0]) {
    if (!steam[1].has(appid) || inLibrary.has(appid) || !info.get(appid)?.multiplayer) continue;
    shared.push({ name: game.name ?? info.get(appid)?.name ?? `App ${appid}`, minutes: minutes(appid) });
  }
  return shared.sort((x, y) => y.minutes - x.minutes);
}

function parseSteamAppId(input: string): number | null {
  const match = input.match(/\/app\/(\d+)/) ?? input.trim().match(/^(\d+)$/);
  return match ? Number(match[1]) : null;
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
}

/** What the people in voice could play, or null if nobody there has linked Steam or marked any games */
export async function candidatesFor(guild: Guild, here: string[]) {
  await refreshStale(here, 3_600_000);

  const library = allGames(guild.id);
  const libByApp = new Map(library.filter((g) => g.steam_appid !== null).map((g) => [g.steam_appid!, g]));
  const manual = new Map(here.map((id) => [id, manualGameIds(id, guild.id)]));
  const steamLibs = new Map<string, Map<number, OwnedGame>>(here.map((id) => [id, ownedSteamGames(id)]));

  // People with no Steam link and no manual marks would block every game, so leave them out and say so
  const counted = here.filter((id) => linkFor(id) || manual.get(id)!.size > 0);
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
  const steamCands: { appid: number; missing: string[] }[] = [];
  for (const appid of appids) {
    const missing = counted.filter((id) => !ownsApp(id, appid));
    if (missing.length <= maxMissing) steamCands.push({ appid, missing });
  }
  await ensureAppInfo(steamCands.map((c) => c.appid)).catch(console.error);

  const info = appInfo();
  const hidden = new Set((db.prepare('SELECT appid FROM hidden_apps WHERE guild_id = ?').all(guild.id) as { appid: number }[]).map((r) => r.appid));
  const candidates: Candidate[] = [];

  for (const { appid, missing } of steamCands) {
    const lib = libByApp.get(appid);
    // Library entries count as group games even if Steam doesn't tag them multiplayer
    if (hidden.has(appid) || !fits(lib) || (!lib && !info.get(appid)?.multiplayer)) continue;
    let playtime = 0;
    let steamName: string | null = null;
    for (const id of counted) {
      const owned = steamLibs.get(id)!.get(appid);
      playtime += owned?.playtime ?? 0;
      steamName ??= owned?.name ?? null;
    }
    candidates.push({ name: lib?.name ?? steamName ?? info.get(appid)?.name ?? `App ${appid}`, appid, missing, playtime });
  }
  for (const g of library) {
    if (g.steam_appid !== null || !fits(g)) continue;
    const missing = counted.filter((id) => !manual.get(id)!.has(g.id));
    if (missing.length <= maxMissing) candidates.push({ name: g.name, appid: null, missing, playtime: 0 });
  }

  const notes: string[] = [];
  if (unknown.length) notes.push(`Not counted (no Steam linked): ${mentions(unknown)}`);
  if (privateIds.length) notes.push(`🔒 Steam game details private: ${mentions(privateIds)}`);
  return { counted, candidates, notes };
}

async function buildPick(guild: Guild, here: string[], avoid?: string) {
  const found = await candidatesFor(guild, here);
  if (!found) return { content: NOBODY_COUNTED, embeds: [], components: [] };
  const { counted, candidates, notes } = found;

  const byPlaytime = (a: Candidate, b: Candidate) => b.playtime - a.playtime;
  const ready = candidates.filter((c) => c.missing.length === 0);
  const almost = candidates.filter((c) => c.missing.length === 1).sort(byPlaytime).slice(0, 8);

  const embed = new EmbedBuilder().setColor(0xeb459e);

  let pick: Candidate | undefined;
  if (ready.length) {
    pick = choose(ready, avoid);
    embed.setTitle(`🎲 ${pick.name}`).setDescription([`All ${counted.length} of you own it.`, ...notes].join('\n'));
    if (pick.appid) embed.setURL(`https://store.steampowered.com/app/${pick.appid}`);
    const others = ready.filter((c) => c !== pick).sort(byPlaytime);
    if (others.length) {
      embed.addFields({ name: `Also works (${others.length})`, value: others.map((c) => c.name).join(', ').slice(0, 1024) });
    }
  } else {
    embed
      .setTitle('🤷 Nothing fits')
      .setDescription([`No multiplayer game is owned by all ${counted.length} of you and fits ${here.length} players.`, ...notes].join('\n'));
  }
  if (almost.length) {
    embed.addFields({ name: 'One purchase away', value: almost.map((c) => `${c.name} · needs ${mentions(c.missing)}`).join('\n').slice(0, 1024) });
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('wdp:reroll').setLabel('Reroll').setEmoji('🎲').setStyle(ButtonStyle.Primary).setDisabled(ready.length < 2),
    new ButtonBuilder().setCustomId('vote:start').setLabel('Vote').setEmoji('🗳️').setStyle(ButtonStyle.Secondary).setDisabled(ready.length < 2),
  );
  if (pick?.appid) {
    buttons.addComponents(new ButtonBuilder().setCustomId(`wdp:hide:${pick.appid}`).setLabel('Never suggest this').setStyle(ButtonStyle.Secondary));
  }
  return { content: '', embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}

const LIST_PAGE_CHARS = 4000; // embed descriptions stop at 4096

function libraryPage(guild: Guild, wanted: number) {
  const rows = allGames(guild.id);
  if (!rows.length) return { content: 'Library is empty. Add something with `/game add`.', embeds: [], components: [] };
  const group = groupMembers(guild);
  const lines = rows.map((g) => {
    const owners = ownersOf(g, guild);
    const missing = group.filter((id) => !owners.has(id));
    let line = `**${g.name}**${g.max_players ? ` · up to ${g.max_players}` : ''}`;
    if (owners.size) line += `\n  owned: ${mentions(owners)}`;
    if (missing.length) line += `\n  needs it: ${mentions(missing)}`;
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
          const { changes } = db.prepare('DELETE FROM hidden_apps WHERE guild_id = ? AND name = ?').run(i.guildId, name);
          return i.reply(changes ? `👀 **${name}** can be suggested again.` : { content: 'That game is not hidden.', flags: MessageFlags.Ephemeral });
        }

        const game = sub === 'list' ? undefined : findGame(i.guildId, i.options.getString('name', true));
        if (sub !== 'list' && !game) return i.reply({ content: 'No game by that name.', flags: MessageFlags.Ephemeral });

        if (sub === 'own' && game) {
          const user = i.options.getUser('user') ?? i.user;
          if (game.steam_appid !== null && ownedSteamGames(user.id).has(game.steam_appid)) {
            return i.reply({ content: `${user} already owns **${game.name}** on Steam.`, allowedMentions: { parse: [] } });
          }
          const owned = manualGameIds(user.id, i.guildId).has(game.id);
          if (owned) db.prepare('DELETE FROM game_owners WHERE game_id = ? AND user_id = ?').run(game.id, user.id);
          else db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)').run(game.id, user.id);
          return i.reply({
            content: `${owned ? '➖' : '✅'} ${user} ${owned ? 'no longer owns' : 'owns'} **${game.name}**.`,
            allowedMentions: { parse: [] },
          });
        }

        if (sub === 'remove' && game) {
          db.prepare('DELETE FROM games WHERE id = ?').run(game.id);
          return i.reply(`🗑️ Removed **${game.name}**.`);
        }

        return i.reply(libraryPage(i.guild, 0));
      },
    },
    {
      data: new SlashCommandBuilder().setName('whatdoweplay').setDescription('Pick a multiplayer game everyone in your voice channel owns'),
      async run(i) {
        if (!i.inCachedGuild() || !i.member.voice.channel) {
          return i.reply({ content: 'Join a voice channel first, then I can check what everyone owns.', flags: MessageFlags.Ephemeral });
        }
        await i.deferReply();
        return i.editReply(await buildPick(i.guild, humansIn(i.member.voice.channel).map((m) => m.id)));
      },
    },
  ],
  componentPrefix: 'wdp',
  async onButton(i) {
    const [, action, target] = i.customId.split(':');
    if (i.inCachedGuild() && action === 'list') return i.update(libraryPage(i.guild, Number(target)));
    if (!i.inCachedGuild() || !i.member.voice.channel) {
      return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    const shown = i.message.embeds[0]?.title?.replace(/^🎲 /, '');
    if (action === 'hide') {
      const title = shown ?? `App ${target}`;
      db.prepare('INSERT OR IGNORE INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES (?, ?, ?, ?)').run(i.guildId, Number(target), title, i.user.id);
    }
    await i.deferUpdate();
    return i.editReply(await buildPick(i.guild, humansIn(i.member.voice.channel).map((m) => m.id), shown));
  },
};
