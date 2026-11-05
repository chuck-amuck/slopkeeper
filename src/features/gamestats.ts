import { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder, type Client, type GuildMember } from 'discord.js';
import { db } from '../db.ts';
import { isAllowed } from '../settings.ts';
import type { Feature } from '../types.ts';
import { eachGuild, formatDuration, playingGames, servedGuilds, zonedParts, zonedTimeToUtc } from '../util.ts';
import { sharedGames } from './games.ts';

const DAY = 86_400_000;
/** Plays shorter than this (launchers, crashes) aren't kept */
const MIN_PLAY = 60_000;

/** `${guildId}:${userId}` → game → its game_plays row, for games being played right now */
const open = new Map<string, Map<string, number>>();

const insertPlay = db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)');
const extendPlay = db.prepare('UPDATE game_plays SET ended_at = ? WHERE id = ?');
const dropShortPlay = db.prepare('DELETE FROM game_plays WHERE id = ? AND ended_at - started_at < ?');

function close(id: number, now: number) {
  extendPlay.run(now, id);
  dropShortPlay.run(id, MIN_PLAY);
}

/** Opens and closes plays so they match what the member is playing now */
function sync(member: GuildMember, now: number) {
  if (member.user.bot) return;
  const key = `${member.guild.id}:${member.id}`;
  const playing = new Set(playingGames(member));
  const mine = open.get(key) ?? new Map<string, number>();
  for (const [game, id] of mine) {
    if (playing.has(game)) continue;
    close(id, now);
    mine.delete(game);
  }
  for (const game of playing) {
    if (!mine.has(game)) mine.set(game, Number(insertPlay.run(member.guild.id, member.id, game, now, now).lastInsertRowid));
  }
  if (mine.size) open.set(key, mine);
  else open.delete(key);
}

/** Matches open plays to every member's presence, picking up anyone already playing */
function syncAll(client: Client<true>) {
  const now = Date.now();
  for (const guild of servedGuilds(client)) for (const member of guild.members.cache.values()) sync(member, now);
}

/**
 * After a reconnect that couldn't catch up on missed events. Discord only sends who's online, so anyone who
 * went offline meanwhile would stay cached as playing, and their play would grow until they next came online.
 */
export async function resync(client: Client<true>) {
  await eachGuild(client, 'Presence resync', async (guild) => {
    guild.presences.cache.clear();
    await guild.members.fetch({ withPresences: true });
  });
  syncAll(client);
}

/** Brings open plays up to now, so stats include games in progress and a crash loses at most a few minutes */
export function checkpoint() {
  const now = Date.now();
  for (const mine of open.values()) for (const id of mine.values()) extendPlay.run(now, id);
}

/** Time in each play that falls inside the period */
const CLIPPED = 'MIN(ended_at, :until) - MAX(started_at, :since)';

interface Totals {
  ms: number;
  n: number;
}

function playsWhere(user?: string, game?: string): string {
  const where = ['guild_id = :guild', 'ended_at > :since', 'started_at < :until'];
  if (user) where.push('user_id = :user');
  if (game) where.push('game = :game COLLATE NOCASE');
  return where.join(' AND ');
}

export function stats(
  guildId: string,
  since: number,
  filter: 'user' | 'game' | 'both' | 'none',
  groupBy: 'game' | 'user_id',
  user?: string,
  game?: string,
  until = Date.now(),
) {
  const where = playsWhere(filter === 'user' || filter === 'both' ? 'user' : undefined, filter === 'game' || filter === 'both' ? 'game' : undefined);
  const other = groupBy === 'game' ? 'user_id' : 'game';
  return db
    .prepare(
      `SELECT ${groupBy} AS key, SUM(${CLIPPED}) AS ms, COUNT(DISTINCT ${other}) AS n, MAX(ended_at) AS last
       FROM game_plays WHERE ${where}
       GROUP BY ${groupBy} ORDER BY ms DESC`,
    )
    .all({ guild: guildId, since, until, ...(user ? { user } : {}), ...(game ? { game } : {}) }) as unknown as (Totals & {
    key: string;
    last: number;
  })[];
}

