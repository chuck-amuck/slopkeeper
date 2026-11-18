// Reminders people ask chat for: "remind me in 20 minutes to check the oven", "remind Sam and me friday at 8 about the
// raid". Each is posted in the channel it was asked in, pinging only the people it's for. They're checked every 30
// seconds; one that came due while the bot was down is posted when it's back if that's within the hour, and dropped
// after that, as a reminder that late is no use

import type Anthropic from '@anthropic-ai/sdk';
import { type Client, type Guild, type GuildMember, type GuildTextBasedChannel, PermissionFlagsBits } from 'discord.js';
import { logActivity } from '../activity.ts';
import { db } from '../db.ts';
import { setting } from '../settings.ts';
import { listNames, zonedParts } from '../util.ts';
import { nameOf, object, peopleNamed } from './chatLookups.ts';
import { describe, parseWhen } from './gamenight.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const CHECK_EVERY = 30_000;
/** Posted this late at most, after the bot was down */
const LATEST = HOUR;
const FURTHEST_AHEAD = 30 * DAY;
/** Waiting at once, for each person who sets them */
const MOST_OPEN = 10;
const MOST_PEOPLE = 5;
const LONGEST_TEXT = 300;

interface Reminder {
  id: number;
  guild_id: string;
  channel_id: string;
  created_by: string;
  /** JSON list of the ids it pings */
  people: string;
  text: string;
  due_at: number;
  created_at: number;
}
const peopleOf = (r: Reminder) => JSON.parse(r.people) as string[];
const names = (guild: Guild, ids: string[]) => listNames(ids.map((id) => nameOf(guild, id)));

export const reminderTools = (): Anthropic.Tool[] => [
  {
    name: 'set_reminder',
    description:
      'Sets a reminder, posted in this channel at that time and pinging the people it’s for: the person asking, or those they name (at most 5 people, never a role or everyone). Up to 30 days ahead.',
    strict: true,
    input_schema: object({
      when: { type: 'string', description: 'A wait like “in 20 minutes”, “in 2 hours” or “in 3 days”, or a day and time like “fri 9pm”, “tomorrow 9am” or “nov 3 7pm”' },
      about: { type: 'string', description: 'What to remind them of, in a few words, like “check the oven”' },
      people: { type: 'array', items: { type: 'string' }, description: 'Who it’s for, by display name or “me”; empty for just the person asking' },
    }),
  },
  {
    name: 'reminders',
    description: 'Lists the reminders waiting that the person asking set or that are for them: each one’s id, time, who it’s for and who set it.',
    strict: true,
    input_schema: object({}),
  },
  {
    name: 'cancel_reminder',
    description: 'Cancels a reminder the person asking set. One someone else set for them, it takes them off.',
    strict: true,
    input_schema: object({ reminder_id: { type: 'integer', description: 'The reminder’s id from reminders' } }),
  },
];

export async function remind(member: GuildMember, name: string, input: Record<string, unknown>, where: GuildTextBasedChannel | null, text: (key: string) => string): Promise<string | null> {
  switch (name) {
    case 'set_reminder':
      return setReminder(member, text('when'), text('about'), input.people, where);
    case 'reminders':
      return listFor(member);
    case 'cancel_reminder':
      return cancelFor(member, Number(input.reminder_id));
    default:
      return null;
  }
}

/** How long until then, roughly, as it's said */
function inWords(ms: number): string {
  if (ms <= 0) return 'due now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `in ${plural(Math.max(1, minutes), 'minute')}`;
  if (minutes < 48 * 60) return `in ${plural(Math.floor(minutes / 60), 'hour')}${minutes % 60 ? ` ${plural(minutes % 60, 'minute')}` : ''}`;
  return `in ${plural(Math.round(ms / DAY), 'day')}`;
}

const UNITS: Record<string, number> = { m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE, h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR, d: DAY, day: DAY, days: DAY, w: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY };

/** A wait in ms and what's left after it, or null if the text doesn't start with one */
function splitWait(text: string): { wait: number; rest: string } | null {
  const wait = /^in\s+(.+)$/i.exec(text.trim())?.[1]?.toLowerCase().replace(/,|\band\b/g, ' ');
  if (!wait) return null;
  let total = 0;
  const rest = wait.replace(/(\d+(?:\.\d+)?|an?|one)\s*([a-z]+)/g, (part, count: string, unit: string) => {
    if (!UNITS[unit]) return part;
    total += (/^\d/.test(count) ? Number(count) : 1) * UNITS[unit]!;
    return ' ';
  });
  return total ? { wait: Math.round(total), rest: rest.trim() } : null;
}

/** A wait like “in 20 minutes”, “in 1 hour 30 minutes”, “in 2h” or “in a day”, in ms, or null if it isn't one */
export function readWait(text: string): number | null {
  const split = splitWait(text);
  return split && !split.rest ? split.wait : null;
}

