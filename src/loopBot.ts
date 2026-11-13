import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { PermissionFlagsBits, type Client, type Guild, type VoiceBasedChannel } from 'discord.js';
import { MIX_VOLUME, Mixer } from './mixer.ts';
import { containerUsage } from './perf.ts';

/**
 * The loop bot: a second Discord bot that only plays the looping room, so the main bot is free to play everywhere else.
 * Discord lets one bot be in one voice channel per server. The main bot works out what the room should play and sends it here
 */

/** One part of the room's loop: the sound or the speech */
export interface LoopPart {
  file: string;
  gain: number;
  /** Starts a fresh copy this often, layered. 0 loops it without a gap */
  everyMs: number;
  /** How long it waits after the intro, or after the loop starts with no intro */
  delayMs: number;
}

/** What the room plays. A new `run` starts it over from the intro, and the same run with other parts takes them up straight away */
export interface LoopProgram {
  run: number;
  channelId: string;
  intro: { file: string; gain: number; delayMs: number } | null;
  parts: LoopPart[];
}

const MAX_VOICES = 12;
const CONNECT_TIMEOUT_MS = 15_000;
const RECONNECT_TIMEOUT_MS = 5_000;
// Told to leave by the main bot as the room empties, but it shouldn't sit there alone if that's missed
const EMPTY_LEAVE_MS = 30_000;
const MOST_MS = 60_000;
const MOST_GAIN = 10;
const MOST_BODY_BYTES = 64 * 1024;

const humansIn = (channel: VoiceBasedChannel) => [...channel.members.values()].filter((m) => !m.user.bot);

/** Why the loop bot can't play in a channel, or null if it can */
function cantJoin(channel: VoiceBasedChannel): string | null {
  const perms = channel.permissionsFor(channel.guild.members.me!);
  const missing = (
    [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [PermissionFlagsBits.Connect, 'Connect'],
      [PermissionFlagsBits.Speak, 'Speak'],
    ] as const
  )
    .filter(([flag]) => !perms?.has(flag))
    .map(([, name]) => name);
  if (missing.length) return `The loop bot can’t play in ${channel.name}. It needs **${missing.join('**, **')}** there.`;
  return channel.joinable ? null : `The loop bot can’t join ${channel.name}, it’s full.`;
}

/** One server's looping room, as this bot plays it */
export class LoopRoom {
  program: LoopProgram | null = null;
  private readonly player: AudioPlayer;
  private mixer?: Mixer;
  private introStop?: () => void;
  private partStops: (() => void)[] = [];
  private timers = new Set<NodeJS.Timeout>();
  /** Counted up whenever it starts over or stops, so whatever an older start left waiting does nothing */
  private seq = 0;
  private introPending = false;
  private emptyTimer?: NodeJS.Timeout;
  private readonly guild: Guild;

  constructor(guild: Guild) {
    this.guild = guild;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on('error', (err) => console.error(`Audio player error in ${guild.name}:`, err.message));
  }

  /** Plays a program, starting over or taking up the change as its run says. Returns null, or why it couldn't */
  async play(program: LoopProgram): Promise<string | null> {
    const channel = this.guild.channels.cache.get(program.channelId);
    if (!channel?.isVoiceBased()) return 'That isn’t a voice channel the loop bot can see.';
    const problem = cantJoin(channel);
    if (problem) return problem;
    const old = this.program;
    const joined = await this.connect(channel);
    if (typeof joined === 'string') return joined;
    this.program = program;
    this.checkEmpty();
    if (!joined && old?.run === program.run && old.channelId === program.channelId) {
      if (JSON.stringify(old) !== JSON.stringify(program) && !this.introPending) this.startParts(this.seq, false);
      return null;
    }
    this.begin();
    return null;
  }

