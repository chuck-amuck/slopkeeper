import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anyChange, changeFeed, feeds } from '../src/changes.ts';

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test('a feed’s version changes per server, and waiting ends when it does', async () => {
  const feed = changeFeed();
  const a = feed.version('a');
  const b = feed.version('b');
  const waiting = feed.next('a', a, new AbortController().signal);
  assert.equal(await settled(waiting), false);
  feed.changed('b');
  assert.equal(await settled(waiting), false, 'another server’s change doesn’t wake it');
  assert.notEqual(feed.version('b'), b);
  feed.changed('a');
  assert.equal(await settled(waiting), true);
  assert.notEqual(feed.version('a'), a);
  // A version from before, or one from another run of the bot, answers straight away
  assert.equal(await settled(feed.next('a', a, new AbortController().signal)), true);
  assert.equal(await settled(feed.next('a', '', new AbortController().signal)), true);
});

test('a change everywhere wakes every server, and giving up ends the wait', async () => {
  const feed = changeFeed();
  const [a, b] = [feed.version('a'), feed.version('b')];
  const waits = [feed.next('a', a, new AbortController().signal), feed.next('b', b, new AbortController().signal)];
  feed.changedEverywhere();
  assert.deepEqual(await Promise.all(waits.map(settled)), [true, true]);
  assert.notEqual(feed.version('a'), a);
  assert.notEqual(feed.version('b'), b);

  const stop = new AbortController();
  const waiting = feed.next('a', feed.version('a'), stop.signal);
  assert.equal(await settled(waiting), false);
  stop.abort();
  assert.equal(await settled(waiting), true);
  assert.equal(await settled(feed.next('a', feed.version('a'), stop.signal)), true, 'already given up');
});

test('waiting on several feeds ends when any of them changes', async () => {
  const asked = { music: feeds.music.version('g'), voice: feeds.voice.version('g') };
  const waiting = anyChange('g', asked, new AbortController().signal);
  feeds.playing.changed('g');
  assert.equal(await settled(waiting), false, 'one it didn’t ask about');
  feeds.voice.changed('g');
  assert.equal(await settled(waiting), true);
});
