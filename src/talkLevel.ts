/**
 * How loud someone in the call is, so music drops under their talking but not under the background noise their microphone
 * picks up. Their audio is decoded only to measure it, 50 times a second while music plays, and never recorded or kept
 */

/** A level, and how many of the last few 20 ms frames must reach it */
export interface Heard {
  db: number;
  frames: number;
  of: number;
}

/**
 * What counts as talking, by the "What counts as talking" setting. Any sound is whatever Discord sends, as it was before
 * anything was measured, so it needs no decoding
 */
export const HEARD = {
  any: null,
  // Talking, not a keyboard, a cough or a TV across the room: louder than −45 dB for 160 ms of the last 300 ms
  talking: { db: -45, frames: 8, of: 15 },
  // Only clear, loud talking: louder than −35 dB for 240 ms of the last 400 ms
  loud: { db: -35, frames: 12, of: 20 },
} satisfies Record<string, Heard | null>;
export type HeardAs = keyof typeof HEARD;

/** The setting's value as a level, or null for any sound, with an unknown value read as the default */
export const heardAs = (value: unknown): Heard | null => (typeof value === 'string' && Object.hasOwn(HEARD, value) ? HEARD[value as HeardAs] : HEARD.talking);

/** The quietest a frame reads, for digital silence */
const SILENT_DB = -100;

/** A frame of 16-bit PCM's loudness: its RMS, in dB under full scale */
export function frameDb(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return sum ? Math.max(SILENT_DB, 10 * Math.log10(sum / samples / 32768 ** 2)) : SILENT_DB;
}

/**
 * One person's audio, frame by frame: talking once enough of the last few frames are loud enough, and not once none of
 * them are, or Discord stops sending. A short sound, like a click, never gets there, and nor does quiet noise, however
 * long it goes on
 */
export class LevelGate {
  private readonly heard: Heard;
  private readonly changed: (talking: boolean) => void;
  /** The last few frames, each whether it was loud enough */
  private readonly recent: boolean[] = [];
  private loud = 0;
  talking = false;

  constructor(heard: Heard, changed: (talking: boolean) => void) {
    this.heard = heard;
    this.changed = changed;
  }

  frame(db: number) {
    const loud = db >= this.heard.db;
    this.recent.push(loud);
    if (loud) this.loud++;
    if (this.recent.length > this.heard.of && this.recent.shift()) this.loud--;
    if (!this.talking && this.loud >= this.heard.frames) {
      this.talking = true;
      this.changed(true);
    } else if (this.talking && this.loud === 0) {
      this.talking = false;
      this.changed(false);
    }
  }

  /** Nothing's coming, as when Discord stops sending: not talking, and starting over when it comes again */
  quiet() {
    this.recent.length = 0;
    this.loud = 0;
    if (!this.talking) return;
    this.talking = false;
    this.changed(false);
  }
}

/**
 * A burst of someone's audio, summed up for the log while the levels are tuned: how long, how loud typically and at its
 * loudest, and whether it counted. Kept as a count of frames at each level, never the audio
 */
export class Burst {
  private readonly counts = new Map<number, number>();
  private frames = 0;

  add(db: number) {
    const level = Math.round(db);
    this.counts.set(level, (this.counts.get(level) ?? 0) + 1);
    this.frames++;
  }

  /** The level this share of frames are at or under */
  private at(share: number) {
    let seen = 0;
    for (const level of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(level)!;
      if (seen >= share * this.frames) return level;
    }
    return SILENT_DB;
  }

  /** One line for the log, without saying who */
  line(counted: boolean, heard: Heard) {
    return `Talking measured: ${(this.frames / 50).toFixed(1)} s, typically ${this.at(0.5)} dB, loudest tenth ${this.at(0.9)} dB, ${counted ? 'counted' : 'left alone'} at ${heard.db} dB`;
  }

  get empty() {
    return this.frames === 0;
  }
}
