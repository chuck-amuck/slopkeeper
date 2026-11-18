import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, MessageFlags, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { due, every, once } from '../schedule.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild, formatDuration, paginate, requestTimeout } from '../util.ts';
import { factsFor } from './gamefacts.ts';
import { allGames, groupMembers, ownersOfApp } from './games.ts';
import { checkpoint, plural, short, stats } from './gamestats.ts';
import { appInfo, ensureAppInfo, linkFor, refreshStale, refreshWishlists } from './steam.ts';
import { commandMention } from '../commandIds.ts';
import { sendPost } from '../postFailures.ts';
import { feeds } from '../changes.ts';

const PLAYED_DAYS = 180;
// A sale that only gets a little deeper isn't worth another post
const DEEPER_BY = 10;
const PRICE_BATCH = 50;
const POSTED_GAMES = 10;
const NAMED_PEOPLE = 5;
// Message text stops at 2000 characters, and a post can name at most 100 people to ping
const MAX_PINGS = 80;
const LIST_CHARS = 4000; // embed descriptions stop at 4096
export const ITAD = 'https://api.isthereanydeal.com';
const ITAD_BATCH = 200;
// IsThereAnyDeal's id for Steam, as a store and as the DRM a copy needs
const STEAM = 61;
// A game IsThereAnyDeal didn't know is asked about again after this long
const ITAD_RETRY_MS = 7 * 86_400_000;
const GG_DEALS = 'https://api.gg.deals/v1/prices/by-steam-app-id/';
const GG_DEALS_BATCH = 100;
// It turns away requests that don't say who they're from
export const USER_AGENT = 'slopkeeper (https://github.com/chuck-amuck/slopkeeper)';

// Stay well under what Steam's store API, IsThereAnyDeal and gg.deals will take
export const pauses = { steamMs: 1500, itadMs: 1000, ggDealsMs: 1000 };

interface PriceOverview {
  currency: string;
  discount_percent: number;
  initial_formatted: string;
  final_formatted: string;
  /** in cents */
  initial: number;
  final: number;
}

/** Other official stores selling a Steam key, from IsThereAnyDeal, all in cents of `currency` */
interface StorePrice {
  /** the cheapest store other than Steam, or null when none sells a Steam key */
  now: number | null;
  shop: string | null;
  url: string | null;
  /** the lowest any of them, Steam included, has ever charged, or null when unknown. When IsThereAnyDeal couldn't be asked, the last check's */
  lowest: number | null;
  currency: string;
}

/** The cheapest key reseller, from gg.deals, which can't say whether it's a Steam key or where it works */
interface KeyshopPrice {
  now: number;
  currency: string;
  url: string;
}

/**
 * One check's prices, by region and app, shared by every server. Undefined means Steam couldn't be asked, null that
 * it isn't sold there. An app missing from `stores` or `keyshops` wasn't asked about them
 */
interface Prices {
  steam: Map<string, PriceOverview | null | undefined>;
  stores: Map<string, StorePrice | null>;
  keyshops: Map<string, KeyshopPrice | null>;
}

const newPrices = (): Prices => ({ steam: new Map(), stores: new Map(), keyshops: new Map() });

async function fetchPrices(appids: number[], country: string) {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appids.join(',')}&cc=${country}&filters=price_overview`, { signal: requestTimeout() });
  if (!res.ok) throw new Error(`Steam appdetails: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { success: boolean; data?: { price_overview?: PriceOverview } | [] }>;
  return new Map(
    appids.map((appid) => {
      const entry = body[String(appid)];
      // Free or unreleased games come back with data: []
      return [appid, !entry?.success || !entry.data || Array.isArray(entry.data) ? null : (entry.data.price_overview ?? null)];
    }),
  );
}

const cents = (amount: string) => Math.round(Number(amount) * 100);

