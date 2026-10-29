import { ActivityType, type Client, type Guild, type GuildMember, type SendableChannels, type VoiceBasedChannel } from 'discord.js';
import { guildSettings, isAllowed } from './settings.ts';

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
  const id = guildSettings(guildId).announceChannelId;
  if (!id) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  if (channel?.isSendable()) return channel;
  console.error(`Announce channel ${id} in server ${guildId} is gone or the bot can't post there; run /setup announce-channel`);
  return null;
}
