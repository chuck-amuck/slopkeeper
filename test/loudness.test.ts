import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { levelGain, levelSpeech, measureGain } from '../src/loudness.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(path.join(tmpdir(), 'slopkeeper-loudness-'));

function tone(name: string, seconds: number, db: number) {
  const file = path.join(dir, name);
  if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=800:duration=${seconds}`, '-af', `volume=${db}dB`, file]);
  return file;
}

test('brings a sound to the target', () => {
  assert.equal(levelGain(-20, -10), 6);
  assert.equal(levelGain(-8, -1), -6);
});

test('stops turning up before a loud spike would clip', () => {
  assert.equal(levelGain(-30, -4), 3);
});

test('won’t boost or cut past its limits', () => {
  assert.equal(levelGain(-60, -50), 12);
  assert.equal(levelGain(20, 30), -24);
});

test('leaves silence and unreadable results alone', () => {
  for (const [lufs, peak] of [[-70, -70], [-Infinity, -Infinity], [NaN, NaN], [-20, -Infinity]]) assert.equal(levelGain(lufs, peak), 0);
});

test('a quiet tone is turned up by as much more as it is quieter', { skip: !hasFfmpeg }, async () => {
  const loud = await measureGain(tone('loud.wav', 4, 12));
  const quiet = await measureGain(tone('quiet.wav', 4, 6));
  assert.ok(Math.abs(quiet - loud - 6) < 0.3, `${loud} and ${quiet}`);
});

test('a clip too short for a loudness reading matches a longer one at the same level', { skip: !hasFfmpeg }, async () => {
  const short = await measureGain(tone('short.wav', 0.15, 6));
  const long = await measureGain(tone('long.wav', 4, 6));
  // Neither is at the boost limit, or they'd match whatever was read
  assert.ok(Math.abs(long) < 6, String(long));
  assert.ok(Math.abs(short - long) < 0.5, `${short} and ${long}`);
});

test('a silent file gets no gain', { skip: !hasFfmpeg }, async () => {
  const file = path.join(dir, 'silent.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:d=1', '-t', '1', file]);
  assert.equal(await measureGain(file), 0);
});

test('speech comes up to the level of sounds without clipping', { skip: !hasFfmpeg }, async () => {
  // Quiet, with sharp peaks at full scale, which is how speech looks to a level meter
  const input = path.join(dir, 'speech.wav');
  const output = path.join(dir, 'levelled.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.17*sin(2*PI*220*t)+if(lt(mod(t,0.5),0.002),0.8,0)':d=4:s=22050", input]);
  assert.ok((await measureGain(input)) <= 0, 'levelling alone can’t raise it');
  await levelSpeech(input, output);
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', output, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' });
  const before = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const read = (log: string, name: string) => Number(new RegExp(`\\b${name}:\\s+(\\S+) (?:LUFS|dBFS)`).exec(log.slice(log.lastIndexOf('Summary')))![1]);
  assert.ok(read(stderr, 'I') > read(before, 'I') + 3, 'louder');
  assert.ok(read(stderr, 'Peak') < 0.5, 'not clipped');
});
