import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Imported first by each test file. Node runs every file in its own process, so each gets its own empty database
process.env.DISCORD_TOKEN = 'test-token';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'slopkeeper-test-'));
process.env.TZ = 'America/Chicago';
// Each test file's data goes when it's done, rather than piling up in the temp folder
process.on('exit', () => rmSync(process.env.DATA_DIR!, { recursive: true, force: true }));

export interface FakeGuild {
  id: string;
  name: string;
}

/** Just enough of a client for the scheduled jobs: its servers, plus a channel that records or rejects what's sent */
export function fakeClient(guilds: FakeGuild[], send: (guildId: string, message: Record<string, unknown>) => Promise<unknown>) {
  const byChannel = new Map(guilds.map((g) => [`channel-${g.id}`, g.id]));
  return {
    guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
    channels: {
      fetch: async (id: string) => ({ isSendable: () => true, send: (m: Record<string, unknown>) => send(byChannel.get(id)!, m) }),
    },
  } as never;
}
