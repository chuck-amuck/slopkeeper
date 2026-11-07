import { EmbedBuilder, type Client, type Guild, type SendableChannels } from 'discord.js';
import { db, getKv, setKv } from '../db.ts';
import { gameKey } from '../gameNames.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild, paginate, zonedParts } from '../util.ts';
import { checkpoint, stats } from './gamestats.ts';
import { allGames } from './games.ts';
import { patchNotes as readPatchNotes } from './steam.ts';

const DAY = 86_400_000;
const CHECK_EVERY_MS = 30 * 60_000;
const PLAYED_WITHIN_MS = 30 * DAY;
/** Anything older was out before anyone here could have wanted telling */
const NEWS_FOR_MS = 14 * DAY;
const DIGEST_PAGE_CHARS = 4000;

interface PatchPost {
  gid: string;
  game: string;
  title: string;
  url: string;
  date: number;
  text: string;
}

/** Games with a Steam ID that were played here lately, as appid → name */
export function playedApps(guildId: string) {
  checkpoint();
  const known = new Map<string, number>();
  const named = db.prepare('SELECT appid, name FROM app_info WHERE name IS NOT NULL UNION SELECT appid, name FROM steam_owned WHERE name IS NOT NULL').all() as { appid: number; name: string }[];
  for (const { appid, name } of named) known.set(gameKey(name), appid);
  for (const g of allGames(guildId)) if (g.steam_appid !== null) known.set(gameKey(g.name), g.steam_appid);
  const played = new Map<number, string>();
  for (const { key } of stats(guildId, Date.now() - PLAYED_WITHIN_MS, 'none', 'game')) {
    const appid = known.get(gameKey(key));
    if (appid !== undefined) played.set(appid, key);
  }
  return played;
}

/** Notes what's new. A game seen for the first time only marks where to start from, so turning this on posts nothing old */
async function discover(guildId: string) {
  const seen = db.prepare('SELECT 1 FROM patch_posts WHERE guild_id = ? AND appid = ? LIMIT 1');
  const add = db.prepare('INSERT OR IGNORE INTO patch_posts (guild_id, gid, appid, game, title, url, date, text, posted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [appid, game] of playedApps(guildId)) {
    const notes = await readPatchNotes(appid).catch((err) => (console.error(err), []));
    const first = !seen.get(guildId, appid);
    for (const note of notes) add.run(guildId, note.gid, appid, game, note.title, note.url, note.date, note.text, first || note.date < Date.now() - NEWS_FOR_MS ? 1 : 0);
  }
}

const noteEmbed = (post: PatchPost) => new EmbedBuilder().setTitle(`🩹 ${post.game}: ${post.title}`.slice(0, 256)).setURL(post.url).setDescription(post.text || null).setColor(0x1b2838).setTimestamp(post.date);

async function postDigest(guild: Guild, out: SendableChannels, posts: PatchPost[], done: (post: PatchPost) => void) {
  const now = zonedParts(Date.now(), setting(guild.id, 'timezone'));
  if (now.weekday !== setting(guild.id, 'weeklyPostDay') || now.hour < setting(guild.id, 'weeklyPostHour')) return;
  const today = `${now.year}-${now.month}-${now.day}`;
  const key = `patch_digest:${guild.id}`;
  if (getKv(key) === today) return;
  const lines = posts.map((p) => `**${p.game}**: [${p.title.replace(/[[\]]/g, '')}](${p.url})`);
  for (const page of paginate(lines, DIGEST_PAGE_CHARS)) await out.send({ embeds: [new EmbedBuilder().setTitle('🩹 Patch notes this week').setDescription(page.join('\n')).setColor(0x1b2838)] });
  // Afterwards, so a post that fails is tried again on the next check
  posts.forEach(done);
  setKv(key, today);
}

export async function maybePostPatches(client: Client<true>) {
  await eachGuild(client, 'Patch notes', async (guild) => {
    const mode = setting(guild.id, 'patchNotes');
    if (mode === 'off') return;
    await discover(guild.id);
    const posts = db.prepare('SELECT gid, game, title, url, date, text FROM patch_posts WHERE guild_id = ? AND posted = 0 ORDER BY date').all(guild.id) as unknown as PatchPost[];
    if (!posts.length) return;
    const out = (await announceChannel(client, guild.id, 'patchNotesChannel')) ?? (await announceChannel(client, guild.id));
    if (!out) return;
    const done = (post: PatchPost) => db.prepare('UPDATE patch_posts SET posted = 1 WHERE guild_id = ? AND gid = ?').run(guild.id, post.gid);
    if (mode === 'digest') return postDigest(guild, out, posts, done);
    for (const post of posts) {
      await out.send({ embeds: [noteEmbed(post)] });
      done(post);
    }
  });
}

export const patchNotes: Feature = {
  title: 'Patch notes',
  setup(client) {
    setInterval(() => void maybePostPatches(client).catch(console.error), CHECK_EVERY_MS);
  },
};
