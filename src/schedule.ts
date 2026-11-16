// Repeating jobs, and posts each server gets once a day, week or month at its own hour

import { getKv, setKv } from './db.ts';
import { setting } from './settings.ts';
import { zonedParts, zonedTimeToUtc } from './util.ts';

const timers = new Set<NodeJS.Timeout>();
// Discord's and Steam's calls give up long before this, so a run this old is stuck, and the next shouldn't wait on it forever
const STUCK_MS = 10 * 60_000;
const DAY = 86_400_000;

export interface Repeating {
  /** Runs the job now, unless it's already running */
  run(): Promise<void>;
  stop(): void;
}

/**
 * Runs `job` every `ms`, never two at once: a tick that finds the last run still going skips, unless that run is stuck,
 * which is after `stuck` (10 minutes unless said). A failure is logged under `name` and the next tick goes ahead. The
 * timers don't keep the process alive, and {@link stopTimers} stops them all when the bot exits. `first` waits that long
 * before the first run, `now` runs at once
 */
export function every(name: string, ms: number, job: () => unknown, { first, now = false, stuck = STUCK_MS }: { first?: number; now?: boolean; stuck?: number } = {}): Repeating {
  let running = 0;
  const mine = new Set<NodeJS.Timeout>();
  const run = async () => {
    if (running && Date.now() - running < Math.max(stuck, ms)) return;
    if (running) console.error(`${name}: the last run never finished, so this one goes ahead`);
    const started = (running = Date.now());
    try {
      await job();
    } catch (err) {
      console.error(`${name} failed:`, err);
    } finally {
      if (running === started) running = 0;
    }
  };
  const keep = (timer: NodeJS.Timeout) => {
    timer.unref();
    mine.add(timer);
    timers.add(timer);
  };
  const repeat = () => keep(setInterval(() => void run(), ms));
  if (first === undefined) repeat();
  else {
    const wait = setTimeout(() => {
      mine.delete(wait);
      timers.delete(wait);
      void run();
      repeat();
    }, first);
    keep(wait);
  }
  if (now) void run();
  return {
    run,
    stop() {
      for (const timer of mine) {
        clearInterval(timer);
        timers.delete(timer);
      }
      mine.clear();
    },
  };
}

/** Stops every repeating job, so none starts while the bot is exiting */
export function stopTimers() {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
}

export type Period = 'day' | 'week' | 'month';

export interface Due {
  /** Which day, week or month it is, as stored once its post is made: "2026-11-16" (the post day), or "2026-11" */
  period: string;
  /** The moment it came due */
  at: number;
}

/**
 * The day, week or month a server's post is due for, once its hour has come in its time zone, or null before then.
 * A week is due from its post day's hour until the next one, and a month from the 1st at the hour. `weekday` is the
 * week's post day, 0 for Sunday
 */
export function due(guildId: string, every: Period, hour: number, { weekday = 0, now = Date.now() }: { weekday?: number; now?: number } = {}): Due | null {
  const timeZone = setting(guildId, 'timezone');
  const today = zonedParts(now, timeZone);
  if (every === 'month') {
    if (today.day === 1 && today.hour < hour) return null;
    return { period: `${today.year}-${today.month}`, at: zonedTimeToUtc(today.year, today.month, 1, hour, 0, timeZone) };
  }
  let back = 0;
  if (every === 'week') {
    back = (today.weekday - weekday + 7) % 7;
    if (back === 0 && today.hour < hour) back = 7;
  } else if (today.hour < hour) return null;
  // Counted on the calendar rather than in hours, so a day that's 23 or 25 hours long can't skip or repeat a date
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
  const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
  return { period: `${y}-${m}-${d}`, at: zonedTimeToUtc(y, m, d, hour, 0, timeZone) };
}

/** A day's period as a time, to tell how far apart two are, or NaN for a month's */
const dayOf = (period: string) => {
  const [y, m, d] = period.split('-').map(Number);
  return d === undefined ? NaN : Date.UTC(y, m - 1, d);
};

/**
 * Makes a post once in its period, marked afterwards so one that fails is tried again at the next check. `post` returns
 * false to be tried again too, as when there's nowhere to post yet.
 *
 * A weekly post says `late` and `apart`: one the bot missed, as it was down, still goes out up to `late` after it was
 * due, and one that'd come less than `apart` after the last, as the post day moved, is taken as made
 */
export async function once(key: string, when: Due | null, post: (at: number) => Promise<boolean | void>, { late = Infinity, apart = 0 }: { late?: number; apart?: number } = {}) {
  if (!when) return;
  const last = getKv(key);
  if (last === when.period) return;
  const skip = Date.now() - when.at > late || (!!last && Math.abs(dayOf(when.period) - dayOf(last)) < apart);
  if (skip || (await post(when.at)) !== false) setKv(key, when.period);
}

/** How a weekly post catches up: within a day of being missed, and never twice in six days */
export const WEEKLY = { late: DAY, apart: 6 * DAY } as const;
