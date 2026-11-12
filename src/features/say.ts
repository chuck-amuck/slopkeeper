import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getVoiceConnection } from '@discordjs/voice';
import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type PermissionsBitField,
  type VoiceBasedChannel,
} from 'discord.js';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { levelSpeech } from '../loudness.ts';
import { DEFAULTS, idSetting, setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { canSee, humansIn } from '../util.ts';
import { plural } from './gamestats.ts';
import { onPlaybackStop, play } from './voiceAudio.ts';
import { setGreeter } from './joinSounds.ts';
import { setLoopSpeaker } from './loopRoom.ts';

/** How much longer speech gets, paired with the length_scale that gives it, from fastest to slowest */
type Stretches = readonly (readonly [number, number])[];

/**
 * How much longer speech takes at each of Piper's length_scale values, measured across the default model's voices. It's far
 * from proportional, as each sound's length gets rounded: asking for 18% longer only gives about 5%
 */
const STRETCHES: Stretches = [
  [0.68, 0.5],
  [0.78, 0.7],
  [0.9, 0.8],
  [1, 1],
  [1.07, 1.2],
  [1.13, 1.3],
  [1.21, 1.4],
  [1.27, 1.5],
  [1.38, 1.6],
  [1.5, 1.8],
  [1.62, 2],
  [1.73, 2.2],
  [2, 2.5],
] as const;

/** The same, measured across the GLaDOS and HAL models, which stretch more evenly. Bender, Optimus Prime, TikTok and KSS (State broadcast) match it within 3% */
const CHARACTER_STRETCHES: Stretches = [
  [0.61, 0.5],
  [0.78, 0.7],
  [0.86, 0.8],
  [1, 1],
  [1.14, 1.2],
  [1.21, 1.3],
  [1.3, 1.4],
  [1.38, 1.5],
  [1.47, 1.6],
  [1.61, 1.8],
  [1.79, 2],
  [1.95, 2.2],
  [2.19, 2.5],
] as const;

/** Measured on the Russian model reading English with its accent, which stretches between the two */
const RUSSIAN_STRETCHES: Stretches = [
  [0.66, 0.5],
  [0.78, 0.7],
  [0.88, 0.8],
  [1, 1],
  [1.09, 1.2],
  [1.17, 1.3],
  [1.26, 1.4],
  [1.34, 1.5],
  [1.4, 1.6],
  [1.57, 1.8],
  [1.72, 2],
  [1.86, 2.2],
  [2.09, 2.5],
] as const;

interface Voice {
  id: string;
  name: string;
  /** A model the voice container keeps besides its default one (see voice/start.sh) */
  model?: string;
  /** For a model with several speakers, numbered as they were when they were picked */
  speaker?: number;
  /** Piper's noise_scale and noise_w_scale, to change how much the sound and timing vary from the model's own */
  noise?: readonly [number, number];
  stretches?: Stretches;
  /** Multiplies the length_scale, for a model that sounds rushed at the same speed as the others */
  pace?: number;
  /** ffmpeg filters for a voice that's a style built on a model, run before the speech is levelled */
  effects?: string;
}

/** An old state TV sound: narrowed, pushed forward, squeezed and with a hall's echo, turned up to match the others */
const BROADCAST_EFFECTS =
  'highpass=f=170,lowpass=f=6800,equalizer=f=2500:t=q:w=1.2:g=5,acompressor=threshold=0.05:ratio=8:attack=3:release=80:makeup=4,aecho=0.8:0.5:70|140:0.22|0.12,asoftclip=type=tanh,volume=6dB';

/** The default model's speakers the effect styles are built on */
const DEEP = 499;
const MAN = 400;
const WOMAN = 0;

/**
 * Styles made with ffmpeg effects on one of the default model's speakers, each turned up or down at the end to match that
 * speaker without them
 */
const STYLES: readonly Voice[] = [
  {
    id: 'demon',
    name: 'Demon',
    speaker: DEEP,
    pace: 1.1,
    // An octave and a fifth down, layered, with grit and a short echo
    effects:
      'asplit=2[a][b];[a]rubberband=pitch=0.5[a2];[b]rubberband=pitch=0.7[b2];[a2][b2]amix=inputs=2:weights=1 0.7:normalize=0,lowshelf=f=150:g=4,asoftclip=type=tanh,aecho=0.8:0.6:40|90:0.35|0.2,volume=3dB',
  },
  // Chipmunk style: the pitch goes up and the voice shrinks with it
  { id: 'helium', name: 'Helium', speaker: MAN, pace: 0.9, effects: 'rubberband=pitch=1.8' },
  { id: 'giant', name: 'Giant', speaker: DEEP, pace: 1.2, effects: 'rubberband=pitch=0.7,lowshelf=f=150:g=5,aecho=0.8:0.7:90|180:0.35|0.2,volume=1.6dB' },
  {
    id: 'robot',
    name: 'Robot',
    speaker: MAN,
    // Every frequency's phase flattened, which turns speech into a monotone buzz, then a metal ring
    effects: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,aecho=0.8:0.8:8:0.4,volume=16dB",
  },
  {
    id: 'alien',
    name: 'Alien',
    speaker: WOMAN,
    effects: "rubberband=pitch=1.25,flanger=delay=3:depth=6:speed=0.6:regen=50,vibrato=f=7:d=0.35,aeval='val(0)*(0.65+0.35*sin(2*PI*90*t))',volume=7dB",
  },
  {
    id: 'radio',
    name: 'Walkie-talkie',
    speaker: MAN,
    pace: 0.95,
    // Narrow, overdriven and squeezed, with hiss
    effects:
      "highpass=f=500,lowpass=f=2800,volume=12dB,asoftclip=type=hard,volume=-12dB,acompressor=threshold=0.05:ratio=8:attack=2:release=60:makeup=4,aeval='val(0)+0.012*(random(0)*2-1)',volume=1.3dB",
  },
  {
    id: 'phone',
    name: 'Phone call',
    speaker: WOMAN,
    effects: 'highpass=f=300,lowpass=f=3400,aresample=8000,aresample=22050,equalizer=f=1500:t=q:w=1:g=4,acompressor=threshold=0.1:ratio=4:makeup=2',
  },
  {
    id: 'megaphone',
    name: 'Megaphone',
    speaker: MAN,
    pace: 0.95,
    effects: 'highpass=f=600,lowpass=f=4000,equalizer=f=1500:t=q:w=1:g=8,volume=10dB,asoftclip=type=atan,volume=-10dB,aecho=0.8:0.3:30:0.3,volume=18dB',
  },
  {
    id: 'stadium',
    name: 'Stadium PA',
    speaker: MAN,
    pace: 1.1,
    // Slapback from the stands, then a long tail
    effects: 'highpass=f=250,lowpass=f=6000,equalizer=f=2000:t=q:w=1:g=4,aecho=0.8:0.6:180|360|540:0.4|0.25|0.15,aecho=0.8:0.85:60|117|173:0.3|0.25|0.2,volume=8dB',
  },
  {
    id: 'newsreel',
    name: 'Newsreel',
    speaker: MAN,
    pace: 0.88,
    // A 1940s film soundtrack: narrow, squeezed, a slow wow, and crackle
    effects:
      "highpass=f=250,lowpass=f=4500,equalizer=f=1500:t=q:w=1:g=4,acompressor=threshold=0.08:ratio=6:makeup=3,vibrato=f=0.7:d=0.03,aeval='val(0)+if(lt(random(0),0.0008),0.25*(random(1)*2-1),0)+0.006*(random(2)*2-1)',volume=0.8dB",
  },
  { id: 'cathedral', name: 'Cathedral', speaker: MAN, pace: 1.15, effects: 'aecho=0.8:0.9:120|240|370|510|660|820:0.5|0.4|0.32|0.25|0.18|0.12' },
  {
    id: 'underwater',
    name: 'Underwater',
    speaker: MAN,
    pace: 1.1,
    effects: 'lowpass=f=800,rubberband=pitch=0.92,vibrato=f=5:d=0.5,chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|1.3,volume=2.3dB',
  },
  {
    id: 'ghost',
    name: 'Ghost',
    speaker: WOMAN,
    pace: 1.25,
    // An echo run backwards, so it swells in before each word, and a tremble
    effects: 'highpass=f=200,rubberband=pitch=1.08,areverse,aecho=0.8:0.9:80|160|260|400:0.45|0.35|0.25|0.15,areverse,tremolo=f=5:d=0.3,aecho=0.8:0.7:300:0.3,volume=8dB',
  },
  {
    id: 'trailer',
    name: 'Trailer narrator',
    speaker: DEEP,
    pace: 1.15,
    effects: 'rubberband=pitch=0.85,lowshelf=f=120:g=6,acompressor=threshold=0.1:ratio=4:makeup=2,aecho=0.8:0.6:80|160:0.3|0.2,volume=3.6dB',
  },
];

export const VOICES: readonly Voice[] = [
  // Calmer than the model's own 0.667 and 0.8, which wobble in longer lines
  { id: 'glados', name: 'GLaDOS', model: 'glados', noise: [0.333, 0.333], stretches: CHARACTER_STRETCHES },
  { id: 'hal', name: 'HAL 9000', model: 'hal', stretches: CHARACTER_STRETCHES },
  { id: 'bender', name: 'Bender', model: 'bender', stretches: CHARACTER_STRETCHES },
  { id: 'optimus', name: 'Optimus Prime', model: 'optimus', stretches: CHARACTER_STRETCHES },
  // Kronk stretches like the default model's voices, but sounded rushed: it's 15% slower, with steadier timing
  { id: 'kronk', name: 'Kronk', model: 'kronk', noise: [0.667, 0.333], pace: 1.15 },
  { id: 'tiktok', name: 'TikTok', model: 'tiktok', stretches: CHARACTER_STRETCHES },
  // Models in other languages reading English with an accent (voice/accent.py), turned up or down to match the others.
  // State broadcast reads Korean as it is, goes 15% slower, as an announcer reads, and has a style's effects
  { id: 'broadcast', name: 'State broadcast', model: 'kss', pace: 1.15, stretches: CHARACTER_STRETCHES, effects: BROADCAST_EFFECTS },
  { id: 'russian', name: 'Russian', model: 'dmitri', stretches: RUSSIAN_STRETCHES, effects: 'volume=2dB' },
  { id: 'spanish', name: 'Spanish', model: 'davefx', stretches: CHARACTER_STRETCHES, effects: 'volume=-3dB' },
  // The emotional model's neutral speaker, which leaves its drunk, whispering and other speakers free to add
  { id: 'german', name: 'German', model: 'thorsten', speaker: 4, stretches: CHARACTER_STRETCHES, effects: 'volume=4.5dB' },
  ...STYLES,
];

const ACCENTS = new Set(['broadcast', 'russian', 'spanish', 'german']);
/** How the web UI groups the voices */
export const voiceGroup = (voice: Voice) => (STYLES.includes(voice) ? 'Effects' : ACCENTS.has(voice.id) ? 'Accents' : 'Characters');

/**
 * The voice a server uses when nobody picks one, or the one given. One that's since been removed falls back to the server's
 * default, then the bot's, then TikTok
 */
export function serverVoice(guildId: string, id: string | null = setting(guildId, 'ttsVoice')): Voice {
  const find = (wanted: string | null) => VOICES.find((v) => v.id === wanted);
  return find(id) ?? find(setting(guildId, 'ttsVoice')) ?? find(DEFAULTS.ttsVoice) ?? find('tiktok')!;
}

/** A voice by its id, or by its name as someone might type it into /say instead of picking it */
const voiceCalled = (typed: string) => VOICES.find((v) => v.id === typed) ?? VOICES.find((v) => v.name.toLowerCase() === typed.trim().toLowerCase());

/** Clears servers' picks of voices that have since been removed, so Settings shows the voice they really get. Returns how many */
export function forgetRemovedVoices(): number {
  const ids = VOICES.map((v) => v.id);
  return Number(
    db
      .prepare(`DELETE FROM guild_settings WHERE key IN ('ttsVoice', 'loopVoice') AND value != '' AND value NOT IN (${ids.map(() => '?').join(', ')})`)
      .run(...ids).changes,
  );
}

const SPEAK_TIMEOUT_MS = 15_000;
/** Lines waiting behind the one being said */
const MOST_WAITING = 5;
const MOST_PHRASES = 25;
/** After this, the next message from the same person gets their name read again */
const SAME_SPEAKER_MS = 30_000;
const LINK = /https?:\/\/\S+/g;
/** Discord's own limit on the option. The server's limit is applied to what gets read out, so a mention doesn't count as its id */
const LONGEST_TYPED = 1000;
const UNAVAILABLE = 'The voice isn’t available right now. Try again in a moment.';
const STOPPED = 'Stopped before that was said.';

interface Line {
  channel: VoiceBasedChannel;
  text: string;
  voice: Voice;
  /** Runs once the line starts playing, or with why it never will */
  started: (problem: string | null) => void;
}

interface Queue {
  lines: Line[];
  running: boolean;
  /** Cancels the line being made, for when it isn't playing yet */
  cancel?: AbortController;
}

const queues = new Map<string, Queue>();
const lastLine = new Map<string, number>();
const lastReader = new Map<string, { id: string; at: number }>();
let folder: string | undefined;

function queueFor(guildId: string) {
  let queue = queues.get(guildId);
  if (!queue) queues.set(guildId, (queue = { lines: [], running: false }));
  return queue;
}

/** What should be read out. Discord's markup would otherwise come out as long strings of digits */
export function speechFor(guild: Guild, typed: string) {
  return typed
    .replace(/<@!?(\d+)>/g, (_, id: string) => guild.members.cache.get(id)?.displayName ?? 'someone')
    .replace(/<@&(\d+)>/g, (_, id: string) => guild.roles.cache.get(id)?.name ?? 'a role')
    .replace(/<#(\d+)>/g, (_, id: string) => {
      const channel = guild.channels.cache.get(id);
      return channel && canSee(guild, channel) ? channel.name : 'a channel';
    })
    .replace(/<a?:(\w+):\d+>/g, ' $1 ')
    .replace(LINK, 'link')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, ' ')
    .replace(/[*~`|]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Says a line into a WAV file, levelled like any other speech, for the looping room to play over and over. Throws why it couldn't, for the user */
async function speakToFile(guild: Guild, typed: string, voiceId: string, file: string) {
  if (!config.voiceUrl) throw new Error('Text to speech isn’t set up on this bot. It needs VOICE_URL.');
  const text = speechFor(guild, typed);
  if (!hasWords(text)) throw new Error('There’s nothing in that to say.');
  const voice = serverVoice(guild.id, voiceId);
  const made = await lineAudio(text, voice, setting(guild.id, 'ttsSpeed'), new AbortController().signal).catch((err: unknown) => {
    // Anything else, like ffmpeg failing, says what it is
    throw err instanceof VoiceDown ? new Error('The voice container isn’t answering, so the looping speech can’t be made.') : err;
  });
  writeFileSync(file, made);
}

/** The length_scale that gives a speed, as a percentage of the voice's natural speed */
export function lengthFor(speed: number, stretches = STRETCHES) {
  const stretch = 100 / speed;
  const next = stretches.findIndex(([longer]) => longer >= stretch);
  if (next === -1) return stretches.at(-1)![1];
  if (next === 0) return stretches[0][1];
  const [[fromStretch, fromLength], [toStretch, toLength]] = [stretches[next - 1], stretches[next]];
  return Math.round((fromLength + ((toLength - fromLength) * (stretch - fromStretch)) / (toStretch - fromStretch)) * 100) / 100;
}

async function speech(text: string, voice: Voice, speed: number, signal: AbortSignal) {
  // A model the container doesn't have gets its default one instead, with no error, so voice/start.sh fetches every model named here
  const res = await fetch(`${config.voiceUrl}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice: voice.model,
      speaker_id: voice.speaker,
      length_scale: Math.round(lengthFor(speed, voice.stretches) * (voice.pace ?? 1) * 100) / 100,
      noise_scale: voice.noise?.[0],
      noise_w_scale: voice.noise?.[1],
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`Voice container said HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Most of what's said again soon is a saved line, a preview then the same line said, or a looping room's speech */
const KEEP_SPOKEN_BYTES = 24 * 1024 * 1024;
const LONGEST_KEPT_BYTES = 4 * 1024 * 1024;
/**
 * Kept no longer than this. A voice container still fetching a model answers in its default voice, with no error, and
 * that shouldn't stick to a line for good
 */
const KEEP_SPOKEN_MS = 30 * 60_000;
/** Lines lately made, levelled and ready to play, oldest first. In memory, so a restart or a change to a voice starts afresh */
const spoken = new Map<string, { audio: Buffer; at: number }>();
let spokenBytes = 0;
/** Lines being made right now, so asking for one twice at once makes it once */
const making = new Map<string, Promise<Buffer>>();

/** The voice container didn't answer, as opposed to the levelling after it failing */
class VoiceDown extends Error {}

function forgetLine(key: string) {
  const old = spoken.get(key);
  if (!old) return;
  spoken.delete(key);
  spokenBytes -= old.audio.length;
}

function keepLine(key: string, audio: Buffer) {
  if (audio.length > LONGEST_KEPT_BYTES) return;
  forgetLine(key);
  spoken.set(key, { audio, at: Date.now() });
  spokenBytes += audio.length;
  for (const [oldKey] of spoken) {
    if (spokenBytes <= KEEP_SPOKEN_BYTES) break;
    forgetLine(oldKey);
  }
}

async function makeLine(text: string, voice: Voice, speed: number): Promise<Buffer> {
  folder ??= mkdtempSync(path.join(tmpdir(), 'slopkeeper-say-'));
  const file = path.join(folder, `made-${randomUUID()}.wav`);
  const unlevelled = `${file}.raw.wav`;
  try {
    const raw = await speech(text, voice, speed, new AbortController().signal).catch((err: unknown) => {
      throw new VoiceDown(err instanceof Error ? err.message : String(err));
    });
    writeFileSync(unlevelled, raw);
    await levelSpeech(unlevelled, file, voice.effects);
    return readFileSync(file);
  } finally {
    rmSync(file, { force: true });
    rmSync(unlevelled, { force: true });
  }
}

/** A line levelled and ready to play, made again only if it isn't one of the lines lately made or being made */
async function lineAudio(text: string, voice: Voice, speed: number, signal: AbortSignal): Promise<Buffer> {
  const key = JSON.stringify([voice.id, speed, text]);
  const kept = spoken.get(key);
  if (kept && Date.now() - kept.at < KEEP_SPOKEN_MS) {
    // To the newest end, so lines said often are the last to go
    spoken.delete(key);
    spoken.set(key, kept);
    return kept.audio;
  }
  forgetLine(key);
  let made = making.get(key);
  if (!made) {
    // Made for whoever asks for it meanwhile, so one caller's Stop doesn't fail the others. A stopped line is still
    // finished and kept, as it's often said again straight after
    made = makeLine(text, voice, speed).then(
      (audio) => (keepLine(key, audio), audio),
    );
    making.set(key, made);
    const settled = () => void (making.get(key) === made && making.delete(key));
    made.then(settled, settled);
  }
  signal.throwIfAborted();
  return Promise.race([made, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
}

/** For tests: forgets every line lately made */
export function forgetSpoken() {
  spoken.clear();
  making.clear();
  spokenBytes = 0;
}

const PREVIEW_EVERY_MS = 2_000;
const PREVIEWS_PER_MINUTE = 12;
/** Server id → when its recent previews were asked for */
const previewsAt = new Map<string, number[]>();

/**
 * A line in a voice, as a WAV file, for the web UI to play in the browser so someone can hear a voice before the
 * whole call does. A blank line gets the voice saying its name. Throws a TooSoon when a server asks too often
 */
export async function previewSpeech(guild: Guild, typed: string, voiceId: string): Promise<Buffer> {
  if (!config.voiceUrl) throw new Error('Text to speech isn’t set up on this bot.');
  const voice = serverVoice(guild.id, voiceId);
  const now = Date.now();
  const recent = (previewsAt.get(guild.id) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= PREVIEWS_PER_MINUTE || now - (recent.at(-1) ?? 0) < PREVIEW_EVERY_MS) throw new TooSoon();
  previewsAt.set(guild.id, [...recent, now]);
  const text = typed.trim() ? speechFor(guild, typed).slice(0, setting(guild.id, 'ttsMaxChars')) : `Hi, this is ${voice.name}.`;
  if (!hasWords(text)) throw new Error('There’s nothing in that to say.');
  return lineAudio(text, voice, setting(guild.id, 'ttsSpeed'), new AbortController().signal);
}

/** A server asked for previews faster than they're allowed */
export class TooSoon extends Error {
  constructor() {
    super('Wait a moment before the next preview.');
  }
}

async function sayLine(queue: Queue, { channel, text, voice, started }: Line) {
  const guildId = channel.guild.id;
  const cancel = (queue.cancel = new AbortController());
  folder ??= mkdtempSync(path.join(tmpdir(), 'slopkeeper-say-'));
  // Each line has its own file, as the mixer takes a file it's already playing to be a restart
  const file = path.join(folder, `${randomUUID()}.wav`);
  try {
    writeFileSync(file, await lineAudio(text, voice, setting(guildId, 'ttsSpeed'), cancel.signal));
    cancel.signal.throwIfAborted();
    // At full gain: the speech volume is the group's, so moving it changes a line already being said
    await new Promise<void>((finished, failed) => {
      play(channel, file, 1, finished, { group: 'speech', label: text })
        .then((problem) => {
          started(problem);
          if (problem) finished();
        })
        .catch(failed);
    });
  } catch (err) {
    if (!cancel.signal.aborted) console.error(`Couldn’t say a line in server ${guildId}:`, err);
    started(cancel.signal.aborted ? STOPPED : UNAVAILABLE);
  } finally {
    rmSync(file, { force: true });
  }
}

async function run(queue: Queue) {
  if (queue.running) return;
  queue.running = true;
  // One at a time, as two voices at once can't be understood
  for (let line = queue.lines.shift(); line; line = queue.lines.shift()) await sayLine(queue, line);
  queue.running = false;
}

function stopLines(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;
  for (const line of queue.lines.splice(0)) line.started(STOPPED);
  queue.cancel?.abort();
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** Why this can't be said right now, or null if it can */
function sayProblem(guild: Guild, text: string, who: string): string | null {
  if (!config.voiceUrl) return 'Text to speech isn’t set up on this bot. It needs VOICE_URL.';
  if (!setting(guild.id, 'tts')) return 'Text to speech is off in this server.';
  if (!hasWords(text)) return 'There’s nothing in that to read out.';
  const longest = setting(guild.id, 'ttsMaxChars');
  if (text.length > longest) return `That’s ${text.length} characters, and the limit here is ${longest}.`;
  const left = (lastLine.get(`${guild.id}:${who}`) ?? -Infinity) + setting(guild.id, 'ttsCooldownSec') * 1000 - Date.now();
  if (left > 0) return `Wait ${plural(Math.ceil(left / 1000), 'more second')} first.`;
  return queueFor(guild.id).lines.length >= MOST_WAITING ? `There are already ${MOST_WAITING} lines waiting. Try again in a moment.` : null;
}

/** Says something in a channel, after any lines ahead of it. Returns null once it's started, or why it couldn't. `who` is a user id, or who on the web UI (see activity.ts) */
export async function say(channel: VoiceBasedChannel, typed: string, voiceId: string | undefined, who: string): Promise<string | null> {
  const { guild } = channel;
  const voice = voiceId === undefined ? serverVoice(guild.id) : voiceCalled(voiceId);
  if (!voice) return 'Pick a voice from the list.';
  const text = speechFor(guild, typed);
  const problem = sayProblem(guild, text, who);
  if (problem) return problem;
  lastLine.set(`${guild.id}:${who}`, Date.now());

  const failed = await queueLine(channel, text, voice);
  if (!failed) logActivity(guild.id, who, `Said “${text}” in <#${channel.id}>`);
  return failed;
}

/** Says a line nobody typed, in the server's voice. Returns null once it's started, or why it couldn't */
export function sayOut(channel: VoiceBasedChannel, line: string): Promise<string | null> {
  const { guild } = channel;
  const text = speechFor(guild, line);
  const voice = serverVoice(guild.id);
  if (!config.voiceUrl || !setting(guild.id, 'tts') || !hasWords(text)) return Promise.resolve('Nothing to say.');
  if (queueFor(guild.id).lines.length >= MOST_WAITING) return Promise.resolve('Too many lines waiting.');
  return queueLine(channel, text, voice);
}

/** Says an announcement to the people in a channel, unless that means leaving people in another */
export async function announceAloud(channel: VoiceBasedChannel, line: string, key: 'ttsNightReminders' | 'ttsHopOn') {
  const { guild } = channel;
  if (!setting(guild.id, key) || !humansIn(channel).length) return;
  const botChannel = getVoiceConnection(guild.id)?.joinConfig.channelId;
  if (botChannel && botChannel !== channel.id) return;
  const problem = await sayOut(channel, line);
  if (problem && problem !== STOPPED) console.error(`Couldn’t say an announcement in server ${guild.id}: ${problem}`);
}

/** What to say when someone joins voice, or null for nothing */
function greetingFor(member: GuildMember): string | null {
  const { guild } = member;
  if (!config.voiceUrl || !setting(guild.id, 'tts') || !setting(guild.id, 'ttsGreet')) return null;
  const name = [member.displayName, member.user.username].find((n) => hasWords(speechFor(guild, n)));
  return name ? setting(guild.id, 'ttsGreeting').replaceAll('{name}', () => name) : null;
}

/** A line to say again, in whichever voice is picked when it's said */
export interface Phrase {
  id: number;
  text: string;
}

export const phrases = (guildId: string) => db.prepare('SELECT id, text FROM saved_phrases WHERE guild_id = ? ORDER BY id').all(guildId) as unknown as Phrase[];

/** Keeps a line to say again. Returns null on success or the reason it couldn't */
export function savePhrase(guild: Guild, typed: string): string | null {
  const text = typed.trim().replace(/\s+/g, ' ');
  const spoken = speechFor(guild, text);
  if (!hasWords(spoken)) return 'There’s nothing in that to read out.';
  const longest = setting(guild.id, 'ttsMaxChars');
  if (spoken.length > longest) return `That’s ${spoken.length} characters, and the limit here is ${longest}.`;
  const saved = phrases(guild.id);
  if (saved.some((p) => p.text === text)) return null;
  if (saved.length >= MOST_PHRASES) return `You can keep ${MOST_PHRASES} lines. Remove one first.`;
  // Lines used to keep the voice they were saved in. The column stays, as the table can't change shape, but nothing reads it
  db.prepare("INSERT INTO saved_phrases (guild_id, text, voice) VALUES (?, ?, '')").run(guild.id, text);
  return null;
}

export const removePhrase = (guildId: string, id: number) => db.prepare('DELETE FROM saved_phrases WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;

function queueLine(channel: VoiceBasedChannel, text: string, voice: Voice) {
  const queue = queueFor(channel.guild.id);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  queue.lines.push({ channel, text, voice, started: resolve });
  void run(queue);
  return promise;
}

/** Where to read out someone's message: wherever they are, or wherever people are listening */
function listeningChannel(message: Message<true>): VoiceBasedChannel | null {
  const { guild } = message;
  const open = (channel: VoiceBasedChannel | null | undefined) => (channel && channel.id !== guild.afkChannelId && humansIn(channel).length > 0 ? channel : null);
  const own = open(message.member?.voice.channel);
  if (own || setting(guild.id, 'ttsChannelWho') === 'voice') return own;
  const joined = guild.channels.cache.get(getVoiceConnection(guild.id)?.joinConfig.channelId ?? '');
  const current = open(joined?.isVoiceBased() ? joined : null);
  if (current) return current;
  const busy = [...guild.channels.cache.values()].flatMap((c) => (c.isVoiceBased() && open(c) ? [c] : []));
  return busy.sort((a, b) => humansIn(b).length - humansIn(a).length)[0] ?? null;
}

/** Reads out a message from the server's chosen channel, if it's something that can be said */
export async function readMessage(message: Message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
  const { guild, member, author } = message;
  if (!config.voiceUrl || !setting(guild.id, 'tts') || message.channelId !== idSetting(guild.id, 'ttsChannel')) return;
  const role = idSetting(guild.id, 'ttsRole');
  if (role && !member?.roles.cache.has(role) && !member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;

  const shown = sayable(message.content);
  const text = speechFor(guild, shown);
  if (!hasWords(speechFor(guild, shown.replace(LINK, ' '))) || text.length > setting(guild.id, 'ttsMaxChars')) return;
  const channel = listeningChannel(message);
  const voice = serverVoice(guild.id);
  if (!channel || queueFor(guild.id).lines.length >= MOST_WAITING) return;

  const last = lastReader.get(guild.id);
  const sameSpeaker = last?.id === author.id && Date.now() - last.at < SAME_SPEAKER_MS;
  lastReader.set(guild.id, { id: author.id, at: Date.now() });
  const problem = await queueLine(channel, sameSpeaker ? text : `${speechFor(guild, member?.displayName ?? author.displayName)} says, ${text}`, voice);
  if (problem && problem !== STOPPED) console.error(`Couldn’t read a message out in server ${guild.id}: ${problem}`);
}

/** A message's text without what shouldn't be read out: saying a spoiler would ruin it, and nobody wants to hear code */
const sayable = (content: string) => content.replace(/\|\|[\s\S]*?\|\|/g, ' ').replace(/```[\s\S]*?```/g, ' ');

/** With a role set, using this takes that role or Manage Server */
function canSay(i: { guildId: string; memberPermissions: Readonly<PermissionsBitField>; member: GuildMember }) {
  const role = idSetting(i.guildId, 'ttsRole');
  return !role || i.memberPermissions.has(PermissionFlagsBits.ManageGuild) || i.member.roles.cache.has(role);
}

export const speak: Feature = {
  title: 'Text to speech',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Have the bot say something in your voice channel')
        .addStringOption((o) => o.setName('text').setDescription('What to say').setMaxLength(LONGEST_TYPED))
        .addStringOption((o) =>
          o
            .setName('voice')
            .setDescription('Which voice (default: this server’s)')
            .setAutocomplete(true),
        )
        .addStringOption((o) => o.setName('saved').setDescription('A saved line, instead of typing one').setAutocomplete(true)),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        if (!canSay(i)) {
          return i.reply({ content: `Only <@&${idSetting(i.guildId, 'ttsRole')}> and people with **Manage Server** can use this.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
        const channel = i.member.voice.channel;
        if (!channel) return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
        const typed = i.options.getString('text');
        const saved = i.options.getString('saved');
        const phrase = phrases(i.guildId).find((p) => String(p.id) === saved);
        const text = typed ?? phrase?.text;
        if (!text) return i.reply({ content: saved ? 'Pick a saved line from the list.' : 'Type something to say, or pick a saved line.', flags: MessageFlags.Ephemeral });
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const problem = await say(channel, text, i.options.getString('voice') ?? undefined, i.user.id);
        return i.editReply(problem ?? 'Said it.');
      },
      async autocomplete(i) {
        const focused = i.options.getFocused(true);
        const search = focused.value.toLowerCase();
        // Searched rather than a fixed list, as Discord shows at most 25 choices
        if (focused.name === 'voice') {
          const matches = VOICES.filter((v) => v.name.toLowerCase().includes(search) || v.id.includes(search));
          return i.respond(matches.slice(0, 25).map((v) => ({ name: v.name, value: v.id })));
        }
        const matches = i.guildId ? phrases(i.guildId).filter((p) => p.text.toLowerCase().includes(search)) : [];
        return i.respond(matches.slice(0, 25).map((p) => ({ name: p.text.slice(0, 100), value: String(p.id) })));
      },
    },
  ],
  menus: [
    {
      data: new ContextMenuCommandBuilder().setName('Say this aloud').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),
      about: 'On a message: reads it out in your voice channel, in the server’s voice, as /say would.',
      async run(i) {
        if (!i.isMessageContextMenuCommand() || !i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        if (!canSay(i)) {
          return i.reply({ content: `Only <@&${idSetting(i.guildId, 'ttsRole')}> and people with **Manage Server** can use this.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
        const channel = i.member.voice.channel;
        if (!channel) return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
        const message = i.targetMessage;
        const shown = sayable(message.content);
        if (!hasWords(speechFor(i.guild, shown.replace(LINK, ' ')))) return i.reply({ content: 'There’s nothing in that message to read out.', flags: MessageFlags.Ephemeral });
        // Someone else's words say whose they are, as reading the chat channel aloud does
        const line = message.author.id === i.user.id ? shown : `${message.member?.displayName ?? message.author.displayName} says, ${shown}`;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const problem = await say(channel, line, undefined, i.user.id);
        return i.editReply(problem ?? 'Said it.');
      },
    },
  ],
  setup(client) {
    const forgotten = forgetRemovedVoices();
    if (forgotten) console.log(`Text to speech: ${plural(forgotten, 'server voice pick')} of removed voices went back to the default`);
    onPlaybackStop(stopLines);
    setGreeter(greetingFor, sayOut);
    setLoopSpeaker(speakToFile, (guild, id) => serverVoice(guild.id, id));
    client.on(Events.MessageCreate, (message) => void readMessage(message).catch(console.error));
  },
};
