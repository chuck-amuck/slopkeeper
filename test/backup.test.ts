import './helpers.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backUp, copyAside } from '../src/backup.ts';
import { db, setKv } from '../src/db.ts';

const dir = path.join(process.env.DATA_DIR!, 'backups');
const day = (n: number) => new Date(Date.UTC(2026, 10, n));

test('a backup is a working copy of the database, without the health numbers', async () => {
  setKv('marker', 'kept');
  db.prepare("INSERT INTO perf_minutes (at, span, name, labels, count, sum, max) VALUES (1, 1, 'heap_used_bytes', '{}', 1, 1, 1)").run();
  db.prepare("INSERT INTO perf_slow (at, what, seconds, steps, detail) VALUES (1, 'Speech', 5, '[]', '{}')").run();
  await backUp(day(1));
  const copy = new DatabaseSync(path.join(dir, 'bot-2026-11-01.db'), { readOnly: true });
  assert.deepEqual({ ...copy.prepare(`SELECT value FROM kv WHERE key = 'marker'`).get() }, { value: 'kept' });
  assert.deepEqual({ ...copy.prepare('SELECT (SELECT COUNT(*) FROM perf_minutes) + (SELECT COUNT(*) FROM perf_slow) AS n').get() }, { n: 0 });
  copy.close();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_minutes').get() as { n: number }).n, 1, 'the database keeps them');
});

test('runs once a day and keeps the last 7', async () => {
  await backUp(day(1));
  for (let n = 2; n <= 10; n++) await backUp(day(n));
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'bot-2026-11-04.db');
  assert.equal(files.at(-1), 'bot-2026-11-10.db');
});

test('a copy that can’t be made leaves no backup, and says so', async () => {
  // A folder where the copy should go stops it
  const blocked = path.join(dir, 'bot-2026-11-21.db.partial');
  mkdirSync(path.join(blocked, 'inside'), { recursive: true });
  try {
    await assert.rejects(backUp(day(21)));
  } finally {
    rmSync(blocked, { recursive: true, force: true });
  }
  assert.ok(!readdirSync(dir).includes('bot-2026-11-21.db'));
});

test('a copy that fails in its worker says so', async () => {
  const to = path.join(dir, 'worker-fails.db');
  await assert.rejects(copyAside(to, path.join(dir, 'no-such.db')));
});

test('backups for two days asked for at once are both made', async () => {
  await Promise.all([backUp(day(25)), backUp(day(26))]);
  const files = readdirSync(dir);
  assert.ok(files.includes('bot-2026-11-25.db') && files.includes('bot-2026-11-26.db'));
});
