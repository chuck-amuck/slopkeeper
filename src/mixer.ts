import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';

// 20 ms of 48 kHz 16-bit stereo PCM, the frame size @discordjs/voice encodes
const FRAME_MS = 20;
const FRAME_BYTES = (48_000 * 2 * 2 * FRAME_MS) / 1000;
// How far mixing runs ahead of playback. A sound added mid-stream is heard after roughly this long
const MAX_LEAD_MS = 60;
// Audio a new sound buffers before it's mixed in, enough to cover the lead
const START_BYTES = FRAME_BYTES * 4;
// Music drops to this while someone's line is spoken, easing down and back up over a few frames
const DUCKED = 0.3;
const DUCK_STEP = 0.05;
/** How loud everything plays in voice, where 1 is the file as it is. The loop bot uses it too, so the room sounds the same from either */
export const MIX_VOLUME = 0.5;
// A layered loop plays at most this many copies at once, so a long sound repeated often doesn't pile up ffmpegs
const MOST_LAYERS = 8;
// Each copy of a layered loop starts this many frames early, so it's decoded and ready on the beat
const LAYER_LEAD_FRAMES = 10;

export interface VoiceOptions {
  /** Plays over and over, without a gap, until stopped */
  loop?: boolean;
  /** Never dropped for newer sounds, like a whole song */
  lasting?: boolean;
  /** Starts this far in, to carry on after a pause */
  startMs?: number;
  /** With `loop`: starts a fresh copy this often, layered over the ones still playing, rather than looping without a gap */
  everyMs?: number;
  /** Sounds, speech and music each have a volume that can change while they play */
  group?: 'sound' | 'speech' | 'music';
  /** What it's called in the list of what's playing: the file's name if not given, which is a library sound's name */
  label?: string;
  /** Shows as speech in that list, for speech that plays at the sound volume, like the looping room's */
  spoken?: boolean;
}

/** A sound or line of speech playing, for showing what's on and stopping one of them */
export interface Playing {
  id: number;
  name: string;
  kind: 'sound' | 'speech';
  loop: boolean;
  /** Whether it's being heard yet, rather than waiting for ffmpeg to start */
  started: boolean;
  /** How long ago it started, or was asked for if it hasn't yet */
  elapsedMs: number;
}

let playingIds = 0;

interface Source {
  readonly file: string;
  /** Multiplies its samples, to even out loudness between sounds */
  readonly gain: number;
  readonly loop: boolean;
  /** Kept until it's stopped: never dropped for a newer sound, nor restarted by one */
  readonly lasting: boolean;
  readonly group: string;
  ended: boolean;
  /** Whether any of its audio has been mixed in yet */
  heard: boolean;
  /** Earlier copies of the same sound, cut off once this one has audio */
  replaces: Source[];
  ready(): boolean;
  /** Next frame, a shorter final chunk, or null if nothing has arrived yet */
  read(): Buffer | null;
  stop(): void;
}

/** One playing sound, decoded to raw PCM by its own ffmpeg process */
class Voice implements Source {
  readonly proc: ChildProcess;
  readonly pcm: Readable;
  readonly file: string;
  readonly gain: number;
  readonly loop: boolean;
  readonly lasting: boolean;
  readonly group: string;
  ended = false;
  heard = false;
  replaces: Source[] = [];
  private stopped = false;
  private onEnd: ((byItself: boolean) => void) | undefined;

