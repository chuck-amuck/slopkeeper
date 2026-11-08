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

test('passes a music file through as it arrives, past the usual limit, up to its own', async () => {
  const cookie = await login();
  const data = Buffer.from(Array.from({ length: 8 * 1024 * 1024 }, (_, i) => (i * 7) % 256));
  const res = await fetch(`${base}/api/guilds/1/music/file?name=a.mp3&channelId=2`, { method: 'POST', headers: { cookie, 'x-slopkeeper': '1', 'content-type': 'audio/mpeg' }, body: data });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/guilds/1/music/file?name=a.mp3&channelId=2');
  assert.equal(seen[0].headers['content-type'], 'audio/mpeg');
  assert.ok(seen[0].body.equals(data));

  const big = await fetch(`${base}/api/guilds/1/music/file`, { method: 'POST', headers: { cookie, 'x-slopkeeper': '1' }, body: Buffer.alloc(51 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'That file is over 50 MB.' });
  assert.equal(seen.length, 1, 'too big to say so up front is never sent on');
  const pieces = new ReadableStream({
    start(c) {
      for (let i = 0; i < 52; i++) c.enqueue(new Uint8Array(1024 * 1024));
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
