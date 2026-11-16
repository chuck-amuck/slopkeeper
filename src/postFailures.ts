// Posts the bot makes on its own, and the last time each couldn't go out for a reason someone can fix in Settings, so
// the web UI and /setup show can say so instead of it sitting in the log

import { DiscordAPIError, type MessageCreateOptions, type SendableChannels } from 'discord.js';
import { db, setKv } from './db.ts';

export const POSTS = {
  hopOn: 'Hop-on ping',
  sessionRecap: 'Session recap',
  weekly: 'Weekly leaderboard',
  recap: 'Monthly recap',
  sales: 'Daily sale post',
  bundles: 'Bundle post',
  freeGames: 'Free game post',
  patchNotes: 'Patch notes',
} as const;
export type Post = keyof typeof POSTS;

// Discord's refusals a setting can fix: the channel is gone, or the bot is missing access or a permission there
const FIXABLE = new Set([10003, 50001, 50013]);

const PREFIX = 'post_failed:';
const keyOf = (guildId: string, post: Post) => `${PREFIX}${guildId}:${post}`;

export interface PostFailure {
  post: Post;
  /** Where it was going */
  channelId: string;
  at: number;
  /** Discord's reason, like "Missing Permissions" */
  error: string;
}

/** Sends one of the bot's own posts. A refusal a setting can fix is kept until a later one of the same kind goes out */
export async function sendPost(post: Post, guildId: string, channel: SendableChannels, message: MessageCreateOptions) {
  try {
    const sent = await channel.send(message);
    db.prepare('DELETE FROM kv WHERE key = ?').run(keyOf(guildId, post));
    return sent;
  } catch (err) {
    if (err instanceof DiscordAPIError && FIXABLE.has(Number(err.code))) {
      setKv(keyOf(guildId, post), JSON.stringify({ channelId: channel.id, at: Date.now(), error: err.message }));
    }
    throw err;
  }
}

/** The server's posts that last failed for a reason a setting can fix, newest first */
export function postFailures(guildId: string): PostFailure[] {
  const prefix = `${PREFIX}${guildId}:`;
  const rows = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? || char(0x10FFFF)").all(prefix, prefix) as { key: string; value: string }[];
  return rows
    .flatMap(({ key, value }) => {
      const post = key.slice(prefix.length) as Post;
      try {
        const failure = JSON.parse(value) as Omit<PostFailure, 'post'>;
        return post in POSTS ? [{ post, ...failure }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at - a.at);
}
