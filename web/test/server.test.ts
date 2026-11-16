import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createWeb } from '../src/server.ts';

const PASSWORD = 'correct horse';
const TOKEN = 'bot-token';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let seen: Seen[] = [];
const BIG = JSON.stringify({ sounds: Array.from({ length: 400 }, (_, i) => ({ name: `sound ${i}`, volume: 1, plays: i })) });
/** Settles once the web UI lets go of a request the bot is holding, like one waiting for what's playing to change */
let held: Promise<void> | null = null;
const bot = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/guilds/1/held') {
      held = new Promise((resolve) => res.once('close', () => resolve()));
      return;
    }
    if (req.url === '/guilds/1/refused') return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"No."}');
    if (req.url === '/guilds/1/big') return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(BIG);
    if (req.url === '/guilds/1/audio') return res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-private': 'leak' }).end('RIFF');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 11 }).end('{"ok":true}');
  });
});

let web: ReturnType<typeof createWeb>;
let base: string;

const listen = (server: typeof bot) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

before(async () => {
  const botPort = await listen(bot);
  web = createWeb({ password: PASSWORD, apiToken: TOKEN, botUrl: `http://127.0.0.1:${botPort}` });
  base = `http://127.0.0.1:${await listen(web)}`;
});

after(() => {
  for (const server of [bot, web]) {
    server.close();
    server.closeAllConnections();
  }
});

beforeEach(() => {
  seen = [];
});

const write = { 'x-slopkeeper': '1', 'content-type': 'application/json' };
const attemptLogin = (password: string) => fetch(`${base}/auth/login`, { method: 'POST', headers: write, body: JSON.stringify({ password }) });

async function login(): Promise<string> {
  const res = await attemptLogin(PASSWORD);
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  return cookie.split(';')[0];
}

test('serves the page to anyone, with a strict policy', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/html/);
  assert.match(res.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
});

test('serves every file the page needs', async () => {
  const files = readdirSync(new URL('../public/', import.meta.url)).filter((name) => name !== 'index.html');
  assert.ok(files.includes('app.js'));
  for (const name of files) assert.equal((await fetch(`${base}/${name}`)).status, 200, name);
});

