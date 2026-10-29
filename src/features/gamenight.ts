import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
  type Guild,
} from 'discord.js';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { humansIn, servedGuilds, zonedParts, zonedTimeToUtc } from '../util.ts';
import { allGames } from './games.ts';
import { rolesForGames } from './gameroles.ts';

const HOUR = 3_600_000;
/** How long a Discord event runs when nobody is left in its voice channel to keep it going */
const EVENT_LENGTH = 3 * HOUR;

interface Night {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  event_id: string | null;
  game: string;
  details: string | null;
  voice_channel_id: string | null;
  starts_at: number;
  created_by: string;
  reminded: number;
  event_stage: number;
  cancelled: number;
}

const RSVP = {
  in: { label: 'In', emoji: '✅', style: ButtonStyle.Success },
  maybe: { label: 'Maybe', emoji: '🤔', style: ButtonStyle.Secondary },
  out: { label: 'Can’t', emoji: '❌', style: ButtonStyle.Secondary },
} as const;
type Status = keyof typeof RSVP;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Reads times like "fri 8pm", "tomorrow 20:30", "nov 3 7pm", "11/3 9", "2026-11-03 19:00" or just "9pm" (the next 9pm)
 * as wall-clock time in the server's time zone. A bare hour under 12 means pm, since game nights are in the evening.
 */
export function parseWhen(text: string, now: number, timeZone: string): number | null {
  let rest = ` ${text.toLowerCase().replace(/,/g, ' ')} `;
  const today = zonedParts(now, timeZone);
  let date: { year: number; month: number; day: number } | null = null;
  let weekday: number | null = null;
  let skipToday = false;

  const take = (re: RegExp) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(re, ' ');
    return m;
  };
  let m: RegExpMatchArray | null;
  if ((m = take(/\s(\d{4})-(\d{1,2})-(\d{1,2})\s/))) date = { year: +m[1], month: +m[2], day: +m[3] };
  else if ((m = take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/))) {
    date = { year: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : 0, month: +m[1], day: +m[2] };
  } else if ((m = take(new RegExp(`\\s(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s`)))) {
    date = { year: 0, month: MONTHS.indexOf(m[1]) + 1, day: +m[2] };
  } else if (take(/\s(tomorrow|tmrw|tmr)\s/)) {
    date = { year: today.year, month: today.month, day: today.day + 1 };
  } else if (take(/\s(today|tonight)\s/)) {
    date = { year: today.year, month: today.month, day: today.day };
  } else if ((m = take(new RegExp(`\\s(next\\s+)?(${WEEKDAYS.join('|')})[a-z]*\\s`)))) {
    weekday = WEEKDAYS.indexOf(m[2]);
    skipToday = !!m[1];
  }

  let hour: number;
  let minute = 0;
  if (take(/\s(noon)\s/)) hour = 12;
  else if (take(/\s(midnight)\s/)) hour = 0;
  else {
    m = take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s/);
    if (!m) return null;
    hour = +m[1];
    minute = m[2] ? +m[2] : 0;
    const half = m[3]?.[0];
    if (hour > 23 || minute > 59 || (half && (hour === 0 || hour > 12))) return null;
    if (half === 'p' && hour < 12) hour += 12;
    else if (half === 'a' && hour === 12) hour = 0;
    else if (!half && !m[2] && hour >= 1 && hour < 12) hour += 12;
  }
  // Anything left over that isn't filler means the text wasn't understood
  if (rest.replace(/\b(at|on|this|the)\b/g, '').trim()) return null;

  const at = (year: number, month: number, day: number) => zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  if (date) {
    if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null;
    if (date.year) return at(date.year, date.month, date.day);
    // No year: this year's, unless that's already gone
    const thisYear = at(today.year, date.month, date.day);
    return thisYear > now - 24 * HOUR ? thisYear : at(today.year + 1, date.month, date.day);
  }
  if (weekday !== null) {
    let ahead = (weekday - today.weekday + 7) % 7;
    if (ahead === 0 && (skipToday || at(today.year, today.month, today.day) <= now)) ahead = 7;
    return at(today.year, today.month, today.day + ahead);
  }
  const todayAt = at(today.year, today.month, today.day);
  return todayAt > now ? todayAt : at(today.year, today.month, today.day + 1);
}