/** “in 2 days at 9am”: that many days ahead, at that time there */
function daysAheadAt(said: string, now: number, timeZone: string): number | null {
  const split = splitWait(said);
  if (!split?.rest || split.wait % DAY) return null;
  const day = zonedParts(now + split.wait, timeZone);
  return parseWhen(`${day.year}-${day.month}-${day.day} ${split.rest}`, now, timeZone);
}

/** When a reminder is due, from a wait or a day and time, or what's wrong with it */
export function readReminderTime(guildId: string, said: string, now = Date.now()): { at: number; label: string } | string {
  const timeZone = setting(guildId, 'timezone');
  const wait = readWait(said);
  const at = wait !== null ? now + wait : (daysAheadAt(said, now, timeZone) ?? parseWhen(said.slice(0, 100), now, timeZone));
  if (at === null) return `“${said}” isn’t a time it can read. Give it like “in 20 minutes”, “in 2 hours”, “fri 9pm” or “tomorrow 9am”, or ask them when.`;
  if (at < now + MINUTE) return 'That’s less than a minute away, or already passed.';
  if (at > now + FURTHEST_AHEAD) return 'A reminder can be at most 30 days ahead.';
  return { at, label: `${describe(at, timeZone)} (${inWords(at - now)})` };
}

async function setReminder(member: GuildMember, when: string, about: string, said: unknown, where: GuildTextBasedChannel | null): Promise<string> {
  const { guild } = member;
  if (!where) return 'There’s nowhere here to post it.';
  if (!about) return 'Ask what to remind them of.';
  if (about.length > LONGEST_TEXT) return `Put what to remind them of in ${LONGEST_TEXT} characters or fewer.`;
  if (!when) return 'They didn’t say when: ask them.';
  const time = readReminderTime(guild.id, when);
  if (typeof time === 'string') return time;
  const named = peopleNamed(member, said);
  if (typeof named === 'string') return named;
  const people = named ?? [member];
  if (people.length > MOST_PEOPLE) return `A reminder can be for ${MOST_PEOPLE} people at most.`;
  const blind = people.filter((p) => !where.permissionsFor(p)?.has(PermissionFlagsBits.ViewChannel));
  if (blind.length) return `${listNames(blind.map((p) => p.displayName))} can’t see this channel, so the reminder wouldn’t reach them. Ask them to set it somewhere they can see.`;
  const open = (db.prepare('SELECT COUNT(*) AS n FROM chat_reminders WHERE guild_id = ? AND created_by = ?').get(guild.id, member.id) as { n: number }).n;
  if (open >= MOST_OPEN) return `${member.displayName} has ${MOST_OPEN} reminders waiting already, the most there can be. They can cancel one first.`;
  const ids = people.map((p) => p.id);
  const id = Number(
    db
      .prepare('INSERT INTO chat_reminders (guild_id, channel_id, created_by, people, text, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(guild.id, where.id, member.id, JSON.stringify(ids), about, time.at, Date.now()).lastInsertRowid,
  );
  const forWhom = ids.length === 1 && ids[0] === member.id ? member.displayName : names(guild, ids);
  logActivity(guild.id, member.id, `Set a reminder for ${forWhom} for ${time.label.replace(/ \(.*\)$/, '')}`);
  return `Set reminder ${id} for ${forWhom}, ${time.label}: “${about}”. It’s posted here then, pinging ${ids.length === 1 ? 'them' : 'each of them'}.`;
}

function listFor(member: GuildMember): string {
  const { guild } = member;
  const rows = db
    .prepare('SELECT * FROM chat_reminders WHERE guild_id = ? AND (created_by = ? OR EXISTS (SELECT 1 FROM json_each(people) WHERE value = ?)) ORDER BY due_at')
    .all(guild.id, member.id, member.id) as unknown as Reminder[];
  if (!rows.length) return `No reminders are waiting that ${member.displayName} set or that are for them.`;
  const timeZone = setting(guild.id, 'timezone');
  return rows
    .map((r) => {
      const where = guild.channels.cache.get(r.channel_id)?.name;
      return `reminder ${r.id}: ${describe(r.due_at, timeZone)} (${inWords(r.due_at - Date.now())}), for ${names(guild, peopleOf(r))}, set by ${nameOf(guild, r.created_by)}${where ? ` in #${where}` : ''}: ${r.text}`;
    })
    .join('\n');
}

const getReminder = (guildId: string, id: number) => db.prepare('SELECT * FROM chat_reminders WHERE id = ? AND guild_id = ?').get(id, guildId) as Reminder | undefined;

function cancelFor(member: GuildMember, id: number): string {
  const { guild } = member;
  const reminder = getReminder(guild.id, id);
  if (!reminder) return 'There’s no reminder waiting with that id. reminders lists them.';
  const people = peopleOf(reminder);
  if (reminder.created_by === member.id) {
    db.prepare('DELETE FROM chat_reminders WHERE id = ?').run(id);
    logActivity(guild.id, member.id, `Cancelled a reminder for ${names(guild, people)}`);
    return `Cancelled reminder ${id}: “${reminder.text}”.`;
  }
  if (!people.includes(member.id)) return `Only ${nameOf(guild, reminder.created_by)}, who set it, can cancel it.`;
  const left = people.filter((p) => p !== member.id);
  if (left.length) db.prepare('UPDATE chat_reminders SET people = ? WHERE id = ?').run(JSON.stringify(left), id);
  else db.prepare('DELETE FROM chat_reminders WHERE id = ?').run(id);
  logActivity(guild.id, member.id, `Took themselves off a reminder from ${nameOf(guild, reminder.created_by)}`);
  return `Took ${member.displayName} off reminder ${id}${left.length ? `. It still reminds ${names(guild, left)}.` : ', so it’s cancelled.'}`;
}

/** What's posted when it's due */
export function reminderText(guild: Guild, reminder: Reminder, now: number): string {
  const people = peopleOf(reminder);
  const pings = people.map((id) => `<@${id}>`).join(' ');
  const late = now - reminder.due_at > 2 * CHECK_EVERY ? `\n-# ${inWords(now - reminder.due_at).replace(/^in /, '')} late, as the bot was offline` : '';
  // Said to everyone pinged, the one who set it among them
  const from = people.length === 1 && people[0] === reminder.created_by ? ', you asked me to remind you' : `: a reminder from ${nameOf(guild, reminder.created_by)}`;
  return `⏰ ${pings}${from}: ${reminder.text}${late}`;
}

/** Discord's errors carry a number, and asking again won't change them. A network failure is worth trying again */
const fromDiscord = (err: unknown) => typeof (err as { code?: unknown })?.code === 'number';

/** Posts the reminders that are due */
export async function sendDue(client: Client, now = Date.now()) {
  const due = db.prepare('SELECT * FROM chat_reminders WHERE due_at <= ? ORDER BY due_at').all(now) as unknown as Reminder[];
  const drop = (r: Reminder, why: string) => {
    db.prepare('DELETE FROM chat_reminders WHERE id = ?').run(r.id);
    console.log(`Chat reminder ${r.id} in server ${r.guild_id} is dropped: ${why}`);
  };
  for (const reminder of due) {
    if (now - reminder.due_at > LATEST) {
      drop(reminder, 'it’s over an hour late');
      continue;
    }
    let channel;
    try {
      channel = await client.channels.fetch(reminder.channel_id);
    } catch (err) {
      // Gone, or the bot can't see it; otherwise Discord didn't answer, and the next tick tries again
      if (!fromDiscord(err)) {
        console.error(`Chat reminder ${reminder.id}’s channel couldn’t be fetched, so it’s tried again:`, err);
        continue;
      }
    }
    if (!channel?.isSendable() || channel.isDMBased()) {
      drop(reminder, 'its channel is gone, or the bot can’t post there');
      continue;
    }
    const people = peopleOf(reminder);
    try {
      await channel.send({ content: reminderText(channel.guild, reminder, now), allowedMentions: { users: people } });
      db.prepare('DELETE FROM chat_reminders WHERE id = ?').run(reminder.id);
    } catch (err) {
      if (fromDiscord(err)) drop(reminder, `Discord refused it (${(err as Error).message})`);
      else console.error(`Chat reminder ${reminder.id} couldn’t be posted, so it’s tried again:`, err);
    }
  }
}

/** For the web UI: every reminder waiting in a server, soonest first */
export function chatReminders(guild: Guild) {
  const timeZone = setting(guild.id, 'timezone');
  const rows = db.prepare('SELECT * FROM chat_reminders WHERE guild_id = ? ORDER BY due_at').all(guild.id) as unknown as Reminder[];
  return rows.map((r) => ({
    id: r.id,
    at: r.due_at,
    when: describe(r.due_at, timeZone),
    text: r.text,
    by: nameOf(guild, r.created_by),
    people: peopleOf(r).map((id) => nameOf(guild, id)),
    channel: guild.channels.cache.get(r.channel_id)?.name ?? null,
  }));
}

/** Cancels one from the web UI. Returns who it was for, or null if this server has no such reminder */
export function cancelReminder(guild: Guild, id: number): string | null {
  const reminder = getReminder(guild.id, id);
  if (!reminder) return null;
  db.prepare('DELETE FROM chat_reminders WHERE id = ?').run(id);
  return names(guild, peopleOf(reminder));
}
