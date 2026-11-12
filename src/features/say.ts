import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getVoiceConnection } from '@discordjs/voice';
import { Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type Guild, type GuildMember, type Message, type VoiceBasedChannel } from 'discord.js';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { levelSpeech } from '../loudness.ts';
import { DEFAULTS, idSetting, setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { humansIn } from '../util.ts';
import { plural } from './gamestats.ts';
import { onPlaybackStop, play, setGreeter, setLoopSpeaker } from './soundboard.ts';

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

/** The same, measured across the GLaDOS and HAL models, which stretch more evenly. Bender, Optimus Prime and TikTok match it within 3% */
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
}

export const VOICES: readonly Voice[] = [
  { id: '1', name: 'Voice 1', speaker: 0 },
  { id: '2', name: 'Voice 2', speaker: 100 },
  { id: '5', name: 'Voice 5', speaker: 400 },
  { id: '9', name: 'Voice 9', speaker: 800 },
  // Calmer than the model's own 0.667 and 0.8, which wobble in longer lines
  { id: 'glados', name: 'GLaDOS', model: 'glados', noise: [0.333, 0.333], stretches: CHARACTER_STRETCHES },
  { id: 'hal', name: 'HAL 9000', model: 'hal', stretches: CHARACTER_STRETCHES },
  { id: 'bender', name: 'Bender', model: 'bender', stretches: CHARACTER_STRETCHES },
  { id: 'optimus', name: 'Optimus Prime', model: 'optimus', stretches: CHARACTER_STRETCHES },
  // Kronk stretches like the default model's voices, but sounded rushed: it's 15% slower, with steadier timing
  { id: 'kronk', name: 'Kronk', model: 'kronk', noise: [0.667, 0.333], pace: 1.15 },
  { id: 'tiktok', name: 'TikTok', model: 'tiktok', stretches: CHARACTER_STRETCHES },
];

/** The voice a server uses when nobody picks one. A stored voice that's since been removed falls back to the bot's default, then Voice 5 */
export function serverVoice(guildId: string, id: string | null = setting(guildId, 'ttsVoice')): Voice {
  return VOICES.find((v) => v.id === id) ?? VOICES.find((v) => v.id === DEFAULTS.ttsVoice) ?? VOICES.find((v) => v.id === '5')!;
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
    .replace(/<#(\d+)>/g, (_, id: string) => guild.channels.cache.get(id)?.name ?? 'a channel')
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
  const raw = `${file}.raw.wav`;
  try {
    writeFileSync(raw, await speech(text, voice, setting(guild.id, 'ttsSpeed'), new AbortController().signal).catch(() => {
      throw new Error('The voice container isn’t answering, so the looping speech can’t be made.');
    }));
    await levelSpeech(raw, file);
  } finally {
    rmSync(raw, { force: true });
  }
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

async function sayLine(queue: Queue, { channel, text, voice, started }: Line) {
  const guildId = channel.guild.id;
  const cancel = (queue.cancel = new AbortController());
  folder ??= mkdtempSync(path.join(tmpdir(), 'slopkeeper-say-'));
  // Each line has its own file, as the mixer takes a file it's already playing to be a restart
  const file = path.join(folder, `${randomUUID()}.wav`);
  const unlevelled = `${file}.raw.wav`;
  try {
    writeFileSync(unlevelled, await speech(text, voice, setting(guildId, 'ttsSpeed'), cancel.signal));
    await levelSpeech(unlevelled, file);
    cancel.signal.throwIfAborted();
    const gain = setting(guildId, 'ttsVolume') / 100;
    await new Promise<void>((finished, failed) => {
      play(channel, file, gain, finished, { group: 'speech' })
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
    rmSync(unlevelled, { force: true });
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
  const voice = voiceId === undefined ? serverVoice(guild.id) : VOICES.find((v) => v.id === voiceId);
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

  // Saying a spoiler would ruin it, and nobody wants to hear code
  const shown = message.content.replace(/\|\|[\s\S]*?\|\|/g, ' ').replace(/```[\s\S]*?```/g, ' ');
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

/** With a role set, using this takes that role or Manage Server */
function canSay(i: ChatInputCommandInteraction<'cached'>) {
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
            .addChoices(...VOICES.map((v) => ({ name: v.name, value: v.id }))),
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
        const search = i.options.getFocused().toLowerCase();
        const matches = i.guildId ? phrases(i.guildId).filter((p) => p.text.toLowerCase().includes(search)) : [];
        return i.respond(matches.map((p) => ({ name: p.text.slice(0, 100), value: String(p.id) })));
      },
    },
  ],
  setup(client) {
    onPlaybackStop(stopLines);
    setGreeter(greetingFor, sayOut);
    setLoopSpeaker(speakToFile);
    client.on(Events.MessageCreate, (message) => void readMessage(message).catch(console.error));
  },
};
