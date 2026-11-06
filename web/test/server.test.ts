import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
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
const bot = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/refused') return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"No."}');
    if (req.url === '/audio') return res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-private': 'leak' }).end('RIFF');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
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
  const res = await fetch(`${base}/api/audio`, { headers: { cookie: await login() } });
  assert.doesNotMatch(JSON.stringify([...res.headers]), new RegExp(TOKEN));
});

test('passes uploads through intact', async () => {
  const cookie = await login();
  const data = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
  await fetch(`${base}/api/guilds/1/sounds/x?file=a.wav`, { method: 'PUT', headers: { cookie, 'x-slopkeeper': '1' }, body: data });
  assert.equal(seen[0].method, 'PUT');
  assert.deepEqual(seen[0].body, data);
});

test('passes audio back with its type, and nothing else from the bot', async () => {
  const res = await fetch(`${base}/api/audio`, { headers: { cookie: await login() } });
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-private'), null);
  assert.equal(await res.text(), 'RIFF');
});

test('passes the bot’s refusals on', async () => {
  const res = await fetch(`${base}/api/refused`, { headers: { cookie: await login() } });
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
