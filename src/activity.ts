import { feeds } from './changes.ts';
import { db } from './db.ts';

const KEEP_MS = 365 * 24 * 3_600_000;

/** Who changed something from the web UI without signing in through Pangolin, so there's nobody more specific to name */
export const FROM_WEB = 'web';

/** Who changed something from the web UI after signing in through Pangolin */
export const fromWebUser = (email: string) => `web:${email}`;

export interface WebUser {
  email: string;
  name: string;
  userId: string | null;
}

/** Keeps the name Pangolin gives for someone current, so old activity shows it after a change. Writes only when it's new or changed, as it runs on every request */
export function seeWebUser(email: string, name: string) {
  const known = db.prepare('SELECT name FROM web_users WHERE email = ?').get(email) as { name: string } | undefined;
  if (known?.name === name) return;
  db.prepare('INSERT INTO web_users (email, name, seen_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at').run(email, name, Date.now());
}

export function webUser(email: string): WebUser | undefined {
  return db.prepare('SELECT email, name, user_id AS userId FROM web_users WHERE email = ?').get(email) as unknown as WebUser | undefined;
}

/** Who else has said they're this Discord member, if anyone */
export function webUserFor(userId: string): WebUser | undefined {
  return db.prepare('SELECT email, name, user_id AS userId FROM web_users WHERE user_id = ?').get(userId) as unknown as WebUser | undefined;
}

export function linkWebUser(email: string, userId: string | null) {
  db.prepare('UPDATE web_users SET user_id = ? WHERE email = ?').run(userId, email);
}

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
  feeds.activity.changed(guildId);
}

/** Newest first, from before the entry with id `before` if given */
export function recentActivity(guildId: string, limit: number, before = Number.MAX_SAFE_INTEGER): ActivityRow[] {
  return db.prepare('SELECT id, at, actor, action FROM activity WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(guildId, before, limit) as unknown as ActivityRow[];
}
