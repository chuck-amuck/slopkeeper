import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type Guild, type VoiceBasedChannel } from 'discord.js';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { levelSpeech } from '../loudness.ts';
import { idSetting, setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { plural } from './gamestats.ts';
import { onPlaybackStop, play } from './soundboard.ts';

/** Speakers in the voice container's model, numbered as they were when they were picked */
export const VOICES = [
  { id: '1', name: 'Voice 1', speaker: 0 },
  { id: '2', name: 'Voice 2', speaker: 100 },
  { id: '5', name: 'Voice 5', speaker: 400 },
  { id: '9', name: 'Voice 9', speaker: 800 },
];

/**
 * How much longer speech takes at each of Piper's length_scale values, measured across VOICES. It's far from proportional,
 * as each sound's length gets rounded: asking for 18% longer only gives about 5%
 */
const STRETCHES = [
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

const SPEAK_TIMEOUT_MS = 15_000;
/** Lines waiting behind the one being said */
const MOST_WAITING = 5;
/** Discord's own limit on the option. The server's limit is applied to what gets read out, so a mention doesn't count as its id */
const LONGEST_TYPED = 1000;
const UNAVAILABLE = 'The voice isn’t available right now. Try again in a moment.';
const STOPPED = 'Stopped before that was said.';

interface Line {
  channel: VoiceBasedChannel;
  text: string;
  speaker: number;
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
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, ' ')
    .replace(/[*~`|]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The length_scale that gives a speed, as a percentage of the voice's natural speed */
export function lengthFor(speed: number) {
  const stretch = 100 / speed;
  const next = STRETCHES.findIndex(([longer]) => longer >= stretch);
  if (next === -1) return STRETCHES.at(-1)![1];
  if (next === 0) return STRETCHES[0][1];
  const [[fromStretch, fromLength], [toStretch, toLength]] = [STRETCHES[next - 1], STRETCHES[next]];
  return Math.round((fromLength + ((toLength - fromLength) * (stretch - fromStretch)) / (toStretch - fromStretch)) * 100) / 100;
}

async function speech(text: string, speaker: number, speed: number, signal: AbortSignal) {
  const res = await fetch(`${config.voiceUrl}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker_id: speaker, length_scale: lengthFor(speed) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`Voice container said HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function sayLine(queue: Queue, { channel, text, speaker, started }: Line) {
  const guildId = channel.guild.id;
  const cancel = (queue.cancel = new AbortController());
  folder ??= mkdtempSync(path.join(tmpdir(), 'slopkeeper-say-'));
  // Each line has its own file, as the mixer takes a file it's already playing to be a restart
  const file = path.join(folder, `${randomUUID()}.wav`);
  const unlevelled = `${file}.raw.wav`;
  try {
    writeFileSync(unlevelled, await speech(text, speaker, setting(guildId, 'ttsSpeed'), cancel.signal));
    await levelSpeech(unlevelled, file);
    cancel.signal.throwIfAborted();
    const gain = setting(guildId, 'ttsVolume') / 100;
    await new Promise<void>((finished, failed) => {
      play(channel, file, gain, finished)
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

/** Why this can't be said right now, or null if it can */
function sayProblem(guild: Guild, text: string, who: string): string | null {
  if (!config.voiceUrl) return 'Text to speech isn’t set up on this bot. It needs VOICE_URL.';
  if (!setting(guild.id, 'tts')) return 'Text to speech is off in this server.';
  if (!/[\p{L}\p{N}]/u.test(text)) return 'There’s nothing in that to read out.';
  const longest = setting(guild.id, 'ttsMaxChars');
  if (text.length > longest) return `That’s ${text.length} characters, and the limit here is ${longest}.`;
  const left = (lastLine.get(`${guild.id}:${who}`) ?? -Infinity) + setting(guild.id, 'ttsCooldownSec') * 1000 - Date.now();
  if (left > 0) return `Wait ${plural(Math.ceil(left / 1000), 'more second')} first.`;
  return queueFor(guild.id).lines.length >= MOST_WAITING ? `There are already ${MOST_WAITING} lines waiting. Try again in a moment.` : null;
}

/** Says something in a channel, after any lines ahead of it. Returns null once it's started, or why it couldn't. `who` is a user id, or FROM_WEB */
export async function say(channel: VoiceBasedChannel, typed: string, voiceId: string | undefined, who: string): Promise<string | null> {
  const { guild } = channel;
  const voice = VOICES.find((v) => v.id === (voiceId ?? setting(guild.id, 'ttsVoice')));
  if (!voice) return 'Pick a voice from the list.';
  const text = speechFor(guild, typed);
  const problem = sayProblem(guild, text, who);
  if (problem) return problem;
  lastLine.set(`${guild.id}:${who}`, Date.now());

  const queue = queueFor(guild.id);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  queue.lines.push({ channel, text, speaker: voice.speaker, started: resolve });
  void run(queue);
  const failed = await promise;
  if (!failed) logActivity(guild.id, who, `Said “${text}” in <#${channel.id}>`);
  return failed;
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
        .addStringOption((o) => o.setName('text').setDescription('What to say').setRequired(true).setMaxLength(LONGEST_TYPED))
        .addStringOption((o) =>
          o
            .setName('voice')
            .setDescription('Which voice (default: this server’s)')
            .addChoices(...VOICES.map((v) => ({ name: v.name, value: v.id }))),
        ),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        if (!canSay(i)) {
          return i.reply({ content: `Only <@&${idSetting(i.guildId, 'ttsRole')}> and people with **Manage Server** can use this.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
        const channel = i.member.voice.channel;
        if (!channel) return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const problem = await say(channel, i.options.getString('text', true), i.options.getString('voice') ?? undefined, i.user.id);
        return i.editReply(problem ?? 'Said it.');
      },
    },
  ],
  setup() {
    onPlaybackStop(stopLines);
  },
};
