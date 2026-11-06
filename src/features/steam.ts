import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { DEFAULTS } from '../settings.ts';
import type { Feature } from '../types.ts';
import { requestTimeout } from '../util.ts';

// Steam category ids: 1 Multi-player, 36 Online PvP, 38 Online Co-op
const MULTIPLAYER_CATEGORIES = new Set([1, 36, 38]);
const REFRESH_EVERY_MS = 6 * 3_600_000;

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
}

async function steamGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(endpoint, 'https://api.steampowered.com');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: requestTimeout() });
  if (!res.ok) throw new Error(`Steam ${endpoint}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

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
    response: { game_count?: number; games?: { appid: number; name?: string; playtime_forever: number }[] };
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
    .prepare('SELECT o.appid, o.name, o.playtime FROM steam_owned o JOIN steam_links l ON l.steam_id = o.steam_id WHERE l.user_id = ?')
    .all(userId) as { appid: number; name: string | null; playtime: number }[];
  return new Map(rows.map((r) => [r.appid, { name: r.name, playtime: r.playtime }]));
}

async function refreshUser(userId: string): Promise<number | null> {
  const link = linkFor(userId);
  if (!link) return null;
  const games = await fetchOwned(link.steam_id);
  db.exec('BEGIN');
  try {
    if (games) {
      db.prepare('DELETE FROM steam_owned WHERE steam_id = ?').run(link.steam_id);
      const insert = db.prepare('INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES (?, ?, ?, ?)');
      for (const g of games) insert.run(link.steam_id, g.appid, g.name ?? null, g.playtime_forever);
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
}

/** Fetches and caches store categories for any appids we haven't seen yet */
export async function ensureAppInfo(appids: number[]) {
  const known = new Set((db.prepare('SELECT appid FROM app_info').all() as { appid: number }[]).map((r) => r.appid));
  const missing = [...new Set(appids)].filter((id) => !known.has(id));
  const insert = db.prepare('INSERT OR REPLACE INTO app_info (appid, name, multiplayer) VALUES (?, ?, ?)');

  for (let idx = 0; idx < missing.length; idx += 100) {
    const chunk = missing.slice(idx, idx + 100);
    const body = await steamGet<{
      response: { store_items?: { appid?: number; id: number; success: number; name?: string; categories?: { supported_player_categoryids?: number[] } }[] };
    }>('/IStoreBrowseService/GetItems/v1/', {
      input_json: JSON.stringify({
        ids: chunk.map((appid) => ({ appid })),
        context: { language: 'english', country_code: DEFAULTS.steamCountry.toUpperCase() },
        data_request: { include_basic_info: false },
      }),
    });
    const found = new Map((body.response.store_items ?? []).map((item) => [item.appid ?? item.id, item]));
    db.exec('BEGIN');
    for (const appid of chunk) {
      // Delisted apps come back unsuccessful; cache them as non-multiplayer so we don't keep asking
      const item = found.get(appid);
      const cats = item?.success === 1 ? (item.categories?.supported_player_categoryids ?? []) : [];
      insert.run(appid, item?.name ?? null, cats.some((c) => MULTIPLAYER_CATEGORIES.has(c)) ? 1 : 0);
    }
    db.exec('COMMIT');
  }
}

export function appInfo(): Map<number, { name: string | null; multiplayer: boolean }> {
  const rows = db.prepare('SELECT appid, name, multiplayer FROM app_info').all() as { appid: number; name: string | null; multiplayer: number }[];
  return new Map(rows.map((r) => [r.appid, { name: r.name, multiplayer: r.multiplayer === 1 }]));
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

        if (sub === 'refresh') {
          await i.deferReply();
          await refreshAll();
          return i.editReply('🔄 Steam libraries refreshed.');
        }

        // Links are shared between servers; only list this server's members
        const links = i.inCachedGuild() ? steamLinks().filter((l) => i.guild.members.cache.has(l.user_id)) : [];
        if (!links.length) return i.reply('Nobody here has linked Steam yet. Use `/steam link`.');
        const lines = links.map(
          (l) =>
            `<@${l.user_id}> · [profile](${profileUrl(l.steam_id)}) · ${l.private ? '🔒 game details private' : `${l.games} games`}`,
        );
        return i.reply({ embeds: [new EmbedBuilder().setTitle('🔗 Linked Steam accounts').setDescription(lines.join('\n')).setColor(0x1b2838)] });
      },
    },
  ],
  setup() {
    if (!config.steamApiKey) return;
    const run = () => void refreshAll().catch(console.error);
    run();
    setInterval(run, REFRESH_EVERY_MS);
  },
};
