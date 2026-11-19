import { AudioPlayerStatus, type AudioPlayer, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource, getVoiceConnection } from '@discordjs/voice';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { feeds } from '../changes.ts';
import * as discordBoard from '../discordSounds.ts';
import { Mixer, type OnEnd, type Playing, type VoiceOptions } from '../mixer.ts';
import * as perf from '../perf.ts';
import { setting } from '../settings.ts';
import type { DiscordSound } from '../discordSounds.ts';
import { humansIn } from '../util.ts';
import { destroy, join, voiceProblem } from '../voiceJoin.ts';
import { type Sound, VOLUME, findSound, recordPlay, soundGain } from './soundLibrary.ts';
import { botClient, checkLoopRoom, isLooping, silenced } from './loopRoom.ts';

// Playing in voice: joining and leaving, the mixer, volumes, and what’s playing

const MAX_VOICES = 12;

const IDLE_LEAVE_MS = 5 * 60_000;

/** A sound that takes this long to be heard is kept for a look */
const SLOW_SOUND_S = 2;

/** How loud a sound plays in voice, where 1 is the file as it is */
export const voiceVolume = (guildId: string, name: string) => VOLUME * soundGain(guildId, name);

/** Plays a Discord sound in voice. One that isn't in the library plays from a temporary copy, as loud as it is on Discord */
export async function playDiscordSound(channel: VoiceBasedChannel, sound: DiscordSound): Promise<string | null> {
  const saved = sound.library ? findSound(channel.guild.id, sound.library) : undefined;
  if (saved) return playFromWeb(channel, saved);
  const file = path.join(tmpdir(), `slopkeeper-discord-${sound.id}`);
  if (!existsSync(file)) writeFileSync(file, (await discordBoard.download(sound)).data);
  return play(channel, file, sound.volume / VOLUME, undefined, { label: sound.name });
}

interface GuildAudio {
  player: AudioPlayer;
  mixer?: Mixer;
  idleTimer?: NodeJS.Timeout;
}

/** Server id → its audio; the bot can be in a voice channel in every server at once */
export const audio = new Map<string, GuildAudio>();

export function audioFor(guildId: string): GuildAudio {
  const existing = audio.get(guildId);
  if (existing) return existing;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  const a: GuildAudio = { player };
  player.on('error', (err) => console.error('Audio player error:', err.message));
  player.on(AudioPlayerStatus.Idle, () => leaveWhenIdle(guildId, a));
  audio.set(guildId, a);
  return a;
}

export function leaveWhenIdle(guildId: string, a: GuildAudio) {
  clearTimeout(a.idleTimer);
  a.idleTimer = setTimeout(() => {
    getVoiceConnection(guildId)?.destroy();
    // Being free again might mean it's wanted in the looping room
    const guild = botClient?.guilds.cache.get(guildId);
    if (guild) void checkLoopRoom(guild).catch(console.error);
  }, IDLE_LEAVE_MS).unref();
}

/** Why the bot can't play in a channel, or null if it can */
export function cantJoin(channel: VoiceBasedChannel): string | null {
  const problem = voiceProblem(channel);
  if (problem === 'full') return `I can’t join ${channel}, it’s full.`;
  return problem && `I can’t play in ${channel}. A server admin needs to give my role **${problem.missing.join('**, **')}** there.`;
}

/** Gets the bot into a channel, ready to play. Returns null on success or the reason it couldn't, for the user */
export async function connect(channel: VoiceBasedChannel): Promise<string | null> {
  const problem = cantJoin(channel);
  if (problem) return problem;

  const a = audioFor(channel.guild.id);
  clearTimeout(a.idleTimer);
  // The loop belongs to the room, so it doesn't follow the bot anywhere else
  const was = getVoiceConnection(channel.guild.id);
  if (was && was.joinConfig.channelId !== channel.id) a.mixer?.stopLoops();
  return (await join(channel, a.player)) ? null : `I couldn’t connect to ${channel}. Try again in a moment.`;
}