/**
 * Game time per day, week or month in the server's time zone, whichever suits the length of the period.
 * `keep` picks whose time counts. Every step is listed, so a quiet one shows up as a gap.
 */
export function activity(guildId: string, since: number, until: number, timeZone: string, keep: (userId: string) => boolean, user?: string, game?: string) {
  const plays = (
    db
      .prepare(`SELECT user_id AS userId, MAX(started_at, :since) AS start, MIN(ended_at, :until) AS end FROM game_plays WHERE ${playsWhere(user, game)}`)
      .all({ guild: guildId, since, until, ...(user ? { user } : {}), ...(game ? { game } : {}) }) as { userId: string; start: number; end: number }[]
  ).filter((p) => keep(p.userId));
  if (!plays.length) return { step: 'day', buckets: [] };

  const first = since || plays.reduce((earliest, p) => Math.min(earliest, p.start), Infinity);
  const days = (until - first) / DAY;
  const step = days <= 45 ? 'day' : days <= 400 ? 'week' : 'month';
  const { year, month, day } = zonedParts(first, timeZone);
  const boundary = (i: number) => {
    if (step === 'month') return zonedTimeToUtc(year, month + i, 1, 0, 0, timeZone);
    return zonedTimeToUtc(year, month, day + i * (step === 'week' ? 7 : 1), 0, 0, timeZone);
  };

  const buckets: { start: number; ms: number }[] = [];
  for (let i = 0; boundary(i) < until; i++) {
    const start = boundary(i);
    const end = boundary(i + 1);
    let ms = 0;
    for (const p of plays) ms += Math.max(0, Math.min(p.end, end) - Math.max(p.start, start));
    buckets.push({ start, ms });
  }
  return { step, buckets };
}

/** Time two people spent in the same game at the same moment, most first */
export function playedTogether(guildId: string, a: string, b: string) {
  return db
    .prepare(
      `SELECT x.game AS game, SUM(MIN(x.ended_at, y.ended_at) - MAX(x.started_at, y.started_at)) AS ms
       FROM game_plays x JOIN game_plays y
         ON y.guild_id = x.guild_id AND y.game = x.game AND y.user_id = ? AND y.started_at < x.ended_at AND y.ended_at > x.started_at
       WHERE x.guild_id = ? AND x.user_id = ?
       GROUP BY x.game ORDER BY ms DESC`,
    )
    .all(b, guildId, a) as { game: string; ms: number }[];
}

