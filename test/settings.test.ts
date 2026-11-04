import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.HOPON_MIN_PEOPLE = '3';
const { idSetting, setSetting, setting } = await import('../src/settings.ts');

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
