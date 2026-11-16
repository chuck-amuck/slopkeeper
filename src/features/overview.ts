import { db } from '../db.ts';
import { gameName } from '../gameNames.ts';
import { zonedParts, zonedTimeToUtc } from '../util.ts';

/**
 * The web UI's Stats overview: a period cut into steps for its charts, time spread across them, and when in the week
 * people are on. Everything here works on rows already read, so one read of a period serves every part
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Every time zone's offset is a whole number of quarter hours, so a quarter never straddles a local hour */
const QUARTER = 15 * MINUTE;

export type Step = 'hour' | 'day' | 'week' | 'month';

/** A period in steps: each starts where the last ended, and the last ends at or after the period does */
export interface Steps {
  step: Step;
  starts: number[];
  ends: number[];
}

interface Span {
  start: number;
  end: number;
}

interface PersonSpan extends Span {
  userId: string;
}

/**
 * The steps that suit a period's length: hours up to 2 days, then days up to 45, weeks up to 400 and months beyond.
 * Each starts on the hour, or at midnight in the time zone. Every step is listed, so a quiet one shows as a gap
 */
export function stepsOf(first: number, until: number, timeZone: string): Steps {
  const days = (until - first) / DAY;
  const step: Step = days <= 2 ? 'hour' : days <= 45 ? 'day' : days <= 400 ? 'week' : 'month';
  const { year, month, day, hour } = zonedParts(first, timeZone);
  const top = step === 'hour' ? zonedTimeToUtc(year, month, day, hour, 0, timeZone) : 0;
  const boundary = (i: number) => {
    if (step === 'hour') return top + i * HOUR;
    if (step === 'month') return zonedTimeToUtc(year, month + i, 1, 0, 0, timeZone);
    return zonedTimeToUtc(year, month, day + i * (step === 'week' ? 7 : 1), 0, 0, timeZone);
  };
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; boundary(i) < until; i++) {
    starts.push(boundary(i));
    ends.push(boundary(i + 1));
  }
  return { step, starts, ends };
}

/** The step a moment falls in, or the first one for a moment before it */
function stepAt(steps: Steps, at: number) {
  let lo = 0;
  let hi = steps.starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps.starts[mid] <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** How much of each step the spans cover, in ms. `weight` spreads an amount over a span instead, in proportion */
export function spread(spans: (Span & { weight?: number })[], steps: Steps): number[] {
  const out = steps.starts.map(() => 0);
  for (const { start, end, weight } of spans) {
    if (end <= start) {
      // A moment, or a span with no length: all of it goes in its step
      if (weight !== undefined && start >= (steps.starts[0] ?? Infinity)) out[stepAt(steps, start)] += weight;
      continue;
    }
    for (let i = stepAt(steps, start); i < out.length && steps.starts[i] < end; i++) {
      const covered = Math.max(0, Math.min(end, steps.ends[i]) - Math.max(start, steps.starts[i]));
      out[i] += weight === undefined ? covered : (weight * covered) / (end - start);
    }
  }
  return out;
}

/** How many of the moments fall in each step */
export function countIn(times: number[], steps: Steps): number[] {
  const out = steps.starts.map(() => 0);
  for (const at of times) if (out.length && at >= steps.starts[0] && at < steps.ends.at(-1)!) out[stepAt(steps, at)]++;
  return out;
}

/** How many different people were on in each step */
export function peopleIn(spans: PersonSpan[], steps: Steps): number[] {
  const sets = steps.starts.map(() => new Set<string>());
  for (const { userId, start, end } of spans) {
    for (let i = stepAt(steps, start); i < sets.length && steps.starts[i] < end; i++) if (end > steps.starts[i]) sets[i].add(userId);
  }
  return sets.map((s) => s.size);
}

/** Each person's spans with overlaps joined, so someone in two games at once, or playing in voice, counts once */
function joinedByPerson(spans: PersonSpan[]): Span[] {
  const byPerson = Map.groupBy(spans, (s) => s.userId);
  const out: Span[] = [];
  for (const mine of byPerson.values()) {
    const sorted = mine.map((s) => ({ start: s.start, end: s.end })).sort((a, b) => a.start - b.start);
    const joined: Span[] = [];
    for (const s of sorted) {
      const last = joined.at(-1);
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else joined.push(s);
    }
    out.push(...joined);
  }
  return out;
}

/**
 * Finds the weekday (Monday first) and hour of a moment in a time zone, as 0–167. The zone's offset is looked up
 * once a day, and every quarter hour only on a day it changes
 */
function slotFinder(timeZone: string) {
  const offsetAt = (ms: number) => {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE) * MINUTE;
  };
  const daily = new Map<number, number | null>();
  return (ms: number) => {
    const day = Math.floor(ms / DAY);
    let offset = daily.get(day);
    if (offset === undefined) {
      const atStart = offsetAt(day * DAY);
      offset = atStart === offsetAt(day * DAY + DAY - 1) ? atStart : null;
      daily.set(day, offset);
    }
    const local = ms + (offset ?? offsetAt(ms));
    // 1 January 1970 was a Thursday, the fourth day of a week from Monday
    const weekday = (Math.floor(local / DAY) + 3) % 7;
    return weekday * 24 + Math.floor((local - Math.floor(local / DAY) * DAY) / HOUR);
  };
}

