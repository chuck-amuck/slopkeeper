import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { durationOf } from './discordSounds.ts';

const exec = promisify(execFile);

// What sounds are levelled to, before the mix turns everything down to leave room for layering
const TARGET_LUFS = -14;
// Quiet sounds with one loud spike can only come up until the spike reaches this
const PEAK_CEILING_DB = -1;
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = -24;
// EBU R128 reads in 400 ms blocks, so a shorter sound has no reading at all. Looped, it reads the same as it would if it were longer
const SHORTEST_READ_SECONDS = 3;
// ffmpeg's floor, which is what silence reads as
const SILENT_LUFS = -70;

/** The gain, in dB, that brings a sound with this loudness and peak to the target */
export function levelGain(lufs: number, peak: number): number {
  if (!Number.isFinite(lufs) || lufs <= SILENT_LUFS || !Number.isFinite(peak)) return 0;
  const gain = Math.min(TARGET_LUFS - lufs, PEAK_CEILING_DB - peak, MAX_BOOST_DB);
  return Math.round(Math.max(gain, MAX_CUT_DB) * 10) / 10;
}

// Speech hits full scale while sounding quiet, so levelling can't raise it. Taking its peaks off with a limiter lets it reach the target
const SPEECH_FILTER = `volume=7dB,alimiter=limit=${10 ** (PEAK_CEILING_DB / 20)}:attack=3:release=40:level=false`;

/** Writes a copy of spoken audio that's about as loud as a levelled sound, after a voice's own ffmpeg effects if it has any */
export async function levelSpeech(input: string, output: string, effects?: string) {
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-af', effects ? `${effects},${SPEECH_FILTER}` : SPEECH_FILTER, output]);
}

/** As slow as rubberband goes: 100 times as long */
const MOST_STRETCH = 0.01;

/**
 * Holds sounds in spoken audio for as long as asked, at the same pitch: a drawn-out word's vowel, from its start to its end
 * sample. Each is padded before rubberband stretches it and cut to length after, as rubberband drops the end of a short piece
 */
export async function holdSounds(input: string, output: string, holds: readonly { start: number; end: number; seconds: number }[], rate: number) {
  const pieces: string[] = [];
  let from = 0;
  for (const { start, end, seconds: asked } of [...holds].sort((a, b) => a.start - b.start)) {
    const length = (end - start) / rate;
    // Overlapping, or already as long
    if (start < from || asked <= length) continue;
    if (start > from) pieces.push(`atrim=start_sample=${from}:end_sample=${start},asetpts=N/SR/TB`);
    const tempo = Math.max(MOST_STRETCH, length / asked);
    const seconds = Math.min(asked, length / tempo);
    pieces.push(
      `atrim=start_sample=${start}:end_sample=${end},asetpts=N/SR/TB,apad=pad_dur=1,rubberband=tempo=${tempo.toFixed(5)}:pitchq=quality:formant=preserved:window=long,atrim=end=${seconds},asetpts=N/SR/TB`,
    );
    from = end;
  }
  pieces.push(`atrim=start_sample=${from},asetpts=N/SR/TB`);
  const split = `[0]asplit=${pieces.length}${pieces.map((_, i) => `[s${i}]`).join('')}`;
  const graph = [split, ...pieces.map((piece, i) => `[s${i}]${piece}[p${i}]`), `${pieces.map((_, i) => `[p${i}]`).join('')}concat=n=${pieces.length}:v=0:a=1`].join(';');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-filter_complex', graph, output]);
}

/**
 * How loud spoken audio comes out once it's levelled as a line is, after any ffmpeg filters in `before` and then turning
 * it up or down by `volume` dB
 */
export async function levelledLoudness(file: string, volume: number, before?: string): Promise<number> {
  const filters = [before, `volume=${volume}dB`, SPEECH_FILTER, 'ebur128'].filter(Boolean).join(',');
  const { stderr } = await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', filters, '-f', 'null', '-']);
  // The summary at the end, not a running reading
  const lufs = [...stderr.matchAll(/\bI:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1];
  if (lufs === undefined) throw new Error('ffmpeg gave no loudness reading');
  return Number(lufs);
}

/** Reads a file's loudness and works out its gain. Takes about a second for a sound of a few minutes */
export async function measureGain(file: string): Promise<number> {
  const seconds = await durationOf(file);
  const loops = seconds > 0 && seconds < SHORTEST_READ_SECONDS ? Math.ceil(SHORTEST_READ_SECONDS / seconds) : 0;
  const { stderr } = await exec('ffmpeg', ['-hide_banner', '-nostats', '-stream_loop', String(loops), '-i', file, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
  const lufs = /\bI:\s+(\S+) LUFS/.exec(stderr)?.[1];
  const peak = /\bPeak:\s+(\S+) dBFS/.exec(stderr)?.[1];
  return levelGain(Number(lufs), Number(peak));
}