  constructor(file: string, gain: number, onEnd?: (byItself: boolean) => void, options: VoiceOptions = {}) {
    this.file = file;
    this.gain = gain;
    this.onEnd = onEnd;
    this.loop = options.loop ?? false;
    this.lasting = this.loop || (options.lasting ?? false);
    this.group = options.group ?? 'sound';
    const loop = this.loop ? ['-stream_loop', '-1'] : [];
    const start = options.startMs ? ['-ss', (options.startMs / 1000).toFixed(3)] : [];
    this.proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...loop, ...start, '-i', file, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pcm = this.proc.stdout!;
    // Without a 'readable' listener, Node resumes stdout when ffmpeg exits and the unread PCM is discarded
    this.pcm.on('readable', () => {});
    // 'close' only follows 'end' once every buffered byte has been read, so nothing is cut off.
    // A stopped sound has already said so, so closing here means it played to the end
    this.pcm.once('close', () => this.finish(true));

    // Only surface ffmpeg's errors for sounds that failed by themselves; a stopped one always complains about the closed pipe
    let stderr = '';
    this.proc.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    this.proc.once('exit', (code) => {
      if (code !== 0 && !this.stopped) console.error(`ffmpeg failed on ${file} (exit ${code}):`, stderr.trim());
    });
    this.proc.once('error', (err) => {
      console.error('ffmpeg error:', err.message);
      this.finish(false);
    });
  }

  /** `byItself` is whether it played to the end, rather than being stopped or failing to start */
  private finish(byItself: boolean) {
    this.ended = true;
    this.onEnd?.(byItself);
    this.onEnd = undefined;
  }

  /**
   * Whether enough audio is buffered to start mixing it in. ffmpeg's first chunk can arrive a little ahead of the rest,
   * and starting on it alone plays a blip, then silence until the rest catches up
   */
  ready(): boolean {
    return this.pcm.readableLength >= START_BYTES || this.proc.exitCode !== null;
  }

  read(): Buffer | null {
    return this.pcm.read(FRAME_BYTES) as Buffer | null;
  }

  stop() {
    this.stopped = true;
    this.finish(false);
    // ffmpeg ignores SIGTERM while it's blocked writing to a full pipe, so close the pipe and SIGKILL it
    this.pcm.destroy();
    this.proc.kill('SIGKILL');
  }
}

/**
 * A sound started afresh every `everyMs`, each copy playing out on top of those before it, until stopped. The copies are
 * timed by the frames mixed, so they land exactly on the beat, and the oldest fades out once there are too many
 */
class LayeredVoice implements Source {
  readonly file: string;
  // The copies are mixed at this gain here, before they're added up, so the gain the mixer applies is 1
  readonly gain = 1;
  readonly loop = true;
  readonly lasting = true;
  readonly group: NonNullable<VoiceOptions['group']>;
  ended = false;
  heard = false;
  replaces: Source[] = [];
  private readonly level: number;
  private readonly every: number;
  /** Copies being heard, oldest first */
  private copies: Voice[] = [];
  /** The next copy, started early and waiting for its beat */
  private next: Voice | undefined;
  private framesToNext = 0;
  private onEnd: ((byItself: boolean) => void) | undefined;

  constructor(file: string, gain: number, everyMs: number, onEnd?: (byItself: boolean) => void, options: VoiceOptions = {}) {
    this.file = file;
    this.level = gain;
    this.every = Math.max(1, Math.round(everyMs / FRAME_MS));
    this.onEnd = onEnd;
    this.group = options.group ?? 'sound';
    this.next = this.copy();
  }

  private copy() {
    return new Voice(this.file, 1, undefined, { group: this.group });
  }

  ready(): boolean {
    return this.copies.length > 0 || !!this.next?.ready();
  }

  read(): Buffer | null {
    let fading: Voice | undefined;
    if (this.framesToNext <= 0 && this.next?.ready()) {
      this.copies.push(this.next);
      this.next = undefined;
      this.framesToNext = this.every;
      if (this.copies.length > MOST_LAYERS) fading = this.copies.shift();
    }
    if (!this.next && this.framesToNext <= LAYER_LEAD_FRAMES) this.next = this.copy();
    this.framesToNext--;

    const sum = new Float64Array(FRAME_BYTES / 2);
    let any = false;
    const add = (copy: Voice, fadeOut: boolean) => {
      const chunk = copy.read();
      if (!chunk) return;
      any = true;
      const samples = chunk.length >> 1;
      for (let s = 0; s < samples; s++) sum[s] += chunk.readInt16LE(s * 2) * this.level * (fadeOut ? 1 - s / samples : 1);
    };
    if (fading) {
      add(fading, true);
      fading.stop();
    }
    for (const copy of this.copies) add(copy, false);
    this.copies = this.copies.filter((c) => !c.ended);
    if (!any) return null;
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let s = 0; s < sum.length; s++) frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum[s]))), s * 2);
    return frame;
  }

  stop() {
    if (this.ended) return;
    this.ended = true;
    for (const copy of [...this.copies, ...(this.next ? [this.next] : [])]) copy.stop();
    this.copies = [];
    this.next = undefined;
    this.onEnd?.(false);
    this.onEnd = undefined;
  }
}