  /** Silences the room and leaves it */
  stop() {
    this.seq++;
    this.program = null;
    this.introPending = false;
    clearTimeout(this.emptyTimer);
    this.clearTimers();
    this.mixer?.stopAll();
    this.mixer = undefined;
    this.introStop = undefined;
    this.partStops = [];
    this.player.stop(true);
    const connection = getVoiceConnection(this.guild.id);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  /** Leaves a while after the last person goes, in case the main bot's word doesn't arrive */
  checkEmpty() {
    const channelId = getVoiceConnection(this.guild.id)?.joinConfig.channelId;
    const channel = channelId ? this.guild.channels.cache.get(channelId) : undefined;
    clearTimeout(this.emptyTimer);
    if (!channel?.isVoiceBased() || humansIn(channel).length) return;
    this.emptyTimer = setTimeout(() => {
      console.log(`Left the empty loop room in ${this.guild.name}`);
      this.stop();
    }, EMPTY_LEAVE_MS).unref();
  }

  /** From the top: the intro after its delay, then each part after its own */
  private begin() {
    const seq = ++this.seq;
    this.clearTimers();
    this.introStop?.();
    this.introStop = undefined;
    this.stopParts();
    const intro = this.program!.intro;
    if (!intro) return this.startParts(seq, true);
    this.introPending = true;
    this.after(intro.delayMs, seq, () => {
      // A file that won't play ends by itself too, so the loop still starts
      this.introStop = this.mix(intro.file, intro.gain, () => {
        if (seq !== this.seq) return;
        this.introPending = false;
        this.introStop = undefined;
        this.startParts(seq, true);
      });
    });
  }

  /** Starts each part, after its delay when coming after the intro, or straight away to take up a change */
  private startParts(seq: number, withDelays: boolean) {
    this.clearTimers();
    this.stopParts();
    for (const part of this.program!.parts) {
      this.after(withDelays ? part.delayMs : 0, seq, () => {
        this.partStops.push(this.mix(part.file, part.gain, undefined, { loop: true, ...(part.everyMs > 0 && { everyMs: part.everyMs }) }));
      });
    }
  }

  private stopParts() {
    for (const stop of this.partStops) stop();
    this.partStops = [];
  }

  private after(ms: number, seq: number, run: () => void) {
    if (ms <= 0) return run();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (seq === this.seq) run();
    }, ms);
    this.timers.add(timer);
  }

  private clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Mixes a file in. A fresh mixer is only needed once the last one has gone quiet */
  private mix(file: string, gain: number, onEnd?: (byItself: boolean) => void, options: { loop?: boolean; everyMs?: number } = {}): () => void {
    if (this.mixer && !this.mixer.finished) return this.mixer.add(file, gain, onEnd, options);
    this.mixer = new Mixer(MIX_VOLUME, MAX_VOICES);
    // Before playing, or the mixer would find nothing to mix and end straight away
    const stop = this.mixer.add(file, gain, onEnd, options);
    this.player.play(createAudioResource(this.mixer, { inputType: StreamType.Raw }));
    return stop;
  }

  /** Gets into the channel. Returns whether it had to join afresh, which starts the room over, or why it couldn't */
  private async connect(channel: VoiceBasedChannel): Promise<boolean | string> {
    let connection: VoiceConnection | undefined = getVoiceConnection(this.guild.id);
    const fresh = !connection || connection.joinConfig.channelId !== channel.id || connection.state.status === VoiceConnectionStatus.Disconnected || connection.state.status === VoiceConnectionStatus.Destroyed;
    if (fresh) {
      const isNew = !connection || connection.state.status === VoiceConnectionStatus.Destroyed;
      connection = joinVoiceChannel({ channelId: channel.id, guildId: this.guild.id, adapterCreator: this.guild.voiceAdapterCreator, selfDeaf: true });
      if (isNew) this.watch(connection);
      connection.subscribe(this.player);
    }
    try {
      await entersState(connection!, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch {
      console.error(`Voice connection to ${channel.name} in ${this.guild.name} timed out in state ${connection!.state.status}`);
      this.stop();
      return `The loop bot couldn’t connect to ${channel.name}. It tries again when someone comes in.`;
    }
    return fresh;
  }

  private watch(connection: VoiceConnection) {
    // Without a listener, a voice network error would be thrown and take the whole bot down
    connection.on('error', (err) => console.error(`Voice connection error in ${this.guild.name}:`, err.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS), entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS)]);
      } catch {
        // Disconnected by someone, or the channel went away. The main bot sends the room again when someone comes in
        this.stop();
      }
    });
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest();

