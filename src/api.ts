import { type Client } from 'discord.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { seeWebUser } from './activity.ts';
import { config } from './config.ts';
import { isAllowed } from './settings.ts';
import type { Feature } from './types.ts';
import { servedGuilds } from './util.ts';
import { type Ask, Refused, asking, authorized, signedIn } from './api/common.ts';
import { soundRoutes } from './api/sounds.ts';
import { gameRoutes } from './api/games.ts';
import { nightRoutes } from './api/nights.ts';
import { musicRoutes } from './api/music.ts';
import { serverRoutes } from './api/server.ts';
import { followVoice, liveRoutes } from './api/live.ts';

/** Which area of the API answers each section of a path */
const AREAS = new Map<string, (ask: Ask) => Promise<unknown>>([
  ...['sounds', 'deleted-sounds', 'discord-sounds', 'discord-sync', 'sound-panels', 'join-sounds', 'playing', 'stop', 'say', 'phrases'].map((s) => [s, soundRoutes] as const),
  ...['games', 'pick', 'votes', 'compare', 'achievements', 'recap', 'members', 'game-pings', 'hidden-games', 'steam-links', 'steam-apps', 'steam-refresh', 'stats', 'free-games', 'sales', 'game-names', 'lobbies'].map((s) => [s, gameRoutes] as const),
  ...['game-nights', 'game-night-series'].map((s) => [s, nightRoutes] as const),
  ...['music'].map((s) => [s, musicRoutes] as const),
  ...['settings', 'me', 'activity'].map((s) => [s, serverRoutes] as const),
  ...['voice', 'updates'].map((s) => [s, liveRoutes] as const),
]);

async function handle(client: Client<true>, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://api');
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Refused(400, 'Bad path.');
  }
  const [root, guildId, section, ...rest] = segments;
  if (root !== 'guilds') throw new Refused(404, 'Not found.');
  if (guildId === undefined) {
    if (req.method !== 'GET') throw new Refused(405, 'Not here.');
    return { guilds: servedGuilds(client).map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) })) };
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild || !isAllowed(guild.id)) throw new Refused(404, 'The bot isn’t in that server.');

  const route = AREAS.get(section ?? '');
  if (!route) throw new Refused(404, 'Not found.');
  return route({ client, guild, req, res, url, section, rest });
}

/** The management API behind the web UI. Every sound and setting rule lives in the bot, so it's the only thing that applies them */
export function createApi(client: Client<true>, token: string): Server {
  return createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      // A refused upload may not have been read to the end, so the connection can't be reused
      res.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 && { connection: 'close' }) }).end(JSON.stringify(body));
    };
    if (!authorized(req, token)) return reply(401, { error: 'Unauthorized.' });
    const who = signedIn(req);
    if (who) seeWebUser(who.email, who.name);
    if (req.method !== 'GET') console.log(`Web UI: ${req.method} ${req.url}${who ? ` (${who.email})` : ''}`);
    asking.run(who, () => handle(client, req, res)).then(
      (body) => body && reply(200, body),
      (err: unknown) => {
        if (err instanceof Refused) return reply(err.status, { error: err.message });
        console.error(`Web UI: ${req.method} ${req.url} failed:`, err);
        if (res.headersSent) res.destroy();
        else reply(500, { error: 'Something broke. Check the bot logs.' });
      },
    );
  });
}

let server: Server | undefined;

export const webApi: Feature = {
  setup(client) {
    if (!config.apiToken) return;
    followVoice(client);
    server = createApi(client, config.apiToken).listen(config.apiPort, () => console.log(`Management API listening on port ${config.apiPort}`));
    server.on('error', (err) => console.error('Management API failed:', err.message));
  },
  shutdown() {
    server?.close();
    server?.closeAllConnections();
  },
};
