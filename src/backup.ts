import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { db } from './db.ts';
import type { Feature } from './types.ts';

const KEEP = 7;
const CHECK_EVERY = 6 * 3_600_000;

/** Copies the database to backups/bot-<date>.db once a day, keeping the last week */
export function backUp(date = new Date()) {
  const dir = path.join(config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bot-${date.toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) return;
  // Written under another name so a failed copy can't pass for a backup
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  db.prepare('VACUUM INTO ?').run(partial);
  renameSync(partial, file);
  const old = readdirSync(dir)
    .filter((f) => /^bot-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) rmSync(path.join(dir, f));
}

export const backups: Feature = {
  setup() {
    const run = () => {
      try {
        backUp();
      } catch (err) {
        console.error('Database backup failed:', err);
      }
    };
    run();
    setInterval(run, CHECK_EVERY);
  },
};
