import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBridge, LEFTOVERS } from './bridge.mjs';

const TOKEN = 'music-token';
const temp = () => fs.mkdtempSync(path.join(tmpdir(), 'slopkeeper-music-'));
const quiet = () => {};
const running = [];
after(() => Promise.all(running.map((b) => b.stop())));

/**
 * Stands in for fetch.py: a song called Missing isn't found, one called Broken stops without answering, and anything else
 * is "downloaded" as a file of a kilobyte per second of song. Each run is counted in runs.log
 */
const FAKE_FETCH = `
  const fs = require('node:fs');
  let raw = '';
  process.stdin.on('data', (c) => (raw += c)).on('end', () => {
    const r = JSON.parse(raw);
    fs.appendFileSync(r.dir + '/../runs.log', (r.uri ?? r.url) + (r.info ? ' info' : '') + '\\n');
    if (r.title === 'Broken') process.exit(1);
    if (r.title === 'Missing') return console.log(JSON.stringify({ error: 'No match on YouTube or SoundCloud.', missing: true }));
    if (r.title === 'Odd') return console.log(JSON.stringify({ file: '../escape.webm' }));
    if (r.info) return console.log(JSON.stringify({ url: r.url, title: 'A Video', artist: 'Someone', durationMs: 61000, cover: null }));
    setTimeout(() => {
      const file = 'youtube-' + (r.uri ?? r.url).replace(/\\W/g, '') + '.webm';
      fs.writeFileSync(r.dir + '/' + file, Buffer.alloc(Math.round((r.durationMs ?? 4000) / 1000) * 1024));
      console.log(JSON.stringify({ file, source: 'youtube', url: 'https://www.youtube.com/watch?v=x', title: r.title ?? 'A Video', durationMs: r.durationMs ?? 4000 }));
    }, 30);
  });
`;
const youtubeFake = { fetchCommand: [process.execPath, '-e', FAKE_FETCH], versionCommand: [process.execPath, '-e', 'console.log("2026.10.26")'], updateCommand: null };

/** A bridge with a stand-in for yt-dlp */
async function bridge(options = {}) {
  const b = createBridge({ dataDir: temp(), port: 0, token: TOKEN, log: quiet, ...youtubeFake, ...options });
  running.push(b);
  await b.start();
  return { b, base: `http://127.0.0.1:${b.server.address().port}` };
}

const ask = (base, where, init = {}) => fetch(base + where, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } });

const song = (n, extra = {}) => ({ uri: `spotify:track:${String(n).padStart(22, '0')}`, title: `Song ${n}`, artist: 'Band', durationMs: 4000, ...extra });

test('everything needs the token, and the status says whether yt-dlp is ready', async () => {
  const { base } = await bridge();
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { authorization: 'Bearer music-tokem' } })).status, 401);
  assert.deepEqual(await (await ask(base, '/status')).json(), { youtube: { ready: true, version: '2026.10.26', message: '' } });
  assert.equal((await ask(base, '/command', { method: 'POST', body: '{}' })).status, 404, 'Spotify’s player is gone');
  assert.equal((await ask(base, '/audio')).status, 404);
});

test('what Spotify Soloist left behind is deleted on start, and downloaded songs are kept', async () => {
  const dataDir = temp();
  for (const dir of LEFTOVERS) fs.mkdirSync(path.join(dataDir, dir, 'inside'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'audio'));
  fs.writeFileSync(path.join(dataDir, 'audio', 'youtube-kept.webm'), 'song');
  await bridge({ dataDir });
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['audio']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'audio', 'youtube-kept.webm'), 'utf8'), 'song');
});

const fetchSong = (base, body) => ask(base, '/fetch', { method: 'POST', body: JSON.stringify(body) });
const runs = (dataDir) => (fs.existsSync(path.join(dataDir, 'runs.log')) ? fs.readFileSync(path.join(dataDir, 'runs.log'), 'utf8').trim().split('\n') : []);

