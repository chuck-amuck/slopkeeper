// Every page of the web UI in a real browser, against the real management API with the API tests' fake server: no
// script errors, no failed requests, nothing blank or showing an error, and nothing that scrolls sideways on a phone.
// It needs Chrome or Chromium (CHROME names one). In CI one is required; elsewhere, without one, it's skipped
import { base, GUILD, soundFolder, TOKEN, wav } from './apiFixture.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../src/config.ts';
import { resetChat } from '../src/features/chat.ts';
import { db, setKv } from '../src/db.ts';
import { createWeb } from '../web/src/server.ts';

/** A small PNG of an orange ring on teal, made without ffmpeg, which the host running this may not have */
function ringPng(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      row.push(...(r > 0.45 && r < 0.75 ? [240, 140, 40] : [30, 120, 130]));
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const PASSWORD = 'browser-test';
// A sound this device saw last time, that's since been deleted
const STALE = { sounds: [{ name: 'deleted since', plays: 3 }], groups: [] };
// A page's address, its name, what it remembers, what must be true of it once it's shown, and what to do on it first
const PAGES: [string, string, Record<string, string>?, string?, string?][] = [
  ['board', 'Soundboard'],
  // An effect picked beside the voice. A pick remembered from when the effects were voices becomes the voice and effect
  [
    'board',
    'Soundboard: an old effect voice remembered',
    { [`voice:${GUILD}`]: 'demon' },
    `(() => { const v = document.querySelector('.say-voice'); const e = document.querySelector('.say-effect'); return !!v && !!e && v.value === 'american-deep' && e.value === 'demon' && e.options.length === 16 && localStorage.getItem('effect:${GUILD}') === 'demon'; })()`,
  ],
  // Drawn at once from what was seen last, and the server remembered, so its parts are asked for as the page starts. Then
  // what's since changed: a sound deleted and the server renamed
  [
    'board',
    'Soundboard: from the last visit',
    { guild: GUILD, sessionUntil: String(Date.now() + 86_400_000), [`soundsShown:${GUILD}`]: JSON.stringify(STALE), lastStart: JSON.stringify({ guildId: GUILD, guilds: [{ id: GUILD, name: 'Old server name', icon: null }], me: null }) },
    `![...document.querySelectorAll('.tile-name')].some((n) => n.textContent === 'deleted since') && !document.body.innerText.includes('Old server name')`,
  ],
  ['board', 'Soundboard: Manage', { soundboardView: 'manage' }],
  // Cut another, from a sound that has no link, opens the picker on all of it with both ways to save
  [
    'board',
    'Soundboard: Cut another',
    { soundboardView: 'manage' },
    `(() => { const d = document.querySelector('dialog[open]'); return !!d && /Cut another from airhorn/.test(d.textContent) && [...d.querySelectorAll('button')].some((b) => b.textContent === 'Save and cut another') && d.querySelector('input[aria-label="Sound name"]').value === 'airhorn-2'; })()`,
    `document.querySelector('[aria-label="Cut another sound from airhorn"]').click()`,
  ],
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
  // Chat tried here: asked something, answered with who it would ping, and nothing said aloud, as that's turned off
  [
    'chat',
    'Chat',
    { 'try-chat:speak': 'off' },
    `(() => { const bot = [...document.querySelectorAll('.try-line.bot')].at(-1); const you = [...document.querySelectorAll('.try-line.you')].at(-1); return !!bot && /Right away, @Ben!/.test(bot.textContent) && /Claude Haiku/.test(bot.textContent) && you?.querySelector('.mention')?.textContent === '@Ben' && !document.querySelector('.try-ask textarea').value && document.querySelector('.mention-picker').hidden; })()`,
    // Picked from the @ list as in Discord: Ben's the only one whose name starts "Be"
    `(() => { const box = document.querySelector('.try-ask textarea'); box.focus(); box.value = 'say hi to @Be'; box.setSelectionRange(13, 13); box.dispatchEvent(new Event('input')); const shown = [...document.querySelectorAll('.mention-choice')].map((c) => c.textContent); if (shown.join() !== 'BBen') throw new Error('The @ list shows ' + shown.join()); document.querySelector('.mention-choice').click(); if (box.value !== 'say hi to @Ben ') throw new Error('Picked as ' + box.value); document.querySelector('.try-ask').requestSubmit(); })()`,
  ],
  // Tried as another profile than the server's: said so, and answered under its name
  [
    'chat',
    'Chat: trying another profile',
    { 'try-chat:speak': 'off' },
    `(() => { const note = document.querySelector('#try-profile-note'); const bot = [...document.querySelectorAll('.try-line.bot')].at(-1); return document.querySelector('select[aria-label="Profile"]')?.value === 'butler' && !note.hidden && /Trying as Robot butler, answering as Slopkeeper\. This server uses A grumpy pirate/.test(note.textContent) && bot?.querySelector('.try-who')?.textContent === 'Slopkeeper' && /Right away/.test(bot.textContent); })()`,
    `(() => { const pick = document.querySelector('select[aria-label="Profile"]'); pick.value = 'butler'; pick.dispatchEvent(new Event('change')); const box = document.querySelector('.try-ask textarea'); box.value = 'hello'; box.dispatchEvent(new Event('input')); document.querySelector('.try-ask').requestSubmit(); })()`,
  ],
  // The @ list, open on what's typed, with the one picked marked
  [
    'chat',
    'Chat: the @ list',
    { 'try-chat:speak': 'off' },
    `(() => { const list = document.querySelector('.mention-picker'); const shown = [...list.querySelectorAll('.mention-choice')]; return !list.hidden && shown.length === 3 && shown[1].getAttribute('aria-selected') === 'true' && document.querySelector('.try-ask textarea').getAttribute('aria-activedescendant') === shown[1].id; })()`,
    `(() => { const box = document.querySelector('.try-ask textarea'); box.focus(); box.value = 'roast @'; box.setSelectionRange(7, 7); box.dispatchEvent(new Event('input')); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`,
  ],
  ['activity', 'Activity'],
  // Settings with no section asked for: the list of them on a phone, and beside it the first, with what needs fixing
  [
    'settings',
    'Settings',
    {},
    `(() => {
      const layout = document.querySelector('.settings-layout');
      const shown = (n) => !!n && n.getClientRects().length > 0;
      const items = [...document.querySelectorAll('.settings-item')];
      const basics = document.querySelector('#settings-section-basics');
      const sections = items.length === 9 && items[0].textContent.startsWith('Basics') && !items[0].querySelector('.settings-badge').hidden;
      return sections && layout.classList.contains('listing') && (innerWidth < 760
        ? shown(document.querySelector('.settings-nav')) && !shown(basics) && shown(items[0].querySelector('.settings-item-about'))
        : shown(basics) && items[0].getAttribute('aria-current') === 'page' && shown(document.querySelector('#settings-problems')) && shown(document.querySelector('#settings-this-browser')));
    })()`,
  ],
  ['settings/pings', 'Settings: Voice and pings', {}, `!!document.querySelector('#settings-game-pings') && !document.querySelector('#settings-section-pings').hidden`],
  ['settings/games', 'Settings: Games'],
  ['settings/deals', 'Settings: Deals', {}, `!!document.querySelector('#settings-free-games') && [...document.querySelectorAll('#settings-section-deals details.preview')].length === 2`],
  // Join sounds with their list under them, and their delay and cooldown folded away
  ['settings/soundboard', 'Settings: Soundboard', {}, `!!document.querySelector('#settings-join-sounds + #settings-join-sound-list') && !document.querySelector('#settings-join-sounds .more-options').open && !!document.querySelector('#setting-soundVolume[type=range]')`],
  ['settings/music', 'Settings: Music'],
  // With no channel picked, the looping room is one line, and its speech isn't shown
  [
    'settings/loop',
    'Settings: Looping room off',
    {},
    `(() => { const line = document.querySelector('#settings-looping-room .needs-line'); return !!line && line.getClientRects().length > 0 && document.querySelector('#settings-looping-speech').getClientRects().length === 0 && document.querySelector('#setting-loopSound').closest('.field').getClientRects().length === 0; })()`,
  ],
  // A link to one setting: its section opened, its More options too, and the cursor in it, at the section's own address
  [
    'settings?key=musicSearchFallback',
    'Settings: a link to a setting',
    {},
    `location.hash === '#settings/music?key=musicSearchFallback' && document.activeElement?.id === 'setting-musicSearchFallback' && document.querySelector('#settings-music-search .more-options').open`,
  ],
  // A search finds settings in every section, even folded or hidden ones, and clearing it goes back to the one open.
  // Basics has the Sounds button, beside Volume
  [
    'settings/music',
    'Settings: a search',
    {},
    `window.searched === 'basics,soundboard,music,speech,loop|music'`,
    `(async () => {
      const find = document.querySelector('.settings-find input');
      const type = (text) => { find.value = text; find.dispatchEvent(new Event('input')); };
      type('volume');
      const found = [...document.querySelectorAll('.settings-section')].filter((n) => !n.hidden).map((n) => n.dataset.id).join();
      const folded = document.querySelector('#setting-evenVolume')?.closest('details').open && document.querySelector('#setting-loopVolume').closest('.field').getClientRects().length > 0;
      type('');
      const after = [...document.querySelectorAll('.settings-section')].filter((n) => !n.hidden).map((n) => n.dataset.id).join();
      window.searched = folded ? found + '|' + after : 'not opened';
    })()`,
  ],
  // On a phone, a section from the list, and Back to the list. Beside the list, another section in its place
  [
    'settings',
    'Settings: into a section and back',
    {},
    `window.wentBack === true`,
    `(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 300));
      const layout = document.querySelector('.settings-layout');
      [...document.querySelectorAll('.settings-item')].find((b) => b.textContent.startsWith('Speech')).click();
      await wait();
      const opened = location.hash === '#settings/speech' && !document.querySelector('#settings-section-speech').hidden && !layout.classList.contains('listing');
      if (innerWidth >= 760) return (window.wentBack = opened && document.querySelector('#settings-section-basics').hidden);
      document.querySelector('#settings-section-speech .settings-back').click();
      await wait();
      window.wentBack = opened && location.hash === '#settings' && layout.classList.contains('listing') && document.querySelector('.settings-nav').getClientRects().length > 0;
    })()`,
  ],
  [
    'settings/chat',
    'Settings: Chat',
    {},
    `/A grumpy pirate with a long name to wrapUsing/.test(document.querySelector('#settings-profiles')?.textContent ?? '') && document.querySelector('#setting-chatProfile')?.value === 'pirate' && document.querySelector('#settings-chat-notes')?.textContent.includes('Captain') && /for .+, .+check the oven \\(set by .+\\)Cancel/.test(document.querySelector('#settings-chat-reminders')?.textContent ?? '')`,
  ],
  // Profiles: the one in use, and its settings
  [
    'settings/chat',
    'Settings: Edit a profile',
    {},
    `(() => { const d = document.querySelector('dialog[open]'); return !!d && /Edit A grumpy pirate/.test(d.textContent) && d.querySelectorAll('select').length === 6 && d.querySelector('#profile-swearing').value === 'freely' && d.querySelector('#profile-voice').value === 'scottish' && d.querySelector('#profile-effect').value === 'robot' && d.querySelector('#profile-nickname').value === 'Captain Grump' && /\\d+ of 1000 characters/.test(d.textContent); })()`,
    `[...[...document.querySelectorAll('#settings-profiles .profile-row')].find((r) => r.textContent.startsWith('A grumpy pirate')).querySelectorAll('button')].find((b) => b.textContent === 'Edit').click()`,
  ],
  // Added voices: one ready with speakers, one downloading and one that failed, and the ready one's settings
  [
    'settings/speech',
    'Settings: Edit a voice',
    {},
    `(() => { const d = document.querySelector('dialog[open]'); return !!d && /Edit Narrator/.test(d.textContent) && d.querySelectorAll('select').length === 5 && d.querySelector('#voice-effect').options.length === 16 && /Measured: Middle, -2.5 dB/.test(d.textContent) && [...d.querySelectorAll('button')].some((b) => b.textContent === 'Use measured') && /Downloading, 40%/.test(document.body.innerText) && /Couldn’t download/.test(document.body.innerText); })()`,
    `[...document.querySelectorAll('#settings-voices .voice-row')].find((r) => r.textContent.startsWith('Narrator')).querySelector('button:nth-child(2)').click()`,
  ],
  // An import, from a file picked, says what it would do first
  [
    'settings/speech',
    'Settings: Import voices',
    {},
    `(() => { const d = document.querySelector('dialog[open]'); return !!d && /Added \\(1\\)/.test(d.textContent) && /Skipped \\(1\\)/.test(d.textContent) && /Already the same \\(1\\)/.test(d.textContent); })()`,
    `(() => {
      const input = document.querySelector('#settings-voices input[type=file]');
      const list = [{ name: 'Narrator', model: 'https://example.com/narrator.onnx' }, { name: 'A pirate with a long name to wrap', model: 'https://example.com/pirate.onnx' }, { name: 'Scottish', model: 'https://example.com/g.onnx' }];
      const files = new DataTransfer();
      files.items.add(new File([JSON.stringify(list)], 'voices.json', { type: 'application/json' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change'));
    })()`,
  ],
  // The bot's profile, as its face left of the server: its menu open, at the one in use, with the others and Edit
  [
    'music',
    'Header: the profile menu',
    {},
    `(() => {
      const pick = document.querySelector('.profile-pick');
      const face = pick?.querySelector('.profile-face');
      const menu = pick?.querySelector('[role=menu]');
      const items = [...(menu?.querySelectorAll('[role^=menuitem]') ?? [])];
      const named = (text) => items.find((b) => b.querySelector('.profile-menu-name')?.textContent.startsWith(text));
      const left = pick.getBoundingClientRect().right <= document.querySelector('.guild').getBoundingClientRect().left;
      return left && face.getAttribute('aria-label') === 'Profile: A grumpy pirate with a long name to wrap' && pick.querySelector('.profile-tip').textContent === 'A grumpy pirate with a long name to wrap'
        && !menu.hidden && face.getAttribute('aria-expanded') === 'true' && named('A grumpy pirate')?.getAttribute('aria-checked') === 'true' && document.activeElement === named('A grumpy pirate')
        && named('A grumpy pirate').querySelector('img.profile-photo') && named('Robot butler')?.getAttribute('aria-checked') === 'false' && named('Robot butler').querySelector('.mono')?.textContent === 'RB'
        && items.at(-1).textContent === 'Edit profiles…';
    })()`,
    `document.querySelector('.profile-face').click()`,
  ],
  // Escape closes it, back on the face; the arrows open it again at the last, and Escape again
  [
    'music',
    'Header: the profile menu closed',
    {},
    `(() => { const face = document.querySelector('.profile-face'); return document.querySelector('.profile-menu').hidden && face.getAttribute('aria-expanded') === 'false' && document.activeElement === face; })()`,
    `(async () => {
      const face = document.querySelector('.profile-face');
      const menu = document.querySelector('.profile-menu');
      const key = (on, k) => on.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      face.click();
      key(document.activeElement, 'Escape');
      if (!menu.hidden || document.activeElement !== face) throw new Error('Escape left it open');
      key(face, 'ArrowUp');
      if (menu.hidden || document.activeElement.textContent !== 'Edit profiles…') throw new Error('ArrowUp opened it at ' + document.activeElement.textContent);
      key(document.activeElement, 'ArrowDown');
      if (document.activeElement.getAttribute('role') !== 'menuitemradio') throw new Error('ArrowDown didn’t go round to the first');
      key(document.activeElement, 'Escape');
    })()`,
  ],
  // Edit profiles… opens Settings at Profiles. Whether it came into view is noted as it does, as a picture of the whole page
  // moves where it's scrolled to
  [
    'music',
    'Header: Edit profiles',
    {},
    `location.hash === '#settings/chat' && window.profilesInView === true && document.querySelector('.profile-menu').hidden`,
    `(async () => {
      document.querySelector('.profile-face').click();
      [...document.querySelectorAll('.profile-menu [role=menuitem]')].find((b) => b.textContent === 'Edit profiles…').click();
      const inView = () => { const top = document.querySelector('#settings-profiles')?.getBoundingClientRect().top ?? -1; return top >= 0 && top < innerHeight / 2; };
      for (let i = 0; i < 40 && !inView(); i++) await new Promise((r) => setTimeout(r, 100));
      // Still there once the cards above it have loaded
      await new Promise((r) => setTimeout(r, 1000));
      window.profilesInView = inView();
    })()`,
  ],
  // Picking another from it: the face changes at once, and the server uses it. Put back afterwards for the pages that follow
  [
    'music',
    'Header: another profile picked',
    {},
    `(async () => {
      const face = document.querySelector('.profile-face');
      const ok = face.getAttribute('aria-label') === 'Profile: Robot butler' && face.querySelector('.mono')?.textContent === 'RB' && document.querySelector('.profile-menu').hidden
        && (await (await fetch('/api/guilds/${GUILD}/settings').catch(() => null))?.json().catch(() => null))?.settings?.find?.((x) => x.key === 'chatProfile')?.value === 'butler';
      face.click();
      [...document.querySelectorAll('.profile-menu-name')].find((n) => n.textContent.startsWith('A grumpy pirate')).closest('button').click();
      for (let i = 0; i < 50 && face.getAttribute('aria-label') !== 'Profile: A grumpy pirate with a long name to wrap'; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
      return ok;
    })()`,
    `(() => { document.querySelector('.profile-face').click(); [...document.querySelectorAll('.profile-menu-name')].find((n) => n.textContent === 'Robot butler').closest('button').click(); })()`,
  ],
];
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
  // Sounds, so the Soundboard has tiles and Manage has rows, one with the longest name there can be
  mkdirSync(soundFolder, { recursive: true });
  for (const name of ['airhorn', 'a-very-long-sound-name-for-rows']) writeFileSync(path.join(soundFolder, `${name}.wav`), wav(1));
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
  db.prepare("INSERT INTO speech_lines (guild_id, at, user_id, voice, characters, kind) VALUES (?, ?, 'u2', 'scottish', 30, 'say')").run(GUILD, now - 4 * HOUR);
  // A sale with every part a row can have, and a bundle, for Deals
  const wanted = db.prepare("INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, 'The Elder Scrolls V: Skyrim Special Edition', 489830, 'u1')").run(GUILD).lastInsertRowid;
  db.prepare("INSERT INTO game_wants (game_id, user_id) VALUES (?, 'u2')").run(wanted);
  db.prepare(
    "INSERT INTO sale_prices (country, appid, discount, was, price, final, store, store_off, store_url, store_name, keyshop, keyshop_url, currency, lowest) VALUES ('us', 489830, 75, '$39.99', '$9.99', 999, 799, 80, 'https://example.com/store', 'Green Man Gaming', 650, 'https://example.com/keys', 'USD', 649)",
  ).run();
  config.itadKey = 'browser-test';
  // Chat on, with what it remembers about someone and a reminder waiting, for their cards in Settings
  config.anthropicKey = 'browser-test';
  db.prepare("INSERT INTO chat_notes (guild_id, user_id, note, updated_at) VALUES (?, 'u1', 'Wants to be called Captain.', ?)").run(GUILD, now);
  db.prepare("INSERT INTO chat_reminders (guild_id, channel_id, created_by, people, text, due_at, created_at) VALUES (?, '702', 'u1', '[\"u1\",\"u2\"]', 'check the oven', ?, ?)").run(GUILD, now + 2 * HOUR, now);
  // A profile in use, with a name long enough to wrap, a voice and an effect, for the Profiles card and its dialog
  db.prepare(
    "INSERT INTO chat_profiles (id, name, personality, length, opinions, swearing, roasts, despises, voice, effect, nickname, added_by, added_at, changed_at) VALUES ('pirate', 'A grumpy pirate with a long name to wrap', 'A grumpy pirate who has seen too many storms.', 'short', 'straight', 'freely', 'playful', '', 'scottish', 'robot', 'Captain Grump', 'u1', ?, ?)",
  ).run(now, now);
  db.prepare("INSERT INTO guild_settings (guild_id, key, value) VALUES (?, 'chatProfile', 'pirate')").run(GUILD);
  // And a photo, for the header's picker and the Profiles card
  mkdirSync(path.join(config.dataDir, 'profile-photos'), { recursive: true });
  writeFileSync(path.join(config.dataDir, 'profile-photos', 'pirate.png'), ringPng(64));
  db.prepare("INSERT INTO profile_photos (profile_id, hash) VALUES ('pirate', '0123456789abcdef')").run();
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
  // Added voices, which the fake voice container below says are in each state
  config.voiceUrl = VOICE_URL;
  const fields = { group: 'Characters', config_url: null, sha256: null, config_sha256: null, speaker: null, volume: 0, pace: 1, noise: null, noise_w: null, curve: 'character', added_by: 'u1', added_at: now, changed_at: now };
  for (const [id, name] of [['narrator', 'Narrator'], ['robot-butler', 'Robot butler'], ['broken', 'A voice whose link is wrong']]) {
    db.prepare('INSERT INTO voices (id, name, grp, model_url, config_url, sha256, config_sha256, speaker, volume, pace, noise, noise_w, curve, added_by, added_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      name,
      fields.group,
      `https://example.com/${id}.onnx`,
      ...Object.values(fields).slice(1),
    );
  }
  // The narrator has been measured, and is set by hand, so its Edit dialog offers what was measured
  db.prepare("UPDATE voices SET tune = 'manual', measured = ? WHERE id = 'narrator'").run(JSON.stringify({ key: 'x', curve: 'middle', fit: 0.012, volume: -2.5, at: now }));
}

