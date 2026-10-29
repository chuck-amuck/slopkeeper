import { ActivityType, type Client, type GuildMember, type SendableChannels, type VoiceBasedChannel } from 'discord.js';
import { config } from './config.ts';

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

export async function announceChannel(client: Client<true>): Promise<SendableChannels> {
  const channel = await client.channels.fetch(config.announceChannelId);
  if (!channel?.isSendable()) throw new Error(`ANNOUNCE_CHANNEL_ID ${config.announceChannelId} is not a sendable channel`);
  return channel;
}
