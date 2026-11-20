import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as perf from './perf.ts';

// 20 ms of 48 kHz 16-bit stereo PCM, the frame size @discordjs/voice encodes
const FRAME_MS = 20;
const FRAME_BYTES = (48_000 * 2 * 2 * FRAME_MS) / 1000;
// How far mixing runs ahead of playback. A sound added mid-stream is heard after roughly this long
const MAX_LEAD_MS = 60;
// Audio a new sound buffers before it's mixed in, enough to cover the lead
const START_BYTES = FRAME_BYTES * 4;
// Frames mixed are counted together, once a second
const FRAMES_COUNTED_TOGETHER = 50;
// Music drops to this while someone's line is spoken, easing down and back up over a few frames
const DUCKED = 0.3;
const DUCK_STEP = 0.05;
// Sounds piling up are held a decibel under full scale rather than clipped. A frame that would go over is turned down as a
// whole, and the frames after it come back up by a little each, about 200 ms from 6 dB down
const CEILING = 32767 * 10 ** (-1 / 20);
const LIMIT_RELEASE = 10 ** (0.6 / 20);
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
  /** Runs once it's first heard, after ffmpeg has started and it's mixed in */
  onHeard?: () => void;
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

/** `byItself` is whether a sound played to the end; `failed` whether it ended because ffmpeg couldn't play the file */
export type OnEnd = (byItself: boolean, failed?: boolean) => void;

// The decoded audio of sounds played lately, so a sound played again starts without waiting for ffmpeg. Each is kept by
// its file as it was, so a replaced file is decoded afresh, and the least lately played go first past the limit
const DECODED_LIMIT_BYTES = 24 * 1024 * 1024;
// A soundboard sound is a few seconds; a longer file isn't kept
const DECODED_MOST_BYTES = (48_000 * 2 * 2 * 10_000) / 1000;
const decoded = new Map<string, Buffer>();
let decodedBytes = 0;

/** What a file's decoded audio is kept under, which changes when the file does. Null if it can't be read */
function decodedKey(file: string): string | null {
  try {
    const { mtimeMs, size } = statSync(file);
    return `${file}\u0000${mtimeMs}\u0000${size}`;
  } catch {
    return null;
  }
}

function keepDecoded(key: string, pcm: Buffer) {
  if (pcm.length > DECODED_MOST_BYTES || decoded.has(key)) return;
  decoded.set(key, pcm);
  decodedBytes += pcm.length;
  for (const [old, oldPcm] of decoded) {
    if (decodedBytes <= DECODED_LIMIT_BYTES) break;
    decoded.delete(old);
    decodedBytes -= oldPcm.length;
  }
}

/** A file's decoded audio, if it's kept, which now counts as played most lately */
function decodedOf(key: string): Buffer | undefined {
  const pcm = decoded.get(key);
  if (pcm) {
    decoded.delete(key);
    decoded.set(key, pcm);
  }
  return pcm;
}

/** Forgets every decoded sound, for tests */
export function forgetDecoded() {
  decoded.clear();
  decodedBytes = 0;
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
  private onEnd: OnEnd | undefined;
  /** Its decoded audio so far, to keep once it's played to the end, and what to keep it under */
  private decoding: { key: string; chunks: Buffer[]; bytes: number } | null;

  constructor(file: string, gain: number, onEnd?: OnEnd, options: VoiceOptions = {}, keepAs: string | null = null) {
    this.decoding = keepAs ? { key: keepAs, chunks: [], bytes: 0 } : null;
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
    // The process's 'close' waits for stdout's, which only follows 'end' once every buffered byte has been read, so nothing
    // is cut off. A stopped sound has already said so, so closing here means it played to the end, or ffmpeg failed. One
    // killed from outside, as when memory runs out, isn't the file's fault
    this.proc.once('close', (code, signal) => this.finish(code === 0, code !== 0 && !signal));

    // Only surface ffmpeg's errors for sounds that failed by themselves; a stopped one always complains about the closed pipe
    let stderr = '';
    this.proc.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    this.proc.once('exit', (code) => {
      if (code !== 0 && !this.stopped) console.error(`ffmpeg failed on ${file} (exit ${code}):`, stderr.trim());
    });
    this.proc.once('error', (err) => {
      console.error('ffmpeg error:', err.message);
      this.finish(false, true);
    });
  }

  /** `byItself` is whether it played to the end, rather than being stopped or failing */
  private finish(byItself: boolean, failed = false) {
    this.ended = true;
    if (this.decoding && byItself && !this.stopped && this.decoding.bytes > 0) keepDecoded(this.decoding.key, Buffer.concat(this.decoding.chunks));
    this.decoding = null;
    this.onEnd?.(byItself, failed && !this.stopped);
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
    const chunk = this.pcm.read(FRAME_BYTES) as Buffer | null;
    if (chunk && this.decoding) {
      this.decoding.bytes += chunk.length;
      if (this.decoding.bytes > DECODED_MOST_BYTES) this.decoding = null;
      else this.decoding.chunks.push(chunk);
    }
    return chunk;
  }

  stop() {
    this.stopped = true;
    this.finish(false);
    // ffmpeg ignores SIGTERM while it's blocked writing to a full pipe, so close the pipe and SIGKILL it
    this.pcm.destroy();
    this.proc.kill('SIGKILL');
  }
}

/** A sound played from its decoded audio, kept from an earlier play, so it starts at once */
class DecodedVoice implements Source {
  readonly file: string;
  readonly gain: number;
  readonly loop = false;
  readonly lasting = false;
  readonly group: string;
  ended = false;
  heard = false;
  replaces: Source[] = [];
  private at = 0;
  private onEnd: OnEnd | undefined;
  private readonly pcm: Buffer;