test('a song is found and downloaded into the shared folder', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir });
  const res = await fetchSong(base, song(1));
  assert.equal(res.status, 200);
  const answer = await res.json();
  assert.equal(answer.source, 'youtube');
  assert.equal(fs.statSync(path.join(dataDir, 'audio', answer.file)).size, 4 * 1024);
});

test('each song is fetched once, however often or at once it’s asked for, and kept', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir });
  const answers = await Promise.all([1, 2, 3].map(() => fetchSong(base, song(1)).then((r) => r.json())));
  assert.equal(new Set(answers.map((a) => a.file)).size, 1);
  await fetchSong(base, song(1));
  assert.deepEqual(runs(dataDir), [song(1).uri]);
  // Gone from the folder, it's fetched again
  fs.rmSync(path.join(dataDir, 'audio', answers[0].file));
  assert.equal((await fetchSong(base, song(1))).status, 200);
  assert.equal(runs(dataDir).length, 2);
});

test('the least recently played audio goes once the folder is over its cap', async () => {
  const dataDir = temp();
  // Room for two four-second songs
  const { base } = await bridge({ dataDir, cacheBytes: 9 * 1024 });
  const file = async (n) => (await (await fetchSong(base, song(n))).json()).file;
  const one = await file(1);
  await sleep(20);
  const two = await file(2);
  await sleep(20);
  await file(1);
  await sleep(20);
  await file(3);
  const left = fs.readdirSync(path.join(dataDir, 'audio')).filter((f) => f !== 'index.json');
  assert.deepEqual(left.sort(), [one, path.basename(left.find((f) => f.includes('3')))].sort(), 'song 2 went, as song 1 was played since');
  assert.ok(!left.includes(two));
  await file(2);
  assert.equal(runs(dataDir).filter((r) => r === song(2).uri).length, 2, 'and is fetched again when it’s wanted');
});

test('a song bigger than the whole cap is still kept, since it’s about to play', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir, cacheBytes: 1024 });
  const { file } = await (await fetchSong(base, song(1))).json();
  assert.ok(fs.existsSync(path.join(dataDir, 'audio', file)));
});

test('a song with no match, a failing yt-dlp and an odd answer each say so', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir });
  const missing = await fetchSong(base, song(1, { title: 'Missing' }));
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /No match/);
  const broken = await fetchSong(base, song(2, { title: 'Broken' }));
  assert.equal(broken.status, 502);
  assert.match((await broken.json()).error, /without an answer/);
  assert.equal((await fetchSong(base, song(3, { title: 'Odd' }))).status, 502);
  assert.ok(!fs.existsSync(path.join(dataDir, 'escape.webm')));
  assert.equal((await fetchSong(base, { title: 'no uri' })).status, 400);
  assert.equal((await fetchSong(base, { url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await ask(base, '/fetch', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/fetch`, { method: 'POST', body: JSON.stringify(song(4)) })).status, 401);
});

test('a link can be looked up without downloading, and downloaded when it plays', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir });
  const url = 'https://www.youtube.com/watch?v=abc';
  const info = await ask(base, '/lookup', { method: 'POST', body: JSON.stringify({ url }) });
  assert.deepEqual(await info.json(), { url, title: 'A Video', artist: 'Someone', durationMs: 61000, cover: null });
  assert.equal(fs.readdirSync(path.join(dataDir, 'audio')).length, 0);
  assert.equal((await fetchSong(base, { url })).status, 200);
  assert.deepEqual(runs(dataDir), [`${url} info`, url]);
});

test('without a working yt-dlp, fetching says why', async () => {
  const { b, base } = await bridge({ versionCommand: [process.execPath, '-e', 'process.exit(1)'], updateCommand: [process.execPath, '-e', 'process.exit(1)'] });
  assert.equal(b.status.youtube.ready, false);
  const res = await fetchSong(base, song(1));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /yt-dlp didn’t run/);
});
