import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db.ts';
import { stats } from '../src/features/gamestats.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t = Date.now();
const play = db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)');
play.run('g', 'a', 'Valheim', t - 3 * HOUR, t - HOUR);
play.run('g', 'b', 'Valheim', t - 2 * HOUR, t - HOUR);
play.run('g', 'a', 'Valheim', t - 8 * DAY - HOUR, t - 8 * DAY + HOUR);
play.run('g', 'a', 'Lethal Company', t - 40 * DAY, t - 40 * DAY + HOUR);
play.run('other', 'a', 'Valheim', t - HOUR, t);

const hours = (rows: { key: string; ms: number; n: number }[]) => rows.map((r) => [r.key, Math.round(r.ms / HOUR), r.n]);

test('adds up the server’s games over a period', () => {
  assert.deepEqual(hours(stats('g', t - 7 * DAY, 'none', 'game')), [['Valheim', 3, 2]]);
  assert.deepEqual(hours(stats('g', t - 30 * DAY, 'none', 'game')), [['Valheim', 5, 2]]);
  assert.deepEqual(hours(stats('g', 0, 'none', 'game')), [['Valheim', 5, 2], ['Lethal Company', 1, 1]]);
});

test('breaks down per person and per game', () => {
  assert.deepEqual(hours(stats('g', 0, 'user', 'game', 'a')), [['Valheim', 4, 1], ['Lethal Company', 1, 1]]);
  assert.deepEqual(hours(stats('g', 0, 'game', 'user_id', undefined, 'Valheim')), [['a', 4, 1], ['b', 1, 1]]);
});

test('only counts the part of a play inside the period', () => {
  play.run('g', 'c', 'Deep Rock', t - 7 * DAY - HOUR, t - 7 * DAY + HOUR);
  assert.equal(stats('g', t - 7 * DAY, 'none', 'game').find((r) => r.key === 'Deep Rock')!.ms > HOUR - 60_000, true);
  assert.equal(stats('g', t - 7 * DAY, 'none', 'game').find((r) => r.key === 'Deep Rock')!.ms < HOUR + 60_000, true);
});
