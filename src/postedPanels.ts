import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild } from 'discord.js';
import { db } from './db.ts';

/** The tables of panels posted in channels, which the bot keeps up to date */
export type PanelTable = 'sound_panels' | 'music_panels';

export interface PostedPanel {
  messageId: string;
  channelId: string;
  /** The channel's name, or null for one the bot can't see */
  channel: string | null;
  url: string;
}

/** The panels posted in a server, oldest first, with a link to each */
export function postedPanels(guild: Guild, table: PanelTable): PostedPanel[] {
  const rows = db.prepare(`SELECT message_id, channel_id FROM ${table} WHERE guild_id = ? ORDER BY rowid`).all(guild.id) as { message_id: string; channel_id: string }[];
  return rows.map((r) => ({
    messageId: r.message_id,
    channelId: r.channel_id,
    channel: guild.channels.cache.get(r.channel_id)?.name ?? null,
    url: `https://discord.com/channels/${guild.id}/${r.channel_id}/${r.message_id}`,
  }));
}

/**
 * Deletes posted panels, all of them or the ones named, so the bot stops keeping them up to date. One already deleted
 * in Discord counts as taken down. One in a channel the bot can't see any more is forgotten, as it couldn't be updated
 * either, but stays for someone to delete by hand. One Discord didn't answer about is kept, to try again
 */
export async function takeDownPanels(client: Client, guild: Guild, table: PanelTable, only?: string) {
  const panels = postedPanels(guild, table).filter((p) => !only || p.messageId === only);
  const removed: PostedPanel[] = [];
  const failed: { channel: string; problem: string }[] = [];
  for (const panel of panels) {
    const where = panel.channel ? `#${panel.channel}` : 'a channel the bot can’t see';
    try {
      const channel = await client.channels.fetch(panel.channelId);
      if (channel?.isTextBased()) await channel.messages.delete(panel.messageId);
      removed.push(panel);
    } catch (err) {
      const code = err instanceof DiscordAPIError ? err.code : null;
      if (code === RESTJSONErrorCodes.UnknownMessage || code === RESTJSONErrorCodes.UnknownChannel) removed.push(panel);
      else if (code === RESTJSONErrorCodes.MissingAccess || code === RESTJSONErrorCodes.MissingPermissions) {
        failed.push({ channel: where, problem: 'The bot can’t see that channel any more, so it won’t update the panel there. Delete it by hand.' });
      } else {
        failed.push({ channel: where, problem: 'Discord didn’t take it down. Try again in a moment.' });
        continue;
      }
    }
    db.prepare(`DELETE FROM ${table} WHERE message_id = ?`).run(panel.messageId);
  }
  return { removed, failed };
}
