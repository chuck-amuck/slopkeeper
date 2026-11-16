// Joining a voice channel, for the main bot and the loop bot alike. Kept light, as the loop bot runs without the database

import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus, type AudioPlayer, type VoiceConnection } from '@discordjs/voice';
import { PermissionFlagsBits, type VoiceBasedChannel } from 'discord.js';
import * as perf from './perf.ts';

export const CONNECT_TIMEOUT_MS = 15_000;
// Being moved to another channel, or a blip, comes back by itself within this
export const RECONNECT_TIMEOUT_MS = 5_000;

const VOICE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
] as const;

/** What keeps a bot from playing in a channel: the permissions it's missing, or that the channel's full. Null if nothing */
export function voiceProblem(channel: VoiceBasedChannel): { missing: string[] } | 'full' | null {
  const perms = channel.permissionsFor(channel.guild.members.me!);
  const missing = VOICE_PERMISSIONS.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
  if (missing.length) return { missing };
  return channel.joinable ? null : 'full';
}

// When this process started, so whoever adds up its counts can tell a restart from a quiet spell
const STARTED_AT = Date.now();

/** The voice counts a loop bot sends in its /stats, by field */
export const LOOP_VOICE_COUNTS = { connectFailures: 'voice_connect_failures_total', disconnects: 'voice_disconnects_total' } as const;
export type LoopVoice = { startedAt: number } & Record<keyof typeof LOOP_VOICE_COUNTS, number>;

/** This loop bot's voice troubles since it started */
export function loopVoiceTotals(): LoopVoice {
  const totals = Object.fromEntries(Object.entries(LOOP_VOICE_COUNTS).map(([field, name]) => [field, perf.counterValue(name, { bot: 'loop' })]));
  return { startedAt: STARTED_AT, ...totals } as LoopVoice;
}

export function destroy(connection: VoiceConnection) {
  if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
}

export interface JoinOptions {
  /** Which bot is joining, for the health numbers. The main bot's go unlabelled, as they always have */
  bot?: 'loop';
  /** Runs when the connection dropped and didn't come back, after it's been destroyed */
  onLost?: () => void;
}

/**
 * Gets into `channel`, playing `player` there, and waits until it's ready. Joining again also revives a connection that
 * dropped. A drop that doesn't come back by itself destroys the connection, so nothing waits on it later. Returns
 * whether it joined afresh, or null when it couldn't get ready in time, having destroyed the connection
 */
export async function join(channel: VoiceBasedChannel, player: AudioPlayer, { bot, onLost }: JoinOptions = {}): Promise<{ fresh: boolean } | null> {
  const labels: perf.Labels = bot ? { bot } : {};
  let connection = getVoiceConnection(channel.guild.id);
  const fresh =
    !connection ||
    connection.joinConfig.channelId !== channel.id ||
    connection.state.status === VoiceConnectionStatus.Disconnected ||
    connection.state.status === VoiceConnectionStatus.Destroyed;
  const joining = performance.now();
  if (fresh) {
    // Joining with one already there rejoins that one, which is already watched
    const isNew = !connection || connection.state.status === VoiceConnectionStatus.Destroyed;
    connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    if (isNew) watch(connection, channel, labels, onLost);
    connection.subscribe(player);
  }
  try {
    await entersState(connection!, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
  } catch {
    perf.count('voice_connect_failures_total', labels);
    console.error(`Voice connection to ${channel.name} in ${channel.guild.name} (${channel.guild.id}) timed out in state ${connection!.state.status}`);
    // Left in place it would be reused, and every later try would time out as well
    destroy(connection!);
    return null;
  }
  // The loop bot's would stay in its own process, which nothing reads them from
  if (fresh && !bot) perf.time('voice_connect_seconds', (performance.now() - joining) / 1000);
  return { fresh };
}

function watch(connection: VoiceConnection, channel: VoiceBasedChannel, labels: perf.Labels, onLost?: () => void) {
  // Without a listener, a voice network error would be thrown and take the whole bot down
  connection.on('error', (err) => console.error(`Voice connection error in ${channel.guild.name} (${channel.guild.id}):`, err.message));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    perf.count('voice_disconnects_total', labels);
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
      ]);
    } catch {
      // Already left on purpose while it waited: whoever did that has moved on, maybe to a new connection
      if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
      // Disconnected by someone, or the channel went away
      destroy(connection);
      onLost?.();
    }
  });
}