/** Layers onto whatever is already playing; a fresh mixer is only needed once the last one has gone quiet */
export function mixInto(guildId: string, add: (mixer: Mixer) => void) {
  const a = audioFor(guildId);
  clearTimeout(a.idleTimer);
  if (a.mixer && !a.mixer.finished) return add(a.mixer);
  a.mixer = new Mixer(VOLUME, MAX_VOICES);
  a.mixer.on('playing', () => feeds.playing.changed(guildId));
  a.mixer.setGroupGain('sound', setting(guildId, 'soundVolume') / 100);
  a.mixer.setGroupGain('speech', setting(guildId, 'ttsVolume') / 100);
  a.mixer.setGroupGain('music', setting(guildId, 'musicVolume') / 100);
  // Before playing, or the mixer would find nothing to mix and end straight away
  add(a.mixer);
  a.player.play(createAudioResource(a.mixer, { inputType: StreamType.Raw }));
}

/** Plays a sound, or restarts it if it's already playing */
export function mixIn(guildId: string, file: string, gain: number, onEnd?: (byItself: boolean) => void, options: VoiceOptions = {}) {
  mixInto(guildId, (mixer) => mixer.add(file, gain, onEnd, options));
}

/**
 * Plays a long file, like a song, at the music volume, where newer sounds can't push it out, from `startMs` in, times
 * `gain` to level it. `onEnd` runs once it's over, saying whether it played to the end. Returns a way to stop it, or the
 * reason it couldn't play, for the user
 */
export async function playLong(channel: VoiceBasedChannel, file: string, onEnd: OnEnd, startMs = 0, onHeard?: () => void, gain = 1): Promise<(() => void) | string> {
  const heard = timeStart(channel, 'music');
  const problem = await connect(channel);
  if (problem) return problem;
  heard.step('joining voice');
  let stop!: () => void;
  mixInto(channel.guild.id, (mixer) => (stop = mixer.add(file, gain, onEnd, { group: 'music', lasting: true, ...(startMs > 0 && { startMs }), onHeard: () => (heard.end(), onHeard?.()) })));
  return stop;
}

/** Times from asking to play until it's heard. Only a sound is kept when slow: speech and music time the rest of their wait too */
function timeStart(channel: VoiceBasedChannel, kind: 'sound' | 'speech' | 'music', name?: string) {
  const trace = new perf.Trace('audio_start_seconds', 'Sound', channel.guild.id, kind === 'sound' ? SLOW_SOUND_S : Infinity, { kind });
  if (name) trace.detail.sound = name;
  return {
    step: (step: string) => trace.step(step),
    end: () => {
      trace.step('starting');
      trace.end();
    },
  };
}

/** Applies the music volume to music already playing */
export function applyMusicVolume(guildId: string) {
  audio.get(guildId)?.mixer?.setGroupGain('music', setting(guildId, 'musicVolume') / 100);
}

/** The voice channel the bot is in, if any */
export const botChannelId = (guildId: string) => getVoiceConnection(guildId)?.joinConfig.channelId ?? null;

/** Plays a sound in a channel. Returns null on success or the reason it couldn't, for the user. `onEnd` runs once it's over, if it played */
export async function play(channel: VoiceBasedChannel, file: string, gain = 1, onEnd?: () => void, options: VoiceOptions = {}): Promise<string | null> {
  const kind = options.group === 'speech' ? 'speech' : 'sound';
  // A line's label is what it says, which isn't kept
  const heard = timeStart(channel, kind, kind === 'sound' ? (options.label ?? path.parse(file).name) : undefined);
  const problem = await connect(channel);
  if (problem) return problem;
  heard.step('joining voice');
  mixIn(channel.guild.id, file, gain, onEnd, { ...options, onHeard: () => (heard.end(), options.onHeard?.()) });
  return null;
}

/** Applies the soundboard volume to sounds already playing */
export function applySoundVolume(guildId: string) {
  audio.get(guildId)?.mixer?.setGroupGain('sound', setting(guildId, 'soundVolume') / 100);
}

