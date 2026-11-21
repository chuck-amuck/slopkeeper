import { feeds } from '../changes.ts';
import { customWindow, healthNumbers, presetWindow, RANGES, slowList, type HealthNumbers, type Range } from '../features/healthReport.ts';
import { setting } from '../settings.ts';
import { type Ask, Refused, datesWindow } from './common.ts';

// How the bot and its containers are doing, for the web UI's Health tab

/**
 * Every tab showing Health asks again as each minute is kept, so each range is worked out once a minute for all of
 * them, in every server: only the slow list is a server's own. What's true now, like Discord being connected, is
 * at most this old
 */
const CACHE_MS = 15_000;
const cache = new Map<Range, { version: string; at: number; numbers: HealthNumbers }>();

/** The health feed changes for every server at once, so any server's version of it will do */
const versionNow = () => feeds.health.version('');

/** A preset range's numbers, worked out at most once every 15 seconds for every tab */
export function healthOf(range: Range, now = Date.now()): HealthNumbers {
  const version = versionNow();
  const known = cache.get(range);
  if (known && known.version === version && now - known.at < CACHE_MS) return known.numbers;
  const numbers = healthNumbers(presetWindow(range, now));
  cache.set(range, { version, at: now, numbers });
  return numbers;
}

export async function healthRoutes({ guild, req, url, rest }: Ask) {
  if (rest.length || req.method !== 'GET') throw new Refused(404, 'Not found.');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const days = datesWindow(url, setting(guild.id, 'timezone'));
  let numbers: HealthNumbers;
  if (days || from !== null || to !== null) {
    // Any stretch of the last 30 days, as whole days or milliseconds; asked for less often than the presets, so not kept
    const window = days ? customWindow(days.since, days.until) : customWindow(Number(from), Number(to ?? Date.now()));
    if (typeof window === 'string') throw new Refused(400, window);
    numbers = healthNumbers(window);
  } else {
    const range = url.searchParams.get('range') ?? '24h';
    if (!Object.hasOwn(RANGES, range)) throw new Refused(400, `Pick a range: ${Object.keys(RANGES).join(', ')}.`);
    numbers = healthOf(range as Range);
  }
  const end = numbers.start + numbers.step * numbers.points;
  return { version: feeds.health.version(guild.id), timeZone: setting(guild.id, 'timezone'), ...numbers, slow: slowList(guild.id, numbers.start, end) };
}