/**
 * Raw PCM stream that sums every sound added to it, so different sounds layer like Discord's soundboard.
 * Adding a sound that's already playing restarts it instead. Ends once all of its sounds have finished.
 */
export class Mixer extends Readable {
  private readonly volume: number;
  private readonly maxVoices: number;
  private voices: Source[] = [];
  private nextFrameAt = performance.now();
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private done = false;
  private readonly groupGains = new Map<string, number>();
  /** How far music is turned down under speech right now */
  private duck = 1;
  private readonly labels = new WeakMap<Source, { id: number; name: string; startedAt: number; loop: boolean; spoken: boolean }>();

  constructor(volume: number, maxVoices: number) {
    super();
    this.volume = volume;
    this.maxVoices = maxVoices;
  }

  get finished(): boolean {
    return this.done || this.destroyed;
  }

  /**
   * `onEnd` runs once the sound is over, however that came about. Returns a way to stop it. The mixer emits 'playing'
   * whenever a sound starts or ends, so what's playing can be shown as it changes
   */
  add(file: string, gain = 1, onEnd?: (byItself: boolean) => void, options: VoiceOptions = {}): () => void {
    // Music isn't in what's playing, so its comings and goings don't count as a change
    const shown = options.group !== 'music';
    const ended = (byItself: boolean) => {
      onEnd?.(byItself);
      if (shown) this.emit('playing');
    };
    const voice = options.loop && options.everyMs ? new LayeredVoice(file, gain, options.everyMs, ended, options) : new Voice(file, gain, ended, options);
    this.labels.set(voice, { id: ++playingIds, name: options.label ?? path.parse(file).name, startedAt: Date.now(), loop: options.loop ?? false, spoken: options.spoken ?? options.group === 'speech' });
    // A restart keeps the playing copy going until the new one has audio, so spamming leaves no gap while ffmpeg starts.
    // A copy from an earlier click that hasn't started yet is dropped, since this one supersedes it. A loop is never restarted by a click
    for (const old of this.voices) {
      if (old.file !== file || old.ended || old.lasting || voice.lasting) continue;
      if (old.heard) voice.replaces.push(old);
      else {
        voice.replaces.push(...old.replaces);
        old.stop();
      }
    }
    this.include(voice);
    if (shown) this.emit('playing');
    return () => {
      voice.stop();
      this.voices = this.voices.filter((v) => v !== voice);
    };
  }

  private include(voice: Source) {
    this.voices = this.voices.filter((v) => !v.ended);
    // Past the cap, the oldest sound is dropped rather than piling up ffmpeg processes, but not a loop or music
    if (this.voices.length >= this.maxVoices) {
      const oldest = Math.max(0, this.voices.findIndex((v) => !v.lasting));
      this.voices.splice(oldest, 1)[0].stop();
    }
    this.voices.push(voice);
  }

  /**
   * The sounds and speech playing, oldest first, leaving out music, which has its own controls. A sound restarted while
   * its earlier copy is still fading out shows once
   */
  playing(): Playing[] {
    const replaced = new Set(this.voices.flatMap((v) => v.replaces));
    const now = Date.now();
    return this.voices.flatMap((voice) => {
      const label = this.labels.get(voice);
      if (voice.ended || voice.group === 'music' || replaced.has(voice) || !label) return [];
      return [{ id: label.id, name: label.name, kind: label.spoken ? 'speech' : 'sound', loop: label.loop, started: voice.heard, elapsedMs: now - label.startedAt }];
    });
  }

