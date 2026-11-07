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
  // Off until a server turns it on, since not every server wants a post every few days
  freeGames: process.env.FREE_GAMES === 'true',
  // Unset posts free games in the announce channel
  freeGamesChannel: null as string | null,
  // Most giveaways are filler, so an alert only goes out for one that looks worth having
  freeGamesMinRating: num('FREE_GAMES_MIN_RATING', 70),
  freeGamesTaste: process.env.FREE_GAMES_TASTE !== 'false',
  freeGamesMultiplayer: process.env.FREE_GAMES_MULTIPLAYER === 'true',
  freeGamesUnlisted: process.env.FREE_GAMES_UNLISTED === 'true',
  // Steam is always running a small sale on something, so an alert waits for one worth mentioning
  saleMinDiscount: num('SALE_MIN_DISCOUNT', 25),
  saleSteamWishlists: process.env.SALE_STEAM_WISHLISTS !== 'false',
  steamStatus: process.env.STEAM_STATUS !== 'false',
  patchNotes: process.env.PATCH_NOTES || 'off',
  patchNotesChannel: null as string | null,
  // Unset posts sales in the announce channel
  saleChannel: null as string | null,
  gameNightReminderMin: num('GAMENIGHT_REMINDER_MIN', 15),
  monthlyRecap: process.env.MONTHLY_RECAP !== 'false',
  evenVolume: process.env.EVEN_VOLUME !== 'false',
  // Nothing plays until someone picks a sound for themselves, so this can default to on
  joinSounds: process.env.JOIN_SOUNDS !== 'false',
  joinSoundCooldownMin: num('JOIN_SOUND_COOLDOWN_MIN', 10),
  joinSoundDelayMs: num('JOIN_SOUND_DELAY_MS', 500),
  // Unset lets everyone change sounds
  soundManagerRole: null as string | null,
  tts: process.env.TTS !== 'false',
  // Unset lets everyone use it
  ttsRole: null as string | null,
  ttsMaxChars: num('TTS_MAX_CHARS', 200),
  ttsCooldownSec: num('TTS_COOLDOWN_SEC', 5),
  ttsVoice: process.env.TTS_VOICE || '5',
  // The voices run a little fast at their natural speed
  ttsSpeed: num('TTS_SPEED', 85),
  // 100 is about as loud as a sound with Even volume on
  ttsVolume: num('TTS_VOLUME', 100),
  // Unset reads nothing out
  ttsChannel: null as string | null,
  ttsChannelWho: process.env.TTS_CHANNEL_WHO || 'everyone',
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
  freeGamesMinRating: 'FREE_GAMES_MIN_RATING',
  freeGamesTaste: 'FREE_GAMES_TASTE',
  freeGamesMultiplayer: 'FREE_GAMES_MULTIPLAYER',
  freeGamesUnlisted: 'FREE_GAMES_UNLISTED',
  saleMinDiscount: 'SALE_MIN_DISCOUNT',
  saleSteamWishlists: 'SALE_STEAM_WISHLISTS',
  steamStatus: 'STEAM_STATUS',
  patchNotes: 'PATCH_NOTES',
  gameNightReminderMin: 'GAMENIGHT_REMINDER_MIN',
  monthlyRecap: 'MONTHLY_RECAP',
  evenVolume: 'EVEN_VOLUME',
  joinSounds: 'JOIN_SOUNDS',
  joinSoundCooldownMin: 'JOIN_SOUND_COOLDOWN_MIN',
  joinSoundDelayMs: 'JOIN_SOUND_DELAY_MS',
  tts: 'TTS',
  ttsMaxChars: 'TTS_MAX_CHARS',
  ttsCooldownSec: 'TTS_COOLDOWN_SEC',
  ttsVoice: 'TTS_VOICE',
  ttsSpeed: 'TTS_SPEED',
  ttsVolume: 'TTS_VOLUME',
  ttsChannelWho: 'TTS_CHANNEL_WHO',
};

export type SettingKey = keyof typeof DEFAULTS;
type SettingValue<K extends SettingKey> = (typeof DEFAULTS)[K];

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

export type IdSettingKey = 'announceChannel' | 'hopOnRole' | 'freeGamesChannel' | 'saleChannel' | 'patchNotesChannel' | 'soundManagerRole' | 'ttsRole' | 'ttsChannel';

/** Channel and role settings store '' for "deliberately none", which reads back as null */
export const idSetting = (guildId: string, key: IdSettingKey) => setting(guildId, key) || null;

/** With ALLOWED_GUILD_IDS set, the bot leaves any other server that adds it */
export const isAllowed = (guildId: string) => !config.allowedGuildIds || config.allowedGuildIds.includes(guildId);