function describe(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

const getNight = (id: number) => db.prepare('SELECT * FROM game_nights WHERE id = ?').get(id) as Night | undefined;

function rsvps(nightId: number): Record<Status, string[]> {
  const rows = db.prepare('SELECT user_id, status FROM game_night_rsvps WHERE night_id = ? ORDER BY rowid').all(nightId) as {
    user_id: string;
    status: Status;
  }[];
  const out: Record<Status, string[]> = { in: [], maybe: [], out: [] };
  for (const r of rows) out[r.status].push(r.user_id);
  return out;
}

function view(night: Night) {
  const seconds = Math.floor(night.starts_at / 1000);
  const people = rsvps(night.id);
  const embed = new EmbedBuilder()
    .setTitle(`${night.cancelled ? '❌ Cancelled: ' : '🎮 '}${night.game} night`)
    .setColor(night.cancelled ? 0x99aab5 : 0xeb459e)
    .addFields({ name: 'When', value: `<t:${seconds}:F> (<t:${seconds}:R>)` });
  if (night.details) embed.setDescription(night.details);
  if (night.voice_channel_id) embed.addFields({ name: 'Where', value: `<#${night.voice_channel_id}>`, inline: true });
  embed.addFields({ name: 'Host', value: `<@${night.created_by}>`, inline: true });
  if (night.event_id) embed.addFields({ name: 'Event', value: `[Open in Discord](https://discord.com/events/${night.guild_id}/${night.event_id})`, inline: true });
  for (const status of Object.keys(RSVP) as Status[]) {
    const ids = people[status];
    embed.addFields({ name: `${RSVP[status].emoji} ${RSVP[status].label} (${ids.length})`, value: ids.map((id) => `<@${id}>`).join(' ') || '—' });
  }
  if (night.cancelled) return { embeds: [embed], components: [] };
  const buttons = (Object.keys(RSVP) as Status[]).map((status) =>
    new ButtonBuilder().setCustomId(`gn:${status}:${night.id}`).setLabel(RSVP[status].label).setEmoji(RSVP[status].emoji).setStyle(RSVP[status].style),
  );
  buttons.push(new ButtonBuilder().setCustomId(`gn:cancel:${night.id}`).setLabel('Cancel night').setStyle(ButtonStyle.Danger));
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] };
}

async function createEvent(guild: Guild, night: Omit<Night, 'id' | 'event_id' | 'message_id'>): Promise<string | null> {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.CreateEvents) && !me?.permissions.has(PermissionFlagsBits.ManageEvents)) return null;
  const event = await guild.scheduledEvents.create({
    name: `${night.game} night`.slice(0, 100),
    description: night.details?.slice(0, 1000),
    scheduledStartTime: new Date(night.starts_at),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    ...(night.voice_channel_id
      ? { entityType: GuildScheduledEventEntityType.Voice, channel: night.voice_channel_id }
      : {
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: { location: 'Voice chat' },
          scheduledEndTime: new Date(night.starts_at + EVENT_LENGTH),
        }),
  });
  return event.id;
}

