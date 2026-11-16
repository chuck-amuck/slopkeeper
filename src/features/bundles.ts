import { EmbedBuilder, escapeMarkdown, type Client, type Guild } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild } from '../util.ts';
import { factsFor } from './gamefacts.ts';
import { everyoneOwns, MULTIPLAYER_TAGS, taste, tasteTags, type Taste } from './freegames.ts';
import { short } from './gamestats.ts';
import { itad, money, pauses, saleReasons, storeUrl, watched, type Watched } from './sales.ts';

// Humble Bundle, Fanatical and Green Man Gaming (listed under two names), by IsThereAnyDeal's ids for bundle sites.
// They sell Steam keys; the rest, like itch.io, mostly don't
const SITES = new Set([1, 8, 47, 73]);
// It sends at most this many bundles at a time. A few dozen run at once, so more pages than this means something's wrong
const PAGE = 50;
const MAX_PAGES = 10;
/** A bundle game has to share this many Steam tags with one game a server plays a lot to count as like it */
const SHARED_TAGS = 4;
/** Steam's names for much the same thing, which would otherwise count as several tags in common */
const SAME_TAG = new Map(['Rogue-like', 'Rogue-lite', 'Roguelite', 'Action Roguelike', 'Action Roguelite', 'Traditional Roguelike'].map((tag) => [tag, 'Roguelike']));
const LISTED_GAMES = 10;
/** Most bundle posts per server per check, so turning it on doesn't flood the channel */
const MAX_POSTS = 3;
const FIRST_CHECK_MS = 5 * 60_000;
// A message can name at most 100 people, and its text stops at 2000 characters
const MAX_PINGS = 80;
// Long after any bundle has ended
const FORGET_POSTS_MS = 365 * 86_400_000;

export interface Bundle {
  id: number;
  title: string;
  site: string;
  url: string;
  /** ISO time, or null when it has no end */
  expiry: string | null;
  /** cheapest first. A tier with no price is pay what you want */
  tiers: { cents: number | null; currency: string; games: string[] }[];
}

interface ItadBundle {
  id: number;
  title: string;
  page: { id: number; name: string };
  url: string;
  expiry: string | null;
  tiers: { price: { amountInt: number; currency: string } | null; games: { title: string; type: string | null }[] }[];
}

/** Every bundle running now on the sites above, priced in this region's money */
export async function currentBundles(country: string): Promise<Bundle[]> {
  const all: ItadBundle[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = (await itad('/bundles/v1', { country: country.toUpperCase(), limit: String(PAGE), offset: String(n * PAGE) })) as ItadBundle[];
    all.push(...page);
    if (page.length < PAGE) break;
    await sleep(pauses.itadMs);
  }
  // Green Man Gaming is listed under two names, which could carry the same bundle twice
  const seen = new Set<string>();
  return all
    .filter((b) => SITES.has(b.page.id) && (!b.expiry || Date.parse(b.expiry) > Date.now()))
    .filter((b) => {
      const key = b.title.trim().toLowerCase();
      return !seen.has(key) && !!seen.add(key);
    })
    .map((b) => ({
      id: b.id,
      title: b.title.trim(),
      site: b.page.name.replace('GreenMan Gaming', 'GreenManGaming').replace('GreenManGaming', 'Green Man Gaming'),
      url: b.url,
      expiry: b.expiry,
      tiers: b.tiers
        .map((t) => ({
          cents: t.price?.amountInt ?? null,
          currency: t.price?.currency ?? '',
          // DLC and soundtracks say nothing about what a server wants
          games: t.games.filter((g) => g.type === 'game').map((g) => g.title),
        }))
        .sort((a, b) => (a.cents ?? 0) - (b.cents ?? 0)),
    }));
}

/** The played game a bundle game is most like, if they share enough tags */
const sameTags = (tags: string[]) => [...new Set(tags.map((tag) => SAME_TAG.get(tag) ?? tag))];

export function likeWhatWePlay(tags: string[], theirs: Taste) {
  if (!theirs) return null;
  let best: { name: string; shared: string[] } | null = null;
  const own = sameTags(tags);
  for (const game of theirs.games) {
    const played = sameTags(game.tags);
    const shared = own.filter((tag) => played.includes(tag));
    if (shared.length >= SHARED_TAGS && shared.length > (best?.shared.length ?? 0)) best = { name: game.name, shared };
  }
  return best && `Like ${best.name} (${best.shared.slice(0, SHARED_TAGS).join(', ')})`;
}

interface Match {
  title: string;
  appid: number;
  /** the cheapest tier that has it */
  tier: number;
  /** someone here wants it, or null when it's only like what the server plays */
  wanted: Watched | null;
  reason: string;
}

const multiplayer = (tags: string[]) => tags.some((tag) => MULTIPLAYER_TAGS.has(tag));

/** Whether most of what a server plays most is multiplayer, so a game like it should be too */
export async function playsTogether(theirs: Taste) {
  if (!theirs) return false;
  let together = 0;
  for (const { name } of theirs.games) if (multiplayer((await factsFor(name).catch(() => null))?.tags ?? [])) together++;
  return together * 2 > theirs.games.length;
}

