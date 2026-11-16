import { DatabaseSync } from 'node:sqlite';
import { workerData } from 'node:worker_threads';

/**
 * Runs in a worker thread, on its own connection, so copying the database never holds up the bot's audio or Discord.
 * Copies `from` to `to`, then empties the tables not worth keeping in the copy and shrinks it
 */
const { from, to, notKept } = workerData as { from: string; to: string; notKept: string[] };
// Waits a moment if the bot is busy with the file, as when it checkpoints, rather than failing that day's copy
const db = new DatabaseSync(from, { readOnly: true, timeout: 5_000 });
try {
  db.prepare('VACUUM INTO ?').run(to);
} finally {
  db.close();
}
const copy = new DatabaseSync(to, { timeout: 5_000 });
try {
  copy.exec(`${notKept.map((table) => `DELETE FROM ${table};`).join(' ')} VACUUM;`);
} finally {
  copy.close();
}