/** Reminders, plus starting and ending the Discord events, once a minute */
async function tick(client: Client<true>) {
  const now = Date.now();
  const nights = db
    .prepare('SELECT * FROM game_nights WHERE cancelled = 0 AND (reminded = 0 OR (event_id IS NOT NULL AND event_stage < 2)) AND starts_at < ?')
    .all(now + 25 * HOUR) as unknown as Night[];
  const served = new Map(servedGuilds(client).map((g) => [g.id, g]));
  for (const night of nights) {
    const guild = served.get(night.guild_id);
    if (!guild) continue;

    const remindMin = setting(guild.id, 'gameNightReminderMin');
    if (!night.reminded && remindMin > 0 && now >= night.starts_at - remindMin * 60_000) {
      db.prepare('UPDATE game_nights SET reminded = 1 WHERE id = ?').run(night.id);
      const people = rsvps(night.id);
      const going = [...people.in, ...people.maybe];
      const channel = await client.channels.fetch(night.channel_id).catch(() => null);
      if (now < night.starts_at && going.length && channel?.isSendable()) {
        const where = night.voice_channel_id ? ` in <#${night.voice_channel_id}>` : '';
        await channel.send({
          content: `⏰ **${night.game} night** starts <t:${Math.floor(night.starts_at / 1000)}:R>${where}: ${going.map((id) => `<@${id}>`).join(' ')}`,
          allowedMentions: { users: going },
          reply: night.message_id ? { messageReference: night.message_id, failIfNotExists: false } : undefined,
        });
      }
    }

    if (!night.event_id) continue;
    if (night.event_stage === 0 && now >= night.starts_at) {
      await guild.scheduledEvents.edit(night.event_id, { status: GuildScheduledEventStatus.Active }).catch(() => {});
      db.prepare('UPDATE game_nights SET event_stage = 1 WHERE id = ?').run(night.id);
    } else if (night.event_stage === 1 && now >= night.starts_at + EVENT_LENGTH) {
      // Leave the event running while people are still in its channel
      const voice = night.voice_channel_id ? guild.channels.cache.get(night.voice_channel_id) : undefined;
      if (voice?.isVoiceBased() && humansIn(voice).length) continue;
      await guild.scheduledEvents.edit(night.event_id, { status: GuildScheduledEventStatus.Completed }).catch(() => {});
      db.prepare('UPDATE game_nights SET event_stage = 2 WHERE id = ?').run(night.id);
    }
  }
}

function gameNames(guildId: string): string[] {
  const played = db.prepare('SELECT DISTINCT game FROM game_plays WHERE guild_id = ?').all(guildId) as { game: string }[];
  return [...new Set([...allGames(guildId).map((g) => g.name), ...played.map((r) => r.game)])].sort();
}

