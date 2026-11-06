import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type Client, type Guild } from 'discord.js';
import { db, getKv, setKv } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild, formatDuration, zonedParts, zonedTimeToUtc } from '../util.ts';
import { checkpoint, plural, rank, short, stats } from './gamestats.ts';

/** The start and end of a calendar month in a time zone; `month` may run past either end of the year */
export function monthBounds(year: number, month: number, timeZone: string) {
  return { start: zonedTimeToUtc(year, month, 1, 0, 0, timeZone), end: zonedTimeToUtc(year, month + 1, 1, 0, 0, timeZone) };
}

/** A month's highlights, or null if nothing happened in it */
export function buildRecap(guild: Guild, start: number, end: number): EmbedBuilder | null {
  const isMember = (id: string) => guild.members.cache.has(id);
  const games = stats(guild.id, start, 'none', 'game', undefined, undefined, end);
  const players = stats(guild.id, start, 'none', 'user_id', undefined, undefined, end).filter((r) => isMember(r.key));

  const period = [guild.id, start, end] as const;
  // Time alone counts as voice time, but a highlight needs company
  const group = '(SELECT COUNT(*) FROM session_members WHERE session_id = sessions.id) >= 2';
  const sessions = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(ended_at - started_at), 0) AS ms FROM sessions WHERE guild_id = ? AND started_at >= ? AND started_at < ? AND ${group}`).get(...period) as {
    n: number;
    ms: number;
  };
  const voice = (
    db
      .prepare(
        `SELECT m.user_id AS userId, SUM(m.seconds) AS seconds
         FROM session_members m JOIN sessions s ON s.id = m.session_id
         WHERE s.guild_id = ? AND s.started_at >= ? AND s.started_at < ?
         GROUP BY m.user_id ORDER BY seconds DESC`,
      )
      .all(...period) as { userId: string; seconds: number }[]
  ).filter((r) => isMember(r.userId));
  const longest = db
    .prepare(`SELECT id, started_at, ended_at FROM sessions WHERE guild_id = ? AND started_at >= ? AND started_at < ? AND ${group} ORDER BY ended_at - started_at DESC LIMIT 1`)
    .get(...period) as { id: number; started_at: number; ended_at: number } | undefined;

  const sounds = db
    .prepare('SELECT name, COUNT(*) AS n FROM sound_plays WHERE guild_id = ? AND played_at >= ? AND played_at < ? GROUP BY name ORDER BY n DESC LIMIT 3')
    .all(...period) as { name: string; n: number }[];
  const spammer = (
    db
      .prepare('SELECT user_id AS userId, COUNT(*) AS n FROM sound_plays WHERE guild_id = ? AND played_at >= ? AND played_at < ? GROUP BY user_id ORDER BY n DESC')
      .all(...period) as { userId: string; n: number }[]
  ).find((r) => isMember(r.userId));

  const nights = db
    .prepare(
      `SELECT n.game AS game, (SELECT COUNT(*) FROM game_night_rsvps r WHERE r.night_id = n.id AND r.status = 'in') AS people
       FROM game_nights n WHERE n.guild_id = ? AND n.starts_at >= ? AND n.starts_at < ? AND n.cancelled = 0
       ORDER BY people DESC`,
    )
    .all(...period) as { game: string; people: number }[];

  if (!games.length && !sessions.n && !voice.length && !sounds.length && !nights.length) return null;

  const timeZone = setting(guild.id, 'timezone');
  const label = new Date(start).toLocaleString('en-US', { timeZone, month: 'long', year: 'numeric' });
  const totals: string[] = [];
  if (games.length) totals.push(`**${formatDuration(games.reduce((sum, g) => sum + g.ms, 0))}** across ${plural(games.length, 'game')}`);
  if (sessions.n) totals.push(`**${plural(sessions.n, 'voice session')}**, ${formatDuration(sessions.ms)} in all`);
  const embed = new EmbedBuilder().setTitle(`🗓️ ${label} recap`).setColor(0xfee75c);
  if (totals.length) embed.setDescription(totals.join(' · '));

  if (games.length) {
    embed.addFields({ name: 'Most played', value: games.slice(0, 3).map((g, idx) => `${rank(idx)} **${short(g.key)}** · ${formatDuration(g.ms)}`).join('\n') });
  }
  if (players.length) {
    embed.addFields({ name: 'Biggest gamers', value: players.slice(0, 3).map((p, idx) => `${rank(idx)} <@${p.key}> · ${formatDuration(p.ms)}`).join('\n') });
  }
  if (voice.length) {
    embed.addFields({ name: 'Most time in voice', value: voice.slice(0, 3).map((v, idx) => `${rank(idx)} <@${v.userId}> · ${formatDuration(v.seconds * 1000)}`).join('\n') });
  }
  if (longest) {
    const members = db.prepare('SELECT user_id AS userId FROM session_members WHERE session_id = ? ORDER BY seconds DESC').all(longest.id) as { userId: string }[];
    const people = members.filter((m) => isMember(m.userId));
    const shown = people.slice(0, 10).map((p) => `<@${p.userId}>`).join(' ');
    const more = people.length > 10 ? ` and ${people.length - 10} more` : '';
    embed.addFields({ name: 'Longest session', value: `**${formatDuration(longest.ended_at - longest.started_at)}** on <t:${Math.floor(longest.started_at / 1000)}:D> with ${shown}${more}` });
  }
  if (sounds.length) {
    const lines = sounds.map((s, idx) => `${rank(idx)} **${s.name}** · ${plural(s.n, 'play')}`);
    if (spammer) lines.push(`Most trigger-happy: <@${spammer.userId}> · ${plural(spammer.n, 'play')}`);
    embed.addFields({ name: 'Top sounds', value: lines.join('\n') });
  }
  if (nights.length) {
    embed.addFields({ name: 'Game nights', value: `${plural(nights.length, 'night')}, best turnout ${short(nights[0].game)} with ${nights[0].people} in` });
  }
  return embed;
}

/** Last month's recap, or this month's so far */
export function recapFor(guild: Guild, current: boolean) {
  checkpoint();
  const timeZone = setting(guild.id, 'timezone');
  const now = zonedParts(Date.now(), timeZone);
  const { start, end } = monthBounds(now.year, current ? now.month : now.month - 1, timeZone);
  return buildRecap(guild, start, Math.min(end, Date.now()));
}

/** Last month's recap on the 1st, at the hour the weekly leaderboard goes out, or as soon as the bot is back if it missed that */
export async function maybePostMonthly(client: Client<true>) {
  await eachGuild(client, 'Monthly recap', async (guild) => {
    if (!setting(guild.id, 'monthlyRecap')) return;
    const timeZone = setting(guild.id, 'timezone');
    const now = zonedParts(Date.now(), timeZone);
    const month = `${now.year}-${now.month}`;
    const key = `monthly_post:${guild.id}`;
    const last = getKv(key);
    if (last === month) return;
    // A server's first month isn't complete, so it starts with the next one
    if (last === undefined) return setKv(key, month);
    if (now.day === 1 && now.hour < setting(guild.id, 'weeklyPostHour')) return;
    const out = await announceChannel(client, guild.id);
    if (!out) return;
    checkpoint();
    const { start, end } = monthBounds(now.year, now.month - 1, timeZone);
    const embed = buildRecap(guild, start, end);
    if (embed) await out.send({ embeds: [embed] });
    // Afterwards, so a post that fails is tried again on the next check
    setKv(key, month);
  });
}

export const recap: Feature = {
  title: 'Monthly recap',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('recap')
        .setDescription('The month’s highlights: top games, biggest gamers, longest session, top sounds')
        .addStringOption((o) =>
          o
            .setName('month')
            .setDescription('Which month (default: last month)')
            .addChoices({ name: 'Last month', value: 'last' }, { name: 'This month so far', value: 'this' }),
        ),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const current = i.options.getString('month') === 'this';
        const embed = recapFor(i.guild, current);
        if (embed) return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        return i.reply({ content: `Nothing to recap for ${current ? 'this month' : 'last month'} yet.`, flags: MessageFlags.Ephemeral });
      },
    },
  ],
  setup(client) {
    setInterval(() => void maybePostMonthly(client).catch(console.error), 10 * 60_000);
  },
};