/**
 * The games in a bundle worth telling this server about: ones it wants first, then ones like what it plays, which
 * have to be multiplayer too when most of what it plays is
 */
export async function matches(guild: Guild, bundle: Bundle, interested: Map<number, Watched>, theirs: Taste, together = false): Promise<Match[]> {
  const hidden = new Set((db.prepare('SELECT appid FROM hidden_apps WHERE guild_id = ?').all(guild.id) as { appid: number }[]).map((r) => r.appid));
  const found: Match[] = [];
  const seen = new Set<string>();
  for (const [tier, { games }] of bundle.tiers.entries()) {
    for (const title of games) {
      if (seen.has(title)) continue;
      seen.add(title);
      const facts = await factsFor(title).catch((err) => (console.error(err), null));
      if (!facts?.appid) continue;
      const wanted = interested.get(facts.appid);
      if (wanted) {
        found.push({ title, appid: facts.appid, tier, wanted, reason: saleReasons(wanted, (id) => `<@${id}>`) });
        continue;
      }
      if (!theirs || hidden.has(facts.appid) || (together && !multiplayer(facts.tags)) || everyoneOwns(guild, facts.appid)) continue;
      const like = likeWhatWePlay(tasteTags(facts), theirs);
      if (like) found.push({ title, appid: facts.appid, tier, wanted: null, reason: like });
    }
  }
  return found.sort((a, b) => Number(!!b.wanted) - Number(!!a.wanted));
}

const tierPrice = (bundle: Bundle, tier: number) => {
  const { cents, currency } = bundle.tiers[tier];
  return cents === null ? null : money(cents, currency);
};

export function bundlePost(bundle: Bundle, found: Match[]) {
  const where = (m: Match) => {
    const price = tierPrice(bundle, m.tier);
    if (price === null) return 'for any price';
    return bundle.tiers.length > 1 ? `in the ${price} tier` : `for ${price}`;
  };
  const from = tierPrice(bundle, 0);
  const lines = found.slice(0, LISTED_GAMES).map((m) => `[**${escapeMarkdown(short(m.title)).replace(/[[\]]/g, '')}**](${storeUrl(m.appid)}) ${where(m)}: ${m.reason}`);
  if (found.length > LISTED_GAMES) lines.push(`and ${found.length - LISTED_GAMES} more`);
  if (bundle.expiry) lines.push('', `Ends <t:${Math.floor(Date.parse(bundle.expiry) / 1000)}:R>`);
  const pings = [...new Set(found.flatMap((m) => (m.wanted ? [...m.wanted.wanted, ...m.wanted.wishlisted] : [])))].slice(0, MAX_PINGS);
  return {
    content: pings.map((id) => `<@${id}>`).join(' ') || undefined,
    embeds: [
      new EmbedBuilder()
        .setTitle(`📦 ${bundle.title}`.slice(0, 256))
        .setURL(bundle.url)
        .setDescription(lines.join('\n'))
        .setFooter({ text: from === null ? bundle.site : `${bundle.site} · from ${from}` })
        .setColor(0xf4900c),
    ],
    allowedMentions: { users: pings },
  };
}

export async function checkBundles(client: Client<true>) {
  if (!config.itadKey) return;
  const byRegion = new Map<string, Promise<Bundle[]>>();
  const posted = db.prepare('SELECT 1 FROM bundle_posts WHERE guild_id = ? AND bundle_id = ?');
  const markPosted = db.prepare('INSERT OR IGNORE INTO bundle_posts (guild_id, bundle_id, posted_at) VALUES (?, ?, ?)');
  db.prepare('DELETE FROM bundle_posts WHERE posted_at < ?').run(Date.now() - FORGET_POSTS_MS);
  await eachGuild(client, 'Bundle check', async (guild) => {
    if (!setting(guild.id, 'bundleAlerts')) return;
    const country = setting(guild.id, 'steamCountry');
    if (!byRegion.has(country)) byRegion.set(country, currentBundles(country));
    const fresh = (await byRegion.get(country)!).filter((b) => !posted.get(guild.id, b.id));
    if (!fresh.length) return;
    const out = (await announceChannel(client, guild.id, 'saleChannel')) ?? (await announceChannel(client, guild.id));
    if (!out) return;
    const interested = new Map((await watched(guild)).map((g) => [g.appid, g]));
    const theirs = setting(guild.id, 'bundlesLikeWePlay') ? await taste(guild.id) : null;
    const together = await playsTogether(theirs);
    let sent = 0;
    for (const bundle of fresh) {
      if (sent === MAX_POSTS) return;
      // Left unmarked when nothing matches, so someone wanting one of its games later still hears about it
      const found = await matches(guild, bundle, interested, theirs, together);
      if (!found.length) continue;
      await out.send(bundlePost(bundle, found));
      markPosted.run(guild.id, bundle.id, Date.now());
      sent++;
    }
  });
}

export const bundles: Feature = {
  setup(client) {
    const run = () => void checkBundles(client).catch(console.error);
    setTimeout(run, FIRST_CHECK_MS);
    setInterval(run, config.saleCheckHours * 3_600_000);
  },
};
