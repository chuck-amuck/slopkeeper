import { EmbedBuilder, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild, requestTimeout } from '../util.ts';
import { factsFor, type GameFacts } from './gamefacts.ts';
import { stats } from './gamestats.ts';

// GamerPower tracks free-to-keep games; this asks for full games only, not DLC, betas or loot
const FEED = 'https://www.gamerpower.com/api/filter?platform=steam.epic-games-store.gog&type=game';
const CHECK_EVERY = 3 * 3_600_000;
/** Most posts per server per check, so a newly enabled server isn't flooded */
const MAX_POSTS = 5;
const MIN_REVIEWS = 50;
const TASTE_DAYS = 180;
const TASTE_GAMES = 10;
const TASTE_TAGS = 15;
/** Fewer known games than this says too little about what a server likes */
const TASTE_MIN_GAMES = 3;
const GAME_TAGS = 8;
const SHARED_TAGS = 2;
const MULTIPLAYER_TAGS = new Set(['Multiplayer', 'Online Co-Op', 'Co-op', 'Local Co-Op', 'Local Multiplayer', 'PvP', 'Online PvP', 'Massively Multiplayer', 'MMORPG']);
/** On so many games that sharing them says nothing about taste */
const GENERIC_TAGS = new Set([...MULTIPLAYER_TAGS, 'Singleplayer', 'Indie', 'Early Access', 'Casual', 'Free to Play', 'Action', 'Adventure', 'Great Soundtrack', 'Atmospheric', 'Funny', '2D', '3D', 'Family Friendly', 'Controller']);

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
      title: String(g.title).replace(/\s+Giveaways?$/i, '').replace(/\s*\((Steam|Epic Games|GOG)\)(\s+Key)?/i, '').replace(/\s+Steam Key$/i, ''),
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
  const res = await fetch(FEED, { signal: requestTimeout() });
  if (!res.ok) throw new Error(`GamerPower: HTTP ${res.status}`);
  cache = { at: Date.now(), giveaways: parseFeed(await res.json()) };
  return cache.giveaways;
}

const tasteTags = (facts: GameFacts) => facts.tags.filter((tag) => !GENERIC_TAGS.has(tag)).slice(0, GAME_TAGS);

/** The tags of what a server plays most, or null if too few of its games are on Steam to tell */
export async function taste(guildId: string) {
  const played = stats(guildId, Date.now() - TASTE_DAYS * 86_400_000, 'none', 'game').slice(0, TASTE_GAMES);
  const games: { name: string; tags: string[] }[] = [];
  for (const { key } of played) {
    const tags = tasteTags(await factsFor(key));
    if (tags.length) games.push({ name: key, tags });
  }
  if (games.length < TASTE_MIN_GAMES) return null;
  const counts = new Map<string, number>();
  for (const { tags } of games) for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  // Sorting is stable, so ties go to the tag from the most played game
  return { games, tags: new Set([...counts].sort((a, b) => b[1] - a[1]).slice(0, TASTE_TAGS).map(([tag]) => tag)) };
}

export type Taste = Awaited<ReturnType<typeof taste>>;

function everyoneOwns(guild: Guild, appid: number) {
  const linked = (db.prepare('SELECT user_id, steam_id FROM steam_links').all() as { user_id: string; steam_id: string }[]).filter((l) => guild.members.cache.has(l.user_id));
  const owns = db.prepare('SELECT 1 FROM steam_owned WHERE steam_id = ? AND appid = ?');
  return linked.length > 0 && linked.every((l) => owns.get(l.steam_id, appid));
}

