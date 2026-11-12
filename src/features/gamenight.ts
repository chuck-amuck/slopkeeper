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
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Guild,
} from 'discord.js';
import { logActivity } from '../activity.ts';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { humansIn, servedGuilds, zonedParts, zonedTimeToUtc } from '../util.ts';
import { allGames } from './games.ts';
import { rolesForGames } from './gameroles.ts';
import { plural } from './gamestats.ts';
import { announceAloud } from './say.ts';
import { commandMention } from '../commandIds.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far ahead a repeating night's next card goes up, so it's there soon after the last night but pings at a sensible time */
const SERIES_LEAD = 6 * DAY;
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
  series_id: number | null;
}

interface Series {
  id: number;
  guild_id: string;
  channel_id: string;
  game: string;
  details: string | null;
  voice_channel_id: string | null;
  created_by: string;
  every_days: number;
  next_at: number;
  post_at: number;
}

type NewNight = Pick<Night, 'guild_id' | 'channel_id' | 'game' | 'details' | 'voice_channel_id' | 'starts_at' | 'created_by' | 'series_id'>;

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

/** The first time in a repeating schedule after `after`, at the same wall-clock time whatever daylight saving does */
export function nextOccurrence(from: number, everyDays: number, after: number, timeZone: string): number {
  const start = zonedParts(from, timeZone);
  for (let days = everyDays; ; days += everyDays) {
    const at = zonedTimeToUtc(start.year, start.month, start.day + days, start.hour, start.minute, timeZone);
    if (at > after) return at;
  }
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
const getSeries = (id: number | null) => (id === null ? undefined : (db.prepare('SELECT * FROM game_night_series WHERE id = ?').get(id) as Series | undefined));
const repeatLabel = (everyDays: number) => (everyDays === 7 ? 'Every week' : `Every ${everyDays / 7} weeks`);

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
  const series = getSeries(night.series_id);
  const embed = new EmbedBuilder()
    .setTitle(`${night.cancelled ? '❌ Cancelled: ' : '🎮 '}${night.game} night`)
    .setColor(night.cancelled ? 0x99aab5 : 0xeb459e)
    .addFields({ name: 'When', value: `<t:${seconds}:F> (<t:${seconds}:R>)` });
  if (night.details) embed.setDescription(night.details);
  if (night.voice_channel_id) embed.addFields({ name: 'Where', value: `<#${night.voice_channel_id}>`, inline: true });
  embed.addFields({ name: 'Host', value: `<@${night.created_by}>`, inline: true });
  if (series) embed.addFields({ name: 'Repeats', value: repeatLabel(series.every_days), inline: true });
  if (night.event_id) embed.addFields({ name: 'Event', value: `[Open in Discord](https://discord.com/events/${night.guild_id}/${night.event_id})`, inline: true });
  for (const status of Object.keys(RSVP) as Status[]) {
    const ids = people[status];
    embed.addFields({ name: `${RSVP[status].emoji} ${RSVP[status].label} (${ids.length})`, value: ids.map((id) => `<@${id}>`).join(' ') || '—' });
  }
  // Cancelling one night leaves the series running, so a cancelled card can still stop it
  const stop = new ButtonBuilder().setCustomId(`gn:stop:${night.id}`).setLabel('Stop repeating').setStyle(ButtonStyle.Secondary);
  if (night.cancelled) return { embeds: [embed], components: series ? [new ActionRowBuilder<ButtonBuilder>().addComponents(stop)] : [] };
  const buttons = (Object.keys(RSVP) as Status[]).map((status) =>
    new ButtonBuilder().setCustomId(`gn:${status}:${night.id}`).setLabel(RSVP[status].label).setEmoji(RSVP[status].emoji).setStyle(RSVP[status].style),
  );
  // The host's buttons go on their own row, under the answers everyone uses
  const manage = [
    new ButtonBuilder().setCustomId(`gn:edit:${night.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gn:cancel:${night.id}`).setLabel('Cancel night').setStyle(ButtonStyle.Danger),
  ];
  if (series) manage.push(stop);
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons), new ActionRowBuilder<ButtonBuilder>().addComponents(manage)] };
}

