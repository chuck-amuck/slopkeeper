import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Keeps each file in its own format. Anything left out is lossless, so ffmpeg's default for the extension is fine */
const ENCODERS: Record<string, string[]> = {
  '.mp3': ['-c:a', 'libmp3lame', '-b:a', '192k'],
  '.ogg': ['-c:a', 'libvorbis', '-q:a', '6'],
  '.opus': ['-c:a', 'libopus', '-b:a', '160k'],
  '.webm': ['-c:a', 'libopus', '-b:a', '160k'],
  '.m4a': ['-c:a', 'aac', '-b:a', '192k'],
};

/** Writes part of a sound to a new file. It's encoded again because copying can only cut where the audio's own frames start */
export async function cutAudio(file: string, output: string, start: number, seconds: number) {
  const encoder = ENCODERS[path.extname(output).toLowerCase()] ?? [];
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', ...encoder, output]);
}
