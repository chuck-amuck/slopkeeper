import { config } from './config.ts';
import { db } from './db.ts';

export interface GuildSettings {
  announceChannelId: string | null;
  hopOnRoleId: string | null;
}

// Settings are set per server with /setup. GUILD_ID, ANNOUNCE_CHANNEL_ID and HOPON_ROLE_ID are from before that
// existed: they only seed that one server's settings, once, so an old .env keeps working
const legacyGuild = process.env.GUILD_ID;
if (legacyGuild) {
  db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id, announce_channel_id, hopon_role_id) VALUES (?, ?, ?)').run(
    legacyGuild,
    process.env.ANNOUNCE_CHANNEL_ID || null,
    process.env.HOPON_ROLE_ID || null,
  );
}

export function guildSettings(guildId: string): GuildSettings {
  const row = db.prepare('SELECT announce_channel_id, hopon_role_id FROM guild_settings WHERE guild_id = ?').get(guildId) as
    | { announce_channel_id: string | null; hopon_role_id: string | null }
    | undefined;
  return { announceChannelId: row?.announce_channel_id ?? null, hopOnRoleId: row?.hopon_role_id ?? null };
}

export function setGuildSetting(guildId: string, key: 'announce_channel_id' | 'hopon_role_id', value: string | null) {
  db.prepare(`INSERT INTO guild_settings (guild_id, ${key}) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET ${key} = excluded.${key}`).run(
    guildId,
    value,
  );
}

/** With ALLOWED_GUILD_IDS set, the bot leaves any other server that adds it */
export const isAllowed = (guildId: string) => !config.allowedGuildIds || config.allowedGuildIds.includes(guildId);
