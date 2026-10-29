import { config } from './config.ts';
import { db } from './db.ts';

const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

/**
 * Per-server settings: whatever /setup set, otherwise these defaults. The host can change a default for every
 * server with the env var named here; the channel and role have no env default since they only exist in one server.
 */
export const DEFAULTS = {
  announceChannel: null as string | null,
  hopOnRole: null as string | null,
  // TZ also sets the container's clock, so the host's time zone is the natural default
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  weeklyPostDay: num('WEEKLY_POST_DAY', 0), // Sunday
  weeklyPostHour: num('WEEKLY_POST_HOUR', 20),
  hopOnMinPeople: num('HOPON_MIN_PEOPLE', 2),
  hopOnCooldownMin: num('HOPON_COOLDOWN_MIN', 120),
  recapMinMinutes: num('RECAP_MIN_MINUTES', 15),
  sessionGraceMin: num('SESSION_GRACE_MIN', 5),
  steamCountry: process.env.STEAM_CC || 'us',
  freeGames: process.env.FREE_GAMES !== 'false',
  gameNightReminderMin: num('GAMENIGHT_REMINDER_MIN', 15),
};

/** Env var that sets each setting's default, for /setup show */
export const DEFAULT_ENV: Partial<Record<SettingKey, string>> = {
  timezone: 'TZ',
  weeklyPostDay: 'WEEKLY_POST_DAY',
  weeklyPostHour: 'WEEKLY_POST_HOUR',
  hopOnMinPeople: 'HOPON_MIN_PEOPLE',
  hopOnCooldownMin: 'HOPON_COOLDOWN_MIN',
  recapMinMinutes: 'RECAP_MIN_MINUTES',
  sessionGraceMin: 'SESSION_GRACE_MIN',
  steamCountry: 'STEAM_CC',
  freeGames: 'FREE_GAMES',
  gameNightReminderMin: 'GAMENIGHT_REMINDER_MIN',
};

export type SettingKey = keyof typeof DEFAULTS;
type SettingValue<K extends SettingKey> = (typeof DEFAULTS)[K];

// GUILD_ID, ANNOUNCE_CHANNEL_ID and HOPON_ROLE_ID are from the single-server version; they only seed that server once
const legacyGuild = process.env.GUILD_ID;
if (legacyGuild) {
  const seed = db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?)');
  if (process.env.ANNOUNCE_CHANNEL_ID) seed.run(legacyGuild, 'announceChannel', process.env.ANNOUNCE_CHANNEL_ID);
  if (process.env.HOPON_ROLE_ID) seed.run(legacyGuild, 'hopOnRole', process.env.HOPON_ROLE_ID);
}

/** The raw /setup value, or undefined when the server uses the default */
export function storedSetting(guildId: string, key: SettingKey): string | undefined {
  const row = db.prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?').get(guildId, key) as { value: string } | undefined;
  return row?.value;
}

export function setting<K extends SettingKey>(guildId: string, key: K): SettingValue<K> {
  const raw = storedSetting(guildId, key);
  const fallback = DEFAULTS[key];
  if (raw === undefined) return fallback;
  if (typeof fallback === 'number') return Number(raw) as SettingValue<K>;
  if (typeof fallback === 'boolean') return (raw === 'true') as SettingValue<K>;
  return raw as SettingValue<K>;
}

/** Stores a /setup value; undefined goes back to the default */
export function setSetting(guildId: string, key: SettingKey, value: string | number | boolean | null | undefined) {
  if (value === undefined) db.prepare('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?').run(guildId, key);
  else {
    db.prepare('INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?) ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value').run(
      guildId,
      key,
      value === null ? '' : String(value),
    );
  }
}

/** Channel and role settings store '' for "deliberately none", which reads back as null */
export const idSetting = (guildId: string, key: 'announceChannel' | 'hopOnRole') => setting(guildId, key) || null;

/** With ALLOWED_GUILD_IDS set, the bot leaves any other server that adds it */
export const isAllowed = (guildId: string) => !config.allowedGuildIds || config.allowedGuildIds.includes(guildId);
