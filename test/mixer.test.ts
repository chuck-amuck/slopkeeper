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

test('a sound can start partway in, and says whether it ended by itself or was stopped', { skip: !hasFfmpeg }, async () => {
  const whole = tone('start.wav', 440, 1);
  const heard = async (startMs?: number) => {
    const mixer = new Mixer(0.5, 12);
    const { peaks, done } = record(mixer);
    let byItself: boolean | undefined;
    mixer.add(whole, 1, (b) => (byItself = b), { startMs });
    await done;
    return { frames: peaks.filter((p) => p > 0).length, byItself };
  };
  const full = await heard();
  const late = await heard(700);
  assert.deepEqual([full.frames, full.byItself], [50, true]);
  assert.ok(late.frames >= 13 && late.frames <= 17, `started 0.7 s in, so about 15 frames, got ${late.frames}`);
  const mixer = new Mixer(0.5, 12);
  const { done } = record(mixer);
  let stopped: boolean | undefined;
  const stop = mixer.add(whole, 1, (b) => (stopped = b));
  await sleep(100);
  stop();
  await done;
  assert.equal(stopped, false);
});

test('a layered loop starts a fresh copy exactly every so often, over the ones still playing, until stopped', { skip: !hasFfmpeg }, async () => {
  // One second of tone, started again every 400 ms: a whole number of cycles, so the copies add up in step
  const beep = tone('layer.wav', 440, 1);
  const mixer = new Mixer(0.5, 12);
  const { peaks, done } = record(mixer);
  let ended: boolean | undefined;
  const stop = mixer.add(beep, 1, (b) => (ended = b), { loop: true, everyMs: 400 });
  try {
    await sleep(1500);
    const one = peaks[5];
    const ratio = (frame: number) => Math.round((peaks[frame] / one) * 10) / 10;
    assert.deepEqual([ratio(19), ratio(20), ratio(39), ratio(40), ratio(45)], [1, 2, 2, 3, 3], `copies start on frames 20 and 40, got ${peaks.slice(15, 45).join(' ')}`);
    // From one second on, the first copy has ended, so three play at a time
    assert.equal(ratio(65), 3);
  } finally {
    stop();
  }
  await done;
  assert.equal(ended, false);
});

test('a layered loop keeps at most 8 copies, fading the oldest out', { skip: !hasFfmpeg }, async () => {
  // 500 Hz is exactly 10 cycles a frame, so copies a whole number of frames apart add up in step
  const beep = tone('layer-many.wav', 500, 1);
  const mixer = new Mixer(0.1, 12);
  const { peaks, done } = record(mixer);
  mixer.add(beep, 1, undefined, { loop: true, everyMs: 20 });
  try {
    await sleep(800);
    const one = peaks[0];
    const most = Math.max(...peaks);
    // Eight, plus the oldest fading out over the frame the next one starts in
    assert.ok(most / one > 7.5 && most / one < 9.1, `eight copies at most, got ${(most / one).toFixed(2)}`);
  } finally {
    mixer.stopLoops();
  }
  await done;
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

test('clicking the looping sound plays a second copy rather than restarting the loop', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(0.5, 12);
  const { done } = record(mixer);
  const file = tone('loop3.wav', 440, 0.3);
  const ended: string[] = [];
  mixer.add(file, 1, () => ended.push('loop'), { loop: true });
  await sleep(100);
  mixer.add(file, 1, () => ended.push('click'));
  await sleep(600);
  assert.deepEqual(ended, ['click']);
  mixer.stopAll();
  await done;
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

test('a lasting sound is never pushed out by newer ones, and can be stopped by itself', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(1, 2);
  const { done } = record(mixer);
  let songEnded = false;
  const stopSong = mixer.add(tone('song.wav', 330, 3), 1, () => (songEnded = true), { group: 'music', lasting: true });
  for (const [n, f] of [[1, 500], [2, 600], [3, 700]] as const) mixer.add(tone(`click${n}.wav`, f, 2), 1);
  await sleep(200);
  assert.equal(songEnded, false, 'sounds past the cap drop each other, not the song');
  stopSong();
  assert.equal(songEnded, true);
  mixer.stopAll();
  await done;
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

/** A file at one steady level, like music that never gets quieter or louder */
function steady(name: string, level: number, seconds: number) {
  const file = path.join(dir, name);
  if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${level}/32768:s=48000:c=stereo:d=${seconds}`, '-c:a', 'pcm_s16le', file]);
  return file;
}
const near = (peak: number | undefined, level: number) => peak !== undefined && Math.abs(peak - level) <= 2;

test('music drops under speech and comes back up after', { skip: !hasFfmpeg }, async () => {
  const mixer = new Mixer(1, 12);
  const { peaks, done } = record(mixer);
  const stop = mixer.add(steady('duck-music.wav', 1000, 3), 1, undefined, { group: 'music', lasting: true });
  await sleep(300);
  assert.ok(near(peaks.at(-1), 1000), `music at full level, got ${peaks.at(-1)}`);
  mixer.setGroupGain('speech', 0);
  mixer.add(tone('duck-line.wav', 440, 0.6), 1, undefined, { group: 'speech' });
  await sleep(500);
  assert.ok(near(peaks.at(-1), 300), `down to 30% while the line is spoken, got ${peaks.at(-1)}`);
  await sleep(700);
  assert.ok(near(peaks.at(-1), 1000), `back up once it’s said, got ${peaks.at(-1)}`);
  stop();
  await done;
});