/** Whether a giveaway is worth posting, and why. Throws if Steam couldn't be asked */
export async function verdict(guild: Guild, g: Giveaway, theirs: Taste): Promise<{ show: boolean; reason: string }> {
  const facts = await factsFor(g.title);
  if (facts.appid === null) return { show: setting(guild.id, 'freeGamesUnlisted'), reason: 'Not on Steam, so it can’t be rated' };
  const reviews = facts.positive + facts.negative;
  const rating = reviews ? Math.floor((facts.positive / reviews) * 100) : 0;
  const lowest = setting(guild.id, 'freeGamesMinRating');
  if (lowest && reviews < MIN_REVIEWS) return { show: false, reason: `${reviews} Steam ${reviews === 1 ? 'review' : 'reviews'}, needs ${MIN_REVIEWS}` };
  if (lowest && rating < lowest) return { show: false, reason: `${rating}% positive, needs ${lowest}%` };
  if (setting(guild.id, 'freeGamesMultiplayer') && !facts.tags.some((tag) => MULTIPLAYER_TAGS.has(tag))) return { show: false, reason: 'No multiplayer' };
  if (everyoneOwns(guild, facts.appid)) return { show: false, reason: 'Everyone with a linked Steam account owns it' };
  const reasons = reviews ? [`${rating}% positive`] : [];
  if (setting(guild.id, 'freeGamesTaste') && theirs) {
    const shared = tasteTags(facts).filter((tag) => theirs.tags.has(tag));
    if (shared.length < SHARED_TAGS) return { show: false, reason: 'Not much like what you play' };
    const closest = theirs.games.reduce((best, game) => (overlap(game, shared) > overlap(best, shared) ? game : best));
    reasons.push(`Like ${closest.name} (${shared.slice(0, SHARED_TAGS).join(', ')})`);
  }
  return { show: true, reason: reasons.join(' · ') };
}

const overlap = (game: { tags: string[] }, tags: string[]) => tags.filter((tag) => game.tags.includes(tag)).length;

/** Every current giveaway with whether it would be posted here. Throws if the feed can't be read */
export async function reviewGiveaways(guild: Guild) {
  const giveaways = await current();
  const theirs = setting(guild.id, 'freeGamesTaste') ? await taste(guild.id) : null;
  const reviewed = [];
  for (const g of giveaways) reviewed.push({ ...g, ...(await verdict(guild, g, theirs)) });
  return reviewed;
}

function embed(g: Giveaway, reason?: string): EmbedBuilder {
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
  if (reason) e.setFooter({ text: reason });
  return e;
}

export async function check(client: Client<true>) {
  const giveaways = await current();
  const posted = db.prepare('SELECT 1 FROM free_game_posts WHERE guild_id = ? AND giveaway_id = ?');
  const markPosted = db.prepare('INSERT OR IGNORE INTO free_game_posts (guild_id, giveaway_id) VALUES (?, ?)');
  await eachGuild(client, 'Free game check', async (guild) => {
    if (!setting(guild.id, 'freeGames')) return;
    const fresh = giveaways.filter((g) => !posted.get(guild.id, g.id));
    if (!fresh.length) return;
    const out = (await announceChannel(client, guild.id, 'freeGamesChannel')) ?? (await announceChannel(client, guild.id));
    if (!out) return;
    const theirs = setting(guild.id, 'freeGamesTaste') ? await taste(guild.id) : null;
    let sent = 0;
    for (const g of fresh) {
      if (sent === MAX_POSTS) return;
      // Left unmarked either way, so it's looked at again until it passes or stops being free
      const { show, reason } = await verdict(guild, g, theirs);
      if (!show) continue;
      await out.send({ embeds: [embed(g, reason)] });
      markPosted.run(guild.id, g.id);
      sent++;
    }
  });
}

export const freeGames: Feature = {
  title: 'Free games',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('freegames')
        .setDescription('Games that are free to keep right now on Steam, Epic and GOG')
        .addBooleanOption((o) => o.setName('all').setDescription('Include the ones this server’s filters hide')),
      async run(i) {
        await i.deferReply();
        if (!i.inCachedGuild()) return i.editReply('This only works in a server.');
        const reviewed = await reviewGiveaways(i.guild);
        if (!reviewed.length) return i.editReply('Nothing is free to keep right now.');
        const all = i.options.getBoolean('all') ?? false;
        const shown = all ? reviewed : reviewed.filter((g) => g.show);
        const hidden = reviewed.length - shown.length;
        const note = hidden ? `${hidden} more ${hidden === 1 ? 'is' : 'are'} hidden by this server’s filters. Use \`all\` to see ${hidden === 1 ? 'it' : 'them'}.` : '';
        if (!shown.length) return i.editReply(`Nothing that’s free right now passes this server’s filters. ${note}`);
        // A message holds 10 embeds at most
        const more = shown.length > 10 ? `Showing 10 of ${shown.length}.` : '';
        return i.editReply({ content: [note, more].filter(Boolean).join('\n'), embeds: shown.slice(0, 10).map((g) => embed(g, g.reason)) });
      },
    },
  ],
  setup(client) {
    const run = () => void check(client).catch(console.error);
    run();
    setInterval(run, CHECK_EVERY);
  },
};
