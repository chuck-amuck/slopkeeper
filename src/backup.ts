import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from './config.ts';
import { DB_FILE } from './db.ts';
import type { Feature } from './types.ts';
import { every } from './schedule.ts';

const KEEP = 7;
const CHECK_EVERY = 6 * 3_600_000;

/** How the bot did lately, which is many times the size of everything else and not worth getting back */
const NOT_KEPT = ['perf_minutes', 'perf_slow'];

/** Runs the copy in a worker thread, settling once it's done */
export function copyAside(to: string, from = DB_FILE) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./backupCopy.ts', import.meta.url), { workerData: { from, to, notKept: NOT_KEPT } });
    worker.once('error', reject);
    worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the backup copy stopped with code ${code}`))));
  });
}

let queue: Promise<void> = Promise.resolve();

/** Copies the database to backups/bot-<date>.db once a day, keeping the last week. Health numbers are left out */
export function backUp(date = new Date()): Promise<void> {
  // One at a time: a check while a copy is still going waits for it, then finds that day's copy made
  const job = queue.then(() => copyOnce(date));
  queue = job.catch(() => {});
  return job;
}

async function copyOnce(date: Date) {
  const dir = path.join(config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bot-${date.toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) return;
  // Written under another name so a failed copy can't pass for a backup
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  await copyAside(partial);
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
    every('Database backup', CHECK_EVERY, backUp, { now: true });
  },
};
