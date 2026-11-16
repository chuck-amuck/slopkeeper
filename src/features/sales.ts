import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, MessageFlags, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
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

const PLAYED_DAYS = 180;
// A sale that only gets a little deeper isn't worth another post
const DEEPER_BY = 10;
const PRICE_BATCH = 50;
const POSTED_GAMES = 10;
const NAMED_PEOPLE = 5;
// Message text stops at 2000 characters, and a post can name at most 100 people to ping
const MAX_PINGS = 80;
const LIST_CHARS = 4000; // embed descriptions stop at 4096
const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0/games';
const GG_DEALS = 'https://api.gg.deals/v1/prices/by-steam-app-id/';
const GG_DEALS_BATCH = 100;
// It turns away requests that don't say who they're from
const USER_AGENT = 'slopkeeper (https://github.com/chuck-amuck/slopkeeper)';

// Stay well under what Steam's store API and CheapShark will take
export const pauses = { steamMs: 1500, cheapSharkMs: 500, ggDealsMs: 1000 };

interface PriceOverview {
  currency: string;
  discount_percent: number;
  initial_formatted: string;
  final_formatted: string;
  /** in cents */
  initial: number;
  final: number;
}

/** The cheapest official store, Steam included, from gg.deals. Key shops are left out: they can't say whether a deal is a Steam key or an account, or where it works */
interface StorePrice {
  /** in cents of `currency` */
  now: number;
  /** null when gg.deals has no history, or when this is the last check's price because gg.deals couldn't be asked */
  lowest: number | null;
  currency: string;
  url: string;
}

/**
 * One check's prices, by region and app, shared by every server. Undefined means Steam couldn't be asked, null that
 * it isn't sold there. An app missing from `stores` wasn't asked about other stores. `before` is what Steam charged
 * at the last check, read before this one writes anything
 */
interface Prices {
  steam: Map<string, PriceOverview | null | undefined>;
  stores: Map<string, StorePrice | null>;
  before: Map<string, { discount: number; final: number } | undefined>;
}

const newPrices = (): Prices => ({ steam: new Map(), stores: new Map(), before: new Map() });

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

async function fetchStorePrices(appids: number[], region: string) {
  const query = new URLSearchParams({ ids: appids.join(','), region, key: config.ggDealsKey! });
  const res = await fetch(`${GG_DEALS}?${query}`, { headers: { 'user-agent': USER_AGENT }, signal: requestTimeout() });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: Record<string, { url: string; prices: { currentRetail: string | null; historicalRetail: string | null; currency: string } } | null> & { message?: string };
  } | null;
  if (!res.ok || !body?.success || !body.data) {
    const message = body?.data?.message ?? (body as { message?: string } | null)?.message;
    throw new Error(`gg.deals: HTTP ${res.status}${message ? `, ${message}` : ''}`);
  }
  const data = body.data;
  return new Map(
    appids.map((appid): [number, StorePrice | null] => {
      const game = data[String(appid)];
      const now = game?.prices.currentRetail == null ? NaN : cents(game.prices.currentRetail);
      if (!game || !Number.isFinite(now)) return [appid, null];
      const lowest = game.prices.historicalRetail == null ? NaN : cents(game.prices.historicalRetail);
      return [appid, { now, lowest: Number.isFinite(lowest) ? lowest : null, currency: game.prices.currency, url: game.url }];
    }),
  );
}

/** gg.deals turns away some regions, so they aren't asked again until the bot restarts */
const storeRegionsRefused = new Set<string>();

/** Another store selling it for less than Steam does now, in the same money, and how far under Steam's normal price */
export function storeDeal(steam: PriceOverview | null, store: StorePrice | null | undefined) {
  if (!steam || !store || store.currency !== steam.currency || store.now >= steam.final) return null;
  const normal = steam.discount_percent ? steam.initial : steam.final;
  const off = normal ? Math.round((1 - store.now / normal) * 100) : 0;
  return off >= 1 ? { cents: store.now, off, url: store.url } : null;
}

const steamNormal = (price: PriceOverview) => (price.discount_percent ? price.initial_formatted : price.final_formatted);

