import { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder, type Client, type GuildMember, type VoiceBasedChannel } from 'discord.js';
import { db, getKv, setKv } from '../db.ts';
import { isAllowed, setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, formatDuration, humansIn, playingGames, servedGuilds, zonedDate, zonedParts } from '../util.ts';

interface LiveSession {
  guildId: string;
  startedAt: number;
  /** userId -> time they joined (only people currently in the channel) */
  present: Map<string, number>;
  /** userId -> ms accumulated from completed stints */
  totals: Map<string, number>;
  games: Set<string>;
  emptySince?: number;
  endTimer?: NodeJS.Timeout;
}

const live = new Map<string, LiveSession>();
const DAY = 86_400_000;

function join(channel: VoiceBasedChannel, member: GuildMember, now: number) {
  if (channel.id === channel.guild.afkChannelId) return;
  let s = live.get(channel.id);
  if (!s) {
    s = { guildId: channel.guild.id, startedAt: now, present: new Map(), totals: new Map(), games: new Set() };
    live.set(channel.id, s);
  }
  if (s.endTimer) {
    clearTimeout(s.endTimer);
    s.endTimer = undefined;
    s.emptySince = undefined;
  }
  if (!s.present.has(member.id)) s.present.set(member.id, now);
  for (const game of playingGames(member)) s.games.add(game);
}

function leave(client: Client<true>, channelId: string, userId: string, now: number) {
  const s = live.get(channelId);
  const joinedAt = s?.present.get(userId);
  if (!s || joinedAt === undefined) return;
  s.present.delete(userId);
  s.totals.set(userId, (s.totals.get(userId) ?? 0) + now - joinedAt);
  if (s.present.size === 0) {
    // Grace period so a quick disconnect/reconnect doesn't split the night into two sessions
    s.emptySince = now;
    s.endTimer = setTimeout(() => void finish(client, channelId).catch(console.error), setting(s.guildId, 'sessionGraceMin') * 60_000);
  }
}

async function finish(client: Client<true>, channelId: string) {
  const s = live.get(channelId);
  if (!s || s.present.size > 0) return;
  live.delete(channelId);

  const endedAt = s.emptySince ?? Date.now();
  const duration = endedAt - s.startedAt;
  if (duration < setting(s.guildId, 'recapMinMinutes') * 60_000 || s.totals.size < 2) return;

  db.exec('BEGIN');
  try {
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
      .run(s.guildId, channelId, s.startedAt, endedAt);
    const addMember = db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)');
    for (const [userId, ms] of s.totals) addMember.run(id, userId, Math.round(ms / 1000));
    const addGame = db.prepare('INSERT INTO session_games (session_id, game) VALUES (?, ?)');
    for (const game of s.games) addGame.run(id, game);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const ranked = [...s.totals].sort((a, b) => b[1] - a[1]);
  const embed = new EmbedBuilder()
    .setTitle(`📼 Session recap · ${formatDuration(duration)}`)
    .setDescription(ranked.map(([userId, ms]) => `<@${userId}> · ${formatDuration(ms)}`).join('\n'))
    .setColor(0x5865f2)
    .setTimestamp(endedAt);
  if (s.games.size) embed.addFields({ name: 'Played', value: [...s.games].join(', ') });

  await (await announceChannel(client, s.guildId))?.send({ embeds: [embed] });
}

