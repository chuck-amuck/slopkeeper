import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { DEFAULTS, setting } from '../settings.ts';
import { setSteamGames, type SteamGame } from '../steamStatus.ts';
import type { Feature } from '../types.ts';
import { humansIn, listNames, requestTimeout, servedGuilds } from '../util.ts';

// Steam category ids: 1 Multi-player, 36 Online PvP, 38 Online Co-op
const MULTIPLAYER_CATEGORIES = new Set([1, 36, 38]);
// 9 Co-op, 38 Online Co-op, 39 Shared/Split Screen Co-op, 48 LAN Co-op
const COOP_CATEGORIES = new Set([9, 38, 39, 48]);
// 36 Online PvP, 37 Shared/Split Screen PvP, 47 LAN PvP, 49 PvP
const PVP_CATEGORIES = new Set([36, 37, 47, 49]);
const FAMILY_SHARING_CATEGORY = 62;
const REFRESH_EVERY_MS = 6 * 3_600_000;
const FACTS_LAST_MS = 30 * 86_400_000;
const PLAYER_COUNT_LASTS_MS = 10 * 60_000;
const STATUS_EVERY_MS = 60_000;
/** How long a game stays showing when Steam can't be asked, so an outage doesn't add hours of game time */
const STATUS_LASTS_MS = 5 * 60_000;
const FRIENDS_LAST_MS = 6 * 3_600_000;
export const FAMILY_SIZE = 6;
/** Steam's own values for a game on the Steam Deck */
export const DECK_PLAYABLE = 2;
export const DECK_VERIFIED = 3;

export interface SteamLink {
  user_id: string;
  steam_id: string;
  private: number;
  refreshed_at: number;
}

export interface OwnedGame {
  name: string | null;
  /** minutes */
  playtime: number;
  /** minutes in the last two weeks */
  recent: number;
}

