import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { voices } from '../src/features/say.ts';
import { levelGain, levelSpeech, measureGain, songGain } from '../src/loudness.ts';
import { db } from '../src/db.ts';
import { songLevel, songMultiplier } from '../src/songLevels.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(path.join(process.env.DATA_DIR!, 'loudness-'));

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

test('a song comes to the typical song’s level, coming up only as far as its peaks stay clear once the music volume turns it down', () => {
  // Quiet, with plenty of room
  assert.equal(songGain(-20.5, -10, 20), 10);
  // Loud: turned down, whatever the room
  assert.equal(songGain(-5.5, 1, 14), -5);
  // Quiet, but its peaks would clip at this music volume after 2 dB
  assert.equal(songGain(-20.5, -3, 0), 2);
  // At a music volume that clips already, it isn't turned down for that, only not up
  assert.equal(songGain(-20.5, 0, -4), 0);
  assert.equal(songGain(-40, -30, 30), 12, 'no more than sounds are boosted');
  for (const [lufs, peak] of [[null, null], [-70, -70], [-20, null], [NaN, -3]]) assert.equal(songGain(lufs, peak, 20), 0);
});

test('a song file is read once and kept by its path and size, read again once it changes, and one ffmpeg can’t read plays as it is', { skip: !hasFfmpeg }, async (t) => {
  const quiet = tone('quiet-song.wav', 4, -20);
  const [first, second] = await Promise.all([songLevel(quiet), songLevel(quiet)]);
  assert.deepEqual(first, second, 'two asking at once share one reading');
  assert.ok(first!.lufs! < -25 && first!.peak! < -15, JSON.stringify(first));
  // From what's kept, not read again
  db.prepare('UPDATE song_loudness SET lufs = -99 WHERE file = ?').run(quiet);
  assert.equal((await songLevel(quiet))!.lufs, -99);
  // ffmpeg's test tone is at -18 dBFS before any volume change
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=5', quiet]);
  assert.ok((await songLevel(quiet))!.lufs! > -30, 'a different file under the same name is read afresh');

  const loud = tone('loud-song.wav', 4, 16);
  assert.ok((await songMultiplier(quiet, 0.4)) > 1, 'a quiet song comes up');
  assert.ok((await songMultiplier(loud, 0.4)) < 1, 'a loud one goes down');

  const broken = path.join(dir, 'broken.webm');
  writeFileSync(broken, 'not audio at all');
  const errors = t.mock.method(console, 'error', () => {});
  assert.equal(await songLevel(broken), null);
  assert.equal(await songMultiplier(broken, 0.4), 1);
  assert.equal(errors.mock.callCount(), 1, 'not read and logged again');
  assert.equal(await songLevel(path.join(dir, 'gone.webm')), null);
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

// Their levels were matched on real Piper speech, which a test tone can't stand in for: the broadcast's compressor squeezes a
// steady tone far more than speech. So this checks the filters run and give sound, not how loud
test('every voice’s effects run in ffmpeg and give sound', { skip: !hasFfmpeg }, async () => {
  const input = path.join(dir, 'voice.wav');
  const output = path.join(dir, 'voiced.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='(0.1*sin(2*PI*440*t)+0.06*sin(2*PI*1200*t))*abs(sin(2*PI*3*t))':d=3:s=22050", input]);
  const styled = voices().filter((v) => v.effects);
  assert.ok(styled.length >= 2);
  for (const voice of styled) {
    await levelSpeech(input, output, voice.effects);
    const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', output, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.ok(Number(/\bI:\s+(\S+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary')))![1]) > -30, `${voice.name} gives sound`);
  }
});
