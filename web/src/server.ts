import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';

const SESSION_DAYS = 30;
const COOKIE = 'slopkeeper_session';
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
// A little over the largest sound, which is the largest thing the page sends
const MAX_BODY = 5 * 1024 * 1024 + 1024;
// A music file to play once is far larger, so it's passed on as it arrives rather than held here
const STREAMED = /^\/api\/guilds\/\d+\/music\/file$/;
const MAX_STREAMED = 60 * 1024 * 1024 + 1024;
const TOO_BIG = 'That file is over 60 MB.';
// Syncing a full soundboard to Discord takes a while
const BOT_TIMEOUT_MS = 5 * 60_000;

const CONTENT_TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const asset = (file: string, type: keyof typeof CONTENT_TYPES) => ({ body: readFileSync(new URL(`../public/${file}`, import.meta.url)), type: CONTENT_TYPES[type] });
const ASSETS: Record<string, ReturnType<typeof asset>> = {
  '/': asset('index.html', 'html'),
  ...Object.fromEntries(['achievements', 'activity', 'app', 'board', 'clip', 'emoji', 'emojipicker', 'games', 'lib', 'music', 'pick', 'library', 'nights', 'settings', 'stats', 'trim', 'voice'].map((name) => [`/${name}.js`, asset(`${name}.js`, 'js')])),
  '/style.css': asset('style.css', 'css'),
  '/icon.svg': asset('icon.svg', 'svg'),
};

const HEADERS = {
  // Server icons and custom emoji come from Discord's CDN, and album covers from Spotify's; nothing else is loaded from anywhere
  'content-security-policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com https://i.scdn.co https://i.ytimg.com https://i1.sndcdn.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export interface WebOptions {
  password: string;
  apiToken: string;
  botUrl: string;
  /** Pangolin sends this with every request, so its Remote-Email header can be told apart from one sent straight to the port */
  proxySecret?: string;
}

/** Who Pangolin signed in. Nothing at all for the home network, which skips Pangolin */
interface Identity {
  email: string;
  name: string;
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Sessions are signed rather than stored, so a restart keeps people logged in and a new password logs everyone out */
function sign(password: string, expires: number): string {
  return createHmac('sha256', password).update(`session:${expires}`).digest('base64url');
}

function cookieValue(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value;
  }
}

