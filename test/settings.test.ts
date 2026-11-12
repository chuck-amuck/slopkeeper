import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.HOPON_MIN_PEOPLE = '3';
const { idSetting, setSetting, setting } = await import('../src/settings.ts');
const { feeds } = await import('../src/changes.ts');

test('a setting comes from /setup, then the env default, then the built-in default', () => {
  assert.equal(setting('g1', 'hopOnMinPeople'), 3);
  assert.equal(setting('g1', 'hopOnCooldownMin'), 120);
  setSetting('g1', 'hopOnMinPeople', 5);
  assert.equal(setting('g1', 'hopOnMinPeople'), 5);
  assert.equal(setting('g2', 'hopOnMinPeople'), 3, 'other servers are untouched');
  setSetting('g1', 'hopOnMinPeople', undefined);
  assert.equal(setting('g1', 'hopOnMinPeople'), 3);
});

test('free games are off until a server turns them on', () => {
  assert.equal(setting('g1', 'freeGames'), false);
  setSetting('g1', 'freeGames', true);
  assert.equal(setting('g1', 'freeGames'), true);
  assert.equal(setting('g2', 'freeGames'), false);
});

test('an empty id setting means none', () => {
  setSetting('g1', 'hopOnRole', '');
  assert.equal(idSetting('g1', 'hopOnRole'), null);
});

test('a setting another page shows tells that page, from /setup and the web UI alike', () => {
  const before = { voice: feeds.voice.version('g9'), music: feeds.music.version('g9') };
  setSetting('g9', 'hopOnMinPeople', 4);
  assert.deepEqual({ voice: feeds.voice.version('g9'), music: feeds.music.version('g9') }, before, 'nothing else shows that one');
  setSetting('g9', 'soundVolume', 50);
  assert.notEqual(feeds.voice.version('g9'), before.voice, 'the volume beside Play in');
  setSetting('g9', 'musicVolume', undefined);
  assert.notEqual(feeds.music.version('g9'), before.music, 'the music page, back to the default too');
});
