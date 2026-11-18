import { EmbedBuilder, type Client, type Guild, type SendableChannels } from 'discord.js';
import { db } from '../db.ts';
import { due, every, once, WEEKLY } from '../schedule.ts';
import { gameKey } from '../gameNames.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild, paginate } from '../util.ts';
import { checkpoint, stats } from './gamestats.ts';
import { allGames } from './games.ts';
import { patchNotes as readPatchNotes } from './steam.ts';
import { sendPost } from '../postFailures.ts';

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

async function postDigest(client: Client<true>, guild: Guild, posts: PatchPost[], done: (post: PatchPost) => void) {
  // With the weekly leaderboard, or once the bot is back if it was down then
  const when = due(guild.id, 'week', setting(guild.id, 'weeklyPostHour'), { weekday: setting(guild.id, 'weeklyPostDay') });
  await once(`patch_digest:${guild.id}`, when, async () => {
    // A week with nothing new is done too, so notes found later in it wait for the next one
    if (!posts.length) return;
    const out = await notesChannel(client, guild.id);
    if (!out) return false;
    const lines = posts.map((p) => `**${p.game}**: [${p.title.replace(/[[\]]/g, '')}](${p.url})`);
    for (const [n, page] of paginate(lines, DIGEST_PAGE_CHARS).entries()) await sendPost('patchNotes', guild.id, out, { embeds: [new EmbedBuilder().setTitle('🩹 Patch notes this week').setDescription(page.join('\n')).setColor(0x1b2838)] }, n === 0);
    posts.forEach(done);
  }, WEEKLY);
}

const notesChannel = async (client: Client<true>, guildId: string) => (await announceChannel(client, guildId, 'patchNotesChannel')) ?? (await announceChannel(client, guildId));

export async function maybePostPatches(client: Client<true>) {
  await eachGuild(client, 'Patch notes', async (guild) => {
    const mode = setting(guild.id, 'patchNotes');
    if (mode === 'off') return;
    await discover(guild.id);
    const posts = db.prepare('SELECT gid, game, title, url, date, text FROM patch_posts WHERE guild_id = ? AND posted = 0 ORDER BY date').all(guild.id) as unknown as PatchPost[];
    const done = (post: PatchPost) => db.prepare('UPDATE patch_posts SET posted = 1 WHERE guild_id = ? AND gid = ?').run(guild.id, post.gid);
    if (mode === 'digest') return postDigest(client, guild, posts, done);
    if (!posts.length) return;
    const out = await notesChannel(client, guild.id);
    if (!out) return;
    for (const post of posts) {
      await sendPost('patchNotes', guild.id, out, { embeds: [noteEmbed(post)] });
      done(post);
    }
  });
}

export const patchNotes: Feature = {
  title: 'Patch notes',
  setup(client) {
    every('Patch notes', CHECK_EVERY_MS, () => maybePostPatches(client));
  },
};