  constructor(file: string, pcm: Buffer, gain: number, onEnd?: OnEnd, options: VoiceOptions = {}) {
    this.file = file;
    this.pcm = pcm;
    this.gain = gain;
    this.onEnd = onEnd;
    this.group = options.group ?? 'sound';
  }

  ready() {
    return true;
  }

  /** The next frame, then once it's all been read, nothing, and it's over, as with ffmpeg closing after its last bytes */
  read(): Buffer | null {
    if (this.at >= this.pcm.length) {
      this.finish(true);
      return null;
    }
    const chunk = this.pcm.subarray(this.at, this.at + FRAME_BYTES);
    this.at += chunk.length;
    return chunk;
  }

  private finish(byItself: boolean) {
    if (this.ended) return;
    this.ended = true;
    this.onEnd?.(byItself, false);
    this.onEnd = undefined;
  }

  stop() {
    this.finish(false);
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
  /** How far the whole mix is turned down to keep it under the ceiling, 1 when it isn't */
  private limit = 1;
  private readonly hearing = new WeakMap<Source, () => void>();
  /** Frames mixed and not yet counted */
  private uncounted = 0;
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
  add(file: string, gain = 1, onEnd?: OnEnd, options: VoiceOptions = {}): () => void {
    // Music isn't in what's playing, so its comings and goings don't count as a change
    const shown = options.group !== 'music';
    const ended = (byItself: boolean, failed?: boolean) => {
      onEnd?.(byItself, failed);
      if (shown) this.emit('playing');
    };
    // A library sound played whole is kept decoded: not music, a loop, a resume, or speech, which is a new file each time
    const keepAs = !options.loop && !options.lasting && !options.startMs && !options.spoken && (options.group ?? 'sound') === 'sound' ? decodedKey(file) : null;
    const pcm = keepAs ? decodedOf(keepAs) : undefined;
    const voice =
      options.loop && options.everyMs
        ? new LayeredVoice(file, gain, options.everyMs, ended, options)
        : pcm
          ? new DecodedVoice(file, pcm, gain, ended, options)
          : new Voice(file, gain, ended, options, keepAs);
    if (options.onHeard) this.hearing.set(voice, options.onHeard);
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
    this.countFrames();
    this.stopAll();
    callback(err);
  }

  private countFrames() {
    if (this.uncounted) perf.count('mixer_frames_total', {}, this.uncounted);
    this.uncounted = 0;
  }

  private pushFrame() {
    this.voices = this.voices.filter((v) => !v.ended);
    if (!this.voices.length) {
      this.countFrames();
      this.done = true;
      this.push(null);
      return;
    }

    const sum = new Int32Array(FRAME_BYTES / 2);
    let heard = false;
    const speaking = this.voices.some((v) => v.group === 'speech' && v.heard);
    this.duck = speaking ? Math.max(DUCKED, this.duck - DUCK_STEP) : Math.min(1, this.duck + DUCK_STEP);
    const mix = (chunk: Buffer, voice: Source, fade?: 'in' | 'out') => {
      heard = true;
      const gain = voice.gain * (this.groupGains.get(voice.group) ?? 1) * (voice.group === 'music' ? this.duck : 1);
      const samples = chunk.length >> 1;
      for (let s = 0; s < samples; s++) {
        const ramp = fade === 'in' ? s / samples : fade === 'out' ? 1 - s / samples : 1;
        sum[s] += chunk.readInt16LE(s * 2) * gain * ramp;
      }
    };
    // New sounds first: once a restarted copy has audio, it fades in over this frame while the old one fades out, so a
    // restart neither clicks off nor gets louder than one copy, however fast someone spams it
    const starting = new Set<Source>();
    for (const voice of this.voices) {
      if (voice.heard || voice.ended || !voice.ready()) continue;
      const chunk = voice.read();
      if (!chunk) continue;
      voice.heard = true;
      // Timed from when it's first heard, after ffmpeg has started, so a page's progress bar keeps pace with the sound
      const label = this.labels.get(voice);
      if (label) label.startedAt = Date.now();
      this.hearing.get(voice)?.();
      this.hearing.delete(voice);
      if (voice.group !== 'music') this.emit('playing');
      starting.add(voice);
      let crossfade = false;
      for (const old of voice.replaces) {
        if (old.ended) continue;
        const last = old.read();
        if (last) {
          mix(last, old, 'out');
          crossfade = true;
        }
        old.stop();
      }
      voice.replaces = [];
      mix(chunk, voice, crossfade ? 'in' : undefined);
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

    // Turned down at once for a frame that would go over, so none of it does, and eased back up across the frames after
    let peak = 0;
    for (let s = 0; s < sum.length; s++) peak = Math.max(peak, Math.abs(sum[s]));
    const from = this.limit;
    this.limit = Math.min(peak * this.volume > CEILING ? CEILING / (peak * this.volume) : 1, from * LIMIT_RELEASE, 1);
    const rising = this.limit > from;
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let s = 0; s < sum.length; s++) {
      const limit = rising ? from + ((this.limit - from) * s) / sum.length : this.limit;
      // The clip only catches rounding
      frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum[s] * this.volume * limit))), s * 2);
    }

    // Counted a second at a time, to keep this loop light
    if (++this.uncounted >= FRAMES_COUNTED_TOGETHER) this.countFrames();
    // Due when the one before it has played; much later than that and there was a gap
    if (performance.now() - this.nextFrameAt > FRAME_MS) perf.count('mixer_late_frames_total');
    this.nextFrameAt += FRAME_MS;
    this.push(frame);
  }
}
