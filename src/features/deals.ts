// The bundles for the web UI's Deals tab: the running ones with a game a server wants or plays something like, worked
// out at each price check and kept, so the page shows them without asking IsThereAnyDeal. Its sales come from the
// stored prices, and its free games from the free game check's list

import type { Client, Guild } from 'discord.js';
import { feeds } from '../changes.ts';
import { config } from '../config.ts';
import { getKv, setKv } from '../db.ts';
import { every } from '../schedule.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { eachGuild } from '../util.ts';
import { currentBundles, matches, playsTogether, running, tierPlace, tierPrice, type Bundle } from './bundles.ts';
import { taste } from './freegames.ts';
import { watched, type Watched } from './sales.ts';

// As often as prices are checked: bundles start and end a few times a week
const REFRESH_MS = config.saleCheckHours * 3_600_000;
const matchesKey = (guildId: string) => `deal_bundles:${guildId}`;

/** A bundle with games for this server, as the Deals tab shows it */
export interface DealBundle {
  id: number;
  title: string;
  site: string;
  url: string;
  expiry: string | null;
  /** its cheapest tier, or null when that's pay what you want */
  from: string | null;
  games: {
    title: string;
    appid: number;
    /** "in the $10.00 tier", "for $5.00" or "for any price" */
    where: string;
    /** who here wants it and why, or null when it's only like what the server plays */
    wanted: Watched | null;
    /** for a game like what the server plays, which one and the tags they share */
    like: string | null;
  }[];
}


const read = <T>(key: string): { at: number; value: T } | null => {
  try {
    const kept = getKv(key);
    return kept ? (JSON.parse(kept) as { at: number; value: T }) : null;
  } catch {
    return null;
  }
};

/**
 * Works out which running bundles have games for a server, and keeps that for the page. `regions` holds the bundle
 * lists already asked for in this run, so each region is asked once
 */
export async function refreshDealBundles(guild: Guild, regions = new Map<string, Promise<Bundle[]>>()) {
  // A server that turned bundles off isn't shown them, so there's nothing to work out
  if (!setting(guild.id, 'bundleAlerts')) return;
  const country = setting(guild.id, 'steamCountry');
  if (!regions.has(country)) regions.set(country, currentBundles(country));
  const bundles = await regions.get(country)!;
  const interested = new Map((await watched(guild)).map((g) => [g.appid, g]));
  const theirs = setting(guild.id, 'bundlesLikeWePlay') ? await taste(guild.id) : null;
  const together = await playsTogether(theirs);
  const found: DealBundle[] = [];
  for (const bundle of bundles) {
    const games = await matches(guild, bundle, interested, theirs, together);
    if (!games.length) continue;
    found.push({
      id: bundle.id,
      title: bundle.title,
      site: bundle.site,
      url: bundle.url,
      expiry: bundle.expiry,
      from: tierPrice(bundle, 0),
      games: games.map((m) => ({ title: m.title, appid: m.appid, where: tierPlace(bundle, m.tier), wanted: m.wanted, like: m.wanted ? null : m.reason })),
    });
  }
  setKv(matchesKey(guild.id), JSON.stringify({ at: Date.now(), value: found }));
}

/** The bundles with games for a server, as last worked out, without the ones that have ended since. Null if never */
export function dealBundles(guildId: string): { at: number; bundles: DealBundle[] } | null {
  const kept = read<DealBundle[]>(matchesKey(guildId));
  return kept && { at: kept.at, bundles: kept.value.filter(running) };
}

export const deals: Feature = {
  setup(client: Client<true>) {
    if (!config.itadKey) return;
    // After the first price check, so what's watched is known
    every(
      'Deal bundles',
      REFRESH_MS,
      async () => {
        const regions = new Map<string, Promise<Bundle[]>>();
        await eachGuild(client, 'Deal bundles', (guild) => refreshDealBundles(guild, regions));
        feeds.deals.changedEverywhere();
      },
      { first: 5 * 60_000, now: false },
    );
  },
};
