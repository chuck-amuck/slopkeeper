// Every page of the web UI in a real browser, against the real management API with the API tests' fake server: no
// script errors, no failed requests, nothing blank or showing an error, and nothing that scrolls sideways on a phone.
// It needs Chrome or Chromium (CHROME names one). In CI one is required; elsewhere, without one, it's skipped
import { base, GUILD, TOKEN } from './apiFixture.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../src/config.ts';
import { db, setKv } from '../src/db.ts';
import { createWeb } from '../web/src/server.ts';

const PASSWORD = 'browser-test';
const PAGES = [
  ['board', 'Soundboard'],
  ['board', 'Soundboard: Manage', { soundboardView: 'manage' }],
  ['music', 'Music'],
  ['games', 'Games'],
  ['nights', 'Game nights'],
  ['pick', 'Pick a game'],
  ['deals', 'Deals'],
  ['stats/overview', 'Stats: Overview'],
  ['stats/compare', 'Stats: Compare'],
  ['stats/sounds', 'Stats: Sounds & music'],
  ['stats/recap', 'Stats: Monthly recap'],
  ['stats/health', 'Stats: Health'],
  ['activity', 'Activity'],
  ['settings', 'Settings'],
] as const;
const SCREENS = [
  { name: 'computer', width: 1280, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
];

function findBrowser(): string | null {
  for (const name of [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean) as string[]) {
    try {
      return execFileSync('sh', ['-c', `command -v "${name}"`], { encoding: 'utf8' }).trim() || null;
    } catch {}
  }
  return null;
}
const browserPath = findBrowser();
if (!browserPath && process.env.CI) throw new Error('The web UI test needs Chrome in CI, and none was found');

/** Just enough of Chrome's DevTools protocol: commands, and events as they come */
class Page {
  private next = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: ((method: string, params: any) => void)[] = [];
  private socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.reject(new Error(`${msg.error.message}`));
        else w?.resolve(msg.result);
      } else for (const listen of this.listeners) listen(msg.method, msg.params);
    });
  }
  static async open(url: string) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Page(socket);
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
  on(listen: (method: string, params: any) => void) {
    this.listeners.push(listen);
  }
  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  }
  close() {
    this.socket.close();
  }
}

let chrome: ChildProcess | undefined;
let chromeSaid = '';
let profile: string | undefined;
let web: ReturnType<typeof createWeb> | undefined;

