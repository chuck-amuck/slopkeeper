import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db.ts';

const add = db.prepare('INSERT INTO game_aliases (guild_id, raw, key, name, manual) VALUES (?, ?, ?, ?, ?)');
// As they were stored before numerals counted
add.run('g', 'Slay the Spire 2', 'slaythespire2', 'Slay the Spire 2', 0);
add.run('g', 'Slay the Spire II', 'slaythespireii', 'Slay the Spire II', 0);
add.run('g', 'Rocky IV', 'rockyiv', 'Rocky IV', 1);
add.run('g', 'Rocky 4', 'rocky4', 'Rocky 4', 0);
add.run('g', 'Lone VI', 'lonevi', 'Lone VI', 0);

const { gameKey, gameName, noteGame } = await import('../src/gameNames.ts');

test('a Roman numeral at the end of a name counts as its digit', () => {
  for (const [roman, digit] of [['II', 2], ['III', 3], ['IV', 4], ['V', 5], ['VI', 6], ['VII', 7], ['VIII', 8], ['IX', 9]]) {
    assert.equal(gameKey(`Game ${roman}`), `game${digit}`);
  }
  assert.equal(gameKey('Slay the Spire II '), 'slaythespire2');
  assert.equal(gameKey('Spire: II'), 'spire2');
});

test('only a numeral on its own, in capitals, at the end counts', () => {
  assert.equal(gameKey('Game X'), 'gamex');
  assert.equal(gameKey('Game I'), 'gamei');
  assert.equal(gameKey('Sector Vi'), 'sectorvi');
  assert.equal(gameKey('Sector vi'), 'sectorvi');
  assert.equal(gameKey('Civ VI Deluxe'), 'civvideluxe');
  assert.equal(gameKey('MAXIMUM IIV'), 'maximumiiv');
  assert.equal(gameKey('V'), 'v');
  assert.equal(gameKey('SURVIVE'), 'survive');
});

test('spellings stored before numerals counted join up at the next start', () => {
  assert.equal(gameName('g', 'Slay the Spire II'), 'Slay the Spire 2', 'ties go to the one recorded first');
  assert.equal(gameName('g', 'Slay the Spire 2'), 'Slay the Spire 2');
});

test('a name someone picked stays', () => {
  assert.equal(gameName('g', 'Rocky IV'), 'Rocky IV');
  assert.equal(gameName('g', 'Rocky 4'), 'Rocky 4');
});

test('a spelling with nothing to match keeps its name and its new key', () => {
  assert.equal(gameName('g', 'Lone VI'), 'Lone VI');
  assert.equal((db.prepare(`SELECT key FROM game_aliases WHERE raw = 'Lone VI'`).get() as { key: string }).key, 'lone6');
});

test('new spellings match across numerals and digits', () => {
  noteGame('h', 'Portal 2');
  assert.equal(noteGame('h', 'Portal II'), true);
  assert.equal(gameName('h', 'Portal II'), 'Portal 2');
});