/** Asks IsThereAnyDeal, throwing its reason when it says no */
export async function itad(path: string, query: Record<string, string>, body?: unknown) {
  const res = await fetch(`${ITAD}${path}?${new URLSearchParams({ ...query, key: config.itadKey! })}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'user-agent': USER_AGENT, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestTimeout(),
  });
  if (!res.ok) {
    const reason = ((await res.json().catch(() => null)) as { reason_phrase?: string } | null)?.reason_phrase;
    throw new Error(`IsThereAnyDeal ${path}: HTTP ${res.status}${reason ? `, ${reason}` : ''}`);
  }
  return res.json() as Promise<any>;
}

/** IsThereAnyDeal's ids for these Steam apps, looked up once and remembered */
async function itadIds(appids: number[]) {
  const known = db.prepare('SELECT itad_id, checked_at FROM itad_apps WHERE appid = ?');
  const ids = new Map<number, string>();
  const ask: number[] = [];
  for (const appid of appids) {
    const row = known.get(appid) as { itad_id: string | null; checked_at: number } | undefined;
    if (row?.itad_id) ids.set(appid, row.itad_id);
    else if (!row || Date.now() - row.checked_at > ITAD_RETRY_MS) ask.push(appid);
  }
  const remember = db.prepare('INSERT OR REPLACE INTO itad_apps (appid, itad_id, checked_at) VALUES (?, ?, ?)');
  for (let idx = 0; idx < ask.length; idx += ITAD_BATCH) {
    const chunk = ask.slice(idx, idx + ITAD_BATCH);
    const found = (await itad(`/lookup/id/shop/${STEAM}/v1`, {}, chunk.map((appid) => `app/${appid}`))) as Record<string, string | null>;
    for (const appid of chunk) {
      const id = found[`app/${appid}`] ?? null;
      remember.run(appid, id, Date.now());
      if (id) ids.set(appid, id);
    }
    await sleep(pauses.itadMs);
  }
  return ids;
}

interface ItadDeal {
  shop: { id: number; name: string };
  price: { amountInt: number; currency: string };
  storeLow: { amountInt: number; currency: string } | null;
  drm: { id: number; name: string }[];
  url: string;
}

/** What other stores charge for a Steam key, and the lowest price a Steam key has ever had */
export function storePrice(deals: ItadDeal[]): StorePrice | null {
  const steam = deals.find((d) => d.shop.id === STEAM);
  // GOG, Epic and the rest sell their own copy, and a store that doesn't say isn't trusted to be selling a Steam key
  const keys = deals.filter((d) => d.shop.id !== STEAM && d.drm.some((drm) => drm.id === STEAM));
  const currency = (steam ?? keys[0])?.price.currency;
  if (!currency) return null;
  const cheapest = keys.filter((d) => d.price.currency === currency).sort((a, b) => a.price.amountInt - b.price.amountInt)[0];
  const lows = [steam, ...keys].flatMap((d) => (d?.storeLow?.currency === currency ? [d.storeLow.amountInt] : []));
  return {
    now: cheapest?.price.amountInt ?? null,
    shop: cheapest?.shop.name ?? null,
    url: cheapest?.url ?? null,
    lowest: lows.length ? Math.min(...lows) : null,
    currency,
  };
}

/** Pauses after each batch, so the next caller can ask straight away, unless `pauseAfter` is false: then only between them */
async function fetchStorePrices(appids: number[], country: string, pauseAfter = true) {
  const ids = await itadIds(appids);
  const found = new Map<string, StorePrice | null>();
  const wanted = [...new Set(ids.values())];
  for (let idx = 0; idx < wanted.length; idx += ITAD_BATCH) {
    const games = (await itad('/games/prices/v3', { country: country.toUpperCase() }, wanted.slice(idx, idx + ITAD_BATCH))) as { id: string; deals: ItadDeal[] }[];
    for (const game of games) found.set(game.id, storePrice(game.deals));
    if (pauseAfter || idx + ITAD_BATCH < wanted.length) await sleep(pauses.itadMs);
  }
  // A game IsThereAnyDeal doesn't know, or knows no prices for, has no other stores
  return new Map(appids.map((appid) => [appid, found.get(ids.get(appid) ?? '') ?? null]));
}

/**
 * What a game costs now in a store region, for chat's price check of any game: Steam's price (null when it's free or
 * not sold), and other official stores selling a Steam key with the lowest price ever, if IsThereAnyDeal is set up
 */
export async function priceCheck(appid: number, country: string) {
  // Both at once, and no pause after, as someone is waiting on the answer
  const [steam, stores] = await Promise.all([
    fetchPrices([appid], country),
    config.itadKey ? fetchStorePrices([appid], country, false).catch((err) => (console.error(err), null)) : null,
  ]);
  return { steam: steam.get(appid) ?? null, store: stores?.get(appid) ?? null };
}

async function fetchKeyshops(appids: number[], region: string) {
  const query = new URLSearchParams({ ids: appids.join(','), region, key: config.ggDealsKey! });
  const res = await fetch(`${GG_DEALS}?${query}`, { headers: { 'user-agent': USER_AGENT }, signal: requestTimeout() });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: Record<string, { url: string; prices: { currentKeyshops: string | null; currency: string } } | null> & { message?: string };
  } | null;
  if (!res.ok || !body?.success || !body.data) {
    const message = body?.data?.message ?? (body as { message?: string } | null)?.message;
    throw new Error(`gg.deals: HTTP ${res.status}${message ? `, ${message}` : ''}`);
  }
  const data = body.data;
  return new Map(
    appids.map((appid): [number, KeyshopPrice | null] => {
      const game = data[String(appid)];
      const now = game?.prices.currentKeyshops == null ? NaN : cents(game.prices.currentKeyshops);
      return [appid, game && Number.isFinite(now) ? { now, currency: game.prices.currency, url: game.url } : null];
    }),
  );
}

/** Regions IsThereAnyDeal and gg.deals turn away, which aren't asked again until the bot restarts */
const storeRegionsRefused = new Set<string>();
const keyshopRegionsRefused = new Set<string>();

/** Another store selling a Steam key for less than Steam does now, in the same money, and how far under Steam's normal price */
export function storeDeal(steam: PriceOverview | null, store: StorePrice | null | undefined) {
  if (!steam || store?.now == null || !store.url || store.currency !== steam.currency || store.now >= steam.final) return null;
  const normal = steam.discount_percent ? steam.initial : steam.final;
  const off = normal ? Math.round((1 - store.now / normal) * 100) : 0;
  return off >= 1 ? { cents: store.now, off, url: store.url, shop: store.shop ?? 'another store' } : null;
}

/** The cheapest key reseller, when it's under every official price */
function keyshopDeal(steam: PriceOverview | null, store: StorePrice | null | undefined, keyshop: KeyshopPrice | null | undefined) {
  if (!steam || !keyshop || keyshop.currency !== steam.currency) return null;
  const official = Math.min(steam.final, store?.currency === steam.currency && store.now != null ? store.now : Infinity);
  return keyshop.now < official ? keyshop : null;
}

const steamNormal = (price: PriceOverview) => (price.discount_percent ? price.initial_formatted : price.final_formatted);

/** A row means it's on sale on Steam, or cheaper on another store than on Steam */
function rememberPrice(country: string, appid: number, price: PriceOverview | null, store: StorePrice | null, keyshop: KeyshopPrice | null) {
  const deal = storeDeal(price, store);
  if (!price || (!price.discount_percent && !deal)) db.prepare('DELETE FROM sale_prices WHERE country = ? AND appid = ?').run(country, appid);
  else {
    const reseller = keyshopDeal(price, store, keyshop);
    const lowest = store?.lowest != null && store.currency === price.currency ? store.lowest : null;
    db.prepare(
      'INSERT OR REPLACE INTO sale_prices (country, appid, discount, was, price, final, store, store_off, store_url, store_name, keyshop, keyshop_url, currency, lowest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(country, appid, price.discount_percent, steamNormal(price), price.final_formatted, price.final, deal?.cents ?? null, deal?.off ?? null, deal?.url ?? null, deal?.shop ?? null, reseller?.now ?? null, reseller?.url ?? null, price.currency, lowest);
  }
}

/** What the last check kept, standing in while a store can't be asked, so its deal isn't mistaken for a new one */
function lastPrices(country: string, appid: number) {
  const row = db.prepare('SELECT store, store_url, store_name, keyshop, keyshop_url, currency, lowest FROM sale_prices WHERE country = ? AND appid = ?').get(country, appid) as
    | { store: number | null; store_url: string | null; store_name: string | null; keyshop: number | null; keyshop_url: string | null; currency: string | null; lowest: number | null }
    | undefined;
  if (!row?.currency) return { store: null, keyshop: null };
  return {
    store:
      (row.store != null && row.store_url) || row.lowest != null
        ? { now: row.store_url ? row.store : null, shop: row.store_name, url: row.store_url, lowest: row.lowest, currency: row.currency }
        : null,
    keyshop: row.keyshop != null && row.keyshop_url ? { now: row.keyshop, url: row.keyshop_url, currency: row.currency } : null,
  };
}

/** Asks one source in batches, standing in the last check's price for whatever it couldn't answer */
async function loadFrom<T>(
  appids: number[],
  batch: number,
  pause: number,
  refused: Set<string>,
  country: string,
  ask: (appids: number[], country: string) => Promise<Map<number, T | null>>,
  last: (appid: number) => T | null,
  into: Map<string, T | null>,
) {
  for (let idx = 0; idx < appids.length; idx += batch) {
    const chunk = appids.slice(idx, idx + batch);
    const found = refused.has(country)
      ? null
      : await ask(chunk, country).catch((err: Error) => {
          console.error(err);
          if (/unknown country|unsupported region/i.test(err.message)) refused.add(country);
          return null;
        });
    for (const appid of chunk) into.set(`${country}:${appid}`, found ? (found.get(appid) ?? null) : refused.has(country) ? null : last(appid));
    if (found) await sleep(pause);
  }
}

/**
 * Several servers can watch the same game, so each region's prices are only fetched once a check. Key resellers are
 * only asked about when a server in that region wants other stores
 */
async function loadPrices(appids: number[], country: string, prices: Prices, otherStores: boolean) {
  const key = (appid: number) => `${country}:${appid}`;
  const fetched = new Set<number>();
  const missing = appids.filter((appid) => !prices.steam.has(key(appid)));
  for (let idx = 0; idx < missing.length; idx += PRICE_BATCH) {
    const chunk = missing.slice(idx, idx + PRICE_BATCH);
    const found = await fetchPrices(chunk, country).catch((err) => (console.error(err), null));
    for (const appid of chunk) prices.steam.set(key(appid), found ? (found.get(appid) ?? null) : undefined);
    if (found) for (const appid of chunk) fetched.add(appid);
    await sleep(pauses.steamMs);
  }

  const sold = appids.filter((appid) => prices.steam.get(key(appid)));
  const unasked = (into: Map<string, unknown>) => sold.filter((appid) => !into.has(key(appid)));
  // Asked whether or not a server wants other stores' deals, since it also knows the lowest price ever
  if (config.itadKey) {
    const stores = unasked(prices.stores);
    await loadFrom(stores, ITAD_BATCH, pauses.itadMs, storeRegionsRefused, country, fetchStorePrices, (appid) => lastPrices(country, appid).store, prices.stores);
    for (const appid of stores) fetched.add(appid);
  }
  if (otherStores && config.ggDealsKey) {
    const keyshops = unasked(prices.keyshops);
    await loadFrom(keyshops, GG_DEALS_BATCH, pauses.ggDealsMs, keyshopRegionsRefused, country, fetchKeyshops, (appid) => lastPrices(country, appid).keyshop, prices.keyshops);
    for (const appid of keyshops) fetched.add(appid);
  }

  // Written once everything is known, so another server asking for other stores later in the check fills them in
  for (const appid of fetched) {
    const price = prices.steam.get(key(appid));
    if (price !== undefined) rememberPrice(country, appid, price, prices.stores.get(key(appid)) ?? null, prices.keyshops.get(key(appid)) ?? null);
  }
}

/**
 * How the cheapest price now compares with the lowest a Steam key has ever had, which IsThereAnyDeal knows, in the
 * server's own money: `yet` when it's that low or lower. Null without it
 */
export function lowestPrice(g: Pick<Sale, 'final' | 'store' | 'currency'>, lowest: number | null | undefined, currency = g.currency) {
  if (lowest == null || currency !== g.currency) return null;
  const yet = (g.store?.cents ?? g.final) <= lowest;
  return { yet, text: yet ? 'Lowest price yet' : `Lowest ever ${money(lowest, currency)}` };
}

const priceHistory = (g: Sale, store: StorePrice | null | undefined) => {
  const low = lowestPrice(g, store?.lowest, store?.currency);
  return low && `${low.text}.`;
};

export const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
};

export interface Watched {
  appid: number;
  name: string | null;
  /** in a voice channel here over the past few months */
  playedMs: number;
  /** ran /game want, and doesn't have it yet */
  wanted: string[];
  /** has it on a Steam wishlist, and didn't also ask for it */
  wishlisted: string[];
  /** everyone else who'd want to know */
  others: string[];
}

const interest = (g: Watched) => g.wanted.length + g.wishlisted.length;
const byInterest = (a: Watched, b: Watched) => interest(b) - interest(a) || b.playedMs - a.playedMs;

/** The app each game played here is, and who has played it */
async function playedHere(guild: Guild) {
  checkpoint();
  const recent = new Map(stats(guild.id, Date.now() - PLAYED_DAYS * 86_400_000, 'none', 'game').map((g) => [g.key, g.ms]));
  const played: { name: string; appid: number; ms: number; people: string[] }[] = [];
  for (const { key } of stats(guild.id, 0, 'none', 'game')) {
    const appid = (await factsFor(key).catch((err) => (console.error(err), null)))?.appid;
    if (!appid) continue;
    played.push({ name: key, appid, ms: recent.get(key) ?? 0, people: stats(guild.id, 0, 'game', 'user_id', undefined, key).map((p) => p.key) });
  }
  return played;
}

/** Everything this server would want to hear about, and who to tell. Games nobody needs are left out */
export async function watched(guild: Guild): Promise<Watched[]> {
  const inServer = (id: string) => guild.members.cache.has(id);
  const hidden = new Set((db.prepare('SELECT appid FROM hidden_apps WHERE guild_id = ?').all(guild.id) as { appid: number }[]).map((r) => r.appid));
  const found = new Map<number, { name: string | null; library: boolean; asked: boolean; ms: number; wanted: Set<string>; wished: Set<string> }>();
  const entry = (appid: number, name: string | null = null) => {
    const game = found.get(appid) ?? { name, library: false, asked: false, ms: 0, wanted: new Set<string>(), wished: new Set<string>() };
    game.name ??= name;
    found.set(appid, game);
    return game;
  };

  for (const g of allGames(guild.id)) if (g.steam_appid !== null) entry(g.steam_appid, g.name).library = true;

  const wants = db
    .prepare('SELECT g.steam_appid AS appid, g.name, w.user_id FROM game_wants w JOIN games g ON g.id = w.game_id WHERE g.guild_id = ? AND g.steam_appid IS NOT NULL')
    .all(guild.id) as { appid: number; name: string; user_id: string }[];
  for (const want of wants) {
    const game = entry(want.appid, want.name);
    game.asked = true;
    if (inServer(want.user_id)) game.wanted.add(want.user_id);
  }

  // Someone who has played a game has it, however they got it
  const players = new Map<number, string[]>();
  for (const { name, appid, ms, people } of await playedHere(guild)) {
    players.set(appid, [...(players.get(appid) ?? []), ...people]);
    if (ms && !hidden.has(appid)) entry(appid, name).ms += ms;
  }

  if (setting(guild.id, 'saleSteamWishlists')) {
    const wishes = db.prepare('SELECT w.appid, l.user_id FROM steam_wishlist w JOIN steam_links l ON l.steam_id = w.steam_id').all() as { appid: number; user_id: string }[];
    for (const wish of wishes) if (inServer(wish.user_id) && !hidden.has(wish.appid)) entry(wish.appid).wished.add(wish.user_id);
  }

  const group = groupMembers(guild);
  const games: Watched[] = [];
  for (const [appid, game] of found) {
    const owners = new Set([...ownersOfApp(guild, appid), ...(players.get(appid) ?? [])]);
    const wanted = [...game.wanted].filter((id) => !owners.has(id));
    const wishlisted = [...game.wished].filter((id) => !owners.has(id) && !wanted.includes(id));
    // Asking for a game adds it to the library, which shouldn't tell the whole group about it
    const everyone = game.ms > 0 || (game.library && !game.asked);
    // Nobody can tell what someone with a private library owns, so they're only told what they asked for
    const others = everyone ? group.filter((id) => !owners.has(id) && !linkFor(id)?.private && !wanted.includes(id) && !wishlisted.includes(id)) : [];
    const noOneToTell = !wanted.length && !wishlisted.length && !others.length;
    if (noOneToTell && (group.length || !game.library)) continue;
    games.push({ appid, name: game.name, playedMs: game.ms, wanted, wishlisted, others });
  }
  return games;
}

export interface Sale extends Watched {
  /** Steam's, 0 when only another store has it for less */
  discount: number;
  /** Steam's normal price */
  was: string;
  /** Steam's price now */
  price: string;
  final: number;
  currency: string;
  /** the lowest a Steam key has ever sold for, in `currency`, if IsThereAnyDeal knows */
  lowest: number | null;
  /** Another store selling a Steam key for less than Steam: its price, how far under Steam's normal price, its link and name */
  store: { price: string; cents: number; off: number; url: string; shop: string } | null;
  /** The cheapest key reseller, when it's under every official price: never a deal by itself */
  keyshop: { price: string; cents: number; url: string } | null;
}

/** How far under Steam's normal price the best deal is, which is what's compared with the smallest sale worth posting */
export const dealSize = (g: Pick<Sale, 'discount' | 'store'>) => Math.max(g.discount, g.store?.off ?? 0);

/** The deal in words: Steam's sale, or another store's price with Steam's beside it, then any key reseller under both */
export function dealText(g: Pick<Sale, 'discount' | 'was' | 'price' | 'store' | 'keyshop'>, link = (text: string, _url: string) => text) {
  const keyshop = g.keyshop ? ` Key resellers from ${g.keyshop.price} on ${link('gg.deals', g.keyshop.url)}.` : '';
  if (!g.store) return `${g.discount}% off, ${g.price}, was ${g.was}.${keyshop}`;
  const steam = g.discount ? ` Steam has it at ${g.discount}% off, ${g.price}.` : '';
  return `${g.store.price} as a Steam key from ${link(g.store.shop, g.store.url)}, ${g.store.off}% under Steam’s ${g.was}.${steam}${keyshop}`;
}

/** Why a game is worth mentioning, naming people however the reader sees them */
export function saleReasons(g: Watched, show: (id: string) => string) {
  const named = (ids: string[]) => ids.slice(0, NAMED_PEOPLE).map(show).join(', ') + (ids.length > NAMED_PEOPLE ? ` +${ids.length - NAMED_PEOPLE} more` : '');
  const reasons: string[] = [];
  if (g.playedMs) reasons.push(`Played ${formatDuration(g.playedMs)}`);
  if (g.wanted.length) reasons.push(`Wanted by ${named(g.wanted)}`);
  if (g.wishlisted.length === 1) reasons.push(`On ${show(g.wishlisted[0])}’s Steam wishlist`);
  if (g.wishlisted.length > 1) reasons.push(`On Steam wishlists: ${named(g.wishlisted)}`);
  if (g.others.length) reasons.push(`Needs it: ${named(g.others)}`);
  return reasons.join(' · ');
}

export const saleName = (g: Watched, info = appInfo()) => g.name ?? info.get(g.appid)?.name ?? `App ${g.appid}`;
export const storeUrl = (appid: number) => `https://store.steampowered.com/app/${appid}`;

function saleLine(g: Sale, name: string, history: string | null = null) {
  const title = escapeMarkdown(short(name)).replace(/[[\]]/g, '');
  const facts = [dealText(g, (text, url) => `[${text}](${url})`), history, saleReasons(g, (id) => `<@${id}>`)];
  return `[**${title}**](${storeUrl(g.appid)}): ${facts.filter(Boolean).join(' ')}`;
}

/** Everything on sale at the last check, in this server's store region, with other stores' deals if the server wants them */
export function salePrices(guildId: string) {
  const rows = db
    .prepare('SELECT appid, discount, was, price, final, currency, store, store_off, store_url, store_name, keyshop, keyshop_url, lowest FROM sale_prices WHERE country = ?')
    .all(setting(guildId, 'steamCountry')) as {
    appid: number;
    discount: number;
    was: string;
    price: string;
    final: number;
    currency: string | null;
    store: number | null;
    store_off: number | null;
    store_url: string | null;
    store_name: string | null;
    keyshop: number | null;
    keyshop_url: string | null;
    lowest: number | null;
  }[];
  const otherStores = setting(guildId, 'saleOtherStores');
  return new Map(
    rows.flatMap(({ store, store_off, store_url, store_name, keyshop, keyshop_url, currency, ...r }) => {
      const deal =
        otherStores && store !== null && store_off !== null && store_url && currency
          ? { price: money(store, currency), cents: store, off: store_off, url: store_url, shop: store_name ?? 'another store' }
          : null;
      const reseller = otherStores && keyshop !== null && keyshop_url && currency ? { price: money(keyshop, currency), cents: keyshop, url: keyshop_url } : null;
      return deal || r.discount ? [[r.appid, { ...r, currency: currency ?? '', store: deal, keyshop: reseller }] as const] : [];
    }),
  );
}

/** Watched games on sale at the last check, most wanted first */
export async function onSale(guild: Guild): Promise<Sale[]> {
  const prices = salePrices(guild.id);
  const games = await watched(guild);
  return games.flatMap((g) => (prices.has(g.appid) ? [{ ...g, ...prices.get(g.appid)! }] : [])).sort(byInterest);
}

const alerted = (guildId: string, appid: number) =>
  (db.prepare('SELECT discount FROM sale_alerts WHERE guild_id = ? AND appid = ?').get(guildId, appid) as { discount: number } | undefined)?.discount ?? 0;

function rememberAlert(guildId: string, appid: number, discount: number) {
  if (discount) db.prepare('INSERT OR REPLACE INTO sale_alerts (guild_id, appid, discount) VALUES (?, ?, ?)').run(guildId, appid, discount);
  else db.prepare('DELETE FROM sale_alerts WHERE guild_id = ? AND appid = ?').run(guildId, appid);
}

// A tick that tries a server's post and fails waits this long before trying again
const RETRY_MS = 60 * 60_000;
// Tries at a day's post that some of Steam's prices are missing from, before posting without them
const PARTIAL_TRIES = 3;

/** One check or post at a time, so a slow one isn't overlapped by the next and nothing is posted twice */
let busy = false;
async function alone(job: () => Promise<void>) {
  if (busy) return;
  busy = true;
  try {
    await job();
  } finally {
    busy = false;
  }
}

/** Checks prices for every server, keeping /sales and the web UI current, and posting what's new only if `post` */
export function checkSales(client: Client<true>, post = false) {
  return alone(async () => {
    await refreshWishlists();
    const prices = newPrices();
    await eachGuild(client, 'Sale check', async (guild) => void (await checkGuild(client, guild, prices, post)));
    feeds.deals.changedEverywhere();
  });
}

/** The server's date once its post hour has come today, or null before then */
export const postDay = (guildId: string, now = Date.now()) => due(guildId, 'day', setting(guildId, 'salePostHour'), { now });

/** When each server last tried its day's post, and how many tries found Steam's prices incomplete */
const tries = new Map<string, { at: number; partial: number; day: string }>();

/** Each server's one sale post of the day, with fresh prices, once its hour has come */
export function postDailySales(client: Client<true>) {
  return alone(async () => {
    let prices: Prices | null = null;
    await eachGuild(client, 'Daily sale post', async (guild) => {
      const day = postDay(guild.id);
      await once(`sale_post:${guild.id}`, day, async () => {
        const last = tries.get(guild.id);
        const tried = last?.day === day!.period ? last : { at: 0, partial: 0, day: day!.period };
        if (Date.now() - tried.at < RETRY_MS) return false;
        // Nowhere to post is nothing to do today, without asking anyone for prices
        if (!(await announceChannel(client, guild.id, 'saleChannel')) && !(await announceChannel(client, guild.id))) return true;
        tried.at = Date.now();
        tries.set(guild.id, tried);
        if (!prices) {
          await refreshWishlists();
          prices = newPrices();
        }
        // Left unmarked when the post fails or Steam can't be asked, so a later tick tries again
        const done = await checkGuild(client, guild, prices, true, ++tried.partial >= PARTIAL_TRIES);
        if (done) tries.delete(guild.id);
        return done;
      });
    });
  });
}

/**
 * Whether the check is done: it posted, or found nothing to post. False when there's nowhere to post or Steam didn't
 * answer for some games, unless `partial` says to post without them
 */
async function checkGuild(client: Client<true>, guild: Guild, prices: Prices, post: boolean, partial = true) {
  const out = (await announceChannel(client, guild.id, 'saleChannel')) ?? (await announceChannel(client, guild.id));
  if (!out) return false;
  await refreshStale(groupMembers(guild), config.saleCheckHours * 3_600_000);
  const country = setting(guild.id, 'steamCountry');
  const lowestDiscount = setting(guild.id, 'saleMinDiscount');
  const otherStores = setting(guild.id, 'saleOtherStores');
  const games = await watched(guild);
  await loadPrices(games.map((g) => g.appid), country, prices, otherStores);

  const due: Sale[] = [];
  let missing = 0;
  for (const g of games.sort(byInterest)) {
    const key = `${country}:${g.appid}`;
    const price = prices.steam.get(key);
    const store = otherStores ? (prices.stores.get(key) ?? null) : null;
    if (price === undefined) {
      missing++;
      continue;
    }
    const deal = storeDeal(price, store);
    const reseller = otherStores ? keyshopDeal(price, store, prices.keyshops.get(key)) : null;
    const sale = price && {
      discount: price.discount_percent,
      was: steamNormal(price),
      price: price.final_formatted,
      final: price.final,
      currency: price.currency,
      store: deal && { ...deal, price: money(deal.cents, price.currency) },
      keyshop: reseller && { cents: reseller.now, url: reseller.url, price: money(reseller.now, price.currency) },
      lowest: null,
    };
    const size = sale ? dealSize(sale) : 0;
    const last = alerted(guild.id, g.appid);
    // Only new or much deeper sales, not every check while one is running. Remembering a smaller one means the next is news
    if (size <= last) rememberAlert(guild.id, g.appid, size);
    else if (sale && size >= lowestDiscount && (!last || size >= last + DEEPER_BY)) due.push({ ...g, ...sale });
  }
  // A sale in a batch Steam didn't answer would wait a whole day, so a post waits for it a few times first
  if (missing && !partial) return false;
  if (!post || !due.length) return missing < games.length || !games.length;

  // Wishlisted games only have a name once they're asked about
  await ensureAppInfo(due.map((g) => g.appid)).catch(console.error);
  const info = appInfo();
  const lines: string[] = [];
  for (const g of due.slice(0, POSTED_GAMES)) lines.push(saleLine(g, saleName(g, info), priceHistory(g, prices.stores.get(`${country}:${g.appid}`))));
  if (due.length > POSTED_GAMES) lines.push(`and ${due.length - POSTED_GAMES} more: ${commandMention(guild.id, 'sales')}`);

  const pings = [...new Set(due.flatMap((g) => [...g.wanted, ...g.wishlisted, ...g.others]))].slice(0, MAX_PINGS);
  await sendPost('sales', guild.id, out, {
    content: pings.map((id) => `<@${id}>`).join(' ') || undefined,
    embeds: [new EmbedBuilder().setTitle(`💸 ${plural(due.length, 'game')} on sale`).setDescription(lines.join('\n')).setColor(0x57f287)],
    // Each person sees the full list, or only theirs, without posting it again for everyone
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('sales:show:all').setLabel('Everything on sale').setEmoji('💸').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('sales:show:mine').setLabel('Just mine').setEmoji('🛒').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { users: pings },
  });
  // Afterwards, so a post that fails is tried again on the next check
  for (const g of due) rememberAlert(guild.id, g.appid, dealSize(g));
  return true;
}

/** A page of what's on sale, everything or only what one person wants or wishlisted, with buttons to turn pages */
export async function salesPage(guild: Guild, wanted: number, mine: string | null) {
  const all = await onSale(guild);
  const games = mine ? all.filter((g) => g.wanted.includes(mine) || g.wishlisted.includes(mine)) : all;
  if (!games.length) {
    const content = mine ? 'Nothing you want or have on your Steam wishlist is on sale right now.' : 'Nothing this server plays or wants is on sale right now.';
    return { content, embeds: [], components: [] };
  }
  const info = appInfo();
  const pages = paginate(games.map((g) => saleLine(g, saleName(g, info))), LIST_CHARS);
  const page = Math.min(Math.max(wanted, 0), pages.length - 1);
  const title = `💸 ${plural(games.length, 'game')} on sale${mine ? ' that you want' : ''}`;
  const embed = new EmbedBuilder().setTitle(title).setDescription(pages[page].join('\n')).setColor(0x57f287);
  if (pages.length === 1) return { content: '', embeds: [embed], components: [] };
  embed.setFooter({ text: `Page ${page + 1} of ${pages.length}` });
  const turn = (target: number, emoji: string) =>
    new ButtonBuilder()
      .setCustomId(`sales:page:${target}:${mine ?? ''}`)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(target < 0 || target >= pages.length);
  return { content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(turn(page - 1, '◀️'), turn(page + 1, '▶️'))] };
}

export const sales: Feature = {
  title: 'Sale alerts',
  componentPrefix: 'sales',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('sales')
        .setDescription('Show what this server plays or wants that’s on sale')
        .addBooleanOption((o) => o.setName('mine').setDescription('Only games you want or have on your Steam wishlist')),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        await i.deferReply();
        return i.editReply({ ...(await salesPage(i.guild, 0, i.options.getBoolean('mine') ? i.user.id : null)), allowedMentions: { parse: [] } });
      },
    },
  ],
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    const [, action, page, mine] = i.customId.split(':');
    if (action === 'show') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      return i.editReply({ ...(await salesPage(i.guild, 0, page === 'mine' ? i.user.id : null)), allowedMentions: { parse: [] } });
    }
    if (action !== 'page') return;
    // Working out the list again can take a moment
    await i.deferUpdate();
    return i.editReply({ ...(await salesPage(i.guild, Number(page), mine || null)), allowedMentions: { parse: [] } });
  },
  setup(client) {
    // Through the day, prices are kept current for /sales and the web UI; posting waits for each server's hour
    every('Sale check', config.saleCheckHours * 3_600_000, () => checkSales(client, false), { first: 60_000 });
    every('Daily sale post', 10 * 60_000, () => postDailySales(client));
  },
};