function loggedIn(req: IncomingMessage, password: string): boolean {
  const [expires, signature] = (cookieValue(req) ?? '').split('.');
  if (!expires || !signature || !(Number(expires) > Date.now())) return false;
  return same(Buffer.from(signature), Buffer.from(sign(password, Number(expires))));
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

export function createWeb({ password, apiToken, botUrl, proxySecret }: WebOptions): Server {
  const expected = Buffer.from(password);
  const secret = proxySecret ? Buffer.from(proxySecret) : undefined;
  // A lock per person signed in through Pangolin, and one shared by everyone who isn't
  const locks = new Map<string, { failures: number; lockedUntil: number }>();

  function identity(req: IncomingMessage): Identity | undefined {
    const given = header(req, 'x-slopkeeper-proxy-secret');
    if (!secret || !given || !same(Buffer.from(given), secret)) return undefined;
    const email = header(req, 'remote-email')?.trim().toLowerCase();
    if (!email || email.length > 254) return undefined;
    // Node reads header bytes as Latin-1, and Pangolin sends names as UTF-8
    const name = Buffer.from(header(req, 'remote-name') ?? '', 'latin1').toString('utf8').trim().slice(0, 100);
    return { email, name: name || email };
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    const key = identity(req)?.email ?? '';
    const lock = locks.get(key) ?? { failures: 0, lockedUntil: 0 };
    locks.set(key, lock);
    if (Date.now() < lock.lockedUntil) return json(res, 429, { error: 'Too many wrong passwords. Try again in a minute.' });
    let given = '';
    try {
      const body = await readBody(req);
      given = String((JSON.parse(body?.toString() ?? '{}') as { password?: unknown }).password ?? '');
    } catch {
      return json(res, 400, { error: 'Bad request.' });
    }
    if (!same(Buffer.from(given), expected)) {
      lock.failures += 1;
      if (lock.failures >= MAX_FAILURES) {
        lock.failures = 0;
        lock.lockedUntil = Date.now() + LOCK_MS;
      }
      return json(res, 401, { error: 'Wrong password.' });
    }
    lock.failures = 0;
    const maxAge = SESSION_DAYS * 86_400;
    const expires = Date.now() + maxAge * 1000;
    json(res, 200, {}, { 'set-cookie': `${COOKIE}=${expires}.${sign(password, expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` });
  }

  /** Passes a request to the bot with the token, which never reaches the browser, and who's asking if Pangolin said */
  async function proxy(req: IncomingMessage, res: ServerResponse) {
    const who = identity(req);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const streamed = req.method === 'POST' && STREAMED.test(req.url!.split('?')[0]);
    // The rest of it was never read, so the connection can't be reused
    if (streamed && Number(req.headers['content-length'] ?? 0) > MAX_STREAMED) return json(res, 413, { error: TOO_BIG }, { connection: 'close' });
    let over = false;
    let size = 0;
    const body = streamed
      ? Readable.toWeb(
          req.pipe(
            new Transform({
              transform(chunk: Buffer, _encoding, done) {
                size += chunk.length;
                over = size > MAX_STREAMED;
                done(over ? new Error(TOO_BIG) : null, chunk);
              },
            }),
          ),
        )
      : hasBody
        ? await readBody(req)
        : undefined;
    if (body === null) return json(res, 413, { error: 'File is over 5 MB.' }, { connection: 'close' });
    const type = req.headers['content-type'];
    let answer: Response;
    try {
      answer = await fetch(botUrl + req.url!.slice('/api'.length), {
        method: req.method,
        headers: {
          authorization: `Bearer ${apiToken}`,
          ...(type && { 'content-type': type }),
          ...(who && { 'x-slopkeeper-email': encodeURIComponent(who.email), 'x-slopkeeper-name': encodeURIComponent(who.name) }),
        },
        body: body as BodyInit | undefined,
        ...(streamed && { duplex: 'half' }),
        signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
      } as RequestInit);
    } catch (err) {
      if (over) return json(res, 413, { error: TOO_BIG }, { connection: 'close' });
      console.error('Bot request failed:', err instanceof Error ? err.message : err);
      return json(res, 502, { error: 'The bot isn’t answering. It may be restarting.' });
    }
    const headers: Record<string, string> = { ...HEADERS };
    for (const name of ['content-type', 'content-length', 'cache-control']) {
      const value = answer.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(answer.status, headers);
    if (answer.body) Readable.fromWeb(answer.body as never).pipe(res);
    else res.end();
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = req.url!.split('?')[0];

    if (req.method === 'GET' && Object.hasOwn(ASSETS, path)) {
      const { body, type } = ASSETS[path];
      return res.writeHead(200, { ...HEADERS, 'content-type': type }).end(body);
    }

    const isApi = path.startsWith('/api/');
    const isAuth = path === '/auth/login' || path === '/auth/logout';
    if (!isApi && !isAuth) return json(res, 404, { error: 'Not found.' });

    // Other sites can't set this header without the browser asking first, and nothing here says yes
    if (req.method !== 'GET' && req.headers['x-slopkeeper'] !== '1') return json(res, 403, { error: 'Forbidden.' });

    if (isAuth) {
      if (req.method !== 'POST') return json(res, 405, { error: 'Not here.' });
      if (path === '/auth/login') return login(req, res);
      return json(res, 200, {}, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (!loggedIn(req, password)) return json(res, 401, { error: 'Log in first.' });
    return proxy(req, res);
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error(`${req.method} ${req.url} failed:`, err);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'Something broke. Check the web UI’s logs.' });
    });
  });
}