export const gameNights: Feature = {
  title: 'Game nights',
  componentPrefix: 'gn',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('gamenight')
        .setDescription('Plan game nights people can RSVP to')
        .addSubcommand((s) =>
          s
            .setName('plan')
            .setDescription('Plan a game night: posts an RSVP message and a Discord event, and reminds everyone who’s in')
            .addStringOption((o) => o.setName('game').setDescription('What you’re playing').setRequired(true).setMaxLength(90).setAutocomplete(true))
            .addStringOption((o) =>
              o.setName('when').setDescription('e.g. fri 8pm, tomorrow 20:30, nov 3 7pm').setRequired(true).setMaxLength(100).setAutocomplete(true),
            )
            .addChannelOption((o) => o.setName('voice').setDescription('Voice channel to meet in').addChannelTypes(ChannelType.GuildVoice))
            .addStringOption((o) => o.setName('details').setDescription('Anything people should know').setMaxLength(1000)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Upcoming game nights')),
      async autocomplete(i) {
        if (!i.inGuild()) return i.respond([]);
        const focused = i.options.getFocused(true);
        if (focused.name === 'game') {
          const query = focused.value.toLowerCase();
          return i.respond(
            gameNames(i.guildId)
              .filter((n) => n.toLowerCase().includes(query))
              .slice(0, 25)
              .map((n) => ({ name: n.slice(0, 90), value: n.slice(0, 90) })),
          );
        }
        // Shows how the time will be read before the command is sent
        const timeZone = setting(i.guildId, 'timezone');
        const at = focused.value.trim() ? parseWhen(focused.value, Date.now(), timeZone) : null;
        if (at === null) return i.respond([{ name: focused.value.trim() ? 'Not sure when that is. Try “fri 8pm” or “nov 3 7:30pm”' : 'Type a day and time, like “fri 8pm”', value: focused.value || '?' }]);
        return i.respond([{ name: describe(at, timeZone), value: `@${at}` }]);
      },
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });

        if (i.options.getSubcommand() === 'list') {
          const nights = db
            .prepare('SELECT * FROM game_nights WHERE guild_id = ? AND cancelled = 0 AND starts_at > ? ORDER BY starts_at LIMIT 15')
            .all(i.guildId, Date.now() - 3 * HOUR) as unknown as Night[];
          if (!nights.length) return i.reply({ content: 'No game nights planned. Start one with `/gamenight plan`.', flags: MessageFlags.Ephemeral });
          const lines = nights.map((n) => {
            const link = n.message_id ? ` · [RSVP](https://discord.com/channels/${n.guild_id}/${n.channel_id}/${n.message_id})` : '';
            return `<t:${Math.floor(n.starts_at / 1000)}:F> · **${n.game}** · ${rsvps(n.id).in.length} in${link}`;
          });
          return i.reply({ embeds: [new EmbedBuilder().setTitle('📅 Upcoming game nights').setColor(0xeb459e).setDescription(lines.join('\n'))] });
        }

        const game = i.options.getString('game', true).trim();
        const when = i.options.getString('when', true).trim();
        const timeZone = setting(i.guildId, 'timezone');
        const startsAt = /^@\d+$/.test(when) ? Number(when.slice(1)) : parseWhen(when, Date.now(), timeZone);
        if (startsAt === null) {
          return i.reply({ content: `I couldn’t tell when **${when}** is. Try something like \`fri 8pm\`, \`tomorrow 20:30\` or \`nov 3 7pm\`.`, flags: MessageFlags.Ephemeral });
        }
        if (startsAt < Date.now() + 60_000) {
          return i.reply({ content: `${describe(startsAt, timeZone)} has already passed.`, flags: MessageFlags.Ephemeral });
        }

        const fields = {
          guild_id: i.guildId,
          channel_id: i.channelId,
          game,
          details: i.options.getString('details'),
          voice_channel_id: i.options.getChannel('voice')?.id ?? null,
          starts_at: startsAt,
          created_by: i.user.id,
          reminded: 0,
          event_stage: 0,
          cancelled: 0,
        };
        await i.deferReply();
        let eventId: string | null = null;
        let eventNote = '';
        try {
          eventId = await createEvent(i.guild, fields);
          if (!eventId) eventNote = 'No Discord event was made: my role needs the **Create Events** permission.';
        } catch (err) {
          console.error(err);
          eventNote = 'Making the Discord event failed, so there’s just this post.';
        }

        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO game_nights (guild_id, channel_id, event_id, game, details, voice_channel_id, starts_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(i.guildId, i.channelId, eventId, game, fields.details, fields.voice_channel_id, startsAt, i.user.id);
        const id = Number(lastInsertRowid);
        db.prepare("INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, 'in')").run(id, i.user.id);

        const roles = rolesForGames(i.guildId, [game]);
        const message = await i.editReply({
          content: roles.length ? `${roles.map((r) => `<@&${r}>`).join(' ')} new game night` : undefined,
          ...view(getNight(id)!),
          allowedMentions: { roles },
        });
        db.prepare('UPDATE game_nights SET message_id = ? WHERE id = ?').run(message.id, id);
        if (eventNote) await i.followUp({ content: eventNote, flags: MessageFlags.Ephemeral });
      },
    },
  ],
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    const [, action, idText] = i.customId.split(':');
    const night = getNight(Number(idText));
    if (!night || night.cancelled) return i.update({ components: [] });

    if (action === 'cancel') {
      if (i.user.id !== night.created_by && !i.memberPermissions.has(PermissionFlagsBits.ManageEvents)) {
        return i.reply({ content: 'Only the host or someone with Manage Events can cancel this.', flags: MessageFlags.Ephemeral });
      }
      db.prepare('UPDATE game_nights SET cancelled = 1 WHERE id = ?').run(night.id);
      if (night.event_id) await i.guild.scheduledEvents.delete(night.event_id).catch(() => {});
      await i.update(view(getNight(night.id)!));
      const going = rsvps(night.id).in.filter((id) => id !== i.user.id);
      if (night.starts_at > Date.now() && going.length) {
        await i.followUp({ content: `**${night.game} night** is off. ${going.map((id) => `<@${id}>`).join(' ')}`, allowedMentions: { users: going } });
      }
      return;
    }

    if (!(action in RSVP)) return;
    if (night.starts_at < Date.now() - 12 * HOUR) return i.reply({ content: 'This game night is over.', flags: MessageFlags.Ephemeral });
    db.prepare(
      'INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(night_id, user_id) DO UPDATE SET status = excluded.status',
    ).run(night.id, i.user.id, action);
    return i.update(view(night));
  },
  setup(client) {
    setInterval(() => void tick(client).catch(console.error), 60_000);
  },
};