test('pages are sent compressed, asked about on every load, and only sent again once they change', async () => {
  const first = await fetch(`${base}/style.css`, { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(first.headers.get('content-encoding'), 'br');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  assert.match(first.headers.get('vary') ?? '', /accept-encoding/);
  const css = await first.text();
  assert.match(css, /\{/);
  const etag = first.headers.get('etag')!;
  const again = await fetch(`${base}/style.css`, { headers: { 'accept-encoding': 'br, gzip', 'if-none-match': etag } });
  assert.equal(again.status, 304);
  // Another encoding is another body, so the tag for this one doesn't match it
  const other = await fetch(`${base}/style.css`, { headers: { 'accept-encoding': 'identity', 'if-none-match': etag } });
  assert.equal(other.status, 200);
  assert.equal(await other.text(), css);
  assert.equal(await again.text(), '');
  const gzip = await fetch(`${base}/style.css`, { headers: { 'accept-encoding': 'gzip, br;q=0' } });
  assert.equal(gzip.headers.get('content-encoding'), 'gzip');
  assert.equal(await gzip.text(), css);
  const plain = await fetch(`${base}/style.css`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(await plain.text(), css);
});

test('the page carries its version, which every answer repeats so an open tab can tell it is out of date', async () => {
  const page = await (await fetch(`${base}/`)).text();
  const version = page.match(/<meta name="slopkeeper-version" content="([\w-]+)"/)?.[1];
  assert.ok(version);
  // The scripts app.js loads straight away are fetched together; the emoji list waits for a picker
  assert.match(page, /<link rel="modulepreload" href="\/lib\.js\?v=[\w-]+"/);
  assert.doesNotMatch(page, /emoji\.js/);
  for (const path of ['/app.js', '/api/guilds', '/nowhere']) assert.equal((await fetch(base + path)).headers.get('x-slopkeeper-version'), version, path);
});

test('scripts and the stylesheet have addresses with their version, which browsers keep for good', async () => {
  const page = await (await fetch(`${base}/`)).text();
  const app = page.match(/src="(\/app\.js\?v=[\w-]+)"/)?.[1];
  const css = page.match(/href="(\/style\.css\?v=[\w-]+)"/)?.[1];
  assert.ok(app && css);
  for (const path of [app, css]) assert.equal((await fetch(base + path)).headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
  // The page itself, an old version and no version are asked about every time
  for (const path of ['/', '/app.js', '/app.js?v=old', '/style.css?v=old', '/icon.svg']) assert.equal((await fetch(base + path)).headers.get('cache-control'), 'no-cache', path);
  // Every script it loads is named with the same versions the page preloads, so the browser uses what it fetched
  const script = await (await fetch(base + app)).text();
  const lib = script.match(/'\.\/lib\.js\?v=([\w-]+)'/)?.[1];
  assert.ok(lib);
  assert.match(page, new RegExp(`href="/lib\\.js\\?v=${lib}"`));
  assert.doesNotMatch(script, /['"]\.\/[\w-]+\.js['"]/, 'no script named without its version');
  // Loaded only when needed, and versioned all the same
  const picker = await (await fetch(`${base}/emojipicker.js`)).text();
  assert.match(picker, /import\('\.\/emoji\.js\?v=[\w-]+'\)/);
});

test('scripts name each other one way, so each loads once, and those loaded on a click import nothing', () => {
  const folder = new URL('../public/', import.meta.url);
  const scripts = readdirSync(folder).filter((name) => name.endsWith('.js') && !name.startsWith('vendor-'));
  const later = new Set<string>();
  for (const name of scripts) {
    const text = readFileSync(new URL(name, folder), 'utf8');
    // Only './name.js' in quotes is versioned; any other way of naming a script would load a second copy of it
    assert.doesNotMatch(text, /\bimport\s*\(\s*[^'"\s]/, `${name}: import() with a computed name`);
    assert.doesNotMatch(text, /^(?:import|export)\b[^'"]*\bfrom\s*['"](?!\.\/)/m, `${name}: an import not starting ./`);
    for (const [, loaded] of text.matchAll(/\bimport\s*\(\s*['"]\.\/([\w-]+\.js)['"]/g)) later.add(loaded);
  }
  assert.ok(later.size);
  for (const name of later) assert.doesNotMatch(readFileSync(new URL(name, folder), 'utf8'), /['"]\.\/[\w-]+\.js['"]/, `${name} is loaded on a click, so it can't import another script`);
});

test('large JSON from the bot is compressed on its way through; small answers and audio aren’t', async () => {
  const cookie = await login();
  const big = await fetch(`${base}/api/guilds/1/big`, { headers: { cookie, 'accept-encoding': 'br, gzip' } });
  assert.equal(big.headers.get('content-encoding'), 'br');
  assert.match(big.headers.get('vary') ?? '', /accept-encoding/);
  assert.equal(big.headers.get('content-length'), null);
  assert.match(big.headers.get('server-timing') ?? '', /bot;dur=/);
  assert.equal(await big.text(), BIG);
  const gzip = await fetch(`${base}/api/guilds/1/big`, { headers: { cookie, 'accept-encoding': 'gzip' } });
  assert.equal(gzip.headers.get('content-encoding'), 'gzip');
  assert.equal(await gzip.text(), BIG);
  const plain = await fetch(`${base}/api/guilds/1/big`, { headers: { cookie, 'accept-encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(await plain.text(), BIG);
  assert.match(plain.headers.get('vary') ?? '', /accept-encoding/, 'it could have been compressed');
  for (const path of ['/api/guilds/1/ok', '/api/guilds/1/audio']) {
    const res = await fetch(base + path, { headers: { cookie, 'accept-encoding': 'br, gzip' } });
    assert.equal(res.headers.get('content-encoding'), null, path);
    await res.arrayBuffer();
  }
});

test('only serves its own assets', async () => {
  for (const path of ['/server.ts', '/../package.json', '/%2e%2e/package.json', '/constructor', '/__proto__']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('nothing reaches the bot without logging in', async () => {
  assert.equal((await fetch(`${base}/api/guilds`)).status, 401);
  assert.equal((await fetch(`${base}/api/guilds`, { method: 'DELETE', headers: write })).status, 401);
  assert.equal(seen.length, 0);
});

test('forged, tampered and expired sessions are refused', async () => {
  const good = (await login()).split('=')[1];
  const [expires, signature] = good.split('.');
  const past = String(Date.now() - 1000);
  for (const value of ['', 'x', '.', `${expires}.`, `.${signature}`, `${Number(expires) + 1}.${signature}`, `${expires}.${'A'.repeat(signature.length)}`, `${past}.${signature}`, 'Infinity.x', '9e99.x']) {
    const res = await fetch(`${base}/api/guilds`, { headers: { cookie: `slopkeeper_session=${value}` } });
    assert.equal(res.status, 401, value);
  }
  assert.equal(seen.length, 0);
});

test('a session stops working when it expires', async () => {
  const cookie = await login();
  assert.equal((await fetch(`${base}/api/guilds`, { headers: { cookie } })).status, 200);
  const later = Date.now() + 31 * 86_400_000;
  const clock = mock.method(Date, 'now', () => later);
  assert.equal((await fetch(`${base}/api/guilds`, { headers: { cookie } })).status, 401);
  clock.mock.restore();
});

test('a session signed with another password is refused', async () => {
  const other = createWeb({ password: 'something else', apiToken: TOKEN, botUrl: 'http://127.0.0.1:1' });
  const port = await listen(other);
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', headers: write, body: '{"password":"something else"}' });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  other.close();
  other.closeAllConnections();
  assert.equal((await fetch(`${base}/api/guilds`, { headers: { cookie } })).status, 401);
});

test('passes requests to the bot with the token, not the browser’s cookie', async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/guilds?x=1`, { headers: { cookie, authorization: 'Bearer browser' } });
  assert.deepEqual(await res.json(), { ok: true });
  const [request] = seen;
  assert.equal(request.url, '/guilds?x=1');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers.cookie, undefined);
});

test('the token never reaches the browser', async () => {
  for (const file of ['/', '/app.js']) assert.doesNotMatch(await (await fetch(base + file)).text(), new RegExp(TOKEN));
  const res = await fetch(`${base}/api/guilds/1/audio`, { headers: { cookie: await login() } });
  assert.doesNotMatch(JSON.stringify([...res.headers]), new RegExp(TOKEN));
});

test('passes uploads through intact', async () => {
  const cookie = await login();
  const data = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
  await fetch(`${base}/api/guilds/1/sounds/x?file=a.wav`, { method: 'PUT', headers: { cookie, 'x-slopkeeper': '1' }, body: data });
  assert.equal(seen[0].method, 'PUT');
  assert.deepEqual(seen[0].body, data);
});

test('passes a music file through as it arrives, past the usual limit, up to its own', async () => {
  const cookie = await login();
  const data = Buffer.from(Array.from({ length: 8 * 1024 * 1024 }, (_, i) => (i * 7) % 256));
  const res = await fetch(`${base}/api/guilds/1/music/file?name=a.mp3&channelId=2`, { method: 'POST', headers: { cookie, 'x-slopkeeper': '1', 'content-type': 'audio/mpeg' }, body: data });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/guilds/1/music/file?name=a.mp3&channelId=2');
  assert.equal(seen[0].headers['content-type'], 'audio/mpeg');
  assert.ok(seen[0].body.equals(data));

  const big = await fetch(`${base}/api/guilds/1/music/file`, { method: 'POST', headers: { cookie, 'x-slopkeeper': '1' }, body: Buffer.alloc(61 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'That file is over 60 MB.' });
  assert.equal(seen.length, 1, 'too big to say so up front is never sent on');
  const pieces = new ReadableStream({
    start(c) {
      for (let i = 0; i < 62; i++) c.enqueue(new Uint8Array(1024 * 1024));
      c.close();
    },
  });
  const chunked = await fetch(`${base}/api/guilds/1/music/file`, { method: 'POST', headers: { cookie, 'x-slopkeeper': '1' }, body: pieces, duplex: 'half' } as RequestInit);
  assert.equal(chunked.status, 413, 'sent with no length up front, it’s cut off once it’s too big');
  // Only that address gets the larger limit
  const elsewhere = await fetch(`${base}/api/guilds/1/music/queue`, { method: 'POST', headers: { cookie, 'x-slopkeeper': '1' }, body: Buffer.alloc(6 * 1024 * 1024) });
  assert.equal(elsewhere.status, 413);
});

test('passes audio back with its type, and nothing else from the bot', async () => {
  const res = await fetch(`${base}/api/guilds/1/audio`, { headers: { cookie: await login() } });
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-private'), null);
  assert.equal(await res.text(), 'RIFF');
});

test('stops waiting on the bot once the page has gone', async () => {
  const cookie = await login();
  const leave = new AbortController();
  const asking = fetch(`${base}/api/guilds/1/held`, { headers: { cookie }, signal: leave.signal }).catch(() => 'left');
  while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
  leave.abort();
  assert.equal(await asking, 'left');
  const gaveUp = new Promise<boolean>((resolve) => setTimeout(resolve, 2000, false).unref());
  assert.equal(await Promise.race([held.then(() => true), gaveUp]), true);
});

test('passes the bot’s refusals on', async () => {
  const res = await fetch(`${base}/api/guilds/1/refused`, { headers: { cookie: await login() } });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'No.' });
});

test('refuses an oversized upload without passing it on', async () => {
  const res = await fetch(`${base}/api/guilds/1/sounds/x`, {
    method: 'PUT',
    headers: { cookie: await login(), 'x-slopkeeper': '1' },
    body: Buffer.alloc(6 * 1024 * 1024),
  });
  assert.equal(res.status, 413);
  // The rest was never read, so reusing the connection would leave it stuck
  assert.equal(res.headers.get('connection'), 'close');
  assert.equal(seen.length, 0);
});

test('changes need the header a cross-site page can’t send', async () => {
  const cookie = await login();
  const res = await fetch(`${base}/api/guilds/1/sounds/x`, { method: 'DELETE', headers: { cookie } });
  assert.equal(res.status, 403);
  assert.equal(seen.length, 0);
  assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })).status, 403);
});

test('logging out clears the cookie', async () => {
  const res = await fetch(`${base}/auth/logout`, { method: 'POST', headers: write });
  assert.match(res.headers.get('set-cookie')!, /Max-Age=0/);
});

test('says when the bot is down', async () => {
  const errors = mock.method(console, 'error', () => {});
  const down = createWeb({ password: PASSWORD, apiToken: TOKEN, botUrl: 'http://127.0.0.1:1' });
  const port = await listen(down);
  const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', headers: write, body: JSON.stringify({ password: PASSWORD }) });
  const res = await fetch(`http://127.0.0.1:${port}/api/guilds`, { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } });
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /isn’t answering/);
  down.close();
  down.closeAllConnections();
  errors.mock.restore();
});

test('turns down a malformed login', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: write, body: 'not json' });
  assert.equal(res.status, 400);
});

// Leaves the lock in place, so anything logging in has to come first
test('only the bot’s server routes are passed on, not its report or metrics', async () => {
  const cookie = await login();
  const before = seen.length;
  for (const [method, path] of [['POST', '/api/perf/web'], ['GET', '/api/metrics'], ['GET', '/api/guildsx']]) {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, ...write }, ...(method === 'POST' && { body: '{"memoryBytes":1,"cpuSeconds":1}' }) });
    assert.equal(res.status, 404, path);
  }
  assert.equal(seen.length, before, 'the bot never heard of them');
});

test('a path that climbs out of the server routes is refused, however it’s written', async () => {
  const cookie = await login();
  const before = seen.length;
  const port = new URL(base).port;
  // Sent as written: fetch would tidy the path up before sending it
  const raw = (method: string, path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { cookie, ...write, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.once('error', reject);
      req.end(method === 'POST' ? '{"memoryBytes":1,"cpuSeconds":1}' : undefined);
    });
  for (const path of ['/api/guilds/../metrics', '/api/guilds/%2e%2e/perf/web', '/api/guilds/%2E./metrics', '/api/guilds/..%5cmetrics', '/api/guilds/..\\metrics', '/api/guilds/x/./../../metrics']) {
    assert.equal(await raw(path.includes('perf') ? 'POST' : 'GET', path), 404, path);
  }
  assert.equal(seen.length, before, 'the bot never heard of them');
  assert.equal(await raw('GET', '/api/guilds/1/sounds/a..b'), 200, 'dots inside a name are fine');
});

test('says how long the bot took, so the page can tell it from the network', async () => {
  const res = await fetch(`${base}/api/guilds/1/x`, { headers: { cookie: await login() } });
  assert.match(res.headers.get('server-timing') ?? '', /^bot;dur=\d+\.\d$/);
});

test('a browser’s timings need a login and the header, and stay small', async () => {
  const cookie = await login();
  const before = seen.length;
  assert.equal((await fetch(`${base}/api/perf`, { method: 'POST', headers: write, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/perf`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/perf`, { headers: { cookie } })).status, 405);
  assert.equal((await fetch(`${base}/api/perf`, { method: 'POST', headers: { cookie, ...write }, body: 'not json' })).status, 400);
  assert.equal((await fetch(`${base}/api/perf`, { method: 'POST', headers: { cookie, ...write }, body: JSON.stringify({ requests: 'x'.repeat(70_000) }) })).status, 413);
  assert.equal(seen.length, before, 'none of them reached the bot');
});

test('passes a browser’s timings on with where it was, and nothing about who', async () => {
  const report = { device: 'phone', requests: [['action', 0.4, 0.1]], page: { firstByte: 0.2, shown: 1.1 }, responses: [0.05], quickResponses: 3, email: 'friend@example.com', extra: 'x' };
  const home = await fetch(`${base}/api/perf`, { method: 'POST', headers: { cookie: await login(), ...write }, body: JSON.stringify(report) });
  assert.equal(home.status, 200);
  const sent = seen.at(-1)!;
  assert.deepEqual([sent.method, sent.url, sent.headers.authorization], ['POST', '/perf/browser', `Bearer ${TOKEN}`]);
  assert.deepEqual(JSON.parse(sent.body.toString()), { via: 'home', device: 'phone', requests: [['action', 0.4, 0.1]], page: { firstByte: 0.2, shown: 1.1 }, responses: [0.05], quickResponses: 3 });
  await withSecret(async (url, cookie) => {
    await fetch(`${url}/api/perf`, { method: 'POST', headers: { cookie: await cookie(), ...write, ...sso('friend@example.com', 'Friend') }, body: JSON.stringify({ ...report, via: 'home' }) });
    const away = seen.at(-1)!;
    assert.equal(JSON.parse(away.body.toString()).via, 'away', 'through Pangolin, whatever the page says');
    assert.equal(away.headers['x-slopkeeper-email'], undefined);
  });
});

test('locks login for a minute after five wrong passwords', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await attemptLogin('wrong')).status, 401);
  assert.equal((await attemptLogin(PASSWORD)).status, 429);
  await assert.rejects(login);

  const now = Date.now();
  const clock = mock.method(Date, 'now', () => now + 61_000);
  assert.equal((await attemptLogin(PASSWORD)).status, 200);
  clock.mock.restore();
});

test('a right password clears the count of wrong ones', async () => {
  const web2 = createWeb({ password: PASSWORD, apiToken: TOKEN, botUrl: 'http://127.0.0.1:1' });
  const url = `http://127.0.0.1:${await listen(web2)}/auth/login`;
  const post = (password: string) => fetch(url, { method: 'POST', headers: write, body: JSON.stringify({ password }) });
  for (let i = 0; i < 4; i++) await post('wrong');
  assert.equal((await post(PASSWORD)).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await post('wrong')).status, 401);
  assert.equal((await post(PASSWORD)).status, 200);
  web2.close();
  web2.closeAllConnections();
});

const SECRET = 'pangolin-secret';
const sso = (email: string, name?: string) => ({ 'x-slopkeeper-proxy-secret': SECRET, 'remote-email': email, ...(name && { 'remote-name': name }) });

/** A web UI of its own, so its login lock starts clear, that knows Pangolin's secret unless told otherwise */
async function withSecret(run: (url: string, cookie: (headers?: Record<string, string>) => Promise<string>) => Promise<void>, proxySecret: string | null = SECRET) {
  const signed = createWeb({ password: PASSWORD, apiToken: TOKEN, botUrl: `http://127.0.0.1:${(bot.address() as AddressInfo).port}`, proxySecret: proxySecret ?? undefined });
  const url = `http://127.0.0.1:${await listen(signed)}`;
  const cookie = async (headers = {}) => {
    const res = await fetch(`${url}/auth/login`, { method: 'POST', headers: { ...write, ...headers }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie')!.split(';')[0];
  };
  try {
    await run(url, cookie);
  } finally {
    signed.close();
    signed.closeAllConnections();
  }
}

test('tells the bot who Pangolin signed in', async () => {
  await withSecret(async (url, cookie) => {
    await fetch(`${url}/api/guilds`, { headers: { cookie: await cookie(), ...sso('Chuck@Example.com', 'Chuck') } });
    assert.equal(seen[0].headers['x-slopkeeper-email'], 'chuck%40example.com');
    assert.equal(seen[0].headers['x-slopkeeper-name'], 'Chuck');
  });
});

test('a name outside ASCII reaches the bot intact', async () => {
  await withSecret(async (url, cookie) => {
    // As Pangolin sends it: UTF-8 bytes, which Node reads as Latin-1
    const name = Buffer.from('José Ñandú', 'utf8').toString('latin1');
    await fetch(`${url}/api/guilds`, { headers: { cookie: await cookie(), ...sso('jose@example.com', name) } });
    assert.equal(decodeURIComponent(seen[0].headers['x-slopkeeper-name'] as string), 'José Ñandú');
  });
});

test('without a name, the email stands in', async () => {
  await withSecret(async (url, cookie) => {
    await fetch(`${url}/api/guilds`, { headers: { cookie: await cookie(), ...sso('pat@example.com') } });
    assert.equal(seen[0].headers['x-slopkeeper-name'], 'pat%40example.com');
  });
});

test('Remote-Email without Pangolin’s secret names nobody', async () => {
  await withSecret(async (url, cookie) => {
    const c = await cookie();
    const forged: Record<string, string>[] = [{ 'remote-email': 'chuck@example.com' }, { ...sso('chuck@example.com'), 'x-slopkeeper-proxy-secret': 'guess' }, { 'x-slopkeeper-email': 'chuck%40example.com' }];
    for (const headers of forged) {
      await fetch(`${url}/api/guilds`, { headers: { cookie: c, ...headers } });
    }
  });
  assert.equal(seen.length, 3);
  for (const request of seen) assert.equal(request.headers['x-slopkeeper-email'], undefined);
});

test('without a secret set up, nobody is named', async () => {
  await withSecret(async (url, cookie) => {
    await fetch(`${url}/api/guilds`, { headers: { cookie: await cookie(), ...sso('chuck@example.com', 'Chuck') } });
  }, null);
  assert.equal(seen[0].headers['x-slopkeeper-email'], undefined);
});

test('wrong passwords lock out only the person typing them', async () => {
  await withSecret(async (url, cookie) => {
    const post = (headers: Record<string, string>, password: string) =>
      fetch(`${url}/auth/login`, { method: 'POST', headers: { ...write, ...headers }, body: JSON.stringify({ password }) });
    for (let i = 0; i < 5; i++) assert.equal((await post(sso('pat@example.com'), 'wrong')).status, 401);
    assert.equal((await post(sso('pat@example.com'), PASSWORD)).status, 429);
    await cookie(sso('chuck@example.com'));
    await cookie();
    // Without the secret, the email can't pick which lock to use
    for (let i = 0; i < 5; i++) assert.equal((await post({ 'remote-email': 'chuck@example.com' }, 'wrong')).status, 401);
    assert.equal((await post({}, PASSWORD)).status, 429);
    await cookie(sso('chuck@example.com'));
  });
});