after(async () => {
  web?.close();
  web?.closeAllConnections();
  if (chrome && chrome.exitCode === null) {
    // Chrome writes to its profile as it exits, so the folder goes once it's gone
    const exited = new Promise((resolve) => chrome!.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

/** Somewhere for each view to have something to show */
function seed() {
  const HOUR = 3_600_000;
  const now = Date.now();
  const play = db.prepare("INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, '702', ?, ?)");
  for (const [user, game, from, to] of [
    ['u1', 'Valheim', 30, 28],
    ['u2', 'Valheim', 30, 27],
    ['u1', 'PEAK', 50, 49],
    ['u3', 'Deep Rock Galactic', 100, 98],
  ] as const)
    play.run(GUILD, user, game, now - from * HOUR, now - to * HOUR);
  const session = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)").run(GUILD, now - 30 * HOUR, now - 27 * HOUR).lastInsertRowid;
  for (const user of ['u1', 'u2']) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, 10800)').run(session, user);
  db.prepare("INSERT INTO games (guild_id, name, added_by) VALUES (?, 'Valheim', 'u1')").run(GUILD);
  // Weeks of records, so Overview has its calendar, and sounds, songs and speech for Sounds & music
  const old = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)").run(GUILD, now - 20 * 24 * HOUR, now - 20 * 24 * HOUR + 2 * HOUR).lastInsertRowid;
  db.prepare("INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, 'u1', 7200)").run(old);
  for (const [user, name, hoursAgo] of [['u1', 'airhorn', 2], ['u2', 'a very long sound name that goes on and on', 5], ['u1', 'airhorn', 40]] as const)
    db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)').run(GUILD, user, name, now - hoursAgo * HOUR);
  db.prepare("INSERT INTO music_plays (guild_id, at, uri, title, artist, source, duration_ms, added_by, played_ms, skipped) VALUES (?, ?, 'u', 'A Song With Quite A Long Title (Extended Mix)', 'Some Artist', 'youtube', 200000, 'autoplay', 200000, 0)").run(GUILD, now - 3 * HOUR);
  db.prepare("INSERT INTO speech_lines (guild_id, at, user_id, voice, characters, kind) VALUES (?, ?, 'u2', 'glados', 30, 'say')").run(GUILD, now - 4 * HOUR);
  // A sale with every part a row can have, and a bundle, for Deals
  const wanted = db.prepare("INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, 'The Elder Scrolls V: Skyrim Special Edition', 489830, 'u1')").run(GUILD).lastInsertRowid;
  db.prepare("INSERT INTO game_wants (game_id, user_id) VALUES (?, 'u2')").run(wanted);
  db.prepare(
    "INSERT INTO sale_prices (country, appid, discount, was, price, final, store, store_off, store_url, store_name, keyshop, keyshop_url, currency, lowest) VALUES ('us', 489830, 75, '$39.99', '$9.99', 999, 799, 80, 'https://example.com/store', 'Green Man Gaming', 650, 'https://example.com/keys', 'USD', 649)",
  ).run();
  config.itadKey = 'browser-test';
  const bundle = {
    id: 1,
    title: 'Humble Choice: An Unusually Long Bundle Name For A Phone',
    site: 'Humble Bundle',
    url: 'https://example.com/bundle',
    expiry: new Date(now + 5 * 24 * HOUR).toISOString(),
    from: '$1.00',
    games: [{ title: 'The Elder Scrolls V: Skyrim Special Edition', appid: 489830, where: 'in the $12.00 tier', wanted: null, like: 'Like Valheim (Open World, Survival, Crafting, Exploration)' }],
  };
  setKv(`deal_bundles:${GUILD}`, JSON.stringify({ at: now - 2 * HOUR, value: [bundle] }));
}

// The bot's own calls out, to Steam and GamerPower, get empty answers, so no page waits on the internet
const realFetch = fetch;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname.endsWith('gamerpower.com')) return new Response('[]');
  if (url.pathname === '/api/storesearch/') return new Response('{"items":[]}');
  return new Response('{}');
});

before(async () => {
  if (!browserPath) return;
  profile = mkdtempSync(path.join(tmpdir(), 'sk-browser-'));
  chrome = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Kept to say why, if it never starts
  chrome.stderr!.on('data', (chunk: Buffer) => (chromeSaid = (chromeSaid + chunk).slice(-4000)));
});

