import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';

// 20 ms of 48 kHz 16-bit stereo PCM, the frame size @discordjs/voice encodes
const FRAME_MS = 20;
const FRAME_BYTES = (48_000 * 2 * 2 * FRAME_MS) / 1000;
// How far mixing runs ahead of playback. A sound added mid-stream is heard after roughly this long
const MAX_LEAD_MS = 60;
// Audio a new sound buffers before it's mixed in, enough to cover the lead
const START_BYTES = FRAME_BYTES * 4;

/** One playing sound, decoded to raw PCM by its own ffmpeg process */
class Voice {
  readonly proc: ChildProcess;
  readonly pcm: Readable;
  readonly file: string;
  ended = false;
  /** Whether any of its audio has been mixed in yet */
  heard = false;
  /** Earlier copies of the same sound, cut off once this one has audio */
  replaces: Voice[] = [];
  private stopped = false;

  constructor(file: string) {
    this.file = file;
    this.proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pcm = this.proc.stdout!;
    // Without a 'readable' listener, Node resumes stdout when ffmpeg exits and the unread PCM is discarded
    this.pcm.on('readable', () => {});
    // 'close' only follows 'end' once every buffered byte has been read, so nothing is cut off
    this.pcm.once('close', () => (this.ended = true));

    // Only surface ffmpeg's errors for sounds that failed by themselves; a stopped one always complains about the closed pipe
    let stderr = '';
    this.proc.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    this.proc.once('exit', (code) => {
      if (code !== 0 && !this.stopped) console.error(`ffmpeg failed on ${file} (exit ${code}):`, stderr.trim());
    });
    this.proc.once('error', (err) => {
      console.error('ffmpeg error:', err.message);
      this.ended = true;
    });
  }

  /**
   * Whether enough audio is buffered to start mixing it in. ffmpeg's first chunk can arrive a little ahead of the rest,
   * and starting on it alone plays a blip, then silence until the rest catches up
   */
  ready(): boolean {
    return this.pcm.readableLength >= START_BYTES || this.proc.exitCode !== null;
  }

  /** Next frame, a shorter final chunk, or null if ffmpeg hasn't caught up yet */
  read(): Buffer | null {
    return this.pcm.read(FRAME_BYTES) as Buffer | null;
  }

  stop() {
    this.ended = true;
    this.stopped = true;
    // ffmpeg ignores SIGTERM while it's blocked writing to a full pipe, so close the pipe and SIGKILL it
    this.pcm.destroy();
    this.proc.kill('SIGKILL');
  }
}

/**
 * Raw PCM stream that sums every sound added to it, so different sounds layer like Discord's soundboard.
 * Adding a sound that's already playing restarts it instead. Ends once all of its sounds have finished.
 */
export class Mixer extends Readable {
  private readonly volume: number;
  private readonly maxVoices: number;
  private voices: Voice[] = [];
  private nextFrameAt = performance.now();
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private done = false;

  constructor(volume: number, maxVoices: number) {
    super();
    this.volume = volume;
    this.maxVoices = maxVoices;
  }

  get finished(): boolean {
    return this.done || this.destroyed;
  }

  add(file: string) {
    const voice = new Voice(file);
    // A restart keeps the playing copy going until the new one has audio, so spamming leaves no gap while ffmpeg starts.
    // A copy from an earlier click that hasn't started yet is dropped, since this one supersedes it
    for (const old of this.voices) {
      if (old.file !== file || old.ended) continue;
      if (old.heard) voice.replaces.push(old);
      else {
        voice.replaces.push(...old.replaces);
        old.stop();
      }
    }
    this.voices = this.voices.filter((v) => !v.ended);
    // Past the cap, the oldest sound is dropped rather than piling up ffmpeg processes
    if (this.voices.length >= this.maxVoices) this.voices.shift()!.stop();
    this.voices.push(voice);
  }

  stopAll() {
    for (const voice of this.voices) voice.stop();
    this.voices = [];
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
    const mix = (chunk: Buffer, fadeOut = false) => {
      heard = true;
      const samples = chunk.length >> 1;
      for (let s = 0; s < samples; s++) sum[s] += fadeOut ? chunk.readInt16LE(s * 2) * (1 - s / samples) : chunk.readInt16LE(s * 2);
    };
    // New sounds first: once a restarted copy has audio, the old one fades out over this frame instead of clicking off
    const starting = new Set<Voice>();
    for (const voice of this.voices) {
      if (voice.heard || voice.ended || !voice.ready()) continue;
      const chunk = voice.read();
      if (!chunk) continue;
      voice.heard = true;
      starting.add(voice);
      mix(chunk);
      for (const old of voice.replaces) {
        if (old.ended) continue;
        const last = old.read();
        if (last) mix(last, true);
        old.stop();
      }
      voice.replaces = [];
    }
    for (const voice of this.voices) {
      if (!voice.heard || voice.ended || starting.has(voice)) continue;
      const chunk = voice.read();
      if (chunk) mix(chunk);
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