class SteamError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function steamGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(endpoint, 'https://api.steampowered.com');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: requestTimeout() });
  if (!res.ok) throw new SteamError(`Steam ${endpoint}: HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

/** Steam's answer for something a profile's privacy settings hide */
const isHidden = (err: unknown) => err instanceof SteamError && (err.status === 401 || err.status === 403);

function apiKey(): string {
  if (!config.steamApiKey) throw new Error('STEAM_API_KEY is not set');
  return config.steamApiKey;
}

/** Accepts a profile URL (/profiles/<id> or /id/<vanity>), a 17-digit SteamID64, or a bare vanity name */
async function resolveSteamId(input: string): Promise<string | null> {
  const s = input.trim();
  const direct = s.match(/\/profiles\/(\d{17})/) ?? s.match(/^(\d{17})$/);
  if (direct) return direct[1];
  const vanity = s.match(/\/id\/([^/?#]+)/)?.[1] ?? (/^[\w-]+$/.test(s) ? s : null);
  if (!vanity) return null;
  const body = await steamGet<{ response: { success: number; steamid?: string } }>('/ISteamUser/ResolveVanityURL/v1/', {
    key: apiKey(),
    vanityurl: vanity,
  });
  return body.response.success === 1 ? (body.response.steamid ?? null) : null;
}

/** Returns null when the profile's game details are private */
async function fetchOwned(steamId: string) {
  const body = await steamGet<{
    response: { game_count?: number; games?: { appid: number; name?: string; playtime_forever: number; playtime_2weeks?: number }[] };
  }>('/IPlayerService/GetOwnedGames/v1/', {
    key: apiKey(),
    steamid: steamId,
    include_appinfo: '1',
    include_played_free_games: '1',
  });
  return body.response.games ?? (body.response.game_count === 0 ? [] : null);
}

export function linkFor(userId: string): SteamLink | undefined {
  return db.prepare('SELECT * FROM steam_links WHERE user_id = ?').get(userId) as SteamLink | undefined;
}

export function ownedSteamGames(userId: string): Map<number, OwnedGame> {
  const rows = db
    .prepare('SELECT o.appid, o.name, o.playtime, o.recent FROM steam_owned o JOIN steam_links l ON l.steam_id = o.steam_id WHERE l.user_id = ?')
    .all(userId) as { appid: number; name: string | null; playtime: number; recent: number }[];
  return new Map(rows.map((r) => [r.appid, { name: r.name, playtime: r.playtime, recent: r.recent }]));
}

async function refreshUser(userId: string): Promise<number | null> {
  const link = linkFor(userId);
  if (!link) return null;
  const games = await fetchOwned(link.steam_id);
  db.exec('BEGIN');
  try {
    if (games) {
      db.prepare('DELETE FROM steam_owned WHERE steam_id = ?').run(link.steam_id);
      const insert = db.prepare('INSERT INTO steam_owned (steam_id, appid, name, playtime, recent) VALUES (?, ?, ?, ?, ?)');
      for (const g of games) insert.run(link.steam_id, g.appid, g.name ?? null, g.playtime_forever, g.playtime_2weeks ?? 0);
    }
    db.prepare('UPDATE steam_links SET private = ?, refreshed_at = ? WHERE user_id = ?').run(games ? 0 : 1, Date.now(), userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return games?.length ?? null;
}

const forgetUnlinked = () => {
  db.prepare('DELETE FROM steam_owned WHERE steam_id NOT IN (SELECT steam_id FROM steam_links)').run();
  db.prepare('DELETE FROM steam_wishlist WHERE steam_id NOT IN (SELECT steam_id FROM steam_links)').run();
};

const saveLink = db.prepare('INSERT INTO steam_links (user_id, steam_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET steam_id = excluded.steam_id, refreshed_at = 0');

/**
 * Links someone to a Steam profile and reads its library. Returns null if there's no such profile, or else how many
 * games it has, which is null if they're private. Throws if Steam can't be asked, leaving any link they had.
 */
export async function linkSteam(userId: string, profile: string) {
  const steamId = await resolveSteamId(profile);
  if (!steamId) return null;
  const before = linkFor(userId);
  saveLink.run(userId, steamId);
  try {
    const games = await refreshUser(userId);
    forgetUnlinked();
    void ensureAppInfo([...ownedSteamGames(userId).keys()]).catch(console.error);
    return { games };
  } catch (err) {
    if (before) db.prepare('UPDATE steam_links SET steam_id = ?, private = ?, refreshed_at = ? WHERE user_id = ?').run(before.steam_id, before.private, before.refreshed_at, userId);
    else db.prepare('DELETE FROM steam_links WHERE user_id = ?').run(userId);
    throw err;
  }
}

/** Returns whether they were linked */
export function unlinkSteam(userId: string) {
  const { changes } = db.prepare('DELETE FROM steam_links WHERE user_id = ?').run(userId);
  forgetUnlinked();
  return changes > 0;
}

/** Everyone in someone's Steam family, them included. Empty if they aren't in one. Shared between servers, as links are */
export function familyOf(userId: string) {
  const rows = db.prepare('SELECT user_id FROM steam_family WHERE family = (SELECT family FROM steam_family WHERE user_id = ?) ORDER BY user_id').all(userId) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** Returns whether they were in one */
export function leaveFamily(userId: string) {
  const family = familyOf(userId);
  db.prepare('DELETE FROM steam_family WHERE user_id = ?').run(userId);
  // One person left isn't a family
  if (family.length === 2) db.prepare('DELETE FROM steam_family WHERE user_id = ?').run(family.find((id) => id !== userId)!);
  return family.length > 0;
}

/** Puts someone in another person's family, starting one if needed. Returns why it can't, or null */
export function joinFamily(userId: string, otherId: string) {
  if (userId === otherId) return 'Pick two different people.';
  const family = familyOf(otherId);
  if (family.includes(userId)) return null;
  if (family.length >= FAMILY_SIZE) return `A Steam family holds ${FAMILY_SIZE} people at most.`;
  leaveFamily(userId);
  const add = db.prepare('INSERT INTO steam_family (user_id, family) VALUES (?, ?)');
  const row = db.prepare('SELECT family FROM steam_family WHERE user_id = ?').get(otherId) as { family: number } | undefined;
  const id = row?.family ?? (db.prepare('SELECT COALESCE(MAX(family), 0) + 1 AS id FROM steam_family').get() as { id: number }).id;
  if (!row) add.run(otherId, id);
  add.run(userId, id);
  return null;
}

/** Every family someone in a list belongs to */
export function familiesOf(userIds: string[]) {
  return [...new Map(userIds.map((id) => familyOf(id)).filter((family) => family.length).map((family) => [family.join(), family])).values()];
}

/** Everyone linked, in any server, since links are shared between them */
export function steamLinks() {
  return db
    .prepare(
      `SELECT l.user_id, l.steam_id, l.private, COUNT(o.appid) AS games
       FROM steam_links l LEFT JOIN steam_owned o ON o.steam_id = l.steam_id
       GROUP BY l.user_id`,
    )
    .all() as { user_id: string; steam_id: string; private: number; games: number }[];
}

export const profileUrl = (steamId: string) => `https://steamcommunity.com/profiles/${steamId}`;

export async function refreshStale(userIds: string[], maxAgeMs: number) {
  if (!config.steamApiKey) return;
  const stale = userIds.filter((id) => {
    const link = linkFor(id);
    return link && Date.now() - link.refreshed_at > maxAgeMs;
  });
  const results = await Promise.allSettled(stale.map(refreshUser));
  for (const r of results) if (r.status === 'rejected') console.error(r.reason);
}

/** Steam gives the same empty answer for a private wishlist and an empty one */
async function fetchWishlist(steamId: string) {
  const body = await steamGet<{ response: { items?: { appid: number }[] } }>('/IWishlistService/GetWishlist/v1/', { steamid: steamId });
  return (body.response.items ?? []).map((item) => item.appid);
}

export async function refreshWishlists() {
  const links = db.prepare('SELECT DISTINCT steam_id FROM steam_links').all() as { steam_id: string }[];
  let visible = 0;
  for (const { steam_id } of links) {
    const appids = await fetchWishlist(steam_id).catch((err) => (console.error(err), null));
    // One that couldn't be read keeps the games it had
    if (!appids) continue;
    if (appids.length) visible++;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM steam_wishlist WHERE steam_id = ?').run(steam_id);
      const insert = db.prepare('INSERT OR IGNORE INTO steam_wishlist (steam_id, appid) VALUES (?, ?)');
      for (const appid of appids) insert.run(steam_id, appid);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (links.length) console.log(`Steam wishlists: games on ${visible} of ${links.length}`);
}

export async function refreshAll() {
  const links = db.prepare('SELECT user_id FROM steam_links').all() as { user_id: string }[];
  for (const { user_id } of links) await refreshUser(user_id).catch(console.error);
  // Warm the category cache so /whatdoweplay rarely has to wait on the store API
  const appids = db.prepare('SELECT DISTINCT appid FROM steam_owned').all() as { appid: number }[];
  await ensureAppInfo(appids.map((r) => r.appid));
  // Steam Deck ratings and the like change, so facts don't last forever
  const old = db.prepare('SELECT appid FROM app_info WHERE read_at < ?').all(Date.now() - FACTS_LAST_MS) as { appid: number }[];
  await readFacts(old.map((r) => r.appid));
}

/** Fetches and caches store categories for any appids we haven't seen yet */
export async function ensureAppInfo(appids: number[]) {
  const known = new Set((db.prepare('SELECT appid FROM app_info').all() as { appid: number }[]).map((r) => r.appid));
  await readFacts([...new Set(appids)].filter((id) => !known.has(id)));
}

async function readFacts(appids: number[]) {
  const save = db.prepare('INSERT OR REPLACE INTO app_info (appid, name, multiplayer, coop, pvp, deck, shareable, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // Delisted apps come back unsuccessful; cache them as non-multiplayer so we don't keep asking
  const unlisted = db.prepare('INSERT INTO app_info (appid, name, multiplayer, read_at) VALUES (?, NULL, 0, ?) ON CONFLICT (appid) DO UPDATE SET read_at = excluded.read_at');

  for (let idx = 0; idx < appids.length; idx += 100) {
    const chunk = appids.slice(idx, idx + 100);
    const body = await steamGet<{
      response: {
        store_items?: {
          appid?: number;
          id: number;
          success: number;
          name?: string;
          categories?: { supported_player_categoryids?: number[]; feature_categoryids?: number[] };
          platforms?: { steam_deck_compat_category?: number };
        }[];
      };
    }>('/IStoreBrowseService/GetItems/v1/', {
      input_json: JSON.stringify({
        ids: chunk.map((appid) => ({ appid })),
        context: { language: 'english', country_code: DEFAULTS.steamCountry.toUpperCase() },
        data_request: { include_basic_info: false, include_platforms: true },
      }),
    });
    const found = new Map((body.response.store_items ?? []).map((item) => [item.appid ?? item.id, item]));
    db.exec('BEGIN');
    for (const appid of chunk) {
      const item = found.get(appid);
      if (item?.success !== 1) {
        unlisted.run(appid, Date.now());
        continue;
      }
      const cats = item.categories?.supported_player_categoryids ?? [];
      const any = (wanted: Set<number>) => (cats.some((c) => wanted.has(c)) ? 1 : 0);
      const shareable = item.categories?.feature_categoryids?.includes(FAMILY_SHARING_CATEGORY) ? 1 : 0;
      save.run(appid, item.name ?? null, any(MULTIPLAYER_CATEGORIES), any(COOP_CATEGORIES), any(PVP_CATEGORIES), item.platforms?.steam_deck_compat_category ?? 0, shareable, Date.now());
    }
    db.exec('COMMIT');
  }
}

export function appInfo(): Map<number, { name: string | null; multiplayer: boolean; coop: boolean; pvp: boolean; deck: number; shareable: boolean }> {
  const rows = db.prepare('SELECT appid, name, multiplayer, coop, pvp, deck, shareable FROM app_info').all() as {
    appid: number;
    name: string | null;
    multiplayer: number;
    coop: number;
    pvp: number;
    deck: number;
    shareable: number;
  }[];
  return new Map(rows.map((r) => [r.appid, { name: r.name, multiplayer: r.multiplayer === 1, coop: r.coop === 1, pvp: r.pvp === 1, deck: r.deck, shareable: r.shareable === 1 }]));
}

/** What these people are playing on Steam right now, for those whose profile shows it */
async function readStatus(userIds: string[]) {
  const links = userIds.flatMap((id) => {
    const link = linkFor(id);
    return link ? [[id, link.steam_id]] : [];
  });
  const players = new Map<string, { gameid?: string; gameextrainfo?: string; lobbysteamid?: string }>();
  for (let idx = 0; idx < links.length; idx += 100) {
    const steamids = links.slice(idx, idx + 100).map(([, steamId]) => steamId).join(',');
    const body = await steamGet<{ response: { players?: { steamid: string; gameid?: string; gameextrainfo?: string; lobbysteamid?: string }[] } }>('/ISteamUser/GetPlayerSummaries/v2/', {
      key: apiKey(),
      steamids,
    });
    for (const player of body.response.players ?? []) players.set(player.steamid, player);
  }
  const games = new Map<string, SteamGame>();
  for (const [userId, steamId] of links) {
    const player = players.get(steamId);
    if (player?.gameid && player.gameextrainfo) games.set(userId, { appid: Number(player.gameid), name: player.gameextrainfo, lobby: player.lobbysteamid ?? null });
  }
  return games;
}

function peopleInVoice(client: Client<true>) {
  const people = new Set<string>();
  for (const guild of servedGuilds(client)) {
    if (!setting(guild.id, 'steamStatus')) continue;
    for (const channel of guild.channels.cache.values()) {
      if (channel.isVoiceBased() && channel.id !== guild.afkChannelId) for (const member of humansIn(channel)) people.add(member.id);
    }
  }
  return [...people];
}

let lastStatus = Date.now();

/** Everything that uses this only cares about voice, so nobody else is looked up */
export async function checkSteamStatus(client: Client<true>) {
  try {
    setSteamGames(await readStatus(peopleInVoice(client)));
    lastStatus = Date.now();
  } catch (err) {
    console.error(err);
    if (Date.now() - lastStatus > STATUS_LASTS_MS) setSteamGames(new Map());
  }
}

/** For when waiting for the next check would be too late. Carries on without it if Steam can't say */
export async function checkSteamStatusOf(guildId: string, userIds: string[]) {
  if (!config.steamApiKey || !setting(guildId, 'steamStatus')) return;
  setSteamGames(await readStatus(userIds).catch((err) => (console.error(err), new Map())), userIds);
}

/** Linked members in a joinable Steam lobby right now */
export async function lobbiesIn(guild: Guild) {
  const links = steamLinks().filter((l) => guild.members.cache.has(l.user_id));
  const games = await readStatus(links.map((l) => l.user_id));
  return links.flatMap((l) => {
    const game = games.get(l.user_id);
    if (!game?.lobby) return [];
    return [{ userId: l.user_id, game: game.name, profile: profileUrl(l.steam_id), join: `steam://joinlobby/${game.appid}/${game.lobby}/${l.steam_id}` }];
  });
}

const friendLists = new Map<string, { friends: Set<string> | null; at: number }>();

/** Someone's friends, or null if that's hidden or Steam can't say */
async function friendsOf(steamId: string) {
  const known = friendLists.get(steamId);
  if (known && Date.now() - known.at < FRIENDS_LAST_MS) return known.friends;
  try {
    const body = await steamGet<{ friendslist?: { friends?: { steamid: string }[] } }>('/ISteamUser/GetFriendList/v1/', { key: apiKey(), steamid: steamId, relationship: 'friend' });
    const friends = new Set((body.friendslist?.friends ?? []).map((f) => f.steamid));
    friendLists.set(steamId, { friends, at: Date.now() });
    return friends;
  } catch (err) {
    if (!isHidden(err)) {
      console.error(err);
      return null;
    }
    friendLists.set(steamId, { friends: null, at: Date.now() });
    return null;
  }
}

/** Which pairs in a group aren't Steam friends. Being friends goes both ways, so one visible list settles it */
export async function friendsCheck(userIds: string[]) {
  const linked = userIds.filter((id) => linkFor(id));
  const lists = new Map(await Promise.all(linked.map(async (id) => [id, await friendsOf(linkFor(id)!.steam_id)] as const)));
  const strangers: [string, string][] = [];
  const unknown: [string, string][] = [];
  linked.forEach((a, idx) => {
    for (const b of linked.slice(idx + 1)) {
      const [steamA, steamB] = [linkFor(a)!.steam_id, linkFor(b)!.steam_id];
      const [listA, listB] = [lists.get(a), lists.get(b)];
      if (steamA === steamB) continue;
      if (!listA && !listB) unknown.push([a, b]);
      else if (!listA?.has(steamB) && !listB?.has(steamA)) strangers.push([a, b]);
    }
  });
  return { strangers, unknown, unlinked: userIds.filter((id) => !linkFor(id)) };
}

const playerCounts = new Map<number, { count: number | null; at: number }>();

/** How many people are playing a game on Steam right now, or null if Steam won't say */
export async function currentPlayers(appid: number) {
  const known = playerCounts.get(appid);
  if (known && Date.now() - known.at < PLAYER_COUNT_LASTS_MS) return known.count;
  const count = await steamGet<{ response: { player_count?: number } }>('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', { appid: String(appid) })
    .then((body) => body.response.player_count ?? null)
    .catch((err) => (console.error(err), null));
  playerCounts.set(appid, { count, at: Date.now() });
  return count;
}

const PRIVACY_HELP =
  'Their Steam game details are private, so I can\'t see their library. Fix: Steam → profile → Edit Profile → Privacy Settings → **Game details: Public**, then run `/steam refresh`.';

export const steam: Feature = {
  title: 'Steam',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('steam')
        .setDescription('Link Steam accounts so the bot knows who owns what')
        .addSubcommand((s) =>
          s
            .setName('link')
            .setDescription('Link a Steam account')
            .addStringOption((o) => o.setName('profile').setDescription('Steam profile URL, vanity name or SteamID64').setRequired(true))
            .addUserOption((o) => o.setName('user').setDescription('Who to link (default: you)')),
        )
        .addSubcommand((s) =>
          s
            .setName('unlink')
            .setDescription('Unlink a Steam account')
            .addUserOption((o) => o.setName('user').setDescription('Who to unlink (default: you)')),
        )
        .addSubcommand((s) =>
          s
            .setName('family')
            .setDescription('Say who shares a Steam library, so shared games count for them')
            .addUserOption((o) => o.setName('with').setDescription('Someone in the family').setRequired(true))
            .addUserOption((o) => o.setName('user').setDescription('Who to add to it (default: you)')),
        )
        .addSubcommand((s) =>
          s
            .setName('unfamily')
            .setDescription('Take someone out of their Steam family')
            .addUserOption((o) => o.setName('user').setDescription('Who to take out (default: you)')),
        )
        .addSubcommand((s) => s.setName('friends').setDescription('Check that everyone in your voice channel is friends on Steam'))
        .addSubcommand((s) => s.setName('lobbies').setDescription('Show who’s in a joinable Steam lobby right now'))
        .addSubcommand((s) => s.setName('list').setDescription('Show linked accounts'))
        .addSubcommand((s) => s.setName('refresh').setDescription('Re-sync everyone\'s Steam libraries now')),
      async run(i) {
        if (!config.steamApiKey) return i.reply({ content: 'Steam is not configured (STEAM_API_KEY).', flags: MessageFlags.Ephemeral });
        const sub = i.options.getSubcommand();
        const user = i.options.getUser('user') ?? i.user;

        if (sub === 'link') {
          await i.deferReply();
          const linked = await linkSteam(user.id, i.options.getString('profile', true));
          if (!linked) return i.editReply("Couldn't find that Steam profile. Paste the full profile URL.");
          return i.editReply({
            content: linked.games === null ? `🔗 Linked ${user}, but: ${PRIVACY_HELP}` : `🔗 Linked ${user} (${linked.games} games).`,
            allowedMentions: { parse: [] },
          });
        }

        if (sub === 'unlink') {
          unlinkSteam(user.id);
          return i.reply({ content: `Unlinked ${user}.`, allowedMentions: { parse: [] } });
        }

        if (sub === 'family') {
          const other = i.options.getUser('with', true);
          const problem = other.bot || user.bot ? 'Bots don’t have Steam families.' : joinFamily(user.id, other.id);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          const family = familyOf(user.id).map((id) => `<@${id}>`);
          return i.reply({ content: `👪 Sharing a Steam library: ${listNames(family)}. Shareable games one of them owns now count for the others, with one person playing per copy.`, allowedMentions: { parse: [] } });
        }

        if (sub === 'unfamily') {
          if (!leaveFamily(user.id)) return i.reply({ content: `${user} isn’t in a Steam family.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          return i.reply({ content: `Took ${user} out of their Steam family.`, allowedMentions: { parse: [] } });
        }

        if (sub === 'friends') {
          const voice = i.inCachedGuild() ? i.member.voice.channel : null;
          if (!voice) return i.reply({ content: 'Join a voice channel first, then I can check who’s friends with who.', flags: MessageFlags.Ephemeral });
          await i.deferReply();
          const { strangers, unknown, unlinked } = await friendsCheck(humansIn(voice).map((m) => m.id));
          const pair = ([a, b]: [string, string]) => `<@${a}> and <@${b}>`;
          const lines = [
            ...strangers.map((p) => `${pair(p)} aren’t friends on Steam yet.`),
            ...unknown.map((p) => `Can’t tell for ${pair(p)}: both friends lists are private.`),
            ...(unlinked.length ? [`Not linked: ${listNames(unlinked.map((id) => `<@${id}>`))}`] : []),
          ];
          return i.editReply({ content: lines.join('\n').slice(0, 2000) || '✅ Everyone here is friends on Steam.', allowedMentions: { parse: [] } });
        }

        if (sub === 'lobbies') {
          if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
          await i.deferReply();
          const lobbies = await lobbiesIn(i.guild);
          // Discord won't open steam:// links, but friends can join from a profile
          const lines = lobbies.map((l) => `<@${l.userId}> · ${l.game} · [open their profile to join](${l.profile})`);
          return i.editReply({ content: lines.join('\n').slice(0, 2000) || 'Nobody’s in a joinable Steam lobby right now. Only games that use Steam lobbies show up, and only with public game details.', allowedMentions: { parse: [] } });
        }

        if (sub === 'refresh') {
          await i.deferReply();
          await refreshAll();
          return i.editReply('🔄 Steam libraries refreshed.');
        }

        // Links are shared between servers; only list this server's members
        const links = i.inCachedGuild() ? steamLinks().filter((l) => i.guild.members.cache.has(l.user_id)) : [];
        if (!links.length) return i.reply('Nobody here has linked Steam yet. Use `/steam link`.');
        const lines = links.map((l) => {
          const family = familyOf(l.user_id).filter((id) => id !== l.user_id);
          const shares = family.length ? ` · 👪 ${listNames(family.map((id) => `<@${id}>`))}` : '';
          return `<@${l.user_id}> · [profile](${profileUrl(l.steam_id)}) · ${l.private ? '🔒 game details private' : `${l.games} games`}${shares}`;
        });
        return i.reply({ embeds: [new EmbedBuilder().setTitle('🔗 Linked Steam accounts').setDescription(lines.join('\n')).setColor(0x1b2838)] });
      },
    },
  ],
  setup(client) {
    if (!config.steamApiKey) return;
    const run = () => void refreshAll().catch(console.error);
    run();
    setInterval(run, REFRESH_EVERY_MS);
    setInterval(() => void checkSteamStatus(client), STATUS_EVERY_MS);
  },
};
