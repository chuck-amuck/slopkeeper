import { EmbedBuilder, SlashCommandBuilder, type Client } from 'discord.js';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, servedGuilds } from '../util.ts';

// GamerPower tracks free-to-keep games; this asks for full games only, not DLC, betas or loot
const FEED = 'https://www.gamerpower.com/api/filter?platform=steam.epic-games-store.gog&type=game';
const CHECK_EVERY = 3 * 3_600_000;
/** Most posts per server per check, so a newly enabled server isn't flooded */
const MAX_POSTS = 5;

export interface Giveaway {
  id: number;
  title: string;
  worth: string;
  image: string;
  description: string;
  url: string;
  platforms: string;
  endDate: string | null;
}

/** Turns the feed into giveaways; it sends an object instead of an array when nothing is running */
export function parseFeed(body: unknown): Giveaway[] {
  if (!Array.isArray(body)) return [];
  return body
    .filter((g) => g.status === 'Active')
    .map((g) => ({
      id: Number(g.id),
      title: String(g.title).replace(/\s+Giveaway$/i, '').replace(/\s*\((Steam|Epic Games|GOG)\)/i, ''),
      worth: g.worth === 'N/A' ? '' : String(g.worth),
      image: String(g.image),
      description: String(g.description),
      url: String(g.open_giveaway_url),
      platforms: String(g.platforms).replace(/^PC,\s*/, ''),
      endDate: g.end_date && g.end_date !== 'N/A' ? String(g.end_date) : null,
    }));
}

let cache: { at: number; giveaways: Giveaway[] } | null = null;

async function current(): Promise<Giveaway[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.giveaways;
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`GamerPower: HTTP ${res.status}`);
  cache = { at: Date.now(), giveaways: parseFeed(await res.json()) };
  return cache.giveaways;
}

function embed(g: Giveaway): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(`🎁 Free: ${g.title}`)
    .setURL(g.url)
    .setDescription(g.description.length > 300 ? `${g.description.slice(0, 297)}…` : g.description)
    .setImage(g.image)
    .setColor(0x57f287)
    .addFields({ name: 'Where', value: g.platforms, inline: true });
  if (g.worth) e.addFields({ name: 'Normally', value: g.worth, inline: true });
  // The feed's end dates have no time zone, so only the day is shown
  if (g.endDate) e.addFields({ name: 'Free until', value: new Date(`${g.endDate.slice(0, 10)}T12:00:00Z`).toDateString().slice(4), inline: true });
  return e;
}

async function check(client: Client<true>) {
  const giveaways = await current();
  const posted = db.prepare('SELECT 1 FROM free_game_posts WHERE guild_id = ? AND giveaway_id = ?');
  const markPosted = db.prepare('INSERT OR IGNORE INTO free_game_posts (guild_id, giveaway_id) VALUES (?, ?)');
  for (const guild of servedGuilds(client)) {
    if (!setting(guild.id, 'freeGames')) continue;
    const fresh = giveaways.filter((g) => !posted.get(guild.id, g.id)).slice(0, MAX_POSTS);
    if (!fresh.length) continue;
    const out = await announceChannel(client, guild.id);
    if (!out) continue;
    for (const g of fresh) {
      await out.send({ embeds: [embed(g)] });
      markPosted.run(guild.id, g.id);
    }
  }
}

export const freeGames: Feature = {
  title: 'Free games',
  commands: [
    {
      data: new SlashCommandBuilder().setName('freegames').setDescription('Games that are free to keep right now on Steam, Epic and GOG'),
      async run(i) {
        await i.deferReply();
        const giveaways = await current();
        if (!giveaways.length) return i.editReply('Nothing is free to keep right now.');
        return i.editReply({ embeds: giveaways.slice(0, 10).map(embed) });
      },
    },
  ],
  setup(client) {
    const run = () => void check(client).catch(console.error);
    run();
    setInterval(run, CHECK_EVERY);
  },
};
