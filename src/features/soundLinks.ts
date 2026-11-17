import { type Guild } from 'discord.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { durationOf } from '../discordSounds.ts';
import { cutAudio } from '../trim.ts';
import { askYoutube } from './music.ts';
import { addSound, libraryChanged } from './soundLibrary.ts';

// Sounds cut from part of a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track. The music container
// downloads it, small, the web UI shows it so someone can pick the part they want, and the bot cuts that part into the library

/** The longest part that can be kept. As a 192 kb/s mp3 that's about 4.3 MB, under the 5 MB a sound can be */
export const LONGEST_PART = 180;
const SHORTEST_PART = 0.1;
// The page rounds times, so the end can be a little past the length ffprobe reads
const TOLERANCE = 0.05;
/** As long as the music container keeps it after it was last asked for */
const KEPT_MS = 60 * 60_000;
const SAFE_FILE = /^[\w.-]+$/;

interface Download {
  guildId: string;
  /** Null for a copy of a library sound, to cut another from */
  url: string | null;
  title: string;
  artist: string;
  source: string;
  seconds: number;
  video: boolean;
  file: string;
  at: number;
  peaks?: Promise<number[]>;
  /** A copy the bot made, so the bot deletes it, where the music container deletes its own downloads */
  own?: boolean;
}

/** What each server has downloaded lately, by an id the page holds. Gone after a restart, when the page asks for the link again */
const downloads = new Map<string, Download>();

export const clipDir = () => path.join(path.dirname(config.musicAudioDir), 'clips');

export const linksReady = () => Boolean(config.musicUrl && config.musicToken);

/** Asks the music container for a link, and where its file is. A problem is a string */
async function fetchClip(url: string): Promise<Omit<Download, 'guildId' | 'at' | 'seconds'> & { durationMs: number } | string> {
  let answer: Record<string, unknown> & { missing?: string };
  try {
    answer = await askYoutube('/clip', { url });
  } catch (err) {
    // It keeps downloading after the bot stops waiting, and keeps what it got, so asking again soon is quick
    if (err instanceof Error && err.name === 'TimeoutError') return 'That’s taking a long time to download. Try again in a minute.';
    const message = err instanceof Error ? err.message : String(err);
    return /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message) ? 'The music container isn’t answering. Check that it’s running.' : `That couldn’t be downloaded: ${message}`;
  }
  if (answer.missing) return answer.missing;
  if (typeof answer.file !== 'string' || !SAFE_FILE.test(answer.file)) return 'The music container named the file oddly.';
  return {
    url: typeof answer.url === 'string' ? answer.url : url,
    title: typeof answer.title === 'string' ? answer.title : 'Untitled',
    artist: typeof answer.artist === 'string' ? answer.artist : '',
    source: typeof answer.source === 'string' ? answer.source : '',
    video: answer.video === true,
    file: path.join(clipDir(), answer.file),
    durationMs: Number(answer.durationMs) || 0,
  };
}

function forgetOld(now = Date.now()) {
  for (const [id, d] of downloads) {
    if (now - d.at <= KEPT_MS) continue;
    downloads.delete(id);
    if (d.own) rmSync(d.file, { force: true });
  }
}

// Where copies of library sounds wait while another sound is cut from them. A copy, as saving can replace the sound itself
const sourceDir = () => path.join(tmpdir(), 'slopkeeper-sources');

/** Makes a library sound's file something to cut another sound from, like a download. Returns what it is, or why it can't */
export async function soundSource(guildId: string, name: string, file: string) {
  forgetOld();
  const seconds = await durationOf(file).catch(() => NaN);
  if (!(seconds > 0)) return { error: 'That sound has nothing the bot can read.' };
  const id = randomUUID();
  mkdirSync(sourceDir(), { recursive: true });
  const copy = path.join(sourceDir(), `${id}${path.extname(file).toLowerCase()}`);
  copyFileSync(file, copy);
  downloads.set(id, { guildId, url: null, title: name, artist: '', source: 'sound', video: false, file: copy, seconds, at: Date.now(), own: true });
  return { id, url: null, title: name, artist: '', source: 'sound', video: false, seconds };
}