const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MOST_MS;
const isGain = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MOST_GAIN;

/** A program the main bot sent, checked, with every file inside `filesRoot`, or why it isn't one */
export function readProgram(body: unknown, filesRoot: string): LoopProgram | string {
  const p = body as Partial<LoopProgram> | null;
  if (!p || typeof p !== 'object') return 'Send a program.';
  if (!Number.isSafeInteger(p.run) || typeof p.channelId !== 'string' || !/^\d{1,20}$/.test(p.channelId)) return 'A program needs a run and a channel.';
  const root = path.resolve(filesRoot) + path.sep;
  const inside = (file: unknown): file is string => typeof file === 'string' && path.resolve(file).startsWith(root);
  const intro = p.intro ?? null;
  if (intro !== null && (typeof intro !== 'object' || !inside(intro.file) || !isGain(intro.gain) || !isMs(intro.delayMs))) return 'That intro isn’t right.';
  if (!Array.isArray(p.parts) || !p.parts.length || p.parts.length > 4) return 'A program needs one to four parts.';
  for (const part of p.parts as Partial<LoopPart>[]) {
    if (!part || typeof part !== 'object' || !inside(part.file) || !isGain(part.gain) || !isMs(part.everyMs) || !isMs(part.delayMs)) return 'One of those parts isn’t right.';
  }
  return {
    run: p.run!,
    channelId: p.channelId,
    intro: intro && { file: path.resolve(intro.file), gain: intro.gain, delayMs: intro.delayMs },
    parts: p.parts.map((part) => ({ file: path.resolve(part.file), gain: part.gain, everyMs: part.everyMs, delayMs: part.delayMs })),
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MOST_BODY_BYTES) throw new Error('too big');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The loop bot's API, for the main bot only, inside the stack:
 * `GET /status`, `GET /stats` (its memory and CPU, for the main bot's health numbers), `PUT /guilds/:id/loop` with a
 * program, and `DELETE /guilds/:id/loop`
 */
export function createLoopApi(client: Client, token: string, filesRoot: string, rooms = new Map<string, LoopRoom>()): Server {
  const roomFor = (guild: Guild) => rooms.get(guild.id) ?? rooms.set(guild.id, new LoopRoom(guild)).get(guild.id)!;
  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (!timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${token}`))) return reply(401, { error: 'Unauthorized.' });
    const url = new URL(req.url ?? '/', 'http://loop');
    try {
      if (url.pathname === '/status' && req.method === 'GET') {
        return reply(200, { ready: client.isReady(), name: client.user?.displayName ?? null, guilds: [...client.guilds.cache.keys()] });
      }
      if (url.pathname === '/stats' && req.method === 'GET') return reply(200, { ...containerUsage(), ready: client.isReady() });
      const match = /^\/guilds\/(\d{1,20})\/loop$/.exec(url.pathname);
      if (!match) return reply(404, { error: 'Not found.' });
      const guild = client.guilds.cache.get(match[1]);
      if (req.method === 'DELETE') {
        if (guild) rooms.get(guild.id)?.stop();
        return reply(200, { ok: true });
      }
      if (req.method !== 'PUT') return reply(405, { error: 'Not here.' });
      if (!guild) return reply(404, { error: 'The loop bot isn’t in that server. Invite it there first.' });
      const program = readProgram(await readJson(req).catch(() => null), filesRoot);
      if (typeof program === 'string') return reply(400, { error: program });
      const problem = await roomFor(guild).play(program);
      return problem ? reply(502, { error: problem }) : reply(200, { ok: true });
    } catch (err) {
      console.error(`Loop API: ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) reply(500, { error: 'Something broke. Check the loop bot’s log.' });
    }
  });
}