test('every page of the web UI opens cleanly, on a computer and a phone', { skip: !browserPath && 'no Chrome or Chromium here', timeout: 240_000 }, async () => {
  seed();
  // Started here, as the API's address is only known once the fixture's own set-up has run
  web = createWeb({ password: PASSWORD, apiToken: TOKEN, botUrl: base });
  await new Promise<void>((resolve) => web!.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${(web!.address() as AddressInfo).port}`;

  // Chrome writes its DevTools port here once it's listening, which takes a while on a busy CI machine
  let port = '';
  for (let i = 0; i < 600 && !port && chrome!.exitCode === null; i++) {
    try {
      port = readFileSync(path.join(profile!, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      await sleep(100);
    }
  }
  assert.ok(port, `${browserPath} didn't start (exit code ${chrome!.exitCode}):\n${chromeSaid}`);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
  const page = await Page.open(target.webSocketDebuggerUrl);

  // What goes wrong on the page being looked at
  let problems: string[] = [];
  page.on((method, p) => {
    if (method === 'Runtime.exceptionThrown') problems.push(`script error: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
    if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) problems.push(`console ${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(' ')}`);
    if (method === 'Network.responseReceived' && p.response.url.startsWith(site) && p.response.status >= 400) problems.push(`${p.response.status} for ${p.response.url.slice(site.length)}`);
    // Leaving a page cancels what it was still waiting for, like live updates
    if (method === 'Network.loadingFailed' && !p.canceled && p.errorText !== 'net::ERR_ABORTED') problems.push(`request failed: ${p.errorText}`);
  });
  await Promise.all(['Runtime.enable', 'Network.enable', 'Page.enable'].map((m) => page.send(m)));

  // Signed in as someone who typed the password
  const login = await fetch(`${site}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slopkeeper': '1' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200, 'signed in');
  const [name, value] = login.headers.get('set-cookie')!.split(';')[0].split('=');
  await page.send('Network.setCookie', { name, value, url: site });

  const failures: string[] = [];
  for (const screen of SCREENS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile });
    for (const [hash, label, stored = {}] of PAGES) {
      // A fresh page each time, with what it remembers set first
      await page.send('Page.navigate', { url: `${site}/#${hash}` });
      await page.evaluate(`localStorage.clear(); ${Object.entries(stored).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')} true`);
      problems = [];
      await page.send('Page.reload', { ignoreCache: true });
      // Until it's shown something other than "Loading…", and a moment more for what follows
      const shown = await (async () => {
        for (let i = 0; i < 100; i++) {
          await sleep(100);
          const ready = await page.evaluate<boolean>(`(() => {
            const main = document.querySelector('main');
            return !!main && main.innerText.trim().length > 0 && !main.querySelector('.notice.loading') && !/Loading…/.test(main.innerText);
          })()`).catch(() => false);
          if (ready) return true;
        }
        return false;
      })();
      await sleep(500);
      const look = await page.evaluate<{ text: number; errors: string[]; wide: number; width: number; past: string[] }>(`(() => {
        const main = document.querySelector('main');
        return {
          text: main ? main.innerText.trim().length : 0,
          errors: [...document.querySelectorAll('.notice.error, [role=alert]')].filter((n) => n.offsetParent && n.textContent.trim()).map((n) => n.textContent.trim().slice(0, 120)),
          // On a phone, Chrome zooms out to fit a page that's too wide, so the screen's width is the measure
          wide: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          width: document.documentElement.clientWidth,
          // What reaches past the screen's edge, innermost first, and text that runs out of its box, to say what's too wide
          past: (() => {
            const edge = ${screen.width} + 1;
            const name = (n) => n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : '');
            // A fixed bar stretches with a page that's too wide, so it's never the cause
            const fixed = (n) => { for (; n; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true; return false; };
            const boxes = [...document.querySelectorAll('body *')].filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > edge && !fixed(n));
            const texts = [];
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let t = walk.nextNode(); t; t = walk.nextNode()) {
              const range = document.createRange();
              range.selectNodeContents(t);
              const right = Math.max(0, ...[...range.getClientRects()].map((r) => r.right));
              if (right > edge && t.parentElement && !fixed(t.parentElement)) texts.push('text "' + t.textContent.trim().slice(0, 40) + '" in ' + name(t.parentElement) + ' ends at ' + Math.round(right));
            }
            return [...boxes.reverse().slice(0, 4).map((n) => name(n) + ' "' + (n.textContent || '').trim().slice(0, 30) + '" ends at ' + Math.round(n.getBoundingClientRect().right)), ...texts.slice(0, 4)];
          })(),
        };
      })()`);
      const where = `${label} (${screen.name})`;
      // SHOTS=<folder> keeps a picture of each page, to look over a change by eye
      if (process.env.SHOTS) {
        // The whole page, not just the first screen of it
        const { cssContentSize: size } = await page.send('Page.getLayoutMetrics');
        const clip = { x: 0, y: 0, width: screen.width, height: Math.min(Math.ceil(size.height), 8000), scale: 1 };
        const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
        writeFileSync(path.join(process.env.SHOTS, `${label.replace(/\W+/g, '-')}-${screen.name}.png`), Buffer.from(data, 'base64'));
      }
      if (!shown) failures.push(`${where}: still loading after 10 seconds`);
      if (look.text < 20) failures.push(`${where}: next to nothing on the page`);
      for (const error of look.errors) failures.push(`${where}: shows "${error}"`);
      if (Math.max(look.wide, look.width) > screen.width + 1) failures.push(`${where}: scrolls sideways (${look.wide} px wide on a ${screen.width} px screen): ${look.past.join('; ')}`);
      for (const problem of problems) failures.push(`${where}: ${problem}`);
    }
  }
  page.close();
  assert.deepEqual(failures, []);
});