/** Calls `each(slot, ms)` for each piece of a span, cut at quarter hours */
function byQuarter(start: number, end: number, slotOf: (ms: number) => number, each: (slot: number, ms: number) => void) {
  for (let at = start; at < end; ) {
    const next = Math.min(end, (Math.floor(at / QUARTER) + 1) * QUARTER);
    each(slotOf(at), next - at);
    at = next;
  }
}

/**
 * When people are on: for each weekday (Monday first) and hour in the time zone, how many people were on at once
 * on average over the period. Null for an hour the period doesn't include
 */
export function whenOn(spans: PersonSpan[], first: number, until: number, timeZone: string): (number | null)[][] {
  const slotOf = slotFinder(timeZone);
  const personMs = new Array<number>(168).fill(0);
  const slotMs = new Array<number>(168).fill(0);
  for (const s of joinedByPerson(spans)) byQuarter(Math.max(s.start, first), Math.min(s.end, until), slotOf, (slot, ms) => (personMs[slot] += ms));
  byQuarter(first, until, slotOf, (slot, ms) => (slotMs[slot] += ms));
  const people = personMs.map((ms, i) => (slotMs[i] ? Math.round((ms / slotMs[i]) * 100) / 100 : null));
  return Array.from({ length: 7 }, (_, day) => people.slice(day * 24, day * 24 + 24));
}

/** Sounds played in a period, by one person if given */
export function soundTimes(guildId: string, since: number, until: number, user?: string): number[] {
  const rows = db
    .prepare(`SELECT played_at AS at FROM sound_plays WHERE guild_id = ? AND played_at >= ? AND played_at < ?${user ? ' AND user_id = ?' : ''}`)
    .all(guildId, since, until, ...(user ? [user] : [])) as { at: number }[];
  return rows.map((r) => r.at);
}

/** Game nights that weren't cancelled, starting in a period: those one person said they're in for, or of one game */
export function nightTimes(guildId: string, since: number, until: number, user?: string, game?: string): number[] {
  const rows = db
    .prepare(
      `SELECT n.starts_at AS at, n.game FROM game_nights n
       ${user ? "JOIN game_night_rsvps r ON r.night_id = n.id AND r.user_id = ? AND r.status = 'in'" : ''}
       WHERE n.guild_id = ? AND n.cancelled = 0 AND n.starts_at >= ? AND n.starts_at < ?`,
    )
    .all(...(user ? [user] : []), guildId, since, until) as { at: number; game: string }[];
  const named = game && gameName(guildId, game).toLowerCase();
  return rows.filter((r) => !named || gameName(guildId, r.game).toLowerCase() === named).map((r) => r.at);
}

/** Each time someone was in voice, clipped to a period, by one person if given */
export function voiceStints(guildId: string, since: number, until: number, user?: string): PersonSpan[] {
  return db
    .prepare(
      `SELECT user_id AS userId, MAX(joined_at, :since) AS start, MIN(left_at, :until) AS end FROM voice_stints
       WHERE guild_id = :guild AND left_at > :since AND joined_at < :until${user ? ' AND user_id = :user' : ''}`,
    )
    .all({ guild: guildId, since, until, ...(user ? { user } : {}) }) as unknown as PersonSpan[];
}

/**
 * Voice sessions started in a period, as the voice totals count them: each person's time in each one and when the
 * session ran, by one person if given
 */
export function sessionTime(guildId: string, since: number, until: number, user?: string): (PersonSpan & { weight: number })[] {
  return db
    .prepare(
      `SELECT sm.user_id AS userId, s.started_at AS start, s.ended_at AS end, sm.seconds * 1000 AS weight
       FROM session_members sm JOIN sessions s ON s.id = sm.session_id
       WHERE s.guild_id = :guild AND s.started_at >= :since AND s.started_at < :until${user ? ' AND sm.user_id = :user' : ''}`,
    )
    .all({ guild: guildId, since, until, ...(user ? { user } : {}) }) as unknown as (PersonSpan & { weight: number })[];
}

/** When the server's first game, session or sound was recorded, or null with none */
export function recordsFrom(guildId: string): number | null {
  const row = db
    .prepare(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(started_at) AS at FROM game_plays WHERE guild_id = :guild
         UNION ALL SELECT MIN(started_at) FROM sessions WHERE guild_id = :guild
         UNION ALL SELECT MIN(played_at) FROM sound_plays WHERE guild_id = :guild
         UNION ALL SELECT MIN(joined_at) FROM voice_stints WHERE guild_id = :guild)`,
    )
    .get({ guild: guildId }) as { at: number | null };
  return row.at;
}

/** When the bot started noting everyone's time in voice, or null before it has */
export function voiceFrom(guildId: string): number | null {
  return (db.prepare('SELECT MIN(joined_at) AS at FROM voice_stints WHERE guild_id = ?').get(guildId) as { at: number | null }).at;
}
