import { db } from './db.ts';

const KEEP_MS = 365 * 24 * 3_600_000;

/** Who changed something from the web UI. It has one shared login, so there's nobody more specific to name */
export const FROM_WEB = 'web';

export interface ActivityRow {
  id: number;
  at: number;
  actor: string;
  action: string;
}

/** Records a change to a server's sounds, settings or game nights, in the bot's message style */
export function logActivity(guildId: string, actor: string, action: string) {
  const now = Date.now();
  db.prepare('INSERT INTO activity (guild_id, at, actor, action) VALUES (?, ?, ?, ?)').run(guildId, now, actor, action);
  db.prepare('DELETE FROM activity WHERE guild_id = ? AND at < ?').run(guildId, now - KEEP_MS);
}

/** Newest first, from before the entry with id `before` if given */
export function recentActivity(guildId: string, limit: number, before = Number.MAX_SAFE_INTEGER): ActivityRow[] {
  return db.prepare('SELECT id, at, actor, action FROM activity WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(guildId, before, limit) as unknown as ActivityRow[];
}
