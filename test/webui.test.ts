// Every page of the web UI in a real browser, against the real management API with the API tests' fake server: no
// script errors, no failed requests, nothing blank or showing an error, and nothing that scrolls sideways on a phone.
// It needs Chrome or Chromium (CHROME names one). In CI one is required; elsewhere, without one, it's skipped. CI runs it
// in a job of its own, so its other tests leave it out with SKIP_WEB_UI=1
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
import { refreshVoiceStates, stopFollowingDownloads, syncVoices } from '../src/features/voices.ts';
import { lookups } from '../src/features/gamefacts.ts';
import { db, setKv } from '../src/db.ts';
import * as perf from '../src/perf.ts';
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
// The corner's buttons keep clear of the page wherever there's room beside it for them, as there is from 1140px
const CLEAR_OF_PAGE = `(() => { if (innerWidth < 1140) return true; const main = document.querySelector('main'); const right = main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight); const buttons = [...document.querySelectorAll('.stop-dock .volume-fab')]; return buttons.length > 0 && buttons.every((b) => b.getBoundingClientRect().left >= right); })()`;
// Each sound's name ends inside its tile, and on a phone a long one has its two lines, ending in … rather than cut through
const NAMES_FIT = `[...document.querySelectorAll('.tile')].every((t) => { const n = t.querySelector('.tile-name'); if (!n) return true; const name = n.getBoundingClientRect(); const lines = Math.round(name.height / parseFloat(getComputedStyle(n).lineHeight)); return name.bottom <= t.getBoundingClientRect().bottom - parseFloat(getComputedStyle(t).paddingBottom) + 0.5 && (innerWidth > 640 || !/very-long/.test(n.textContent) || lines === 2); })`;
// A hint's More is easy to tap on a phone without spacing out the lines around it: each hint a whole number of lines
const HINTS_EVEN = `!!document.querySelector('p.hint .hint-more') && [...document.querySelectorAll('p.hint')].filter((p) => p.querySelector('.hint-more') && p.getClientRects().length).every((p) => { const probe = p.cloneNode(false); probe.textContent = 'x'; p.after(probe); const line = probe.getBoundingClientRect().height; probe.remove(); const n = p.getBoundingClientRect().height / line; return Math.abs(n - Math.round(n)) < 0.15; })`;
// A count beside a bar, like "205 plays", on one line, and every view's tab in sight without scrolling them
// (a symbol like ▲ from another font sits a little higher or lower on the same line, so only text below the first line's
// bottom counts as wrapped)
const COUNTS_ONE_LINE = `[...document.querySelectorAll('.rank-value')].every((v) => { const r = document.createRange(); r.selectNodeContents(v); const lines = [...r.getClientRects()]; return lines.every((x) => x.top < lines[0].bottom - 2); })`;
const TABS_IN_SIGHT = `(() => { const t = document.querySelector('.view-tabs'); return t.scrollWidth <= t.clientWidth + 1; })()`;
const STATS_FIT = `${COUNTS_ONE_LINE} && ${TABS_IN_SIGHT}`;
// A row's control, a switch or a button, beside its name and hint rather than under them
// Each row's buttons on one line
const ONE_LINE = (controls: string) =>
  `(() => { const all = [...document.querySelectorAll('${controls}')]; return all.length > 0 && all.every((c) => new Set([...c.children].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1); })()`;
const BESIDE = (rows: string, control: string) =>
  `(() => { const all = [...document.querySelectorAll('${rows}')]; return all.length > 0 && all.every((f) => f.querySelector('${control}').getBoundingClientRect().top < f.querySelector('.hint').getBoundingClientRect().bottom); })()`;
// Games' four views, with the one named open at its own address and, on a phone, Games and Stats on the bottom bar. A phone
// says Nights for Game nights, so all four fit without scrolling
const GAMES_VIEW = (id: string, label: string) =>
  `(() => { const views = document.querySelector('.view-tabs[aria-label="Games view"]'); const phone = innerWidth <= 640; const named = (n) => (phone && n === 'Game nights' ? 'Nights' : n); const tabs = [...views.querySelectorAll('button')].map((t) => t.innerText); return tabs.join('|') === ['Library', 'Game nights', 'Pick a game', 'Deals'].map(named).join('|') && views.scrollWidth <= views.clientWidth && views.querySelector('[aria-current=page]')?.innerText === named('${label}') && location.hash === '#games/${id}' && (innerWidth > 640 || [...document.querySelectorAll('.bottom-nav button')].map((b) => b.textContent).join('|') === 'Sounds|Music|Games|Stats|More'); })()`;
// A page's address, its name, what it remembers, what must be true of it once it's shown, and what to do on it first
// Lines said and kept answered in the page, as there's no voice channel here: each is noted in window.sent as [path, json]
const SAY_STUB = String.raw`const real = window.fetch; window.sent = []; window.fetch = (url, init) => { const u = String(url); if (init?.method === 'POST' && /\/say(\/sound)?$/.test(u)) { const json = JSON.parse(init.body); window.sent.push([u.replace(/.*\/api\/guilds\/[^/]+/, ''), json]); return Promise.resolve(Response.json(u.endsWith('/sound') ? { name: json.name, replaced: false, discordProblem: null } : {})); } return real(url, init); };`;

/**
 * Answers the requests that match a rule in the page itself, and passes the rest to the bot: each rule is [address
 * pattern, method, status, body], and a status of 0 never answers. What it answered is in window.asked
 */
const STUB = (...rules: [string, string, number, unknown?][]) =>
  `const real = window.fetch; window.asked = []; window.fetch = (url, init) => { for (const [p, m, s, b] of ${JSON.stringify(rules)}) if (new RegExp(p).test(String(url)) && (init?.method ?? 'GET') === m) { window.asked.push(m + ' ' + String(url)); return s ? Promise.resolve(new Response(JSON.stringify(b ?? {}), { status: s, headers: { 'content-type': 'application/json' } })) : new Promise(() => {}); } return real(url, init); };`;

/** Something a case does: a script run in the page, or a function run here, for what the page can't reach */
type Step = string | ((page: Page) => unknown);

/**
 * Each page: its address, a name, what the browser remembers first, a check that has to be true, something to do first
 * (then the check is tried until it's true, so it mustn't change anything), and something to put back after
 */