async function createEvent(guild: Guild, night: NewNight): Promise<string | null> {
  const me = guild.members.me;
  // Manage Events alone no longer lets a bot create events, only edit them
  if (!me?.permissions.has(PermissionFlagsBits.CreateEvents)) return null;
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

/** Makes the Discord event and the night, with the host in. Returns a note for the host if the event couldn't be made */
async function addNight(guild: Guild, fields: NewNight) {
  let eventId: string | null = null;
  let eventNote = '';
  try {
    eventId = await createEvent(guild, fields);
    if (!eventId) eventNote = 'No Discord event was made: my role needs the **Create Events** permission.';
  } catch (err) {
    console.error(err);
    eventNote = 'Making the Discord event failed, so there’s just this post.';
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO game_nights (guild_id, channel_id, event_id, game, details, voice_channel_id, starts_at, created_by, series_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fields.guild_id, fields.channel_id, eventId, fields.game, fields.details, fields.voice_channel_id, fields.starts_at, fields.created_by, fields.series_id);
  const id = Number(lastInsertRowid);
  db.prepare("INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, 'in')").run(id, fields.created_by);
  return { id, eventId, eventNote };
}

function newNightPing(guildId: string, game: string) {
  const roles = rolesForGames(guildId, [game]);
  return { content: roles.length ? `${roles.map((r) => `<@&${r}>`).join(' ')} new game night` : undefined, allowedMentions: { roles } };
}

/** Makes a night and posts its card, for when there's no slash command to reply to */
async function postNight(client: Client<true>, guild: Guild, fields: NewNight) {
  const channel = await client.channels.fetch(fields.channel_id).catch(() => null);
  if (!channel?.isSendable()) throw new Error(`can't post in channel ${fields.channel_id}`);

  const { id, eventId, eventNote } = await addNight(guild, fields);
  const message = await channel.send({ ...newNightPing(guild.id, fields.game), ...view(getNight(id)!) }).catch(async (err) => {
    // Otherwise each retry would leave another event behind
    db.prepare('DELETE FROM game_nights WHERE id = ?').run(id);
    if (eventId) await guild.scheduledEvents.delete(eventId).catch(() => {});
    throw err;
  });
  db.prepare('UPDATE game_nights SET message_id = ? WHERE id = ?').run(message.id, id);
  return eventNote;
}

/** Puts up the next card of a repeating night */
async function postNext(client: Client<true>, guild: Guild, series: Series, now: number) {
  const timeZone = setting(guild.id, 'timezone');
  // If the bot was down long enough to miss one, go on to the next that's still ahead
  const startsAt = series.next_at > now + 60_000 ? series.next_at : nextOccurrence(series.next_at, series.every_days, now + 60_000, timeZone);
  await postNight(client, guild, {
    guild_id: series.guild_id,
    channel_id: series.channel_id,
    game: series.game,
    details: series.details,
    voice_channel_id: series.voice_channel_id,
    starts_at: startsAt,
    created_by: series.created_by,
    series_id: series.id,
  });
  const next = nextOccurrence(startsAt, series.every_days, startsAt, timeZone);
  db.prepare('UPDATE game_night_series SET next_at = ?, post_at = ? WHERE id = ?').run(next, next - SERIES_LEAD, series.id);
}

/** Reminders, starting and ending the Discord events, and new cards for repeating nights, once a minute */
export async function tick(client: Client<true>) {
  const now = Date.now();
  const nights = db
    .prepare('SELECT * FROM game_nights WHERE cancelled = 0 AND (reminded = 0 OR (event_id IS NOT NULL AND event_stage < 2)) AND starts_at < ?')
    .all(now + 25 * HOUR) as unknown as Night[];
  const served = new Map(servedGuilds(client).map((g) => [g.id, g]));
  for (const night of nights) {
    const guild = served.get(night.guild_id);
    if (!guild) continue;
    await advance(client, guild, night, now).catch((err) => console.error(`Game night ${night.id} in ${guild.name} (${guild.id}):`, err));
  }
  const due = db.prepare('SELECT * FROM game_night_series WHERE post_at <= ?').all(now) as unknown as Series[];
  for (const series of due) {
    const guild = served.get(series.guild_id);
    if (!guild) continue;
    await postNext(client, guild, series, now).catch((err) => {
      console.error(`Repeating game night ${series.id} in ${guild.name} (${guild.id}):`, err);
      db.prepare('UPDATE game_night_series SET post_at = ? WHERE id = ?').run(now + HOUR, series.id);
    });
  }
}

/** Does whatever is due for one night, so a problem with it doesn't hold up the others */
async function advance(client: Client<true>, guild: Guild, night: Night, now: number) {
  const remindMin = setting(guild.id, 'gameNightReminderMin');
  if (!night.reminded && remindMin > 0 && now >= night.starts_at - remindMin * 60_000) {
    // Claimed before sending so a slow send can't overlap the next tick's; put back below if it fails
    db.prepare('UPDATE game_nights SET reminded = 1 WHERE id = ?').run(night.id);
    const people = rsvps(night.id);
    const going = [...people.in, ...people.maybe];
    const channel = await client.channels.fetch(night.channel_id).catch(() => null);
    if (now < night.starts_at && going.length && channel?.isSendable()) {
      const where = night.voice_channel_id ? ` in <#${night.voice_channel_id}>` : '';
      const card = night.message_id ? ` · [RSVP](https://discord.com/channels/${night.guild_id}/${night.channel_id}/${night.message_id})` : '';
      await channel
        .send({
          content: `⏰ **${night.game} night** starts <t:${Math.floor(night.starts_at / 1000)}:R>${where}: ${going.map((id) => `<@${id}>`).join(' ')}${card}`,
          allowedMentions: { users: going },
        })
        .catch((err) => {
          db.prepare('UPDATE game_nights SET reminded = 0 WHERE id = ?').run(night.id);
          throw err;
        });
      const room = night.voice_channel_id ? guild.channels.cache.get(night.voice_channel_id) : undefined;
      if (room?.isVoiceBased()) {
        const minutes = Math.max(1, Math.round((night.starts_at - now) / 60_000));
        void announceAloud(room, `${night.game} night starts in ${plural(minutes, 'minute')}`, 'ttsNightReminders').catch(console.error);
      }
    }
  }

  if (!night.event_id) return;
  if (night.event_stage === 0 && now >= night.starts_at) {
    await guild.scheduledEvents.edit(night.event_id, { status: GuildScheduledEventStatus.Active }).catch((err) => console.error(`Game night ${night.id} event start:`, err.message));
    db.prepare('UPDATE game_nights SET event_stage = 1 WHERE id = ?').run(night.id);
  } else if (night.event_stage === 1 && now >= night.starts_at + EVENT_LENGTH) {
    // Leave the event running while people are still in its channel
    const voice = night.voice_channel_id ? guild.channels.cache.get(night.voice_channel_id) : undefined;
    if (voice?.isVoiceBased() && humansIn(voice).length) return;
    await guild.scheduledEvents.edit(night.event_id, { status: GuildScheduledEventStatus.Completed }).catch((err) => console.error(`Game night ${night.id} event end:`, err.message));
    db.prepare('UPDATE game_nights SET event_stage = 2 WHERE id = ?').run(night.id);
  }
}

/** The message that tells people a night is off */
function offNotice(night: Night, going: string[]) {
  return { content: `**${night.game} night** is off. ${going.map((id) => `<@${id}>`).join(' ')}`, allowedMentions: { users: going } };
}

async function markCancelled(guild: Guild, night: Night) {
  db.prepare('UPDATE game_nights SET cancelled = 1 WHERE id = ?').run(night.id);
  if (night.event_id) await guild.scheduledEvents.delete(night.event_id).catch(() => {});
}

/** Redraws a night's card, from outside a button press on it */
async function refreshCard(client: Client<true>, night: Night) {
  if (!night.message_id) return;
  const channel = await client.channels.fetch(night.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.messages.edit(night.message_id, view(night)).catch((err) => console.error(`Game night ${night.id} card:`, err.message));
}

/** What the web UI shows: nights still to come, and the series that will post more */
export function upcomingNights(guildId: string, now: number) {
  const nights = db
    .prepare('SELECT * FROM game_nights WHERE guild_id = ? AND cancelled = 0 AND starts_at > ? ORDER BY starts_at LIMIT 50')
    .all(guildId, now - 3 * HOUR) as unknown as Night[];
  const series = db.prepare('SELECT * FROM game_night_series WHERE guild_id = ? ORDER BY next_at').all(guildId) as unknown as Series[];
  return {
    nights: nights.map((n) => ({ ...n, people: rsvps(n.id), repeats: getSeries(n.series_id) ? repeatLabel(getSeries(n.series_id)!.every_days) : null })),
    series: series.map((s) => ({ ...s, repeats: repeatLabel(s.every_days) })),
  };
}

/** How a typed time reads in a server, for the web UI to show before anything is posted */
export function readWhen(guildId: string, text: string) {
  const timeZone = setting(guildId, 'timezone');
  const at = parseWhen(text, Date.now(), timeZone);
  return at === null ? null : { at, label: describe(at, timeZone), passed: at < Date.now() + 60_000 };
}

function addSeries(fields: Omit<NewNight, 'series_id'>, everyDays: number, timeZone: string): number {
  const next = nextOccurrence(fields.starts_at, everyDays, fields.starts_at, timeZone);
  return Number(
    db
      .prepare(
        `INSERT INTO game_night_series (guild_id, channel_id, game, details, voice_channel_id, created_by, every_days, next_at, post_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fields.guild_id, fields.channel_id, fields.game, fields.details, fields.voice_channel_id, fields.created_by, everyDays, next, next - SERIES_LEAD).lastInsertRowid,
  );
}

/** Plans a night from the web UI, the way /gamenight plan does. Returns a note if the Discord event couldn't be made */
export async function planNight(client: Client<true>, guild: Guild, fields: Omit<NewNight, 'guild_id' | 'series_id'>, everyDays: number | null) {
  const night = { ...fields, guild_id: guild.id };
  const seriesId = everyDays ? addSeries(night, everyDays, setting(guild.id, 'timezone')) : null;
  return postNight(client, guild, { ...night, series_id: seriesId }).catch((err) => {
    // Otherwise a night that never got posted would start repeating
    if (seriesId) db.prepare('DELETE FROM game_night_series WHERE id = ?').run(seriesId);
    throw err;
  });
}

/** Cancels a night from the web UI, the way its Cancel button does. Returns the game, or null if this server has no such night */
export async function cancelNight(client: Client<true>, guild: Guild, id: number): Promise<string | null> {
  const night = getNight(id);
  if (night?.guild_id !== guild.id) return null;
  if (night.cancelled) return night.game;
  await markCancelled(guild, night);
  await refreshCard(client, getNight(id)!);
  const going = rsvps(id).in;
  const channel = await client.channels.fetch(night.channel_id).catch(() => null);
  if (night.starts_at > Date.now() && going.length && channel?.isSendable()) await channel.send(offNotice(night, going));
  return night.game;
}

/** Ends a series from the web UI. Nights it already posted stay on. Returns the game, or null if this server has no such series */
export async function stopSeries(client: Client<true>, guild: Guild, id: number): Promise<string | null> {
  const series = getSeries(id);
  if (series?.guild_id !== guild.id) return null;
  db.prepare('DELETE FROM game_night_series WHERE id = ?').run(id);
  // Their cards still have the Repeats line and the Stop repeating button
  const nights = db.prepare('SELECT * FROM game_nights WHERE series_id = ? AND starts_at > ?').all(id, Date.now() - 12 * HOUR) as unknown as Night[];
  for (const night of nights) await refreshCard(client, night);
  return series.game;
}

/** A night's time as text parseWhen reads back exactly, for the Edit form to start from */
export function whenText(ms: number, timeZone: string) {
  const t = zonedParts(ms, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}`;
}

/** What can change about a night. Anything left out stays as it is */
export interface NightEdit {
  game?: unknown;
  when?: unknown;
  details?: unknown;
  voiceChannelId?: string | null;
}

const CHANGE_NAMES = { game: 'game', starts_at: 'time', details: 'details', voice_channel_id: 'voice channel' } as const;

/**
 * Changes a night from its Edit button or the web UI, by the same rules as planning one, then moves its Discord event
 * to match, redraws its card and tells whoever's in or maybe if its time or place moved (apart from `byUserId`).
 * Returns what changed, what's wrong, or undefined when this server has no such night
 */
export async function editNight(client: Client<true>, guild: Guild, id: number, edit: NightEdit, byUserId?: string): Promise<{ game: string; changed: string[]; eventNote: string } | string | undefined> {
  const night = getNight(id);
  if (!night || night.guild_id !== guild.id) return undefined;
  if (night.cancelled) return 'This game night was cancelled.';
  if (night.starts_at < Date.now() - 12 * HOUR) return 'This game night is over.';
  const timeZone = setting(guild.id, 'timezone');
  const next = { game: night.game, starts_at: night.starts_at, details: night.details, voice_channel_id: night.voice_channel_id };
  if (edit.game !== undefined) {
    const game = typeof edit.game === 'string' ? edit.game.trim() : '';
    if (!game || game.length > 90) return 'Say what you’re playing, in 90 characters or fewer.';
    next.game = game;
  }
  if (edit.when !== undefined) {
    const text = typeof edit.when === 'string' ? edit.when.trim().slice(0, 100) : '';
    const at = text ? parseWhen(text, Date.now(), timeZone) : null;
    if (at === null) return `I couldn’t tell when ${text || 'that'} is. Try something like fri 8pm, tomorrow 20:30 or nov 3 7pm.`;
    if (at !== night.starts_at) {
      if (night.starts_at <= Date.now()) return 'It’s already started, so its time can’t change.';
      if (at < Date.now() + 60_000) return `${describe(at, timeZone)} has already passed.`;
      next.starts_at = at;
    }
  }
  if (edit.details !== undefined) {
    if (edit.details !== null && typeof edit.details !== 'string') return 'Details have to be text.';
    const details = edit.details?.trim() ?? '';
    if (details.length > 1000) return 'Details have to fit in 1000 characters.';
    next.details = details || null;
  }
  if (edit.voiceChannelId !== undefined) next.voice_channel_id = edit.voiceChannelId;
  const keys = (Object.keys(next) as (keyof typeof next)[]).filter((key) => next[key] !== night[key]);
  if (!keys.length) return { game: night.game, changed: [], eventNote: '' };

  const moved = keys.includes('starts_at');
  const placed = keys.includes('voice_channel_id');
  // A moved night is reminded again, at its new time
  db.prepare(`UPDATE game_nights SET game = ?, starts_at = ?, details = ?, voice_channel_id = ?${moved ? ', reminded = 0' : ''} WHERE id = ?`).run(
    next.game,
    next.starts_at,
    next.details,
    next.voice_channel_id,
    id,
  );
  let eventNote = '';
  if (night.event_id) {
    const external = !next.voice_channel_id;
    const end = { scheduledEndTime: new Date(next.starts_at + EVENT_LENGTH) };
    await guild.scheduledEvents
      .edit(night.event_id, {
        name: `${next.game} night`.slice(0, 100),
        description: next.details?.slice(0, 1000) ?? '',
        ...(moved && { scheduledStartTime: new Date(next.starts_at) }),
        ...(placed
          ? external
            ? { entityType: GuildScheduledEventEntityType.External, channel: null, entityMetadata: { location: 'Voice chat' }, ...end }
            : { entityType: GuildScheduledEventEntityType.Voice, channel: next.voice_channel_id }
          : external && moved && end),
      })
      .catch((err) => {
        console.error(`Game night ${id} event edit:`, err.message);
        eventNote = 'The Discord event couldn’t be changed to match, so it may show the old details.';
      });
  }
  const changedNight = getNight(id)!;
  await refreshCard(client, changedNight);

  if (moved || placed) {
    const people = rsvps(id);
    const told = [...people.in, ...people.maybe].filter((user) => user !== byUserId);
    const channel = await client.channels.fetch(night.channel_id).catch(() => null);
    if (told.length && channel?.isSendable()) {
      const seconds = Math.floor(next.starts_at / 1000);
      const what = [moved && `now starts <t:${seconds}:F> (<t:${seconds}:R>)`, placed && (next.voice_channel_id ? `meets in <#${next.voice_channel_id}>` : 'has no voice channel set')].filter(Boolean).join(' and ');
      const card = night.message_id ? ` · [RSVP](https://discord.com/channels/${night.guild_id}/${night.channel_id}/${night.message_id})` : '';
      await channel
        .send({ content: `📅 **${next.game} night** ${what}: ${told.map((user) => `<@${user}>`).join(' ')}${card}`, allowedMentions: { users: told } })
        .catch((err) => console.error(`Game night ${id} change notice:`, err.message));
    }
  }
  return { game: next.game, changed: keys.map((key) => CHANGE_NAMES[key]), eventNote };
}

/** The Edit button's form, filled in with how the night is now */
function editForm(night: Night, timeZone: string) {
  const input = (id: string, label: string, style: TextInputStyle, max: number, value: string | null, required: boolean) => {
    const box = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(value ? box.setValue(value) : box);
  };
  return new ModalBuilder()
    .setCustomId(`gn:edit:${night.id}`)
    .setTitle(`Edit ${night.game} night`.slice(0, 45))
    .addComponents(
      input('game', 'Game', TextInputStyle.Short, 90, night.game, true),
      input('when', 'When (like fri 8pm, or keep this)', TextInputStyle.Short, 100, whenText(night.starts_at, timeZone), true),
      input('details', 'Details', TextInputStyle.Paragraph, 1000, night.details, false),
    );
}

export function gameNames(guildId: string): string[] {
  const played = db.prepare('SELECT DISTINCT game FROM named_plays WHERE guild_id = ?').all(guildId) as { game: string }[];
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
            .addStringOption((o) => o.setName('details').setDescription('Anything people should know').setMaxLength(1000))
            .addIntegerOption((o) =>
              o.setName('repeat').setDescription('Post the next night automatically').addChoices({ name: 'Every week', value: 7 }, { name: 'Every 2 weeks', value: 14 }),
            ),
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
          if (!nights.length) return i.reply({ content: `No game nights planned. Start one with ${commandMention(i.guildId, 'gamenight plan')}.`, flags: MessageFlags.Ephemeral });
          const lines = nights.map((n) => {
            const link = n.message_id ? ` · [RSVP](https://discord.com/channels/${n.guild_id}/${n.channel_id}/${n.message_id})` : '';
            const repeats = getSeries(n.series_id) ? ' · 🔁' : '';
            return `<t:${Math.floor(n.starts_at / 1000)}:F> · **${n.game}** · ${rsvps(n.id).in.length} in${repeats}${link}`;
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

        await i.deferReply();
        const details = i.options.getString('details');
        const voiceId = i.options.getChannel('voice')?.id ?? null;
        const everyDays = i.options.getInteger('repeat');
        const fields = { guild_id: i.guildId, channel_id: i.channelId, game, details, voice_channel_id: voiceId, starts_at: startsAt, created_by: i.user.id };
        const seriesId = everyDays ? addSeries(fields, everyDays, timeZone) : null;
        const { id, eventNote } = await addNight(i.guild, { ...fields, series_id: seriesId });

        const message = await i.editReply({ ...newNightPing(i.guildId, game), ...view(getNight(id)!) });
        db.prepare('UPDATE game_nights SET message_id = ? WHERE id = ?').run(message.id, id);
        logActivity(i.guildId, i.user.id, `Planned **${game}** night for ${describe(startsAt, timeZone)}`);
        if (eventNote) await i.followUp({ content: eventNote, flags: MessageFlags.Ephemeral });
      },
    },
  ],
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    const [, action, idText] = i.customId.split(':');
    const night = getNight(Number(idText));
    if (!night) return i.update({ components: [] });
    const canManage = i.user.id === night.created_by || i.memberPermissions.has(PermissionFlagsBits.ManageEvents);
    const [what, sure] = action.split('-');

    if (what === 'edit') {
      if (!canManage) return i.reply({ content: 'Only the host or someone with Manage Events can edit this.', flags: MessageFlags.Ephemeral });
      if (night.cancelled) return i.update({ components: [] });
      return i.showModal(editForm(night, setting(night.guild_id, 'timezone')));
    }

    if (what === 'stop' || what === 'cancel') {
      if (!canManage) return i.reply({ content: `Only the host or someone with Manage Events can ${what} this.`, flags: MessageFlags.Ephemeral });
      // Asked first, privately, as neither can be undone from the card
      if (!sure) {
        const yes = new ButtonBuilder().setCustomId(`gn:${what}-yes:${night.id}`).setLabel(what === 'cancel' ? 'Cancel the night' : 'Stop repeating').setStyle(ButtonStyle.Danger);
        return i.reply({
          content: what === 'cancel' ? `Cancel **${night.game}** night? Everyone who said they’re in is told it’s off.` : `Stop **${night.game}** night repeating? This one stays on, and no more get posted.`,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(yes)],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (what === 'stop') {
        db.prepare('DELETE FROM game_night_series WHERE id = ?').run(night.series_id);
        logActivity(night.guild_id, i.user.id, `Stopped **${night.game}** night repeating`);
        await i.update({ content: `🛑 **${night.game}** night won’t repeat.`, components: [] });
        return refreshCard(i.client, night);
      }
      if (night.cancelled) return i.update({ content: `**${night.game}** night was already cancelled.`, components: [] });
      // Deleting the Discord event can take longer than the 3 s Discord waits for an answer
      await i.deferUpdate();
      await markCancelled(i.guild, night);
      logActivity(night.guild_id, i.user.id, `Cancelled **${night.game}** night`);
      await i.editReply({ content: `❌ Cancelled **${night.game}** night.`, components: [] });
      await refreshCard(i.client, getNight(night.id)!);
      const going = rsvps(night.id).in.filter((id) => id !== i.user.id);
      if (night.starts_at > Date.now() && going.length) await i.followUp(offNotice(night, going));
      return;
    }
    if (night.cancelled) return i.update({ components: [] });

    if (!(action in RSVP)) return;
    if (night.starts_at < Date.now() - 12 * HOUR) return i.reply({ content: 'This game night is over.', flags: MessageFlags.Ephemeral });
    db.prepare(
      'INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(night_id, user_id) DO UPDATE SET status = excluded.status',
    ).run(night.id, i.user.id, action);
    return i.update(view(night));
  },
  async onModal(i) {
    if (!i.inCachedGuild()) return;
    const [, action, idText] = i.customId.split(':');
    if (action !== 'edit') return;
    const night = getNight(Number(idText));
    const canManage = night && (i.user.id === night.created_by || i.memberPermissions.has(PermissionFlagsBits.ManageEvents));
    if (!canManage) return i.reply({ content: 'Only the host or someone with Manage Events can edit this.', flags: MessageFlags.Ephemeral });
    // Moving the Discord event can take longer than the 3 s Discord waits for an answer
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const field = (id: string) => i.fields.getTextInputValue(id);
    const result = await editNight(i.client, i.guild, night.id, { game: field('game'), when: field('when'), details: field('details') }, i.user.id);
    if (result === undefined) return i.editReply('That game night is gone.');
    if (typeof result === 'string') return i.editReply(result);
    if (!result.changed.length) return i.editReply('Nothing changed.');
    logActivity(i.guildId, i.user.id, `Changed the ${result.changed.join(', ')} of **${result.game}** night`);
    return i.editReply([`✏️ Changed the ${result.changed.join(', ')}.`, result.eventNote].filter(Boolean).join(' '));
  },
  setup(client) {
    setInterval(() => void tick(client).catch(console.error), 60_000);
  },
};

/**
 * Answers for someone from the web UI, as their button on the card would, and redraws the card. Returns the night's
 * game and the answer's label when it worked, what's wrong if it didn't, or undefined when there's no such night
 */
export async function answerFor(client: Client<true>, guild: Guild, id: number, userId: string, answer: string): Promise<{ game: string; label: string } | string | undefined> {
  const night = getNight(id);
  if (!night || night.guild_id !== guild.id) return undefined;
  if (!Object.hasOwn(RSVP, answer)) return 'Answer in, maybe or out.';
  if (night.cancelled) return 'This game night was cancelled.';
  if (night.starts_at < Date.now() - 12 * HOUR) return 'This game night is over.';
  db.prepare(
    'INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, ?) ON CONFLICT(night_id, user_id) DO UPDATE SET status = excluded.status',
  ).run(night.id, userId, answer);
  await refreshCard(client, night);
  return { game: night.game, label: RSVP[answer as Status].label };
}
