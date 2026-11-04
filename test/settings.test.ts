import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// A database from before settings were key/value rows, which has to be in place before db.ts opens it
const old = new DatabaseSync(`${process.env.DATA_DIR}/bot.db`);
old.exec(`
  CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, announce_channel_id TEXT, hopon_role_id TEXT);
  INSERT INTO guild_settings VALUES ('g1', 'chan1', 'role1'), ('g2', 'chan2', NULL);
  CREATE TABLE games (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, steam_appid INTEGER, max_players INTEGER, added_by TEXT NOT NULL);
  PRAGMA user_version = 2;
`);
old.close();
process.env.HOPON_MIN_PEOPLE = '3';
const { idSetting, setSetting, setting } = await import('../src/settings.ts');

test('old settings carry over', () => {
  assert.equal(idSetting('g1', 'announceChannel'), 'chan1');
  assert.equal(idSetting('g1', 'hopOnRole'), 'role1');
  assert.equal(idSetting('g2', 'announceChannel'), 'chan2');
  assert.equal(idSetting('g2', 'hopOnRole'), null);
});

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