const PAGES: [string, string, Record<string, string>?, string?, Step?, Step?][] = [
  ['board', 'Soundboard', {}, `${CLEAR_OF_PAGE} && ${NAMES_FIT} && !!document.querySelector('.view-slot > .play-in select') && !!document.querySelector('.view-slot input[type=search]') === innerWidth >= 1100`],
  // The corner's Volume and Sounds panels close with Escape, focus going back to the button, and with a press outside,
  // except the Sounds panel on a wide screen, where it's made to be used beside the page
  [
    'activity',
    'Corner panels close with Escape and a press outside',
    {},
    `window.dismissed === (innerWidth <= 640 ? 'false,true,false,false,false' : 'false,true,false,true,false')`,
    `(() => { const volume = document.querySelector('.volume-fab:not(.sounds-fab)'); const sounds = document.querySelector('.sounds-fab'); const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); const press = () => document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); const seen = []; volume.click(); volume.focus(); escape(); seen.push(volume.ariaExpanded, document.activeElement === volume); volume.click(); press(); seen.push(volume.ariaExpanded); sounds.click(); press(); seen.push(sounds.ariaExpanded); escape(); seen.push(sounds.ariaExpanded); window.dismissed = seen.join(); })()`,
  ],
  // A voice preview pressed again while it's still being made is asked for once
  [
    'board',
    'Soundboard: a voice preview asked for once',
    {},
    `window.asked.length === 1 && document.querySelector('.say-preview').ariaBusy === 'true'`,
    `(() => { ${STUB(['/say/preview', 'GET', 0])} const b = document.querySelector('.say-preview'); b.click(); b.click(); })()`,
  ],
  // Play | Manage stays where it is as the view changes, and Manage has its search and buttons beside it on a wide screen
  [
    'board',
    'Soundboard: Play | Manage stays put',
    {},
    `(async () => { const views = document.querySelector('.views[aria-label="Soundboard view"]'); const at = () => views.getBoundingClientRect().left; const play = at(); views.querySelector('button:last-child').click(); await new Promise((r) => setTimeout(r, 800)); return play === at() && !!document.querySelector('.manage-view') && !!document.querySelector('.view-slot .manage-tools') === innerWidth >= 1100 && !!document.querySelector('.view-slot > .play-in select') && ${CLEAR_OF_PAGE}; })()`,
  ],
  // The address names the view, so a link opens it, and Back goes back to it from the other
  [
    'board/manage',
    'Soundboard: Manage from its address',
    { soundboardView: 'play' },
    `(async () => {
      const views = document.querySelector('.views[aria-label="Soundboard view"]');
      const current = () => views.querySelector('[aria-current=page]')?.textContent;
      const wait = () => new Promise((r) => setTimeout(r, 600));
      const manage = current() === 'Manage' && !!document.querySelector('.manage-view');
      views.querySelector('button').click();
      await wait();
      const play = current() === 'Play' && location.hash === '#board/play';
      history.back();
      await wait();
      return manage && play && current() === 'Manage' && location.hash === '#board/manage' && !!document.querySelector('.manage-view');
    })()`,
  ],
  // An effect picked beside the voice. A pick remembered from when the effects were voices becomes the voice and effect
  [
    'board',
    'Soundboard: an old effect voice remembered',
    { [`voice:${GUILD}`]: 'demon' },
    `(() => { const v = document.querySelector('.say-voice'); const e = document.querySelector('.say-effect'); return !!v && !!e && v.value === 'american-deep' && e.value === 'demon' && e.options.length === 16 && localStorage.getItem('effect:${GUILD}') === 'demon'; })()`,
  ],
  // Speech switched off elsewhere, as from another tab or /setup: the Say box goes without the page asking for it again
  [
    'board',
    'Soundboard: speech switched off elsewhere',
    {},
    `window.shownFirst === true && document.querySelector('.say-box').hidden && window.asked.length === 0`,
    `(async () => { window.shownFirst = !document.querySelector('.say-box').hidden; window.asked = []; const real = window.fetch; window.fetch = (u, i) => (/\\/say$/.test(String(u)) && window.asked.push(String(u)), real(u, i)); await real('/api/guilds/${GUILD}/settings/tts', { method: 'PUT', headers: { 'x-slopkeeper': '1', 'content-type': 'application/json' }, body: JSON.stringify({ value: false }) }); })()`,
    `fetch('/api/guilds/${GUILD}/settings/tts', { method: 'DELETE', headers: { 'x-slopkeeper': '1' } })`,
  ],
  // Drawn at once from what was seen last, and the server remembered, so its parts are asked for as the page starts. Then
  // what's since changed: a sound deleted and the server renamed
  [
    'board',
    'Soundboard: from the last visit',
    { guild: GUILD, sessionUntil: String(Date.now() + 86_400_000), [`soundsShown:${GUILD}`]: JSON.stringify(STALE), lastStart: JSON.stringify({ guildId: GUILD, guilds: [{ id: GUILD, name: 'Old server name', icon: null }], me: null }) },
    `![...document.querySelectorAll('.tile-name')].some((n) => n.textContent === 'deleted since') && !document.body.innerText.includes('Old server name')`,
  ],
  // Discord's three actions in one menu, opened at the first
  [
    'board',
    'Soundboard: Manage',
    { soundboardView: 'manage' },
    `(() => { const items = [...document.querySelectorAll('.manage-tools .action-menu:not([hidden]) [role=menuitem]')].map((b) => b.textContent); return items.join('|') === 'Sync to Discord’s soundboard|Post the sounds panel…|Posted panels…' && document.activeElement?.textContent === items[0] && document.querySelector('.manage-tools .menu-button').ariaExpanded === 'true'; })()`,
    `document.querySelector('.manage-tools .menu-button').click()`,
  ],
  // Cut another, from a sound that has no link, opens the picker on all of it with both ways to save
  [
    'board',
    'Soundboard: Cut another',
    { soundboardView: 'manage' },
    `(() => { const d = document.querySelector('dialog[open]'); const here = [...d.querySelectorAll('button')].find((b) => b.textContent === 'Start here'); return !!d && /Cut a new sound from airhorn/.test(d.textContent) && [...d.querySelectorAll('button')].some((b) => b.textContent === 'Save and cut another') && d.querySelector('input[aria-label="Sound name"]').value === 'airhorn-2' && !!here && !here.classList.contains('quiet'); })()`,
    `document.querySelector('[aria-label="Cut another sound from airhorn"]').click()`,
  ],
  // Where it plays and how loud on the player card, as music apps have them, rather than above it
  [
    'music',
    'Music',
    {},
    `${CLEAR_OF_PAGE} && document.querySelectorAll('.now-panels [role=menuitem]').length === 2 && !!document.querySelector('.now .now-where .play-in select') && !document.querySelector('.now .now-volume').hidden && !document.querySelector('main > .toolbar input[type=range]') && (innerWidth <= 640
      ? (() => { const buttons = [...document.querySelectorAll('.now-controls > button')].filter((n) => n.getClientRects().length).map((n) => n.getBoundingClientRect()); const panels = document.querySelector('.now-panels').getBoundingClientRect(); return buttons.length === 3 && buttons.every((b) => b.top === buttons[0].top) && panels.bottom <= document.querySelector('.now-controls').getBoundingClientRect().top && document.querySelector('.now-title').getBoundingClientRect().right <= panels.left; })()
      : (() => { const shown = [...document.querySelectorAll('.now-controls > *')].filter((n) => n.getClientRects().length); return shown.every((n) => n.getBoundingClientRect().top === shown[0].getBoundingClientRect().top); })())`,
  ],
  // On a phone its toolbar is the search, then two to a row, with nothing left on a row of its own
  [
    'games/library',
    'Games: Library',
    {},
    `${GAMES_VIEW('library', 'Library')} && /Steam accounts/.test(document.querySelector('main').innerText) && (innerWidth > 640 || (() => { const rows = new Map(); for (const n of document.querySelector('.games-tools').children) rows.set(n.offsetTop, (rows.get(n.offsetTop) ?? 0) + 1); return [...rows.values()].join() === '1,2,2'; })())`,
  ],
  // A game added from members' Steam libraries: the dialog stays open for the next, and says so
  [
    'games/library',
    'Games: a game added from the list',
    {},
    `(() => { const d = document.querySelector('dialog[open]'); return /Stub game is in the library/.test(d?.textContent) && !d.querySelector('[aria-label="Add Stub game"]') && window.asked.includes('POST /api/guilds/${GUILD}/games'); })()`,
    `(async () => { ${STUB(['/games/owned$', 'GET', 200, { games: [{ appid: 1, name: 'Stub game', owners: ['Ana'] }] }], ['/games$', 'POST', 200, { name: 'Stub game' }])} [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add a game').click(); for (let i = 0; i < 50 && !document.querySelector('[aria-label="Add Stub game"]'); i++) await new Promise((r) => setTimeout(r, 100)); document.querySelector('[aria-label="Add Stub game"]').click(); })()`,
  ],
  ['games/nights', 'Games: Game nights', {}, `${GAMES_VIEW('nights', 'Game nights')} && /Plan a game night/.test(document.querySelector('main').innerText)`],
  [
    'games/pick',
    'Games: Pick a game',
    {},
    `${GAMES_VIEW('pick', 'Pick a game')} && !!document.querySelector('main select') && (innerWidth > 640 || (() => { const rows = new Map(); for (const n of document.querySelector('.pick-tools').children) rows.set(n.offsetTop, (rows.get(n.offsetTop) ?? 0) + 1); return [...rows.values()].join() === '1,2,1'; })()) && (() => { const label = document.querySelector('.pick-who-label'); const who = label?.querySelector('select'); return !!who && who.getClientRects().length > 0 && /^Who’s playing/.test(label.textContent) && [...who.options].at(-1).textContent === 'Choose people' && who.options.length > 1; })()`,
  ],
  // With nobody in a voice channel there's nothing to pick from, so it's only the ticking, under its label
  [
    'games/pick',
    'Games: Pick a game with nobody in voice',
    {},
    `(() => { const label = document.querySelector('.pick-who-label'); return window.noVoice === true && label?.getClientRects().length > 0 && label.querySelector('select').getClientRects().length === 0 && /^Who’s playing/.test(label.textContent) && document.querySelectorAll('.pick-people input[type=checkbox]').length > 0 && !document.querySelector('.pick-people').hidden; })()`,
    `(async () => { const real = window.fetch; window.fetch = async (url, options) => { const res = await real(url, options); if (!String(url).includes('/pick/options')) return res; const data = await res.json(); window.noVoice = true; return new Response(JSON.stringify({ ...data, voice: [] }), { status: res.status, headers: { 'content-type': 'application/json' } }); }; const views = () => [...document.querySelectorAll('.view-tabs button')]; views()[0].click(); await new Promise((r) => setTimeout(r, 300)); views().find((b) => b.innerText === 'Pick a game').click(); })()`,
  ],
  // Picking a view is a step Back undoes, without drawing the page again
  [
    'games/library',
    'Games: Back to the last view',
    {},
    `window.pickedPick === true && window.samePage === document.querySelector('main') && ${GAMES_VIEW('library', 'Library')}`,
    `(async () => { window.samePage = document.querySelector('main'); [...document.querySelectorAll('.view-tabs button')].find((b) => b.innerText === 'Pick a game').click(); await new Promise((r) => setTimeout(r, 300)); window.pickedPick = location.hash === '#games/pick' && !!document.querySelector('main select'); history.back(); })()`,
  ],
  // Game nights, Pick a game and Deals were tabs of their own: their addresses, and a device that had one open, go to their
  // view
  ['nights', 'Games: the old Game nights address', {}, GAMES_VIEW('nights', 'Game nights')],
  ['pick', 'Games: the old Pick a game address', {}, GAMES_VIEW('pick', 'Pick a game')],
  ['games', 'Games: remembered from the old Pick a game tab', { tab: 'pick' }, GAMES_VIEW('pick', 'Pick a game')],
  ['deals', 'Games: the old Deals address', {}, GAMES_VIEW('deals', 'Deals')],
  // Opened afresh on a bare #games, as the case before leaves a view in the address that a reload would follow
  [
    'games',
    'Games: remembered from the old Deals tab',
    {},
    GAMES_VIEW('deals', 'Deals'),
    `(() => { localStorage.clear(); localStorage.setItem('tab', 'deals'); history.replaceState(null, '', '#games'); location.reload(); })()`,
  ],
  // A note under Bundles' title isn't boxed in by a line under it too
  ['games/deals', 'Games: Deals', {}, `(() => { const note = document.querySelector('.card-note'); const row = note?.nextElementSibling?.querySelector('.free-game'); return !note || note.hidden || !row || getComputedStyle(row).borderTopWidth === '0px'; })()`],
  // The views as tabs on one row, the dates a list on a phone, and the corner's buttons out of the way while scrolling
  // down a phone, and back on the way up or when the keyboard reaches them
  [
    'stats/overview',
    'Stats: Overview',
    {},
    `(async () => {
      const tabs = [...document.querySelectorAll('.view-tabs button')];
      const oneRow = tabs.length === 4 && tabs.every((t) => t.offsetTop === tabs[0].offsetTop);
      const phone = innerWidth <= 640;
      const dates = phone ? !!document.querySelector('select.range-select') && !document.querySelector('.range-presets') : !!document.querySelector('.range-presets') && !document.querySelector('select.range-select');
      const dock = document.querySelector('.stop-dock');
      const wait = () => new Promise((r) => setTimeout(r, 400));
      scrollTo(0, 800);
      await wait();
      const gone = () => dock.classList.contains('away') && getComputedStyle(dock).pointerEvents === 'none';
      const away = gone();
      scrollBy(0, -200);
      await wait();
      const back = !gone();
      // Down again, and Tab brings them back
      scrollTo(0, 1200);
      await wait();
      const awayAgain = gone();
      dock.querySelector('.volume-fab').focus();
      await wait();
      const byKeys = !gone();
      document.activeElement.blur();
      scrollTo(0, 0);
      return oneRow && dates && (phone ? away && back && awayAgain && byKeys : !away);
    })()`,
  ],
  ['stats/compare', 'Stats: Compare', {}, STATS_FIT],
  ['stats/sounds', 'Stats: Sounds & music', {}, STATS_FIT],
  // Another range picked: kept in the address and asked of the bot
  [
    'stats/sounds',
    'Stats: another range, in the address',
    {},
    `/[?&]range=week/.test(location.hash) && window.asked.some((u) => u.endsWith('/stats/sounds?period=week')) && !document.querySelector('main .notice.error')`,
    `(() => { window.asked = []; const real = window.fetch; window.fetch = (u, i) => (window.asked.push(String(u)), real(u, i)); const select = document.querySelector('select.range-select'); if (select) { select.value = 'week'; select.dispatchEvent(new Event('change')); } else [...document.querySelectorAll('.range-presets button')].find((b) => b.textContent === '7 days').click(); })()`,
    // Back to 30 days, which the next page would otherwise open on
    `(() => { const select = document.querySelector('select.range-select'); if (select) { select.value = 'month'; select.dispatchEvent(new Event('change')); } else [...document.querySelectorAll('.range-presets button')].find((b) => b.textContent === '30 days').click(); })()`,
  ],
  // Every chart on the Overview is drawn, takes the arrow keys, and opens as a table
  [
    'stats/overview',
    'Stats: charts drawn, read with the keys and as tables',
    {},
    `(({ boxes, drawn, keys, folds, tables } = window.charts ?? {}) => boxes === 3 && drawn === boxes && keys === boxes && folds === boxes && tables === folds)()`,
    `(async () => { const wait = async (ok) => { for (let i = 0; i < 80 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); }; const boxes = [...document.querySelectorAll('.echart-box')]; await wait(() => boxes.every((b) => b.querySelector('svg'))); let keys = 0; for (const b of boxes) { b.focus(); const e = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }); b.dispatchEvent(e); keys += e.defaultPrevented; b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); b.blur(); } const folds = [...document.querySelectorAll('.chart > details')]; folds.forEach((f) => (f.open = true)); await wait(() => folds.every((f) => f.querySelector('table, p'))); window.charts = { boxes: boxes.length, drawn: boxes.filter((b) => b.querySelector('svg')).length, keys, folds: folds.length, tables: folds.filter((f) => f.querySelector('table, p')).length }; folds.forEach((f) => (f.open = false)); })()`,
  ],
  ['stats/recap', 'Stats: Monthly recap', {}, STATS_FIT],
  // Top games' buttons plain in its head, with no line of their own
  // (once it's drawn, which can be after the rest of the page on a slow machine)
  [
    'stats/overview',
    'Stats: Top games',
    {},
    `(async () => {
      for (let i = 0; i < 50 && !document.querySelector('.card-head .card-actions'); i++) await new Promise((r) => setTimeout(r, 100));
      const actions = [...document.querySelectorAll('.card-head .card-actions')];
      return actions.length > 0 && actions.every((a) => getComputedStyle(a).borderTopWidth === '0px');
    })()`,
  ],
  ['stats/overview', 'Stats: Overview’s counts on one line', {}, COUNTS_ONE_LINE],
  ['stats/overview', 'Stats: Overview’s views in sight', {}, TABS_IN_SIGHT],
  // Each container's lines apart, and none running out of its box
  [
    'health',
    'Health',
    {},
    `location.hash.startsWith('#health?range=') && !!document.querySelector('.health-tiles') && (() => { const rows = [...document.querySelectorAll('.health-container')]; return rows.length > 0 && rows.every((c) => { const parts = [...c.children].filter((x) => x.getClientRects().length); const boxes = parts.map((x) => x.getBoundingClientRect()); return parts.every((x) => x.scrollWidth <= x.clientWidth + 1) && boxes.every((a, i) => boxes.every((b, j) => j <= i || a.bottom <= b.top + 1 || b.bottom <= a.top + 1 || a.right <= b.left + 1 || b.right <= a.left + 1)); }); })()`,
  ],
  // Waits people expect on a tile of their own, each judged once there are enough, and a slow opening with where it was
  [
    'health',
    'Health: waits and a slow opening',
    {},
    `(() => { const text = document.querySelector('main').innerText; return /Waits people expect/.test(text) && /Chat answers: 24, 95% within [^,]+, typically [^,\\n]+\\n/.test(text) && /Songs starting: 3, .*, too few to judge/.test(text) && /Web UI: opening/.test(text) && /opened on Soundboard · away from home · on a phone/.test(text); })()`,
  ],
  // Health was a view in Stats
  ['stats/health?range=7d', 'Health: the old address', {}, `location.hash === '#health?range=7d' && document.title.startsWith('Health')`],
  // Chat tried here: asked something, answered with who it would ping, and nothing said aloud, as that's turned off
  [
    'chat',
    'Chat',
    { 'try-chat:speak': 'off' },
    `(() => { const bot = [...document.querySelectorAll('.try-line.bot')].at(-1); const you = [...document.querySelectorAll('.try-line.you')].at(-1); return !!bot && /Right away, @Ben!/.test(bot.textContent) && /Claude Haiku/.test(bot.textContent) && !/Answer in voice is off in Settings/.test(bot.textContent) && [...document.querySelectorAll('main .page-note')].filter((n) => !n.hidden).length === 1 && !document.querySelector('.try-chat-head').hidden && you?.querySelector('.mention')?.textContent === '@Ben' && !document.querySelector('.try-ask textarea').value && document.querySelector('.mention-picker').hidden; })()`,
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
  // A spoken answer can be added to the soundboard, named from its words, in the profile's voice and effect
  [
    'chat',
    'Chat: a spoken answer added to the soundboard',
    { 'try-chat:speak': 'off' },
    `(() => { const bot = [...document.querySelectorAll('.try-line.bot')].at(-1); const buttons = [...bot.querySelectorAll('.try-actions button')].map((b) => b.textContent); const dialog = document.querySelector('dialog.keep-line-dialog[open]'); return buttons.join('|') === 'Hear it|Add to soundboard' && !!dialog && dialog.querySelector('input[aria-label="Sound name"]').value === 'right-away-ben' && /^In .+/.test(dialog.querySelector('.keep-line-said + .hint').textContent); })()`,
    // Answer in voice on while it answers, so it's said, and off again after, as the other pages expect
    `(async () => { const setting = (method, json) => fetch('/api/guilds/${GUILD}/settings/chatVoice', { method, headers: { 'x-slopkeeper': '1', 'content-type': 'application/json' }, body: json && JSON.stringify(json) }); await setting('PUT', { value: 'also' }); const box = document.querySelector('.try-ask textarea'); box.value = 'hello'; box.dispatchEvent(new Event('input')); document.querySelector('.try-ask').requestSubmit(); for (let i = 0; i < 80 && ![...document.querySelectorAll('.try-line.bot')].at(-1)?.querySelector('.try-actions'); i++) await new Promise((r) => setTimeout(r, 100)); await setting('DELETE'); [...[...document.querySelectorAll('.try-line.bot')].at(-1).querySelectorAll('.try-actions button')].at(-1).click(); })()`,
  ],
  // The @ list, open on what's typed, with the one picked marked
  [
    'chat',
    'Chat: the @ list',
    { 'try-chat:speak': 'off' },
    `(() => { const list = document.querySelector('.mention-picker'); const shown = [...list.querySelectorAll('.mention-choice')]; return !list.hidden && shown.length === 3 && shown[1].getAttribute('aria-selected') === 'true' && document.querySelector('.try-ask textarea').getAttribute('aria-activedescendant') === shown[1].id; })()`,
    `(() => { const box = document.querySelector('.try-ask textarea'); box.focus(); box.value = 'roast @'; box.setSelectionRange(7, 7); box.dispatchEvent(new Event('input')); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`,
  ],
  // Said from the Soundboard (the bot's answer stubbed, as there's no voice here): the line can be added to the soundboard
  [
    'board',
    'Soundboard: add the last line said',
    {},
    `(() => { const keep = document.querySelector('.say-body .keep-line'); const dialog = document.querySelector('dialog.keep-line-dialog[open]'); const box = keep.getBoundingClientRect(); return window.sent?.[0]?.[0] === '/say' && !keep.hidden && keep.querySelector('.keep-line-quote').textContent === 'I’m Chuck Schumer and I approve this message' && box.height < 34 && box.right <= keep.parentElement.getBoundingClientRect().right + 1 && !!dialog && dialog.querySelector('h2').textContent === 'Add to the soundboard' && dialog.querySelector('input[aria-label="Sound name"]').value === 'im-chuck-schumer-and-i-approve' && dialog.querySelector('.keep-line-said').textContent === 'I’m Chuck Schumer and I approve this message' && /^In .+/.test(dialog.querySelector('.keep-line-said + .hint').textContent) && !dialog.querySelector('button[type=submit]').disabled; })()`,
    `(async () => { ${SAY_STUB} const box = document.querySelector('.say-form .say-field'); box.value = 'I’m Chuck Schumer and I approve this message'; box.form.requestSubmit(); const keep = document.querySelector('.say-body .keep-line'); for (let i = 0; i < 50 && keep.hidden; i++) await new Promise((r) => setTimeout(r, 100)); keep.click(); })()`,
  ],
  // And from the Sounds panel, saved: what's sent, the toast, and the button gone
  [
    'activity',
    'Sounds panel: add the last line said',
    {},
    `(() => { const [, json] = window.sent?.[1] ?? []; return window.sent?.[1]?.[0] === '/say/sound' && json.text === 'good game everyone' && json.name === 'good-game-everyone' && json.voice === document.querySelector('.sounds-say .say-voice').value && json.replace === false && json.keep === false && typeof json.discord === 'boolean' && !document.querySelector('dialog[open]') && document.querySelector('.sounds-float .keep-line').hidden && /Added good-game-everyone to the soundboard\./.test(document.body.innerText); })()`,
    `(async () => { ${SAY_STUB} const wait = async (ok) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); }; document.querySelector('.sounds-fab').click(); await wait(() => !document.querySelector('.sounds-say').hidden); const box = document.querySelector('.sounds-say .say-field'); box.value = 'good game everyone'; box.form.requestSubmit(); const keep = document.querySelector('.sounds-float .keep-line'); await wait(() => !keep.hidden); keep.click(); await wait(() => !!document.querySelector('dialog.keep-line-dialog[open] button[type=submit]:not([disabled])')); document.querySelector('dialog.keep-line-dialog[open] form').requestSubmit(); })()`,
  ],
  ['activity', 'Activity'],
  ['chat', 'Chat: Ask as, In and Profile lined up on a phone', {}, `innerWidth > 640 || (() => { const lefts = [...document.querySelectorAll('.try-options select')].map((n) => Math.round(n.getBoundingClientRect().left)); return lefts.length >= 2 && new Set(lefts).size === 1; })()`],
  // Away from the Soundboard and Music, the Sounds panel has Play in at its top
  [
    'activity',
    'Sounds panel: its own Play in',
    {},
    `(() => { const panel = document.querySelector('.sounds-float'); const say = panel.querySelector('.sounds-say'); const top = (n) => Math.round(n.getBoundingClientRect().top); const [voice, effect, preview] = [say.querySelector('.say-voice'), say.querySelector('.say-effect'), say.lastElementChild]; return !panel.hidden && panel.querySelector('.sounds-head + .play-in select')?.ariaLabel === 'Play in' && !say.hidden && top(say.querySelector('.say-field')) === top(say.querySelector('.say-send')) && top(voice) === top(effect) && top(effect) === top(preview) && top(voice) > top(say.querySelector('.say-field')); })()`,
    `document.querySelector('.sounds-fab').click()`,
  ],
  // With the music player showing, the corner's round buttons sit beside it on a computer and above it on a phone, as
  // round icons, and Stop goes above them rather than moving them
  [
    'games/deals',
    'Corner buttons beside the music player',
    {},
    `(() => {
      // Shown here, as the bot's own word that nothing's playing may have hidden it since
      document.querySelector('.dock-row .stop-all').hidden = false;
      const player = document.querySelector('.mini-player').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.dock-row .volume-fab')].map((b) => b.getBoundingClientRect());
      const stop = document.querySelector('.dock-row .stop-all').getBoundingClientRect();
      const placed = innerWidth <= 640 ? buttons.every((b) => b.bottom <= player.top) : buttons.every((b) => b.left >= player.right && b.bottom > player.top);
      const still = buttons.every((b, i) => Math.abs(b.top - window.buttonsAt[i]) < 1);
      return buttons.length === 2 && placed && still && stop.height > 0 && stop.bottom <= Math.min(...buttons.map((b) => b.top)) && buttons.every((b) => b.width <= 48.5);
    })()`,
    `(() => { document.documentElement.classList.add('with-player'); document.querySelector('.mini-player').hidden = false; window.buttonsAt = [...document.querySelectorAll('.dock-row .volume-fab')].map((b) => b.getBoundingClientRect().top); document.querySelector('.dock-row .stop-all').hidden = false; })()`,
  ],
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
  // A setting changed elsewhere, as from another tab or /setup, shows without the page asking for them all again
  [
    'settings/pings',
    'Settings: a change made elsewhere',
    {},
    `document.getElementById('setting-hopOnMinPeople').value === '7' && window.asked.length === 0`,
    `(async () => { window.asked = []; const real = window.fetch; window.fetch = (u, i) => (/\\/settings$/.test(String(u)) && window.asked.push(String(u)), real(u, i)); await real('/api/guilds/${GUILD}/settings/hopOnMinPeople', { method: 'PUT', headers: { 'x-slopkeeper': '1', 'content-type': 'application/json' }, body: JSON.stringify({ value: 7 }) }); })()`,
    `fetch('/api/guilds/${GUILD}/settings/hopOnMinPeople', { method: 'DELETE', headers: { 'x-slopkeeper': '1' } })`,
  ],
  ['settings/games', 'Settings: Games'],
  ['settings/deals', 'Settings: Deals', {}, `!!document.querySelector('#settings-free-games') && [...document.querySelectorAll('#settings-section-deals details.preview')].length === 2`],
  // Join sounds with their list under them, and their delay and cooldown folded away
  // Each person's join sound with Remove beside it, and More in the hints without spacing their lines out
  ['settings/soundboard', 'Settings: Soundboard', {}, `!!document.querySelector('#settings-join-sounds + #settings-join-sound-list') && !document.querySelector('#settings-join-sounds .more-options').open && !!document.querySelector('#setting-soundVolume[type=range]')`],
  ['settings/soundboard', 'Settings: Remove beside each join sound', {}, BESIDE('#settings-join-sound-list .beside-field', 'button')],
  ['settings/soundboard', 'Settings: More in a hint without spacing its lines out', {}, HINTS_EVEN],
  // This browser's switches beside their names, as every other switch is
  ['settings/basics', 'Settings: This browser', {}, BESIDE('#settings-this-browser .field', '.toggle')],
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
  // A note chat keeps, forgotten with a press and a second to be sure, and the list says there are none
  [
    'settings/chat',
    'Settings: a note forgotten',
    {},
    `/Nothing yet. People can ask it/.test(document.querySelector('#settings-chat-notes').textContent) && window.asked.length === 1`,
    `(() => { ${STUB(['/chat-notes/[^/]+$', 'DELETE', 200, { notes: [] }])} const b = document.querySelector('#settings-chat-notes .control button'); b.click(); b.click(); })()`,
  ],
  // Profiles: the one in use, and its settings
  [
    'settings/chat',
    'Settings: Edit a profile',
    {},
    `(() => { const d = document.querySelector('dialog[open]'); return !!d && /Edit A grumpy pirate/.test(d.textContent) && d.querySelectorAll('select').length === 6 && d.querySelector('#profile-swearing').value === 'freely' && d.querySelector('#profile-voice').value === 'scottish' && d.querySelector('#profile-effect').value === 'robot' && d.querySelector('#profile-nickname').value === 'Captain Grump' && /\\d+ of 1000 characters/.test(d.textContent); })()`,
    // A phone shows the button's icon, named in its title
    `[...[...document.querySelectorAll('#settings-profiles .profile-row')].find((r) => r.textContent.startsWith('A grumpy pirate')).querySelectorAll('button')].find((b) => (b.title || b.textContent) === 'Edit').click()`,
  ],
  // Each profile's buttons on one line, on a phone as icons beside Use and Try
  ['settings/chat', 'Settings: a profile’s buttons on one line', {}, ONE_LINE('#settings-profiles .profile-row .control')],
  // And each voice's beside it, rather than a row of their own under every voice
  ['settings/speech', 'Settings: a voice’s buttons beside it', {}, `${BESIDE('#settings-voices .voice-row', '.control')} && ${ONE_LINE('#settings-voices .voice-row .control')}`],
  // Added voices: one ready with speakers, one downloading and one that failed, and the ready one's settings
  // A switch turned off here: Saved beside it, and the settings that need it put away, from the update the bot sends back
  [
    'settings/speech',
    'Settings: a switch turned off hides what needs it',
    {},
    `(() => { const field = (id) => document.getElementById(id).closest('.field'); return !document.getElementById('setting-tts').checked && /Saved/.test(field('setting-tts').querySelector('.status').textContent) && field('setting-ttsMaxChars').classList.contains('off'); })()`,
    `document.getElementById('setting-tts').click()`,
    `fetch('/api/guilds/${GUILD}/settings/tts', { method: 'DELETE', headers: { 'x-slopkeeper': '1' } })`,
  ],
  [
    'settings/speech',
    'Settings: Edit a voice',
    {},
    `(() => { const d = document.querySelector('dialog[open]'); return !!d && /Edit Narrator/.test(d.textContent) && d.querySelectorAll('select').length === 5 && d.querySelector('#voice-effect').options.length === 16 && /Measured: Middle, -2.5 dB/.test(d.textContent) && [...d.querySelectorAll('button')].some((b) => b.textContent === 'Use measured') && /Downloading, 40%/.test(document.body.innerText) && /Couldn’t download/.test(document.body.innerText); })()`,
    `[...document.querySelectorAll('#settings-voices .voice-row')].find((r) => r.textContent.startsWith('Narrator')).querySelector('button:nth-child(2)').click()`,
  ],
  // A download moving on shows without the page asking for the voices: the bot asks the container, and tells the page
  [
    'settings/speech',
    'Settings: a download moves on',
    {},
    `/Downloading, 60%/.test(document.getElementById('settings-voices').innerText) && window.asked.length === 0`,
    async (page) => {
      await page.evaluate(`(() => { window.asked = []; const real = window.fetch; window.fetch = (u, i) => (/\\/voices$/.test(String(u)) && window.asked.push(String(u)), real(u, i)); })()`);
      butlerPercent = 60;
    },
    async () => {
      butlerPercent = 40;
      await refreshVoiceStates();
    },
  ],
  // A save the bot turns down says why in the dialog, and Save can be pressed again. The dialog's closed after, as a
  // problem showing would fail the page
  // A dialog taller than the screen opens on its first field, not on the part that scrolls
  [
    'settings/speech',
    'Settings: a long dialog starts on its first field',
    {},
    `(({ activeElement: a } = document) => a?.tagName === 'INPUT' && a.closest('dialog[open] .dialog-body') && a.value === 'Narrator')()`,
    `[...document.querySelectorAll('#settings-voices .voice-row')].find((r) => r.textContent.startsWith('Narrator')).querySelector('button:nth-child(2)').click()`,
    `document.querySelector('dialog[open]')?.close()`,
  ],
  [
    'settings/speech',
    'Settings: a voice the bot won’t save says why',
    {},
    `window.refused === 'That name is taken.|false'`,
    `(async () => { ${STUB(['/voices/[^/?]+$', 'PUT', 409, { error: 'That name is taken.' }])} [...document.querySelectorAll('#settings-voices .voice-row')].find((r) => r.textContent.startsWith('Narrator')).querySelector('button:nth-child(2)').click(); const d = document.querySelector('dialog[open]'); d.querySelector('form').requestSubmit(); const p = d.querySelector('[role=alert]'); for (let i = 0; i < 50 && p.hidden; i++) await new Promise((r) => setTimeout(r, 100)); window.refused = p.textContent + '|' + d.querySelector('button[type=submit]').disabled; d.close(); })()`,
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
      return face.getAttribute('aria-label') === 'Profile: Robot butler' && face.querySelector('.mono')?.textContent === 'RB' && document.querySelector('.profile-menu').hidden
        && (await (await fetch('/api/guilds/${GUILD}/settings').catch(() => null))?.json().catch(() => null))?.settings?.find?.((x) => x.key === 'chatProfile')?.value === 'butler';
    })()`,
    `(() => { document.querySelector('.profile-face').click(); [...document.querySelectorAll('.profile-menu-name')].find((n) => n.textContent === 'Robot butler').closest('button').click(); })()`,
    // The pirate back, as the pages after expect
    `(async () => {
      const face = document.querySelector('.profile-face');
      face.click();
      [...document.querySelectorAll('.profile-menu-name')].find((n) => n.textContent.startsWith('A grumpy pirate')).closest('button').click();
      for (let i = 0; i < 50 && face.getAttribute('aria-label') !== 'Profile: A grumpy pirate with a long name to wrap'; i++) await new Promise((r) => setTimeout(r, 100));
    })()`,
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
const elsewhere = process.env.SKIP_WEB_UI === '1';
const browserPath = elsewhere ? null : findBrowser();
if (!browserPath && process.env.CI && !elsewhere) throw new Error('The web UI test needs Chrome in CI, and none was found');
// Steam's answers are made up here, so there's no need to wait a second between them as the bot does. Deals and Settings
// ask about a few games, which took seconds and sometimes ran past the wait for a page
lookups.gapMs = 0;

/** How long the network has to be quiet before a page counts as settled, and how long to wait for that at most */
const QUIET_MS = 200;
const SETTLE_MS = 3000;
/** How long a case's check has to come true, after its action or once its page shows */
const CHECK_MS = 5000;

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
  stopFollowingDownloads();
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
  // A container on Health, and someone's join sound in Settings
  perf.gauge('container_up', 1, { container: 'web' });
  perf.gauge('container_memory_bytes', 60e6, { container: 'web' });
  perf.gauge('container_memory_limit_bytes', 134e6, { container: 'web' });
  db.prepare("INSERT INTO join_sounds (guild_id, user_id, name) VALUES (?, 'u1', 'airhorn')").run(GUILD);
  // Steam libraries, so Pick a game has games and its filters
  for (const [user, steam] of [['u1', '76561190000000001'], ['u2', '76561190000000002']]) {
    db.prepare('INSERT INTO steam_links (user_id, steam_id, refreshed_at) VALUES (?, ?, ?)').run(user, steam, Date.now());
    db.prepare("INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES (?, 489830, 'The Elder Scrolls V: Skyrim Special Edition', 600)").run(steam);
  }
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
  // A sale with every part a row can have, and a bundle, for Deals. The sale's of a game nobody here has, as a sale of one
  // everyone has, like Skyrim in both Steam libraries above, is for nobody and isn't shown
  const wanted = db.prepare("INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, 'Deep Rock Galactic', 548430, 'u1')").run(GUILD).lastInsertRowid;
  db.prepare("INSERT INTO game_wants (game_id, user_id) VALUES (?, 'u2')").run(wanted);
  db.prepare(
    "INSERT INTO sale_prices (country, appid, discount, was, price, final, store, store_off, store_url, store_name, keyshop, keyshop_url, currency, lowest) VALUES ('us', 548430, 75, '$39.99', '$9.99', 999, 799, 80, 'https://example.com/store', 'Green Man Gaming', 650, 'https://example.com/keys', 'USD', 649)",
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
  // Waits people expected, enough of chat's to judge, and a slow opening of the web UI, for Health's tile and slow list
  const minuteAgo = Math.floor(now / 60_000) * 60_000 - 5 * 60_000;
  const timed = db.prepare('INSERT INTO perf_minutes (at, span, name, labels, count, sum, max, buckets) VALUES (?, 1, ?, ?, ?, ?, ?, ?)');
  const bucketed = (upTo: number, n: number) => JSON.stringify(perf.BUCKETS.map((b) => (b === upTo ? n : 0)).concat(0));
  timed.run(minuteAgo, 'browser_request_seconds', JSON.stringify({ via: 'away', device: 'computer', kind: 'wait', what: 'chat' }), 24, 48, 4, bucketed(5, 24));
  timed.run(minuteAgo, 'browser_request_seconds', JSON.stringify({ via: 'away', device: 'phone', kind: 'wait', what: 'music' }), 3, 9, 4, bucketed(5, 3));
  db.prepare("INSERT INTO perf_slow (at, guild_id, what, seconds, steps, detail) VALUES (?, NULL, 'Web UI: opening', 4.5, ?, ?)").run(
    now - 10 * 60_000,
    JSON.stringify([['reaching the web UI', 0.4], ['loading its scripts', 0.7], ['drawing the page', 3.4]]),
    JSON.stringify({ via: 'away', device: 'phone', tab: 'board' }),
  );
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
/** How far the butler has got, which a case moves on */
let butlerPercent = 40;
/** The voice container's answer: the narrator downloaded, with speakers, the butler on its way, and the last one failed */
const containerReport = () => ({
  version: containerVersion,
  voices: {
    narrator: { state: 'ready', file: 'voice-narrator-0123456789ab', speakers: [{ id: 0, name: 'calm' }, { id: 1, name: 'an excitable speaker with a long name' }] },
    'robot-butler': { state: 'downloading', percent: butlerPercent },
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

test('every page of the web UI opens cleanly, on a computer and a phone', { skip: elsewhere ? 'run on its own (SKIP_WEB_UI=1)' : !browserPath && 'no Chrome or Chromium here', timeout: 240_000 }, async () => {
  seed();
  // The added voices go to the fake voice container, as the bot sends them as it starts
  await syncVoices();
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
  // What the page is still waiting for, but for live updates, which wait for news on purpose, and when that last changed
  const open = new Set<string>();
  let lastNetwork = performance.now();
  page.on((method, p) => {
    if (method === 'Network.requestWillBeSent' && !p.request.url.includes('/updates?')) open.add(p.requestId);
    else if (method !== 'Network.loadingFinished' && method !== 'Network.loadingFailed') return;
    else open.delete(p.requestId);
    lastNetwork = performance.now();
  });
  /** Until nothing's been asked for or answered for a moment, as what came back is drawn straight after */
  const settle = async () => {
    for (const end = performance.now() + SETTLE_MS; performance.now() < end; await sleep(25)) {
      if (!open.size && performance.now() - lastNetwork >= QUIET_MS) return;
    }
  };
  /** Until a case's check is true, or the time's up. One that throws, as the thing it looks at isn't there yet, isn't */
  const run = (step: Step) => (typeof step === 'string' ? page.evaluate(step) : step(page));
  const until = async (check: string) => {
    for (const end = performance.now() + CHECK_MS; performance.now() < end; await sleep(50)) {
      if (await page.evaluate<boolean>(check).catch(() => false)) return;
    }
  };
  await Promise.all(['Runtime.enable', 'Network.enable', 'Page.enable'].map((m) => page.send(m)));
  // Focus events fire as in a window that has the focus, which a headless one never does
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  // Signed in as someone who typed the password
  const login = await fetch(`${site}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slopkeeper': '1' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200, 'signed in');
  const [name, value] = login.headers.get('set-cookie')!.split(';')[0].split('=');
  await page.send('Network.setCookie', { name, value, url: site });

  const failures: string[] = [];
  for (const screen of SCREENS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile });
    // A phone's touch, so its bigger tap areas are what's tested
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: screen.mobile });
    for (const [hash, label, stored = {}, expect, act, putBack] of PAGES) {
      // A fresh page each time, with what it remembers set first, and chat's wait between questions over, as two pages ask
      // within seconds
      resetChat();
      await page.send('Page.navigate', { url: `${site}/#${hash}` });
      await page.evaluate(`localStorage.clear(); ${Object.entries(stored).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')} true`);
      problems = [];
      // What the last page left waiting is cancelled as it goes
      open.clear();
      lastNetwork = performance.now();
      await page.send('Page.reload', { ignoreCache: true });
      // Until it's shown something other than "Loading…", then until what follows has come and been drawn
      const shown = await (async () => {
        for (let i = 0; i < 200; i++) {
          await sleep(50);
          const ready = await page.evaluate<boolean>(`(() => {
            const main = document.querySelector('main');
            return !!main && main.innerText.trim().length > 0 && !main.querySelector('.notice.loading') && !/Loading…/.test(main.innerText);
          })()`).catch(() => false);
          if (ready) return true;
        }
        return false;
      })();
      if (act && shown) {
        await settle();
        await run(act);
        // Without a check, there's nothing to say when it's done
        if (expect) await until(expect);
        else await sleep(1500);
      }
      // Some checks without an action do things themselves, so they're run once, once the page has settled
      await settle();
      const look = await page.evaluate<{ text: number; errors: string[]; wide: number; width: number; past: string[]; playInHeader: boolean }>(`(() => {
        const main = document.querySelector('main');
        return {
          text: main ? main.innerText.trim().length : 0,
          // Never in the header, so the header's the same on every page: it's on the pages that play, and in the Sounds panel
          playInHeader: (document.querySelector('header .play-in')?.getClientRects().length ?? 0) > 0,
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
      if (look.playInHeader) failures.push(`${where}: Play in is in the header`);
      for (const error of look.errors) failures.push(`${where}: shows "${error}"`);
      if (Math.max(look.wide, look.width) > screen.width + 1) failures.push(`${where}: scrolls sideways (${look.wide} px wide on a ${screen.width} px screen): ${look.past.join('; ')}`);
      for (const problem of problems) failures.push(`${where}: ${problem}`);
      if (putBack && shown) {
        await run(putBack);
        await settle();
      }
    }
  }
  page.close();
  assert.deepEqual(failures, []);
});
