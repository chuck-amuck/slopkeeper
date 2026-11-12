/**
 * A version per server for something the web UI keeps up with, and a way to wait for it to change, so a page can ask
 * once and hear the moment it does instead of asking every few seconds
 */
export interface ChangeFeed {
  /** Something changed in this server */
  changed(guildId: string): void;
  /** Something changed for every server at once, like the music player going down */
  changedEverywhere(): void;
  version(guildId: string): string;
  /** Waits until the version differs from `version`, or `signal` gives up */
  next(guildId: string, version: string, signal: AbortSignal): Promise<void>;
}

export function changeFeed(): ChangeFeed {
  // Starts each run of the bot afresh, so a page that last heard of version 3 before a restart isn't kept waiting
  const run = Date.now().toString(36);
  const versions = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  let everywhere = 0;
  const version = (guildId: string) => `${run}.${everywhere}-${versions.get(guildId) ?? 0}`;
  return {
    changed(guildId) {
      versions.set(guildId, (versions.get(guildId) ?? 0) + 1);
      const waiting = waiters.get(guildId);
      waiters.delete(guildId);
      for (const wake of waiting ?? []) wake();
    },
    changedEverywhere() {
      everywhere++;
      const all = [...waiters.values()];
      waiters.clear();
      for (const waiting of all) for (const wake of waiting) wake();
    },
    version,
    next(guildId, since, signal) {
      if (version(guildId) !== since || signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const waiting = waiters.get(guildId) ?? new Set();
        waiters.set(guildId, waiting);
        const wake = () => {
          waiting.delete(wake);
          if (!waiting.size && waiters.get(guildId) === waiting) waiters.delete(guildId);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        waiting.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    },
  };
}

/**
 * What the web UI can keep up with: sounds and speech playing, the music, who's in which voice channel, game nights,
 * the activity log, and the sound library with its groups, bin and Discord soundboard
 */
export const feeds = {
  playing: changeFeed(),
  music: changeFeed(),
  voice: changeFeed(),
  nights: changeFeed(),
  activity: changeFeed(),
  sounds: changeFeed(),
};

export type FeedName = keyof typeof feeds;

/** Waits until any of `asked` (feed → the version the page has) changes, or `signal` gives up */
export async function anyChange(guildId: string, asked: Partial<Record<FeedName, string>>, signal: AbortSignal): Promise<void> {
  const done = new AbortController();
  const both = AbortSignal.any([signal, done.signal]);
  try {
    await Promise.race(Object.entries(asked).map(([name, version]) => feeds[name as FeedName].next(guildId, version!, both)));
  } finally {
    // Lets go of the others
    done.abort();
  }
}