function leaderboard(guildId: string, sinceMs: number, title: string): EmbedBuilder | null {
  const rows = db
    .prepare(
      `SELECT sm.user_id AS userId, sm.seconds AS secs, s.started_at AS startedAt
       FROM session_members sm JOIN sessions s ON s.id = sm.session_id
       WHERE s.guild_id = ? AND s.started_at >= ?`,
    )
    .all(guildId, sinceMs) as { userId: string; secs: number; startedAt: number }[];
  // Nights are counted by the server's own calendar, so this happens here instead of in SQL
  const timeZone = setting(guildId, 'timezone');
  const byUser = new Map<string, { userId: string; secs: number; dates: Set<string> }>();
  for (const r of rows) {
    const entry = byUser.get(r.userId) ?? { userId: r.userId, secs: 0, dates: new Set<string>() };
    entry.secs += r.secs;
    entry.dates.add(zonedDate(r.startedAt, timeZone));
    byUser.set(r.userId, entry);
  }
  const people = [...byUser.values()]
    .sort((a, b) => b.secs - a.secs)
    .slice(0, 10)
    .map((p) => ({ userId: p.userId, secs: p.secs, nights: p.dates.size }));
  if (!people.length) return null;

  const games = db
    .prepare(
      `SELECT sg.game AS game, COUNT(*) AS n
       FROM session_games sg JOIN sessions s ON s.id = sg.session_id
       WHERE s.guild_id = ? AND s.started_at >= ?
       GROUP BY sg.game ORDER BY n DESC LIMIT 5`,
    )
    .all(guildId, sinceMs) as { game: string; n: number }[];

  const medals = ['🥇', '🥈', '🥉'];
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      people
        .map((p, idx) => `${medals[idx] ?? `${idx + 1}.`} <@${p.userId}> · ${formatDuration(p.secs * 1000)} · ${p.nights} night${p.nights === 1 ? '' : 's'}`)
        .join('\n'),
    )
    .setColor(0xfee75c);
  if (games.length) {
    embed.addFields({ name: 'Most played', value: games.map((g) => `${g.game} (${g.n} session${g.n === 1 ? '' : 's'})`).join('\n') });
  }
  return embed;
}

async function maybePostWeekly(client: Client<true>) {
  for (const guild of servedGuilds(client)) {
    // Each server's own day, hour and time zone
    const now = zonedParts(Date.now(), setting(guild.id, 'timezone'));
    if (now.weekday !== setting(guild.id, 'weeklyPostDay') || now.hour < setting(guild.id, 'weeklyPostHour')) continue;
    const today = `${now.year}-${now.month}-${now.day}`;
    const key = `weekly_post:${guild.id}`;
    if (getKv(key) === today) continue;
    const out = await announceChannel(client, guild.id);
    if (!out) continue;
    setKv(key, today);
    const embed = leaderboard(guild.id, Date.now() - 7 * DAY, '🏆 This week in voice');
    if (embed) await out.send({ embeds: [embed] });
  }
}

export const sessions: Feature = {
  title: 'Voice sessions',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Voice leaderboard')
        .addStringOption((o) =>
          o
            .setName('period')
            .setDescription('Time range (default: week)')
            .addChoices({ name: 'Past week', value: 'week' }, { name: 'Past month', value: 'month' }, { name: 'All time', value: 'all' }),
        ),
      async run(i) {
        if (!i.inGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const period = i.options.getString('period') ?? 'week';
        const since = period === 'week' ? Date.now() - 7 * DAY : period === 'month' ? Date.now() - 30 * DAY : 0;
        const label = period === 'week' ? 'past week' : period === 'month' ? 'past month' : 'all time';
        const embed = leaderboard(i.guildId, since, `🏆 Voice leaderboard · ${label}`);
        return i.reply(embed ? { embeds: [embed] } : { content: `No recorded sessions in the ${label} yet.` });
      },
    },
  ],
  setup(client) {
    // Pick up anyone already in voice when the bot starts
    const now = Date.now();
    for (const guild of servedGuilds(client)) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.isVoiceBased()) for (const member of humansIn(channel)) join(channel, member, now);
      }
    }

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const member = newState.member;
      if (!member || member.user.bot || !isAllowed(newState.guild.id)) return;
      if (oldState.channelId === newState.channelId) return; // mute/deafen/stream toggles
      const now = Date.now();
      if (oldState.channelId) leave(client, oldState.channelId, member.id, now);
      if (newState.channel) join(newState.channel, member, now);
    });

    client.on(Events.PresenceUpdate, (_old, presence) => {
      const member = presence.member;
      const s = member?.voice.channelId ? live.get(member.voice.channelId) : undefined;
      if (member && s) for (const game of playingGames(member)) s.games.add(game);
    });

    setInterval(() => void maybePostWeekly(client).catch(console.error), 10 * 60_000);
  },
};
