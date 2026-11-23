import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Burst, HEARD, LevelGate, frameDb, heardAs } from '../src/talkLevel.ts';

/** 20 ms of 16-bit stereo PCM of a tone at `db` under full scale */
function tone(db: number) {
  const pcm = Buffer.alloc(960 * 4);
  const amplitude = 32767 * Math.SQRT2 * 10 ** (db / 20);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(amplitude * Math.sin((i * 2 * Math.PI * 200) / 48_000));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return pcm;
}

test('a frame’s loudness is its RMS under full scale, and silence is the quietest', () => {
  assert.ok(Math.abs(frameDb(tone(-20)) + 20) < 0.2);
  assert.ok(Math.abs(frameDb(tone(-45)) + 45) < 0.5);
  assert.equal(frameDb(Buffer.alloc(3840)), -100);
});

test('talking counts once enough recent frames are loud, and stops once none are', () => {
  const heard: boolean[] = [];
  const gate = new LevelGate(HEARD.talking, (on) => heard.push(on));
  for (let i = 0; i < 200; i++) gate.frame(-55);
  assert.deepEqual(heard, [], 'quiet noise never counts');
  for (let i = 0; i < HEARD.talking.frames - 1; i++) gate.frame(-30);
  gate.frame(-55);
  assert.deepEqual(heard, [], 'nor a sound too short');
  // Talking with gaps between syllables
  for (let i = 0; i < 20; i++) gate.frame(i % 3 ? -30 : -60);
  assert.deepEqual(heard, [true]);
  for (let i = 0; i < HEARD.talking.of - 1; i++) gate.frame(-60);
  assert.deepEqual(heard, [true], 'a gap in a sentence doesn’t end it');
  gate.frame(-60);
  assert.deepEqual(heard, [true, false]);
  // Discord stopping ends it at once, and it starts over
  for (let i = 0; i < 20; i++) gate.frame(-30);
  gate.quiet();
  assert.deepEqual(heard, [true, false, true, false]);
  gate.frame(-30);
  assert.deepEqual(heard, [true, false, true, false], 'a click after a pause doesn’t count from before');
});

test('the setting reads as a level, any sound as none, and anything else as the default', () => {
  assert.equal(heardAs('any'), null);
  assert.equal(heardAs('loud'), HEARD.loud);
  assert.equal(heardAs('cats'), HEARD.talking);
  assert.equal(heardAs('toString'), HEARD.talking);
});

test('a burst sums up for the log as levels, never who', () => {
  const burst = new Burst();
  assert.equal(burst.empty, true);
  for (let i = 0; i < 90; i++) burst.add(-30.2);
  for (let i = 0; i < 10; i++) burst.add(-12);
  assert.equal(burst.line(true, HEARD.talking), 'Talking measured: 2.0 s, typically -30 dB, loudest tenth -30 dB, counted at -45 dB');
});
