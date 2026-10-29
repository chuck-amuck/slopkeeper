import { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder, type GuildMember } from 'discord.js';
import { db } from '../db.ts';
import { isAllowed } from '../settings.ts';
import type { Feature } from '../types.ts';
import { formatDuration, playingGames, servedGuilds } from '../util.ts';

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

/** Brings open plays up to now, so stats include games in progress and a crash loses at most a few minutes */
function checkpoint() {
  const now = Date.now();
  for (const mine of open.values()) for (const id of mine.values()) extendPlay.run(now, id);
}

/** Time in each play that falls inside the period */
const CLIPPED = 'MIN(ended_at, :now) - MAX(started_at, :since)';

interface Totals {
  ms: number;
  n: number;
}

function stats(guildId: string, since: number, filter: 'user' | 'game' | 'both' | 'none', groupBy: 'game' | 'user_id', user?: string, game?: string) {
  const where = ['guild_id = :guild', 'ended_at > :since'];
  if (filter === 'user' || filter === 'both') where.push('user_id = :user');
  if (filter === 'game' || filter === 'both') where.push('game = :game');
  const other = groupBy === 'game' ? 'user_id' : 'game';
  return db
    .prepare(
      `SELECT ${groupBy} AS key, SUM(${CLIPPED}) AS ms, COUNT(DISTINCT ${other}) AS n, MAX(ended_at) AS last
       FROM game_plays WHERE ${where.join(' AND ')}
       GROUP BY ${groupBy} ORDER BY ms DESC`,
    )
    .all({ guild: guildId, since, now: Date.now(), ...(user ? { user } : {}), ...(game ? { game } : {}) }) as unknown as (Totals & {
    key: string;
    last: number;
  })[];
}

const PERIODS = {
  week: { label: 'past week', ms: 7 * DAY },
  month: { label: 'past month', ms: 30 * DAY },
  year: { label: 'past year', ms: 365 * DAY },
  all: { label: 'all time', ms: Infinity },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rank = (idx: number) => ['🥇', '🥈', '🥉'][idx] ?? `${idx + 1}.`;
const ago = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

export const gameStats: Feature = {
  title: 'Game stats',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('gamestats')
        .setDescription('What this server plays, from Discord’s “Playing” status: overall, per person or per game')
        .addUserOption((o) => o.setName('user').setDescription('Just this person'))
        .addStringOption((o) => o.setName('game').setDescription('Just this game').setAutocomplete(true))
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
        const game = i.options.getString('game')?.trim();
        const isMember = (id: string) => i.guild.members.cache.has(id);
        const embed = new EmbedBuilder().setColor(0x57f287).setFooter({ text: `${period.label} · from Discord activity status` });
        const nothing = (what: string) => i.reply({ content: `No ${what} in the ${period.label}.`, flags: MessageFlags.Ephemeral });

        if (user && game) {
          const players = stats(i.guildId, since, 'game', 'user_id', undefined, game).filter((r) => isMember(r.key));
          const idx = players.findIndex((r) => r.key === user.id);
          if (idx < 0) return nothing(`${game} for ${user.displayName}`);
          const sessions = (
            db.prepare('SELECT COUNT(*) AS n FROM game_plays WHERE guild_id = ? AND user_id = ? AND game = ? AND ended_at > ?').get(i.guildId, user.id, game, since) as {
              n: number;
            }
          ).n;
          const me = players[idx];
          embed
            .setTitle(`🎮 ${user.displayName} · ${game}`)
            .setDescription(
              `**${formatDuration(me.ms)}** over ${plural(sessions, 'session')}, last played ${ago(me.last)}\n` +
                `${rank(idx)} of ${plural(players.length, 'player')} here`,
            );
          return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        if (user) {
          const games = stats(i.guildId, since, 'user', 'game', user.id);
          if (!games.length) return nothing(`games for ${user.displayName}`);
          const total = games.reduce((sum, g) => sum + g.ms, 0);
          embed
            .setTitle(`🎮 ${user.displayName}’s games`)
            .setThumbnail(user.displayAvatarURL())
            .setDescription(
              `**${formatDuration(total)}** across ${plural(games.length, 'game')}\n\n` +
                games
                  .slice(0, 15)
                  .map((g, idx) => `${rank(idx)} **${g.key}** · ${formatDuration(g.ms)} · ${ago(g.last)}`)
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
              `**${formatDuration(total)}** played by ${plural(players.length, 'person')}\n\n` +
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
          .setDescription(`**${formatDuration(total)}** across ${plural(games.length, 'game')} by ${plural(people.length, 'person')}`)
          .addFields(
            {
              name: 'Most played',
              value: games
                .slice(0, 10)
                .map((g, idx) => `${rank(idx)} **${g.key}** · ${formatDuration(g.ms)} · ${plural(g.n, 'player')}`)
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
  ],
  setup(client) {
    const now = Date.now();
    for (const guild of servedGuilds(client)) {
      for (const presence of guild.presences.cache.values()) if (presence.member) sync(presence.member, now);
    }
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