/** Downloads a link for a server, so the page can show it. Returns what it is, or why it can't be had */
export async function downloadLink(guildId: string, url: string) {
  forgetOld();
  const got = await fetchClip(url);
  if (typeof got === 'string') return { error: got };
  if (!existsSync(got.file)) return { error: 'The bot can’t see what the music container downloaded. Check that it has the music volume.' };
  // The file says how long it really is, which a link doesn't always
  const seconds = await durationOf(got.file).catch(() => got.durationMs / 1000);
  if (!(seconds > 0)) return { error: 'That has no sound the bot can read.' };
  const id = randomUUID();
  downloads.set(id, { guildId, url: got.url, title: got.title, artist: got.artist, source: got.source, video: got.video, file: got.file, seconds, at: Date.now() });
  return { id, url: got.url, title: got.title, artist: got.artist, source: got.source, video: got.video, seconds };
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

/** A server's download, if it still has it */
export function downloaded(guildId: string, id: string) {
  const d = downloads.get(id);
  if (!d || d.guildId !== guildId) return null;
  d.at = Date.now();
  if (!existsSync(d.file)) {
    d.peaks = undefined;
    return { ...d, gone: true as const };
  }
  const ext = path.extname(d.file).toLowerCase();
  const type = MEDIA_TYPES[ext] ?? 'application/octet-stream';
  return { ...d, gone: false as const, type: d.video ? type : type.replace(/^video\//, 'audio/'), bytes: statSync(d.file).size, wave: () => waveOf(d) };
}

// How finely the waveform is drawn. A page shows a few hundred columns, and picks the loudest of these for each
const PEAKS = 2000;
// Enough to see where the sound is, and quick to read even for a long video
const PEAK_RATE = 8000;

/** The loudest level in each of PEAKS stretches of a file, from 0 to 1, without holding its sound in memory */
export function peaksOf(file: string, seconds: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const size = Math.max(1, Math.ceil((seconds * PEAK_RATE) / PEAKS));
    const peaks: number[] = [];
    let peak = 0;
    let count = 0;
    let odd: Buffer | null = null;
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(PEAK_RATE), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      // A chunk can end half way through a sample
      const data = odd ? Buffer.concat([odd, chunk]) : chunk;
      const whole = data.length - (data.length % 2);
      odd = whole < data.length ? data.subarray(whole) : null;
      for (let i = 0; i < whole; i += 2) {
        peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
        if (++count === size) {
          peaks.push(peak);
          peak = 0;
          count = 0;
        }
      }
    });
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => {
      if (count) peaks.push(peak);
      if (code !== 0 || !peaks.length) return reject(new Error(`ffmpeg couldn’t read ${path.basename(file)}`));
      const loudest = Math.max(...peaks, 1);
      resolve(peaks.map((p) => Math.round((p / loudest) * 1000) / 1000));
    });
  });
}

/** A download's waveform, worked out once */
export function waveOf(d: { file: string; seconds: number; peaks?: Promise<number[]> }) {
  // One that failed is tried again next time
  d.peaks ??= peaksOf(d.file, d.seconds).catch((err: unknown) => {
    d.peaks = undefined;
    throw err;
  });
  return d.peaks;
}

/** Why this part can't be kept, or null if it can */
export function partProblem(start: unknown, end: unknown, seconds: number): string | null {
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return 'Start and end have to be numbers of seconds.';
  if (start < 0 || end > seconds + TOLERANCE || start >= end) return 'Pick a start and end inside the video.';
  if (end - start < SHORTEST_PART) return `Keep at least ${SHORTEST_PART} s.`;
  if (end - start > LONGEST_PART + TOLERANCE) return `Keep at most ${LONGEST_PART / 60} minutes.`;
  return null;
}

/**
 * Cuts the part of a download into the library as `name`, and remembers where it came from. Returns addSound's answer, or
 * why it couldn't, as a string. The name and replacing have been checked already
 */
export async function savePart(guild: Guild, id: string, name: string, start: number, end: number, toDiscord: boolean) {
  const d = downloads.get(id);
  if (!d || d.guildId !== guild.id) return 'That download has gone. Paste the link again.';
  // The music container deletes what nobody's asked for in an hour, so someone slow to pick gets it downloaded again
  if (!existsSync(d.file)) {
    if (d.url === null) return 'That copy has gone. Open Cut another again.';
    const again = await fetchClip(d.url);
    if (typeof again === 'string') return again;
    d.file = again.file;
  }
  d.at = Date.now();
  const folder = mkdtempSync(path.join(tmpdir(), 'slopkeeper-link-'));
  try {
    const cut = path.join(folder, `${name}.mp3`);
    await cutAudio(d.file, cut, start, Math.min(end, d.seconds) - start);
    const added = await addSound(guild, name, '.mp3', readFileSync(cut), undefined, toDiscord);
    if (!added) return 'That part has no sound the bot can read.';
    // A cut from a library sound has no link to pick again from. One that replaced a sound from a link drops that link
    if (d.url !== null) db.prepare('INSERT OR REPLACE INTO sound_links (guild_id, name, url, title, start_s, end_s) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, name, d.url, d.title, start, end);
    else db.prepare('DELETE FROM sound_links WHERE guild_id = ? AND name = ?').run(guild.id, name);
    // Saving it told open pages already, before it had its link
    libraryChanged(guild.id);
    return added;
  } catch (err) {
    console.error(`Couldn’t cut ${name} from ${d.url ?? `the sound ${d.title}`} in server ${guild.id}:`, err instanceof Error ? err.message : err);
    return 'That part couldn’t be cut, so nothing was saved.';
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export interface SoundLink {
  url: string;
  title: string | null;
  start: number;
  end: number;
}

/** Where each of a server's sounds came from, for those cut from a link */
export function soundLinks(guildId: string): Map<string, SoundLink> {
  const rows = db.prepare('SELECT name, url, title, start_s, end_s FROM sound_links WHERE guild_id = ?').all(guildId) as { name: string; url: string; title: string | null; start_s: number; end_s: number }[];
  return new Map(rows.map((r) => [r.name, { url: r.url, title: r.title, start: r.start_s, end: r.end_s }]));
}

/** For tests: forgets every download */
export function resetDownloads() {
  for (const d of downloads.values()) if (d.own) rmSync(d.file, { force: true });
  downloads.clear();
}
