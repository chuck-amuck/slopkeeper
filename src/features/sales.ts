import type { Client, Guild } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.ts';
import { db } from '../db.ts';
import type { Feature } from '../types.ts';
import { announceChannel, servedGuilds } from '../util.ts';
import { allGames, groupMembers, ownersOf } from './games.ts';

interface PriceOverview {
  discount_percent: number;
  initial_formatted: string;
  final_formatted: string;
}

async function fetchPrice(appid: number): Promise<PriceOverview | null> {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${config.steamCountry}&filters=price_overview`);
  if (!res.ok) throw new Error(`Steam appdetails ${appid}: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, { success: boolean; data?: { price_overview?: PriceOverview } | [] }>;
  const entry = body[String(appid)];
  // Free or unreleased games come back with data: []
  if (!entry?.success || !entry.data || Array.isArray(entry.data)) return null;
  return entry.data.price_overview ?? null;
}

async function checkSales(client: Client<true>) {
  // Several servers can have the same game; ask Steam once per check
  const prices = new Map<number, PriceOverview | null | undefined>();
  for (const guild of servedGuilds(client)) await checkGuild(client, guild, prices);
}

async function checkGuild(client: Client<true>, guild: Guild, prices: Map<number, PriceOverview | null | undefined>) {
  const out = await announceChannel(client, guild.id);
  if (!out) return;
  const group = groupMembers(guild);
  for (const game of allGames(guild.id)) {
    if (game.steam_appid === null) continue;
    const owners = ownersOf(game, guild);
    const needers = group.filter((id) => !owners.has(id));
    if (group.length && !needers.length) continue; // everyone already has it

    if (!prices.has(game.steam_appid)) {
      prices.set(game.steam_appid, await fetchPrice(game.steam_appid).catch((err) => (console.error(err), undefined)));
      await sleep(1500); // stay well under Steam's store API rate limit
    }
    const price = prices.get(game.steam_appid);
    if (price === undefined) continue;

    const discount = price?.discount_percent ?? 0;
    const prev = (db.prepare('SELECT discount FROM sale_state WHERE game_id = ?').get(game.id) as { discount: number } | undefined)?.discount ?? 0;
    db.prepare('INSERT INTO sale_state (game_id, discount) VALUES (?, ?) ON CONFLICT(game_id) DO UPDATE SET discount = excluded.discount').run(
      game.id,
      discount,
    );
    // Only announce new or deeper sales, not every check while a sale is running
    if (!price || discount <= prev) continue;

    let text = `💸 **${game.name}** is **${discount}% off**: ~~${price.initial_formatted}~~ **${price.final_formatted}**`;
    if (needers.length) text += `\nStill need it: ${needers.map((id) => `<@${id}>`).join(' ')}`;
    text += `\nhttps://store.steampowered.com/app/${game.steam_appid}`;
    await out.send({ content: text, allowedMentions: { users: needers } });
  }
}

export const sales: Feature = {
  setup(client) {
    const run = () => void checkSales(client).catch(console.error);
    setTimeout(run, 60_000);
    setInterval(run, config.saleCheckHours * 3_600_000);
  },
};
