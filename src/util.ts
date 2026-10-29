import { ActivityType, type Client, type Guild, type GuildMember, type SendableChannels, type VoiceBasedChannel } from 'discord.js';
import { idSetting, isAllowed } from './settings.ts';

export function humansIn(channel: VoiceBasedChannel): GuildMember[] {
  return [...channel.members.values()].filter((m) => !m.user.bot);
}

export function playingGames(member: GuildMember): string[] {
  return (member.presence?.activities ?? []).filter((a) => a.type === ActivityType.Playing).map((a) => a.name);
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Servers the bot works in: every one it's in, minus any it's leaving for not being allowed */
export function servedGuilds(client: Client<true>): Guild[] {
  return [...client.guilds.cache.values()].filter((g) => isAllowed(g.id));
}

/** The server's announce channel, or null if /setup hasn't picked one (or it's gone) */
export async function announceChannel(client: Client<true>, guildId: string): Promise<SendableChannels | null> {
  const id = idSetting(guildId, 'announceChannel');
  if (!id) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  if (channel?.isSendable()) return channel;
  console.error(`Announce channel ${id} in server ${guildId} is gone or the bot can't post there; run /setup announce-channel`);
  return null;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock date and time of an instant in a time zone */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** The instant a wall-clock time happens in a time zone (month is 1-based; day may overflow into the next month) */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (ms: number) => {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  // Second pass corrects for a DST change between the guess and the answer
  const guess = asUtc - offset(asUtc);
  return asUtc - offset(guess);
}

/** YYYY-MM-DD of an instant in a time zone */
export function zonedDate(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
