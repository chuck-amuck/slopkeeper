// The music container: finds songs on YouTube or SoundCloud with yt-dlp and downloads their audio, for the bot to play from the
// shared volume, and lists songs like one for Autoplay. The bot asks over HTTP, with MUSIC_TOKEN
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createFetcher } from './youtube.mjs';

// What Spotify Soloist left in the volume before Spotify playback was removed. Downloaded songs, in audio/, stay
export const LEFTOVERS = ['bin', 'soloist', 'cache', 'run'];

export function createBridge(options = {}) {
  const env = process.env;
  const o = {
    dataDir: env.DATA_DIR || '/data',
    port: Number(env.PORT || 7700),
    token: env.MUSIC_TOKEN || '',
    cacheBytes: Number(env.MUSIC_CACHE_MB || 1024) * 1024 * 1024,
    // yt-dlp lives in its own Python environment, which the node user can update
    fetchCommand: ['/opt/ytdlp/bin/python', path.join(import.meta.dirname, 'fetch.py')],
    versionCommand: ['/opt/ytdlp/bin/python', '-c', 'import yt_dlp; print(yt_dlp.version.__version__)'],
    updateCommand: ['/opt/ytdlp/bin/pip', 'install', '--quiet', '--upgrade', 'yt-dlp[default,deno]'],
    log: (...args) => console.log(...args),
    ...options,
  };

  const youtube = createFetcher({ ...o, audioDir: o.audioDir ?? path.join(o.dataDir, 'audio') });
  const status = { youtube: youtube.state };
  const sse = new Set();
  let pingTimer;

  youtube.onChange((state) => {
    status.youtube = { ...state };
    const line = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
    for (const res of sse) res.write(line);
  });

  const authorized = (req) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${o.token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const route = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
    if (route === 'GET /status') return json(res, 200, status);
    if (route === 'GET /events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      sse.add(res);
      req.once('close', () => sse.delete(res));
      return;
    }
    if (route !== 'POST /fetch' && route !== 'POST /lookup' && route !== 'POST /similar') return json(res, 404, { error: 'not found' });
    let body;
    try {
      let raw = '';
      for await (const chunk of req) if ((raw += chunk).length > 10_000) throw new Error('too long');
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'bad JSON' });
    }
    const song = typeof body?.uri === 'string' && typeof body.title === 'string' && typeof body.artist === 'string' && Number.isFinite(body.durationMs);
    const link = typeof body?.url === 'string' && /^https:\/\//.test(body.url);
    if (route === 'POST /fetch' ? !song && !link : !link) return json(res, 400, { error: 'say which song or link' });
    if (!youtube.state.ready) return json(res, 503, { error: youtube.state.message || 'yt-dlp isn’t ready' });
    try {
      const answer =
        route === 'POST /lookup'
          ? await youtube.lookup(body.url)
          : route === 'POST /similar'
            ? await youtube.similar(body.url)
            : await youtube.fetchAudio(link ? { url: body.url } : { uri: body.uri, title: body.title, artist: body.artist, durationMs: body.durationMs });
      if (answer.error) return json(res, answer.missing ? 404 : 502, { error: answer.error });
      return json(res, 200, answer);
    } catch (err) {
      o.log('yt-dlp failed:', err.message);
      return json(res, 502, { error: err.message });
    }
  });

  return {
    status,
    server,
    async start() {
      if (!o.token) throw new Error('MUSIC_TOKEN is required');
      for (const dir of LEFTOVERS) fs.rmSync(path.join(o.dataDir, dir), { recursive: true, force: true });
      await new Promise((resolve) => server.listen(o.port, resolve));
      // Fetch gives up on a response that's quiet for five minutes, and nothing happens while music is stopped
      pingTimer = setInterval(() => {
        for (const res of sse) res.write(': ping\n\n');
      }, 15_000);
      pingTimer.unref?.();
      await youtube.start();
    },
    async stop() {
      clearInterval(pingTimer);
      youtube.stop();
      for (const res of sse) res.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.main) {
  const bridge = createBridge();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void bridge.stop().then(() => process.exit(0)));
  bridge.start().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