  /** Stops one sound from playing(), along with any earlier copy of it still fading out. Returns whether it was playing */
  stopPlaying(id: number): boolean {
    const voice = this.voices.find((v) => !v.ended && this.labels.get(v)?.id === id);
    if (!voice) return false;
    for (const old of voice.replaces) old.stop();
    voice.stop();
    this.voices = this.voices.filter((v) => !v.ended);
    return true;
  }

  /** Changes the volume of a group, including what's already playing */
  setGroupGain(group: NonNullable<VoiceOptions['group']>, gain: number) {
    this.groupGains.set(group, gain);
  }

  stopLoops() {
    for (const voice of this.voices) if (voice.loop) voice.stop();
    this.voices = this.voices.filter((v) => !v.ended);
  }

  stopAll() {
    for (const voice of this.voices) voice.stop();
    this.voices = [];
  }

  /** Stops everything except one group, such as the music */
  stopAllBut(group: NonNullable<VoiceOptions['group']>) {
    for (const voice of this.voices) if (voice.group !== group) voice.stop();
    this.voices = this.voices.filter((v) => v.group === group);
  }

  override _read() {
    if (this.timer) return;
    // Pace output to real time; the player would otherwise pull seconds ahead and new sounds would lag
    const wait = this.nextFrameAt - MAX_LEAD_MS - performance.now();
    if (wait <= 0) return this.pushFrame();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pushFrame();
    }, wait);
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void) {
    clearTimeout(this.timer);
    this.stopAll();
    callback(err);
  }

  private pushFrame() {
    this.voices = this.voices.filter((v) => !v.ended);
    if (!this.voices.length) {
      this.done = true;
      this.push(null);
      return;
    }

    const sum = new Int32Array(FRAME_BYTES / 2);
    let heard = false;
    const speaking = this.voices.some((v) => v.group === 'speech' && v.heard);
    this.duck = speaking ? Math.max(DUCKED, this.duck - DUCK_STEP) : Math.min(1, this.duck + DUCK_STEP);
    const mix = (chunk: Buffer, voice: Source, fadeOut = false) => {
      heard = true;
      const gain = voice.gain * (this.groupGains.get(voice.group) ?? 1) * (voice.group === 'music' ? this.duck : 1);
      const samples = chunk.length >> 1;
      for (let s = 0; s < samples; s++) sum[s] += chunk.readInt16LE(s * 2) * gain * (fadeOut ? 1 - s / samples : 1);
    };
    // New sounds first: once a restarted copy has audio, the old one fades out over this frame instead of clicking off
    const starting = new Set<Source>();
    for (const voice of this.voices) {
      if (voice.heard || voice.ended || !voice.ready()) continue;
      const chunk = voice.read();
      if (!chunk) continue;
      voice.heard = true;
      // Timed from when it's first heard, after ffmpeg has started, so a page's progress bar keeps pace with the sound
      const label = this.labels.get(voice);
      if (label) label.startedAt = Date.now();
      if (voice.group !== 'music') this.emit('playing');
      starting.add(voice);
      mix(chunk, voice);
      for (const old of voice.replaces) {
        if (old.ended) continue;
        const last = old.read();
        if (last) mix(last, old, true);
        old.stop();
      }
      voice.replaces = [];
    }
    for (const voice of this.voices) {
      if (!voice.heard || voice.ended || starting.has(voice)) continue;
      const chunk = voice.read();
      if (chunk) mix(chunk, voice);
    }
    // Hold off until ffmpeg delivers the first sound, rather than leading with silence while it starts up
    if (!this.started) {
      if (!heard) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.pushFrame();
        }, 5);
        return;
      }
      this.started = true;
      this.nextFrameAt = performance.now();
    }

    const frame = Buffer.alloc(FRAME_BYTES);
    for (let s = 0; s < sum.length; s++) {
      frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum[s] * this.volume))), s * 2);
    }

    this.nextFrameAt += FRAME_MS;
    this.push(frame);
  }
}
