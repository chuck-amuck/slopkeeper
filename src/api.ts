import { type Client } from 'discord.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { seeWebUser } from './activity.ts';
import { config } from './config.ts';
import { webReport } from './features/health.ts';
import * as perf from './perf.ts';
import { isAllowed } from './settings.ts';
import type { Feature } from './types.ts';
import { servedGuilds } from './util.ts';
import { type Ask, Refused, asking, authorized, readJson, signedIn } from './api/common.ts';
import { soundRoutes } from './api/sounds.ts';
import { gameRoutes } from './api/games.ts';
import { nightRoutes } from './api/nights.ts';
import { musicRoutes } from './api/music.ts';
import { serverRoutes } from './api/server.ts';
import { followVoice, liveRoutes } from './api/live.ts';

/** Which area of the API answers each section of a path */
const AREAS = new Map<string, (ask: Ask) => Promise<unknown>>([
  ...['sounds', 'sound-groups', 'deleted-sounds', 'discord-sounds', 'discord-sync', 'sound-panels', 'join-sounds', 'playing', 'stop', 'say', 'phrases'].map((s) => [s, soundRoutes] as const),
  ...['games', 'pick', 'votes', 'compare', 'achievements', 'recap', 'members', 'game-pings', 'hidden-games', 'steam-links', 'steam-apps', 'steam-refresh', 'stats', 'free-games', 'sales', 'game-names', 'lobbies'].map((s) => [s, gameRoutes] as const),
  ...['game-nights', 'game-night-series'].map((s) => [s, nightRoutes] as const),
  ...['music'].map((s) => [s, musicRoutes] as const),
  ...['settings', 'me', 'activity'].map((s) => [s, serverRoutes] as const),
  ...['voice', 'volumes', 'updates'].map((s) => [s, liveRoutes] as const),
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
  // For Prometheus or anything like it, with the same token
  if (root === 'metrics' && segments.length === 1) {
    if (req.method !== 'GET') throw new Refused(405, 'Not here.');
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(perf.prometheus());
    return;
  }
  // The web UI's report of itself, every 30 seconds
  if (root === 'perf' && guildId === 'web' && segments.length === 2) {
    if (req.method !== 'POST') throw new Refused(405, 'Not here.');
    if (!webReport(await readJson(req))) throw new Refused(400, 'That isn’t a report.');
    return { ok: true };
  }
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

/** A GET answer that takes this long is kept for a look */
const SLOW_ANSWER_S = 2;

/** Counts an answer, and times it unless it waited for a change on purpose */
function answered(req: IncomingMessage, status: number, seconds: number) {
  const [root, guildId, section] = new URL(req.url ?? '/', 'http://api').pathname.split('/').filter(Boolean);
  // Only names the API has, so a stray path doesn't start a series of its own
  const area = root === 'guilds' ? (section === undefined ? 'guilds' : AREAS.has(section) ? section : 'other') : root === 'metrics' || root === 'perf' ? root : 'other';
  perf.count('api_requests_total', { area, status: `${Math.floor(status / 100)}xx` });
  if (section === 'updates' || (section === 'playing' && /[?&]after=/.test(req.url ?? ''))) return;
  perf.time('api_request_seconds', seconds, { area });
  if (seconds >= SLOW_ANSWER_S && req.method === 'GET' && status < 400) perf.slow({ guildId: guildId ?? null, what: `Web UI: ${area}`, seconds, steps: [], detail: {} });
}

/** The management API behind the web UI. Every sound and setting rule lives in the bot, so it's the only thing that applies them */
export function createApi(client: Client<true>, token: string): Server {
  return createServer((req, res) => {
    const started = performance.now();
    res.once('finish', () => answered(req, res.statusCode, (performance.now() - started) / 1000));
    const reply = (status: number, body: unknown) => {
      // A refused upload may not have been read to the end, so the connection can't be reused
      res.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 && { connection: 'close' }) }).end(JSON.stringify(body));
    };
    if (!authorized(req, token)) return reply(401, { error: 'Unauthorized.' });
    const who = signedIn(req);
    if (who) seeWebUser(who.email, who.name);
    // The web UI's own report comes every 30 seconds and would bury what people did
    if (req.method !== 'GET' && !req.url?.startsWith('/perf/')) console.log(`Web UI: ${req.method} ${req.url}${who ? ` (${who.email})` : ''}`);
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
