import './helpers.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('refuses to start on a database too old to read', async () => {
  const old = new DatabaseSync(`${process.env.DATA_DIR}/bot.db`);
  old.exec('CREATE TABLE games (id INTEGER PRIMARY KEY); PRAGMA user_version = 2;');
  old.close();
  await assert.rejects(import('../src/db.ts'), /too old/);
});
