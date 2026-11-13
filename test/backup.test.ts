import './helpers.ts';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backUp } from '../src/backup.ts';
import { db, setKv } from '../src/db.ts';

const dir = path.join(process.env.DATA_DIR!, 'backups');
const day = (n: number) => new Date(Date.UTC(2026, 10, n));

test('a backup is a working copy of the database, without the health numbers', () => {
  setKv('marker', 'kept');
  db.prepare("INSERT INTO perf_minutes (at, span, name, labels, count, sum, max) VALUES (1, 1, 'heap_used_bytes', '{}', 1, 1, 1)").run();
  db.prepare("INSERT INTO perf_slow (at, what, seconds, steps, detail) VALUES (1, 'Speech', 5, '[]', '{}')").run();
  backUp(day(1));
  const copy = new DatabaseSync(path.join(dir, 'bot-2026-11-01.db'), { readOnly: true });
  assert.deepEqual({ ...copy.prepare(`SELECT value FROM kv WHERE key = 'marker'`).get() }, { value: 'kept' });
  assert.deepEqual({ ...copy.prepare('SELECT (SELECT COUNT(*) FROM perf_minutes) + (SELECT COUNT(*) FROM perf_slow) AS n').get() }, { n: 0 });
  copy.close();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM perf_minutes').get() as { n: number }).n, 1, 'the database keeps them');
});

test('runs once a day and keeps the last 7', () => {
  backUp(day(1));
  for (let n = 2; n <= 10; n++) backUp(day(n));
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 7);
  assert.equal(files[0], 'bot-2026-11-04.db');
  assert.equal(files.at(-1), 'bot-2026-11-10.db');
});
