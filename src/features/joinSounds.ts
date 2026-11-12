import { AudioPlayerStatus, getVoiceConnection } from '@discordjs/voice';
import { type GuildMember, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { db } from '../db.ts';
import { idSetting, setting } from '../settings.ts';
import { findSound, soundGain } from './soundLibrary.ts';
import { audioFor, connect, leaveWhenIdle, mixIn } from './voiceAudio.ts';

// Join sounds: a sound someone picks plays when they join voice, or a spoken greeting

/** Everyone's join sounds in a server */
export function joinSounds(guildId: string) {
  return db.prepare('SELECT user_id, name FROM join_sounds WHERE guild_id = ? ORDER BY name').all(guildId) as { user_id: string; name: string }[];
}

export function setJoinSound(guildId: string, userId: string, name: string | null) {
  if (name) db.prepare('INSERT INTO join_sounds (guild_id, user_id, name) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET name = excluded.name').run(guildId, userId, name);
  else db.prepare('DELETE FROM join_sounds WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

/** Server and person → when their join sound last played */
const lastJoinSound = new Map<string, number>();

/** Plays someone's join sound as they connect to voice. These aren't clicks, so they stay out of the recap's top sounds */
export async function playJoinSound(oldState: VoiceState, newState: VoiceState) {
  const { channel, guild, member } = newState;
  // Coming from another channel, or muting, is not joining
  if (!channel || oldState.channelId || member?.user.bot || channel.id === guild.afkChannelId) return;
  // The looping room has its own sound going, which a join sound or greeting would only talk over
  if (channel.id === idSetting(guild.id, 'loopRoom')) return;
  const name = setting(guild.id, 'joinSounds') ? joinSounds(guild.id).find((r) => r.user_id === newState.id)?.name : undefined;
  const sound = name && findSound(guild.id, name);
  // A join sound already says who it is
  const greeting = !sound && member ? greeter?.line(member) : null;
  if (!sound && !greeting) return;
  const what = sound ? `Join sound ${sound.name}` : 'Greeting';
  // One person arriving shouldn't pull the bot away from people using it in another channel
  const busyElsewhere = () => {
    const botChannel = getVoiceConnection(guild.id)?.joinConfig.channelId;
    return !!botChannel && botChannel !== channel.id;
  };
  if (busyElsewhere()) return;
  const key = `${guild.id}:${newState.id}`;
  const now = Date.now();
  if (now - (lastJoinSound.get(key) ?? -Infinity) < setting(guild.id, 'joinSoundCooldownMin') * 60_000) return;
  lastJoinSound.set(key, now);
  // The bot joins straight away, and the delay comes after that, so the sound clears Discord's joining noises
  const problem = await connect(channel);
  if (problem) return console.log(`${what} in ${guild.name} didn’t play: ${problem}`);
  // Connecting cancelled this, and with nothing playing to finish nothing would set it again
  const leaveIfIdle = () => {
    const a = audioFor(guild.id);
    if (a.player.state.status === AudioPlayerStatus.Idle) leaveWhenIdle(guild.id, a);
  };
  const delay = setting(guild.id, 'joinSoundDelayMs');
  if (delay) {
    await sleep(delay);
    if (guild.voiceStates.cache.get(newState.id)?.channelId !== channel.id || busyElsewhere()) {
      lastJoinSound.delete(key);
      return leaveIfIdle();
    }
  }
  if (sound) return mixIn(guild.id, sound.file, soundGain(guild.id, sound.name));
  const failed = await greeter!.say(channel, greeting!);
  if (failed) {
    console.log(`${what} in ${guild.name} didn’t play: ${failed}`);
    leaveIfIdle();
  }
}

let greeter: { line(member: GuildMember): string | null; say(channel: VoiceBasedChannel, line: string): Promise<string | null> } | undefined;

/** How text to speech greets people, kept here by being handed over since it already depends on this file */
export function setGreeter(line: (member: GuildMember) => string | null, say: (channel: VoiceBasedChannel, line: string) => Promise<string | null>) {
  greeter = { line, say };
}
