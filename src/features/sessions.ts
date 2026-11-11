import { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder, type Client, type GuildMember, type VoiceBasedChannel } from 'discord.js';
import { db, getKv, setKv, transaction } from '../db.ts';
import { gameName } from '../gameNames.ts';
import { isAllowed, setting } from '../settings.ts';
import { onSteamChange } from '../steamStatus.ts';
import type { Feature } from '../types.ts';
import { announceChannel, eachGuild, formatDuration, humansIn, playingGames, servedGuilds, zonedDate, zonedParts } from '../util.ts';
import { checkpoint, short, stats } from './gamestats.ts';

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

export function join(channel: VoiceBasedChannel, member: GuildMember, now: number) {
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
  // Time alone counts towards the stats, but it's nothing to announce
  if (!save(s, channelId, endedAt) || s.totals.size < 2) return;
  const duration = endedAt - s.startedAt;

  const ranked = [...s.totals].sort((a, b) => b[1] - a[1]);
  const embed = new EmbedBuilder()
    .setTitle(`📼 Session recap · ${formatDuration(duration)}`)
    .setDescription(ranked.map(([userId, ms]) => `<@${userId}> · ${formatDuration(ms)}`).join('\n'))
    .setColor(0x5865f2)
    .setTimestamp(endedAt);
  if (s.games.size) embed.addFields({ name: 'Played', value: [...new Set([...s.games].map((game) => gameName(s.guildId, game)))].join(', ') });

  await (await announceChannel(client, s.guildId))?.send({ embeds: [embed] });
}

/** Records a session if it was long enough to count. Returns whether it was */
function save(s: LiveSession, channelId: string, endedAt: number): boolean {
  if (endedAt - s.startedAt < setting(s.guildId, 'recapMinMinutes') * 60_000) return false;

  transaction(() => {
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
      .run(s.guildId, channelId, s.startedAt, endedAt);
    const addMember = db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)');
    for (const [userId, ms] of s.totals) addMember.run(id, userId, Math.round(ms / 1000));
    const addGame = db.prepare('INSERT INTO session_games (session_id, game) VALUES (?, ?)');
    for (const game of s.games) addGame.run(id, game);
  });
  return true;
}

/** Starts sessions for anyone in voice that isn't tracked yet */
function pickUp(client: Client<true>, now: number) {
  for (const guild of servedGuilds(client)) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.isVoiceBased()) for (const member of humansIn(channel)) join(channel, member, now);
    }
  }
}

/** Adds what people in tracked sessions are playing, for Steam games that come with no Discord event */
export function noteGames(client: Client<true>) {
  for (const [channelId, s] of live) {
    const channel = client.channels.cache.get(channelId);
    if (channel?.isVoiceBased()) for (const member of humansIn(channel)) for (const game of playingGames(member)) s.games.add(game);
  }
}

/** After a reconnect that couldn't catch up on missed events: without this, someone who left meanwhile keeps their session open */
export function resync(client: Client<true>) {
  const now = Date.now();
  for (const [channelId, s] of live) {
    const channel = client.channels.cache.get(channelId);
    const here = new Set(channel?.isVoiceBased() ? humansIn(channel).map((m) => m.id) : []);
    for (const userId of [...s.present.keys()]) if (!here.has(userId)) leave(client, channelId, userId, now);
  }
  pickUp(client, now);
}

/** Everyone's voice time since a moment, most first */
export function voiceTotals(guildId: string, sinceMs: number) {
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
  return [...byUser.values()].sort((a, b) => b.secs - a.secs).map((p) => ({ userId: p.userId, secs: p.secs, nights: p.dates.size }));
}

function leaderboard(guildId: string, sinceMs: number, title: string): EmbedBuilder | null {
  const people = voiceTotals(guildId, sinceMs).slice(0, 10);
  if (!people.length) return null;

  checkpoint();
  const games = stats(guildId, sinceMs, 'none', 'game').slice(0, 5);

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
    embed.addFields({ name: 'Most played', value: games.map((g) => `${short(g.key)} · ${formatDuration(g.ms)}`).join('\n') });
  }
  return embed;
}

export async function maybePostWeekly(client: Client<true>) {
  await eachGuild(client, 'Weekly leaderboard', async (guild) => {
    if (!setting(guild.id, 'weeklyLeaderboard')) return;
    // Each server's own day, hour and time zone
    const now = zonedParts(Date.now(), setting(guild.id, 'timezone'));
    if (now.weekday !== setting(guild.id, 'weeklyPostDay') || now.hour < setting(guild.id, 'weeklyPostHour')) return;
    const today = `${now.year}-${now.month}-${now.day}`;
    const key = `weekly_post:${guild.id}`;
    if (getKv(key) === today) return;
    const out = await announceChannel(client, guild.id);
    if (!out) return;
    const embed = leaderboard(guild.id, Date.now() - 7 * DAY, '🏆 This week in voice');
    if (embed) await out.send({ embeds: [embed] });
    // Afterwards, so a post that fails is tried again on the next check
    setKv(key, today);
  });
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
    pickUp(client, Date.now());
    onSteamChange(() => noteGames(client));
    // Only fires for later reconnects: this listener is added after the first one
    client.on(Events.ShardReady, () => resync(client));

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
  shutdown() {
    // There's no time left to post a recap, but the stats shouldn't go down with the bot
    const now = Date.now();
    for (const [channelId, s] of live) {
      clearTimeout(s.endTimer);
      for (const [userId, joinedAt] of s.present) s.totals.set(userId, (s.totals.get(userId) ?? 0) + now - joinedAt);
      save(s, channelId, s.emptySince ?? now);
    }
    live.clear();
  },
};