/** Voice sessions two people were both part of. Only each person's total is kept, so the shorter one is the most they can have overlapped */
export function voiceTogether(guildId: string, a: string, b: string) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(MIN(x.seconds, y.seconds)), 0) AS seconds
       FROM session_members x
       JOIN session_members y ON y.session_id = x.session_id AND y.user_id = ?
       JOIN sessions s ON s.id = x.session_id
       WHERE s.guild_id = ? AND x.user_id = ?`,
    )
    .get(b, guildId, a) as { n: number; seconds: number };
}

export const PERIODS = {
  week: { label: 'past week', ms: 7 * DAY },
  month: { label: 'past month', ms: 30 * DAY },
  year: { label: 'past year', ms: 365 * DAY },
  all: { label: 'all time', ms: Infinity },
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const countPeople = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
/** Keeps the top-10 lists inside Discord's limit on embed fields, whatever a game calls itself */
export const short = (name: string) => (name.length > 60 ? `${name.slice(0, 59)}…` : name);
export const rank = (idx: number) => ['🥇', '🥈', '🥉'][idx] ?? `${idx + 1}.`;
const ago = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

export const gameStats: Feature = {
  title: 'Game stats',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('gamestats')
        .setDescription('What this server plays, from Discord’s “Playing” status: overall, per person or per game')
        .addUserOption((o) => o.setName('user').setDescription('Just this person'))
        .addStringOption((o) => o.setName('game').setDescription('Just this game').setMaxLength(100).setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('period')
            .setDescription('Time range (default: past month)')
            .addChoices(...Object.entries(PERIODS).map(([value, p]) => ({ name: p.label[0].toUpperCase() + p.label.slice(1), value }))),
        ),
      async autocomplete(i) {
        if (!i.inGuild()) return i.respond([]);
        const query = `%${i.options.getFocused().replace(/[%_]/g, '')}%`;
        const rows = db
          .prepare('SELECT game, SUM(ended_at - started_at) AS ms FROM game_plays WHERE guild_id = ? AND game LIKE ? GROUP BY game ORDER BY ms DESC LIMIT 25')
          .all(i.guildId, query) as { game: string }[];
        return i.respond(rows.map((r) => ({ name: r.game.slice(0, 100), value: r.game.slice(0, 100) })));
      },
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        checkpoint();
        const period = PERIODS[(i.options.getString('period') ?? 'month') as keyof typeof PERIODS];
        const since = Number.isFinite(period.ms) ? Date.now() - period.ms : 0;
        const user = i.options.getUser('user');
        const name = i.options.getMember('user')?.displayName ?? user?.displayName;
        const game = i.options.getString('game')?.trim();
        const isMember = (id: string) => i.guild.members.cache.has(id);
        const embed = new EmbedBuilder().setColor(0x57f287).setFooter({ text: `${period.label} · from Discord activity status` });
        const nothing = (what: string) => i.reply({ content: `No ${what} in the ${period.label}.`, flags: MessageFlags.Ephemeral });

        if (user && game) {
          const players = stats(i.guildId, since, 'game', 'user_id', undefined, game).filter((r) => isMember(r.key));
          const idx = players.findIndex((r) => r.key === user.id);
          if (idx < 0) return nothing(`${game} for ${name}`);
          const sessions = (
            db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE guild_id = ? AND user_id = ? AND game = ? COLLATE NOCASE AND ended_at > ?').get(i.guildId, user.id, game, since) as {
              n: number;
            }
          ).n;
          const me = players[idx];
          embed
            .setTitle(`🎮 ${name} · ${game}`)
            .setDescription(
              `**${formatDuration(me.ms)}** over ${plural(sessions, 'session')}, last played ${ago(me.last)}\n` +
                `${rank(idx)} of ${plural(players.length, 'player')} here`,
            );
          return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        if (user) {
          const games = stats(i.guildId, since, 'user', 'game', user.id);
          if (!games.length) return nothing(`games for ${name}`);
          const total = games.reduce((sum, g) => sum + g.ms, 0);
          embed
            .setTitle(`🎮 ${name}’s games`)
            .setThumbnail(user.displayAvatarURL())
            .setDescription(
              `**${formatDuration(total)}** across ${plural(games.length, 'game')}\n\n` +
                games
                  .slice(0, 15)
                  .map((g, idx) => `${rank(idx)} **${short(g.key)}** · ${formatDuration(g.ms)} · ${ago(g.last)}`)
                  .join('\n'),
            );
          return i.reply({ embeds: [embed] });
        }

        if (game) {
          const players = stats(i.guildId, since, 'game', 'user_id', undefined, game).filter((r) => isMember(r.key));
          if (!players.length) return nothing(`${game} plays`);
          const total = players.reduce((sum, p) => sum + p.ms, 0);
          embed
            .setTitle(`🎮 ${game}`)
            .setDescription(
              `**${formatDuration(total)}** played by ${countPeople(players.length)}\n\n` +
                players
                  .slice(0, 15)
                  .map((p, idx) => `${rank(idx)} <@${p.key}> · ${formatDuration(p.ms)} · ${ago(p.last)}`)
                  .join('\n'),
            );
          return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        const games = stats(i.guildId, since, 'none', 'game');
        const people = stats(i.guildId, since, 'none', 'user_id').filter((r) => isMember(r.key));
        if (!games.length) return nothing('games played');
        const total = games.reduce((sum, g) => sum + g.ms, 0);
        embed
          .setTitle('🎮 Game stats')
          .setDescription(`**${formatDuration(total)}** across ${plural(games.length, 'game')} by ${countPeople(people.length)}`)
          .addFields(
            {
              name: 'Most played',
              value: games
                .slice(0, 10)
                .map((g, idx) => `${rank(idx)} **${short(g.key)}** · ${formatDuration(g.ms)} · ${plural(g.n, 'player')}`)
                .join('\n'),
            },
            {
              name: 'Biggest gamers',
              value:
                people
                  .slice(0, 10)
                  .map((p, idx) => `${rank(idx)} <@${p.key}> · ${formatDuration(p.ms)} · ${plural(p.n, 'game')}`)
                  .join('\n') || '—',
            },
          );
        return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('compare')
        .setDescription('What two people have in common: games they both own and time played together')
        .addUserOption((o) => o.setName('user').setDescription('Who to compare').setRequired(true))
        .addUserOption((o) => o.setName('with').setDescription('Who to compare them with (default: you)')),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const first = i.options.getUser('with') ?? i.user;
        const second = i.options.getUser('user', true);
        if (first.id === second.id) return i.reply({ content: 'Pick two different people.', flags: MessageFlags.Ephemeral });
        if (first.bot || second.bot) return i.reply({ content: 'Bots don’t play games. Pick two people.', flags: MessageFlags.Ephemeral });

        checkpoint();
        const nameOf = (u: typeof first) => i.guild.members.cache.get(u.id)?.displayName ?? u.displayName;
        const total = (id: string) => stats(i.guildId, 0, 'user', 'game', id).reduce((sum, g) => sum + g.ms, 0);
        const games = playedTogether(i.guildId, first.id, second.id);
        const voice = voiceTogether(i.guildId, first.id, second.id);
        const shared = sharedGames(i.guildId, first.id, second.id);

        const summary: string[] = [];
        if (games.length) summary.push(`**${formatDuration(games.reduce((sum, g) => sum + g.ms, 0))}** in the same game at the same time`);
        if (voice.n) summary.push(`**${plural(voice.n, 'voice session')}** together, up to ${formatDuration(voice.seconds * 1000)}`);
        if (!summary.length) summary.push('No time together on record yet.');
        summary.push(`All-time game time: ${nameOf(first)} ${formatDuration(total(first.id))}, ${nameOf(second)} ${formatDuration(total(second.id))}`);

        const embed = new EmbedBuilder().setColor(0x57f287).setTitle(`🤝 ${nameOf(first)} and ${nameOf(second)}`).setDescription(summary.join('\n'));
        if (games.length) {
          embed.addFields({
            name: 'Played together most',
            value: games
              .slice(0, 5)
              .map((g, idx) => `${rank(idx)} **${short(g.game)}** · ${formatDuration(g.ms)}`)
              .join('\n'),
          });
        }
        embed.addFields({
          name: `Both own (${shared.length})`,
          value: shared.map((g) => short(g.name)).slice(0, 15).join(', ') || 'Nothing yet. Link Steam with `/steam link` or mark games with `/game own`.',
        });
        return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      },
    },
  ],
  setup(client) {
    syncAll(client);
    // Only fires for later reconnects: this listener is added after the first one
    client.on(Events.ShardReady, () => void resync(client).catch(console.error));
    client.on(Events.PresenceUpdate, (_old, presence) => {
      if (presence.member && presence.guild && isAllowed(presence.guild.id)) sync(presence.member, Date.now());
    });
    client.on(Events.GuildMemberRemove, (member) => {
      const mine = open.get(`${member.guild.id}:${member.id}`);
      if (!mine) return;
      for (const id of mine.values()) close(id, Date.now());
      open.delete(`${member.guild.id}:${member.id}`);
    });
    setInterval(checkpoint, 5 * 60_000);
  },
  shutdown() {
    const now = Date.now();
    for (const mine of open.values()) for (const id of mine.values()) close(id, now);
    open.clear();
  },
};
