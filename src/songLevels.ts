import { statSync } from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { songGain, songLoudness } from './loudness.ts';
import { MIX_VOLUME } from './mixer.ts';

type Level = { lufs: number | null; peak: number | null };

const keptLevel = db.prepare('SELECT lufs, peak FROM song_loudness WHERE file = ? AND bytes = ?');
const keepLevel = db.prepare('INSERT OR REPLACE INTO song_loudness (file, bytes, lufs, peak, at) VALUES (?, ?, ?, ?, ?)');
/** Readings under way, so fetching a song ahead and then playing it read it once */
const reading = new Map<string, Promise<Level | null>>();
/** Files ffmpeg couldn't read, not tried again until the bot restarts, so one isn't read and logged at every play */
const unreadable = new Set<string>();

/**
 * How loud a song file is: as read before, if the file hasn't changed, or read now and kept. Null if it can't be read,
 * so the song plays as it was released. Never throws
 */
export function songLevel(file: string): Promise<Level | null> {
  let bytes: number;
  try {
    bytes = statSync(file).size;
  } catch {
    return Promise.resolve(null);
  }
  const key = `${file}\n${bytes}`;
  if (!bytes || unreadable.has(key)) return Promise.resolve(null);
  const kept = keptLevel.get(file, bytes) as Level | undefined;
  if (kept) return Promise.resolve(kept);
  let job = reading.get(key);
  if (!job) {
    job = songLoudness(file)
      .then((level) => {
        keepLevel.run(file, bytes, level.lufs, level.peak, Date.now());
        return level;
      })
      .catch((err: Error) => {
        unreadable.add(key);
        console.error(`Music: couldn’t read how loud ${path.basename(file)} is, so it plays as it is:`, err.message);
        return null;
      })
      .finally(() => reading.delete(key));
    reading.set(key, job);
  }
  return job;
}

/**
 * What a song is multiplied by to play about as loud as the others, at a music volume of `volume` percent: 1 if it
 * can't be read. The music volume turns it down after this, so the louder that's set, the less a quiet song can come up
 * before its peaks would clip
 */
export async function songMultiplier(file: string, volume: number): Promise<number> {
  const level = await songLevel(file);
  if (!level) return 1;
  // What the music volume and the mix take off, in dB
  const headroom = -20 * Math.log10(Math.max(volume, 1e-6) / 100) - 20 * Math.log10(MIX_VOLUME);
  return 10 ** (songGain(level.lufs, level.peak, headroom) / 20);
}