/** Applies the speech volume to a line already being said */
export function applySpeechVolume(guildId: string) {
  audio.get(guildId)?.mixer?.setGroupGain('speech', setting(guildId, 'ttsVolume') / 100);
}

/** The volumes a slider can be heard at while it's dragged: the setting each saves to, and the mixer's group for it */
export const PREVIEWED = {
  sounds: { key: 'soundVolume', group: 'sound' },
  speech: { key: 'ttsVolume', group: 'speech' },
  music: { key: 'musicVolume', group: 'music' },
} as const;
/** A volume heard while a slider is dragged that isn't saved, say from a page closed mid-drag, goes back after this */
export const PREVIEW_FOR_MS = 5_000;
const previews = new Map<string, NodeJS.Timeout>();

/**
 * Plays what's playing at a volume someone's dragging a slider to, so they hear it as it moves, without saving it.
 * Saving the setting applies it as usual; otherwise the saved volume comes back after a few seconds
 */
export function previewVolume(guildId: string, name: keyof typeof PREVIEWED, percent: number) {
  const { key, group } = PREVIEWED[name];
  audio.get(guildId)?.mixer?.setGroupGain(group, percent / 100);
  const id = `${guildId} ${name}`;
  clearTimeout(previews.get(id));
  previews.set(
    id,
    setTimeout(() => {
      previews.delete(id);
      audio.get(guildId)?.mixer?.setGroupGain(group, setting(guildId, key) / 100);
    }, PREVIEW_FOR_MS).unref(),
  );
}

/** Plays a sound for the web UI, which has nobody to credit. It still counts towards the recap's top sounds */
export async function playFromWeb(channel: VoiceBasedChannel, sound: Sound): Promise<string | null> {
  const problem = await play(channel, sound.file, soundGain(channel.guild.id, sound.name));
  if (!problem) recordPlay(channel.guild.id, 'web', sound.name);
  return problem;
}

const stopListeners: ((guildId: string, keepMusic: boolean) => void)[] = [];

/** For whatever else is waiting to play, so that Stop stops that too */
export const onPlaybackStop = (listener: (guildId: string, keepMusic: boolean) => void) => void stopListeners.push(listener);

/** Whether music is on in a server, playing or between songs, as the music feature tells it */
export let musicOn = (_guildId: string) => false;

export const onMusicCheck = (check: (guildId: string) => boolean) => void (musicOn = check);

/** The sounds and speech playing in a server, not counting music */
export function playingNow(guildId: string): Playing[] {
  const mixer = audio.get(guildId)?.mixer;
  return mixer && !mixer.finished ? mixer.playing() : [];
}

/** Stops one sound or line of speech. Stopping the room's loop keeps it quiet until someone else joins, as Stop does */
export function stopPlayingOne(guildId: string, id: number): boolean {
  const mixer = audio.get(guildId)?.mixer;
  const found = mixer?.finished ? undefined : mixer?.playing().find((p) => p.id === id);
  if (!found) return false;
  if (found.loop && isLooping(guildId)) silenced.add(guildId);
  return mixer!.stopPlaying(id);
}

/** Stops sounds and speech, and pauses the music unless `keepMusic`, as the web UI's Stop does */
export function stopPlayback(guildId: string, keepMusic = false) {
  for (const listener of stopListeners) listener(guildId, keepMusic);
  if (isLooping(guildId)) silenced.add(guildId);
  const a = audio.get(guildId);
  if (keepMusic && a?.mixer) return a.mixer.stopAllBut('music');
  a?.mixer?.stopAll();
  a?.player.stop(true);
}

export function leaveVoice(guildId: string) {
  stopPlayback(guildId);
  const connection = getVoiceConnection(guildId);
  if (connection) destroy(connection);
}

/** Leaves voice once the last person has gone, rather than sitting there alone until the idle timer */
export function leaveIfAlone(guild: Guild) {
  const channelId = getVoiceConnection(guild.id)?.joinConfig.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
  if (channel?.isVoiceBased() && !humansIn(channel).length) leaveVoice(guild.id);
}