/** A row means it's on sale on Steam, or cheaper on another store than on Steam */
function rememberPrice(country: string, appid: number, price: PriceOverview | null, store: StorePrice | null) {
  const deal = storeDeal(price, store);
  if (!price || (!price.discount_percent && !deal)) db.prepare('DELETE FROM sale_prices WHERE country = ? AND appid = ?').run(country, appid);
  else {
    db.prepare(
      'INSERT OR REPLACE INTO sale_prices (country, appid, discount, was, price, final, store, store_off, store_url, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(country, appid, price.discount_percent, steamNormal(price), price.final_formatted, price.final, deal?.cents ?? null, deal?.off ?? null, deal?.url ?? null, price.currency);
  }
}

/** The other store's price the last check kept, standing in while gg.deals can't be asked, so its deal isn't mistaken for a new one */
function lastStore(country: string, appid: number): StorePrice | null {
  const row = db.prepare('SELECT store, store_url, currency FROM sale_prices WHERE country = ? AND appid = ?').get(country, appid) as
    | { store: number | null; store_url: string | null; currency: string | null }
    | undefined;
  return row?.store != null && row.store_url && row.currency ? { now: row.store, lowest: null, currency: row.currency, url: row.store_url } : null;
}

/**
 * gg.deals' cheapest price counts Steam's own, and can lag behind it. Steam's sale ending at the price gg.deals still
 * has as the cheapest is that lag, not another store
 */
function staleSteam(before: { discount: number; final: number } | undefined, price: PriceOverview | null | undefined, store: StorePrice | null) {
  return !!(before?.discount && store && price && !price.discount_percent && store.now === before.final);
}

/**
 * Several servers can watch the same game, so each region's prices are only fetched once a check. Other stores are
 * only asked about when a server in that region wants them and there's a gg.deals key
 */
async function loadPrices(appids: number[], country: string, prices: Prices, otherStores: boolean) {
  const key = (appid: number) => `${country}:${appid}`;
  const fetched = new Set<number>();
  const missing = appids.filter((appid) => !prices.steam.has(key(appid)));
  for (const appid of missing) {
    const row = db.prepare('SELECT discount, final FROM sale_prices WHERE country = ? AND appid = ?').get(country, appid) as { discount: number; final: number } | undefined;
    prices.before.set(key(appid), row && { ...row });
  }
  for (let idx = 0; idx < missing.length; idx += PRICE_BATCH) {
    const chunk = missing.slice(idx, idx + PRICE_BATCH);
    const found = await fetchPrices(chunk, country).catch((err) => (console.error(err), null));
    for (const appid of chunk) prices.steam.set(key(appid), found ? (found.get(appid) ?? null) : undefined);
    if (found) for (const appid of chunk) fetched.add(appid);
    await sleep(pauses.steamMs);
  }

  const askStores = otherStores && !!config.ggDealsKey && !storeRegionsRefused.has(country);
  const unasked = askStores ? appids.filter((appid) => prices.steam.get(key(appid)) && !prices.stores.has(key(appid))) : [];
  for (let idx = 0; idx < unasked.length; idx += GG_DEALS_BATCH) {
    const chunk = unasked.slice(idx, idx + GG_DEALS_BATCH);
    const found = storeRegionsRefused.has(country)
      ? null
      : await fetchStorePrices(chunk, country).catch((err: Error) => {
          console.error(err);
          if (/unsupported region/i.test(err.message)) storeRegionsRefused.add(country);
          return null;
        });
    for (const appid of chunk) {
      const store = found ? (found.get(appid) ?? null) : lastStore(country, appid);
      prices.stores.set(key(appid), staleSteam(prices.before.get(key(appid)), prices.steam.get(key(appid)), store) ? null : store);
      fetched.add(appid);
    }
    if (found) await sleep(pauses.ggDealsMs);
  }

  // Written once both are known, so another server asking for other stores later in the check fills them in
  for (const appid of fetched) {
    const price = prices.steam.get(key(appid));
    if (price !== undefined) rememberPrice(country, appid, price, prices.stores.get(key(appid)) ?? null);
  }
}

/** The lowest price on any store, in cents of a US dollar */
async function lowestEver(appid: number) {
  const ask = async (query: string) => {
    const res = await fetch(`${CHEAPSHARK}?${query}`, { headers: { 'user-agent': USER_AGENT }, signal: requestTimeout() });
    if (!res.ok) throw new Error(`CheapShark: HTTP ${res.status}`);
    return (await res.json()) as any;
  };
  const [listing] = (await ask(`steamAppID=${appid}`)) as { gameID: string }[];
  if (!listing) return null;
  const { cheapestPriceEver } = (await ask(`id=${listing.gameID}`)) as { cheapestPriceEver?: { price: string } };
  return Math.round(Number(cheapestPriceEver?.price) * 100) || null;
}

/** gg.deals knows every region's lowest price. Without it, CheapShark only knows US dollars, and a post doesn't need it, so anything else leaves it out */
async function priceHistory(g: Sale, country: string, store: StorePrice | null | undefined) {
  const now = g.store?.cents ?? g.final;
  if (store?.lowest != null && store.currency === g.currency) return now <= store.lowest ? 'Lowest price yet.' : `Lowest ever ${money(store.lowest, store.currency)}.`;
  if (country !== 'us') return null;
  const lowest = await lowestEver(g.appid).catch((err) => (console.error(err), null));
  await sleep(pauses.cheapSharkMs);
  if (lowest === null) return null;
  return now <= lowest ? 'Lowest price yet.' : `Lowest ever $${(lowest / 100).toFixed(2)}.`;
}

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
  /** Another store selling it for less than Steam: its price, how far under Steam's normal price, and gg.deals' page listing the stores */
  store: { price: string; cents: number; off: number; url: string } | null;
}