const VOICE_URL = 'http://voice.test';
let containerVersion = '';
/** The voice container's answer: the narrator downloaded, with speakers, the butler on its way, and the last one failed */
const containerReport = () => ({
  version: containerVersion,
  voices: {
    narrator: { state: 'ready', file: 'voice-narrator-0123456789ab', speakers: [{ id: 0, name: 'calm' }, { id: 1, name: 'an excitable speaker with a long name' }] },
    'robot-butler': { state: 'downloading', percent: 40 },
    broken: { state: 'failed', error: 'Its settings file isn’t a Piper voice’s. Check the link is to the model’s .onnx file.' },
  },
});

// The bot's own calls out, to Steam and GamerPower, get empty answers, so no page waits on the internet
const realFetch = fetch;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname === 'voice.test' && url.pathname === '/models') {
    if (init?.method === 'POST') containerVersion = JSON.parse(String(init.body)).version;
    return Response.json(containerReport());
  }
  if (url.hostname.endsWith('gamerpower.com')) return new Response('[]');
  // Chat's model, for the Chat tab, answering at once
  if (url.hostname === 'api.anthropic.com') {
    return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text: 'Right away, @Ben!' }] });
  }
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
    for (const [hash, label, stored = {}, expect, act] of PAGES) {
      // A fresh page each time, with what it remembers set first, and chat's wait between questions over, as two pages ask
      // within seconds
      resetChat();
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
      if (act && shown) {
        await page.evaluate(act);
        await sleep(1500);
      }
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
      if (expect && !(await page.evaluate<boolean>(expect))) failures.push(`${where}: isn't so: ${expect}`);
      if (look.text < 20) failures.push(`${where}: next to nothing on the page`);
      for (const error of look.errors) failures.push(`${where}: shows "${error}"`);
      if (Math.max(look.wide, look.width) > screen.width + 1) failures.push(`${where}: scrolls sideways (${look.wide} px wide on a ${screen.width} px screen): ${look.past.join('; ')}`);
      for (const problem of problems) failures.push(`${where}: ${problem}`);
    }
  }
  page.close();
  assert.deepEqual(failures, []);
});
