import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Mixer } from '../src/mixer.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(path.join(tmpdir(), 'slopkeeper-mixer-'));

function tone(name: string, frequency: number, seconds: number) {
  const file = path.join(dir, name);
  if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, file]);
  return file;
}

/** Peak level of each 20 ms frame the mixer produces */
function record(mixer: Mixer) {
  const peaks: number[] = [];
  mixer.on('data', (frame: Buffer) => {
    let peak = 0;
    for (let s = 0; s < frame.length; s += 2) peak = Math.max(peak, Math.abs(frame.readInt16LE(s)));
    peaks.push(peak);
  });
  return { peaks, done: new Promise((resolve) => mixer.once('end', resolve)) };
}

test('spamming a sound restarts it with no gap, and doesn’t stack', { skip: !hasFfmpeg }, async () => {
  const a = tone('a.wav', 440, 1);
  const mixer = new Mixer(0.5, 12);
  const { peaks, done } = record(mixer);
  mixer.add(a);
  await sleep(300);
  for (let n = 0; n < 6; n++) {
    mixer.add(a);
    await sleep(15);
  }
  await done;

  const start = peaks.findIndex((p) => p > 0);
  const end = peaks.findLastIndex((p) => p > 0);
  const level = Math.max(...peaks.slice(start + 2, start + 12));
  const heard = peaks.slice(start, end + 1);
  assert.equal(heard.filter((p) => p < level / 2).length, 0, 'no quiet frames');
  assert.ok(heard.length * 20 > 1250, `restarted rather than finishing at 1 s (${heard.length * 20} ms)`);
  // One frame can hold the crossfade between the two copies
  assert.ok(heard.filter((p) => p > level * 1.5).length <= 1, 'copies never stack');
});

test('different sounds layer', { skip: !hasFfmpeg }, async () => {
  const b = tone('b.wav', 440, 0.6);
  const c = tone('c.wav', 660, 0.6);
  const alone = new Mixer(0.5, 12);
  const first = record(alone);
  alone.add(b);
  await first.done;

  const mixer = new Mixer(0.5, 12);
  const both = record(mixer);
  mixer.add(b);
  mixer.add(c);
  await both.done;
  assert.ok(Math.max(...both.peaks) > Math.max(...first.peaks) * 1.5, 'louder than one tone');
});

test('a clip shorter than the start buffer plays in full', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 12);
  const { peaks, done } = record(mixer);
  mixer.add(tone('short.wav', 440, 0.04));
  await done;
  assert.equal(peaks.filter((p) => p > 0).length, 2);
});

test('a sound’s gain scales only that sound', { skip: !hasFfmpeg }, async () => {
  const level = async (gain: number) => {
    const mixer = new Mixer(0.5, 12);
    const { peaks, done } = record(mixer);
    mixer.add(tone('gain.wav', 440, 0.3), gain);
    await done;
    return Math.max(...peaks);
  };
  const normal = await level(1);
  assert.ok(Math.abs((await level(0.5)) / normal - 0.5) < 0.02);
  assert.ok(Math.abs((await level(1.5)) / normal - 1.5) < 0.02);
});

test('stopping ends playback', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 12);
  const { peaks, done } = record(mixer);
  mixer.add(tone('long.wav', 440, 5));
  await sleep(200);
  mixer.stopAll();
  await done;
  assert.ok(peaks.length < 40);
});

test('says when a sound is over, however it ended', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 2);
  const { done } = record(mixer);
  const ended: string[] = [];
  mixer.add(tone('e1.wav', 440, 0.2), 1, () => ended.push('played out'));
  mixer.add(tone('e2.wav', 550, 5), 1, () => ended.push('dropped'));
  await sleep(50);
  mixer.add(tone('e3.wav', 660, 0.2), 1, () => ended.push('never'));
  mixer.add(tone('e4.wav', 770, 5), 1, () => ended.push('stopped'));
  await sleep(100);
  mixer.stopAll();
  await done;
  assert.equal(new Set(ended).size, ended.length, 'each one only says so once');
  assert.ok(ended.includes('stopped'));
  assert.ok(ended.includes('dropped'));
});

test('a loop keeps going past the sound’s length, without a gap, until stopped', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 12);
  const { peaks, done } = record(mixer);
  let ended = false;
  mixer.add(tone('loop.wav', 440, 0.3), 1, () => (ended = true), { loop: true });
  await sleep(1300);
  assert.equal(ended, false);
  assert.ok(peaks.length > 50, 'still going after four times its length');
  assert.ok(peaks.slice(0, -2).every((p) => p > 1000), 'no quiet frames where it wraps around');
  mixer.stopLoops();
  await done;
  assert.equal(ended, true);
});

test('clicking the looping sound plays a second copy, and the cap never drops the loop', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 2);
  const { peaks, done } = record(mixer);
  const file = tone('loop2.wav', 440, 0.3);
  const ended: string[] = [];
  mixer.add(file, 1, () => ended.push('loop'), { loop: true });
  await sleep(100);
  mixer.add(file, 1, () => ended.push('click'));
  mixer.add(tone('other.wav', 660, 0.2), 1, () => ended.push('other'));
  await sleep(700);
  assert.deepEqual(ended.sort(), ['click', 'other'], 'the loop outlived both, and the cap dropped the click instead');
  mixer.stopAll();
  await done;
  assert.ok(peaks.length > 30);
});

test('a group’s volume changes what’s already playing, and only that group', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 12);
  const { peaks, done } = record(mixer);
  mixer.add(tone('group-sound.wav', 440, 1.2));
  await sleep(300);
  const before = Math.max(...peaks.slice(-5));
  mixer.setGroupGain('sound', 0.5);
  await sleep(300);
  const after = Math.max(...peaks.slice(-5));
  assert.ok(Math.abs(after / before - 0.5) < 0.05, `halved, got ${after / before}`);
  mixer.stopAll();
  await done;

  const speech = new Mixer(0.5, 12);
  speech.setGroupGain('sound', 0);
  const spoken = record(speech);
  speech.add(tone('group-speech.wav', 440, 0.3), 1, undefined, { group: 'speech' });
  await spoken.done;
  assert.ok(Math.max(...spoken.peaks) > 1000, 'speech isn’t changed by the soundboard volume');
});