/** How far under Steam's normal price the best deal is, which is what's compared with the smallest sale worth posting */
export const dealSize = (g: Pick<Sale, 'discount' | 'store'>) => Math.max(g.discount, g.store?.off ?? 0);

/** The deal in words: Steam's sale, or another store's price with Steam's beside it */
export function dealText(g: Pick<Sale, 'discount' | 'was' | 'price' | 'store'>, link = (text: string, _url: string) => text) {
  if (!g.store) return `${g.discount}% off, ${g.price}, was ${g.was}.`;
  const steam = g.discount ? ` Steam has it at ${g.discount}% off, ${g.price}.` : '';
  return `${g.store.price} ${link('on another store', g.store.url)}, ${g.store.off}% under Steam’s ${g.was}.${steam}`;
}

/** Why a game is worth mentioning, naming people however the reader sees them */
export function saleReasons(g: Sale, show: (id: string) => string) {
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
  const rows = db.prepare('SELECT appid, discount, was, price, final, currency, store, store_off, store_url FROM sale_prices WHERE country = ?').all(setting(guildId, 'steamCountry')) as {
    appid: number;
    discount: number;
    was: string;
    price: string;
    final: number;
    currency: string | null;
    store: number | null;
    store_off: number | null;
    store_url: string | null;
  }[];
  const otherStores = setting(guildId, 'saleOtherStores');
  return new Map(
    rows.flatMap(({ store, store_off, store_url, currency, ...r }) => {
      const deal = otherStores && store !== null && store_off !== null && store_url && currency ? { price: money(store, currency), cents: store, off: store_off, url: store_url } : null;
      return deal || r.discount ? [[r.appid, { ...r, currency: currency ?? '', store: deal }] as const] : [];
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

export async function checkSales(client: Client<true>) {
  await refreshWishlists();
  const prices = newPrices();
  await eachGuild(client, 'Sale check', (guild) => checkGuild(client, guild, prices));
}

async function checkGuild(client: Client<true>, guild: Guild, prices: Prices) {
  const out = (await announceChannel(client, guild.id, 'saleChannel')) ?? (await announceChannel(client, guild.id));
  if (!out) return;
  await refreshStale(groupMembers(guild), config.saleCheckHours * 3_600_000);
  const country = setting(guild.id, 'steamCountry');
  const lowestDiscount = setting(guild.id, 'saleMinDiscount');
  const otherStores = setting(guild.id, 'saleOtherStores');
  const games = await watched(guild);
  await loadPrices(games.map((g) => g.appid), country, prices, otherStores);

  const due: Sale[] = [];
  for (const g of games.sort(byInterest)) {
    const key = `${country}:${g.appid}`;
    const price = prices.steam.get(key);
    const store = otherStores ? (prices.stores.get(key) ?? null) : null;
    if (price === undefined) continue;
    const deal = storeDeal(price, store);
    const sale = price && {
      discount: price.discount_percent,
      was: steamNormal(price),
      price: price.final_formatted,
      final: price.final,
      currency: price.currency,
      store: deal && { ...deal, price: money(deal.cents, price.currency) },
    };
    const size = sale ? dealSize(sale) : 0;
    const last = alerted(guild.id, g.appid);
    // Only new or much deeper sales, not every check while one is running. Remembering a smaller one means the next is news
    if (size <= last) rememberAlert(guild.id, g.appid, size);
    else if (sale && size >= lowestDiscount && (!last || size >= last + DEEPER_BY)) due.push({ ...g, ...sale });
  }
  if (!due.length) return;

  // Wishlisted games only have a name once they're asked about
  await ensureAppInfo(due.map((g) => g.appid)).catch(console.error);
  const info = appInfo();
  const lines: string[] = [];
  for (const g of due.slice(0, POSTED_GAMES)) lines.push(saleLine(g, saleName(g, info), await priceHistory(g, country, otherStores ? prices.stores.get(`${country}:${g.appid}`) : null)));
  if (due.length > POSTED_GAMES) lines.push(`and ${due.length - POSTED_GAMES} more: ${commandMention(guild.id, 'sales')}`);

  const pings = [...new Set(due.flatMap((g) => [...g.wanted, ...g.wishlisted, ...g.others]))].slice(0, MAX_PINGS);
  await out.send({
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
    const run = () => void checkSales(client).catch(console.error);
    setTimeout(run, 60_000);
    setInterval(run, config.saleCheckHours * 3_600_000);
  },
};
