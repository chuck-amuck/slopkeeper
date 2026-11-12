import { getVoiceConnection } from '@discordjs/voice';
import { type Client, type Guild, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import { idSetting, setting } from '../settings.ts';
import type { LoopProgram } from '../loopBot.ts';
import { humansIn, servedGuilds } from '../util.ts';
import { type Sound, findSound, soundGain } from './soundLibrary.ts';
import { audio, connect, mixIn, mixInto } from './voiceAudio.ts';

// The looping room: a sound and a line of speech on repeat while people are in a channel, here or through the loop bot

const LOOP_BOT_TIMEOUT_MS = 20_000;

const LOOP_BOT_RESYNC_MS = 60_000;

/** The room loops its sound, its speech, or both, each on its own */
type LoopPart = 'sound' | 'speech';

/** Which parts of each server's loop are playing, or about to, as `guildId:part` */
const looping = new Set<string>();

const loopKey = (guildId: string, part: LoopPart) => `${guildId}:${part}`;

export const isLooping = (guildId: string) => looping.has(loopKey(guildId, 'sound')) || looping.has(loopKey(guildId, 'speech'));

/** Servers where Stop silenced the loop, until someone else joins the room */
export const silenced = new Set<string>();

/** Each server's current run of the loop, counted up when someone coming in restarts it, so the run before leaves the new one alone */
const loopRuns = new Map<string, number>();

const runOf = (guildId: string) => loopRuns.get(guildId) ?? 0;

/** How to stop each server's intro while it plays */
const introStops = new Map<string, () => void>();

export let botClient: Client | undefined;

/**
 * Starts the looping sound and speech, whichever are set, if people are in the room and the bot isn't needed elsewhere.
 * Starting from nothing plays the intro first, unless `intro` is false
 */
export async function checkLoopRoom(guild: Guild, { intro = true } = {}) {
  if (config.loopBotUrl) return syncLoopBot(guild);
  const roomId = idSetting(guild.id, 'loopRoom');
  const sound = findSound(guild.id, setting(guild.id, 'loopSound') ?? '');
  const wanted: LoopPart[] = [];
  if (sound) wanted.push('sound');
  if (setting(guild.id, 'loopText') && loopSpeaker) wanted.push('speech');
  const parts = wanted.filter((part) => !looping.has(loopKey(guild.id, part)));
  if (!roomId || !parts.length || silenced.has(guild.id)) return;
  const room = guild.channels.cache.get(roomId);
  if (!room?.isVoiceBased() || !humansIn(room).length) return;
  // People using the bot in another channel keep it, until that channel empties or the bot goes idle
  const botChannelId = getVoiceConnection(guild.id)?.joinConfig.channelId;
  const elsewhere = botChannelId && botChannelId !== room.id ? guild.channels.cache.get(botChannelId) : undefined;
  if (elsewhere?.isVoiceBased() && humansIn(elsewhere).length) return;
  for (const part of parts) looping.add(loopKey(guild.id, part));
  const run = runOf(guild.id);
  const problem = await connect(room);
  // Someone coming in while it connected restarted the room, and that run plays instead
  if (runOf(guild.id) !== run) return;
  if (problem) {
    for (const part of parts) looping.delete(loopKey(guild.id, part));
    return console.log(`Looping room in ${guild.name} didn’t play: ${problem}`);
  }
  // Starting from nothing, rather than taking up changed settings, plays the intro and keeps each part's delay
  const fresh = intro && parts.length === wanted.length;
  const introSound = fresh ? findSound(guild.id, setting(guild.id, 'loopIntro') ?? '') : undefined;
  if (introSound && !(await playIntro(guild, room, introSound, run))) {
    if (runOf(guild.id) === run) for (const part of parts) looping.delete(loopKey(guild.id, part));
    return;
  }
  const delayOf = (part: LoopPart) => (fresh ? setting(guild.id, part === 'sound' ? 'loopSoundDelayMs' : 'loopTextDelayMs') : 0);
  await Promise.all(parts.map((part) => startLoop(guild, room, part, sound, run, delayOf(part))));
}

/** Waits the intro delay, then plays the intro like a join sound. Says whether the loop should follow, which it shouldn't once stopped, restarted or left */
async function playIntro(guild: Guild, room: VoiceBasedChannel, intro: Sound, run: number): Promise<boolean> {
  const current = () => runOf(guild.id) === run && !silenced.has(guild.id) && humansIn(room).length > 0;
  const delay = setting(guild.id, 'loopIntroDelayMs');
  if (delay) await sleep(delay);
  if (!current()) return false;
  return new Promise((resolve) => {
    let stop!: () => void;
    // A file that won't play ends by itself too, so the loop still starts
    mixInto(guild.id, (mixer) => (stop = mixer.add(intro.file, soundGain(guild.id, intro.name), (byItself) => {
      if (introStops.get(guild.id) === stop) introStops.delete(guild.id);
      resolve(byItself && current());
    })));
    introStops.set(guild.id, stop);
  });
}

/** Someone else coming in starts the room over from the intro: the loop and any intro stop, and the next check plays it all again */
function restartLoop(guildId: string) {
  loopRuns.set(guildId, runOf(guildId) + 1);
  introStops.get(guildId)?.();
  introStops.delete(guildId);
  audio.get(guildId)?.mixer?.stopLoops();
  looping.delete(loopKey(guildId, 'sound'));
  looping.delete(loopKey(guildId, 'speech'));
}

/** Plays one part of the room's loop over and over, at its own volume, layered if it has a gap set, after `delayMs` */
async function startLoop(guild: Guild, room: VoiceBasedChannel, part: LoopPart, sound: Sound | undefined, run: number, delayMs: number) {
  const key = loopKey(guild.id, part);
  const current = () => runOf(guild.id) === run;
  let file: string;
  try {
    file = part === 'sound' ? await loopable(guild.id, sound!.file) : await loopSpeechFile(guild);
  } catch (err) {
    if (current()) looping.delete(key);
    return console.error(`Looping ${part} in ${guild.name} couldn’t be prepared:`, (err as Error).message);
  }
  // Made ready first, so the delay is all there is
  if (delayMs) {
    await sleep(delayMs);
    if (!current() || silenced.has(guild.id) || !humansIn(room).length) {
      if (current()) looping.delete(key);
      return;
    }
  }
  const gain = part === 'sound' ? soundGain(guild.id, sound!.name) * (setting(guild.id, 'loopVolume') / 100) : setting(guild.id, 'loopTextVolume') / 100;
  const everyMs = Math.round(setting(guild.id, part === 'sound' ? 'loopEvery' : 'loopTextEvery') * 1000);
  mixIn(
    guild.id,
    file,
    gain,
    () => {
      if (current()) looping.delete(key);
    },
    { loop: true, ...(everyMs > 0 && { everyMs }), label: part === 'sound' ? sound!.name : (setting(guild.id, 'loopText') ?? 'Looping speech'), spoken: part !== 'sound' },
  );
}

const loopSpeechDir = () => path.join(config.dataDir, 'loop-speech');

/**
 * The room's looping speech as a file, made by the voice container once for each line, voice and speed, then reused.
 * An older line for the same server is deleted once it's replaced
 */
async function loopSpeechFile(guild: Guild): Promise<string> {
  const text = setting(guild.id, 'loopText') ?? '';
  const voice = setting(guild.id, 'loopVoice') || setting(guild.id, 'ttsVoice');
  // Keyed on how the voice is made as well as its name, so a voice that's been retuned or removed is made again
  const made = createHash('sha256')
    .update(JSON.stringify([text, voice, loopVoiceDetails?.(guild, voice), setting(guild.id, 'ttsSpeed')]))
    .digest('hex')
    .slice(0, 16);
  const file = path.join(loopSpeechDir(), `${guild.id}-${made}.wav`);
  if (existsSync(file)) return file;
  mkdirSync(loopSpeechDir(), { recursive: true });
  const making = `${file}.${randomUUID()}.new.wav`;
  try {
    await loopSpeaker!(guild, text, voice, making);
    renameSync(making, file);
  } finally {
    rmSync(making, { force: true });
  }
  for (const old of readdirSync(loopSpeechDir())) if (old.startsWith(`${guild.id}-`) && old !== path.basename(file) && !old.includes('.new.')) rmSync(path.join(loopSpeechDir(), old), { force: true });
  return file;
}

/** Why the room's looping speech can't be made, or null if it can or there isn't any. Makes it ahead of time if it can */
export async function loopSpeechProblem(guild: Guild): Promise<string | null> {
  if (!setting(guild.id, 'loopText')) return null;
  if (!loopSpeaker) return 'Text to speech isn’t running on this bot.';
  try {
    await loopSpeechFile(guild);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const loopCacheDir = () => path.join(config.dataDir, 'loop-cache');

/**
 * A WAV copy to loop, as some formats (m4a, for one) leave a moment of silence the first time ffmpeg goes round.
 * It's kept on the data volume, where the loop bot can read it too, and reused until the sound changes
 */
async function loopable(guildId: string, file: string): Promise<string> {
  if (path.extname(file) === '.wav') return file;
  const made = createHash('sha256').update(JSON.stringify([file, statSync(file).mtimeMs])).digest('hex').slice(0, 16);
  const copy = path.join(loopCacheDir(), `${guildId}-${made}.wav`);
  if (existsSync(copy)) return copy;
  mkdirSync(loopCacheDir(), { recursive: true });
  const making = `${copy}.${randomUUID()}.new.wav`;
  try {
    await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-ar', '48000', '-ac', '2', making]);
    renameSync(making, copy);
  } finally {
    rmSync(making, { force: true });
  }
  for (const old of readdirSync(loopCacheDir())) if (old.startsWith(`${guildId}-`) && old !== path.basename(copy) && !old.includes('.new.')) rmSync(path.join(loopCacheDir(), old), { force: true });
  return copy;
}

/** Whether a setting changes what the looping room plays: its own, or the speech voice and speed its speech can follow */
export const affectsLoopRoom = (key: string) => key.startsWith('loop') || key === 'ttsVoice' || key === 'ttsSpeed' || (!!config.loopBotUrl && key === 'soundVolume');

/** After the looping settings change: stops the loop as it was, then starts it again if it should be playing */
export function refreshLoopRoom(guild: Guild) {
  // The loop bot takes up a change itself, as the run stays the same
  if (config.loopBotUrl) return syncLoopBot(guild);
  audio.get(guild.id)?.mixer?.stopLoops();
  silenced.delete(guild.id);
  // Turning a setting shouldn't replay the intro each time. One that's playing carries on, and the loop after it has the new settings
  return checkLoopRoom(guild, { intro: false });
}

/** Stop lasts until someone else joins the room, or it empties. With an intro, someone coming in starts the room over */
export function noteLoopRoom(oldState: VoiceState, newState: VoiceState) {
  const { guild } = newState;
  const roomId = idSetting(guild.id, 'loopRoom');
  if (!roomId) return;
  const room = guild.channels.cache.get(roomId);
  const arrived = newState.channelId === roomId && oldState.channelId !== roomId && !newState.member?.user.bot;
  if (arrived || (room?.isVoiceBased() && !humansIn(room).length)) silenced.delete(guild.id);
  if (!arrived || !findSound(guild.id, setting(guild.id, 'loopIntro') ?? '')) return;
  // The loop bot starts over when the run changes. Here, what's playing stops and the next check plays it all again
  if (config.loopBotUrl) loopRuns.set(guild.id, runOf(guild.id) + 1);
  else if (isLooping(guild.id)) restartLoop(guild.id);
}

/** Each server's last word to the loop bot, sent one after another so they arrive in order */
const loopBotQueue = new Map<string, Promise<void>>();

/** Servers the loop bot was last told to leave, so it isn't told again on every voice change */
const loopBotLeft = new Set<string>();

let loopBotTimer: NodeJS.Timeout | undefined;

/** Starts the looping room in each server, and keeps the loop bot in step with it */
export function startLoopRoom(client: Client<true>) {
  botClient = client;
  for (const guild of servedGuilds(client)) void checkLoopRoom(guild).catch(console.error);
  if (config.loopBotUrl) {
    console.log(`The looping room plays through the loop bot at ${config.loopBotUrl}`);
    loopBotTimer = setInterval(() => {
      for (const guild of servedGuilds(client)) if (idSetting(guild.id, 'loopRoom')) void syncLoopBot(guild);
    }, LOOP_BOT_RESYNC_MS).unref();
  }
}

export function stopLoopRoom() {
  clearInterval(loopBotTimer);
}

function loopBotFetch(pathname: string, init: RequestInit = {}) {
  return fetch(config.loopBotUrl + pathname, {
    ...init,
    headers: { authorization: `Bearer ${config.loopToken}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(LOOP_BOT_TIMEOUT_MS),
  });
}

/**
 * Tells the loop bot what the room should play, or to leave. It takes the same program again as nothing new,
 * so this runs on every voice change, and every minute in case the loop bot restarted
 */
export function syncLoopBot(guild: Guild): Promise<void> {
  const next = (loopBotQueue.get(guild.id) ?? Promise.resolve())
    .then(async () => {
      const program = await loopProgram(guild);
      if (!program && loopBotLeft.has(guild.id)) return;
      const res = await loopBotFetch(`/guilds/${guild.id}/loop`, program ? { method: 'PUT', body: JSON.stringify(program) } : { method: 'DELETE' });
      if (res.ok) {
        if (program) loopBotLeft.delete(guild.id);
        else loopBotLeft.add(guild.id);
        return;
      }
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      console.log(`Looping room in ${guild.name} didn’t play: ${error ?? `the loop bot answered ${res.status}`}`);
    })
    .catch((err: Error) => console.error(`The loop bot couldn’t be reached for ${guild.name}:`, err.message));
  loopBotQueue.set(guild.id, next);
  return next;
}

/** What the loop bot should play in the room, or null if nobody's there or there's nothing to play */
async function loopProgram(guild: Guild): Promise<LoopProgram | null> {
  const roomId = idSetting(guild.id, 'loopRoom');
  const room = roomId ? guild.channels.cache.get(roomId) : undefined;
  if (!room?.isVoiceBased() || !humansIn(room).length) return null;
  // Here, loops are in the soundboard's volume group. The loop bot has no groups, so it's in the gain
  const soundVolume = setting(guild.id, 'soundVolume') / 100;
  const parts: LoopProgram['parts'] = [];
  const sound = findSound(guild.id, setting(guild.id, 'loopSound') ?? '');
  if (sound) {
    try {
      parts.push({
        file: path.resolve(await loopable(guild.id, sound.file)),
        gain: soundGain(guild.id, sound.name) * (setting(guild.id, 'loopVolume') / 100) * soundVolume,
        everyMs: Math.round(setting(guild.id, 'loopEvery') * 1000),
        delayMs: setting(guild.id, 'loopSoundDelayMs'),
      });
    } catch (err) {
      console.error(`Looping sound in ${guild.name} couldn’t be prepared:`, (err as Error).message);
    }
  }
  if (setting(guild.id, 'loopText') && loopSpeaker) {
    try {
      parts.push({
        file: path.resolve(await loopSpeechFile(guild)),
        gain: (setting(guild.id, 'loopTextVolume') / 100) * soundVolume,
        everyMs: Math.round(setting(guild.id, 'loopTextEvery') * 1000),
        delayMs: setting(guild.id, 'loopTextDelayMs'),
      });
    } catch (err) {
      console.error(`Looping speech in ${guild.name} couldn’t be prepared:`, (err as Error).message);
    }
  }
  if (!parts.length) return null;
  const intro = findSound(guild.id, setting(guild.id, 'loopIntro') ?? '');
  return {
    run: runOf(guild.id),
    channelId: room.id,
    intro: intro ? { file: path.resolve(intro.file), gain: soundGain(guild.id, intro.name) * soundVolume, delayMs: setting(guild.id, 'loopIntroDelayMs') } : null,
    parts,
  };
}

/** What Settings says about the loop bot, or null without one */
export async function loopBotStatus(guildId: string): Promise<{ ok: boolean; note: string } | null> {
  if (!config.loopBotUrl) return null;
  try {
    const res = await loopBotFetch('/status');
    if (!res.ok) throw new Error(String(res.status));
    const status = (await res.json()) as { ready: boolean; name: string | null; guilds: string[] };
    if (!status.ready) return { ok: false, note: 'The loop bot is starting, or can’t log in to Discord. Its log says which.' };
    if (!status.guilds.includes(guildId)) return { ok: false, note: `The loop bot, ${status.name}, isn’t in this server yet. Invite it with View Channels, Connect and Speak.` };
    return { ok: true, note: `${status.name} plays this room, so Slopkeeper stays free for everything else. Stop on the soundboard doesn’t stop it.` };
  } catch {
    return { ok: false, note: 'The loop bot isn’t answering, so the room is quiet.' };
  }
}

let loopSpeaker: ((guild: Guild, text: string, voiceId: string, file: string) => Promise<void>) | undefined;

/** How a voice is made, which changes when it's retuned */
let loopVoiceDetails: ((guild: Guild, voiceId: string) => unknown) | undefined;

/** How text to speech makes the looping room's speech, handed over like the greeter */
export function setLoopSpeaker(speak: (guild: Guild, text: string, voiceId: string, file: string) => Promise<void>, voiceDetails: (guild: Guild, voiceId: string) => unknown) {
  loopSpeaker = speak;
  loopVoiceDetails = voiceDetails;
}
