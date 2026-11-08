import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createBridge, elfProblem, FRAME_BYTES, parseVersion, tarGz, untar } from './bridge.mjs';

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

/** A bridge with a stand-in for Soloist, which prints what it's told to and stays up until it exits with `code` */
async function bridge(options = {}, { code = null, say = 'xx yy: logged in as someone' } = {}) {
  const script = `console.log(${JSON.stringify(say)}); ${code === null ? 'setInterval(() => {}, 1000)' : `setTimeout(() => process.exit(${code}), 50)`}`;
  const b = createBridge({
    dataDir: temp(),
    port: 0,
    token: TOKEN,
    apiKey: 'the-key',
    consent: true,
    pulse: false,
    wsPort: 1,
    // Soloist's own options follow, which the stand-in ignores
    soloistCommand: [process.execPath, '-e', script, '--'],
    spotifyPlayback: true,
    log: quiet,
    ...youtubeFake,
    ...options,
  });
  running.push(b);
  await b.start();
  return { b, base: `http://127.0.0.1:${b.server.address().port}` };
}

const ask = (base, where, init = {}) => fetch(base + where, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } });

/** A minimal 64-bit ELF header for a CPU */
const elf = (machine) => {
  const head = Buffer.alloc(64);
  head.writeUInt32BE(0x7f454c46, 0);
  head[4] = 2;
  head.writeUInt16LE(machine, 18);
  return head;
};

test('reads tar archives, keeping nothing that could land outside where it’s unpacked', () => {
  const archive = tarGz([
    { name: 'soloist_release/soloist', data: Buffer.from('binary') },
    { name: '../escape', data: Buffer.from('x') },
    { name: '/etc/passwd', data: Buffer.from('x') },
    { name: 'a/../../escape', data: Buffer.from('x') },
  ]);
  const entries = untar(archive);
  assert.deepEqual(
    entries.map((e) => [e.name, String(e.data)]),
    [['soloist_release/soloist', 'binary']],
  );
});

test('only a 64-bit Linux binary for this CPU is accepted', () => {
  assert.equal(elfProblem(elf(0x3e), 0x3e), null);
  assert.equal(elfProblem(elf(0xb7), 0x3e), 'built for another CPU');
  assert.equal(elfProblem(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(64)), 0x3e), 'not an ELF binary');
  const thirtyTwo = elf(0x3e);
  thirtyTwo[4] = 1;
  assert.equal(elfProblem(thirtyTwo, 0x3e), 'not a 64-bit binary');
});

test('reads the version and build date', () => {
  assert.deepEqual(parseVersion('soloist 1.3.10.51 build 1793988108 (20261106) linux x86_64\n'), { version: '1.3.10.51', built: Date.UTC(2026, 10, 6) });
  assert.equal(parseVersion('something else'), null);
});

test('everything needs the token, and only known commands go through', async () => {
  const { b, base } = await bridge();
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  assert.equal((await fetch(`${base}/audio`, { headers: { authorization: 'Bearer music-tokem' } })).status, 401);
  const status = await (await ask(base, '/status')).json();
  assert.equal(status.state, 'running');
  await sleep(200);
  assert.equal(b.status.account, 'someone', 'the account is read from what Soloist prints');
  const command = (body) => ask(base, '/command', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await command({ command: 'rm -rf' })).status, 400);
  assert.equal((await ask(base, '/command', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await command({ command: 'pause' })).status, 503, 'with no player connected, it says so');
});

test('without the key or the consent nothing is downloaded, and it says why', async () => {
  let downloads = 0;
  const cdn = http.createServer((req, res) => void (downloads++, res.end()));
  await new Promise((r) => cdn.listen(0, r));
  const options = { soloistCommand: undefined, cdn: `http://127.0.0.1:${cdn.address().port}/{arch}` };
  assert.equal((await bridge({ ...options, apiKey: '' })).b.status.state, 'no-key');
  assert.equal((await bridge({ ...options, consent: false })).b.status.state, 'no-consent');
  assert.equal(downloads, 0);
  cdn.close();
});

test('a download that isn’t a working build is refused, and says why', async () => {
  const served = [];
  const cdn = http.createServer((req, res) => res.end(served.shift()));
  await new Promise((r) => cdn.listen(0, r));
  const options = { soloistCommand: undefined, cdn: `http://127.0.0.1:${cdn.address().port}/{arch}`, arch: { name: 'x86_64', machine: process.arch === 'arm64' ? 0xb7 : 0x3e } };
  served.push(tarGz([{ name: 'soloist', data: Buffer.from('not a program') }]));
  const notElf = await bridge(options);
  assert.equal(notElf.b.status.state, 'failed');
  assert.match(notElf.b.status.message, /not an ELF binary/);
  // A real program, which isn't Soloist
  served.push(tarGz([{ name: 'soloist', data: fs.readFileSync('/bin/true') }]));
  const wrong = await bridge(options);
  assert.match(wrong.b.status.message, /doesn't run: unexpected version output/);
  served.push(tarGz([{ name: 'README', data: Buffer.from('hi') }]));
  assert.match((await bridge(options)).b.status.message, /no soloist binary/);
  cdn.close();
});

test('an expired build is downloaded again, and if that fails it stops and says why', async () => {
  let downloads = 0;
  const cdn = http.createServer((req, res) => {
    downloads++;
    res.writeHead(500).end();
  });
  await new Promise((r) => cdn.listen(0, r));
  const { b } = await bridge({ cdn: `http://127.0.0.1:${cdn.address().port}/{arch}` }, { code: 10, say: 'expired' });
  for (let i = 0; i < 50 && b.status.state !== 'failed'; i++) await sleep(20);
  assert.equal(downloads, 1);
  assert.equal(b.status.state, 'failed');
  assert.match(b.status.message, /HTTP 500/);
  cdn.close();
});

test('the key never reaches the logs', async () => {
  const lines = [];
  await bridge({ log: (...args) => lines.push(args.join(' ')) }, { say: 'starting with key the-key now' });
  await sleep(200);
  assert.ok(lines.some((l) => l.includes('starting with key <key> now')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('the-key')));
});

test('a pairing from SOLOIST_SESSION is put in place once, and only its own files', async () => {
  const session = tarGz([
    { name: 'settings/Users/someone/prefs', data: Buffer.from('paired') },
    { name: 'cache/client_token', data: Buffer.from('token') },
    { name: 'cache/other', data: Buffer.from('not part of a pairing') },
  ]).toString('base64');
  const dataDir = temp();
  await bridge({ dataDir, session });
  assert.equal(fs.readFileSync(path.join(dataDir, 'soloist/settings/Users/someone/prefs'), 'utf8'), 'paired');
  assert.equal(fs.readFileSync(path.join(dataDir, 'soloist/cache/client_token'), 'utf8'), 'token');
  assert.ok(!fs.existsSync(path.join(dataDir, 'soloist/cache/other')));
  // Already paired here, perhaps to another account since: left alone
  fs.writeFileSync(path.join(dataDir, 'soloist/settings/Users/someone/prefs'), 'newer');
  await bridge({ dataDir, session });
  assert.equal(fs.readFileSync(path.join(dataDir, 'soloist/settings/Users/someone/prefs'), 'utf8'), 'newer');
  // A pairing with nobody signed in would only stop the volume taking a real one later
  const lines = [];
  const empty = temp();
  await bridge({ dataDir: empty, session: tarGz([{ name: 'cache/client_token', data: Buffer.from('token') }]).toString('base64'), log: (...args) => lines.push(args.join(' ')) });
  assert.ok(!fs.existsSync(path.join(empty, 'soloist/cache/client_token')));
  assert.ok(lines.some((l) => l.includes('no signed-in account')), lines.join('\n'));
});

test('audio passes through in whole samples, at the pace it’s played', { skip: spawnSync('mkfifo', ['--version']).status !== 0 }, async () => {
  const dir = temp();
  const fifo = path.join(dir, 'audio.fifo');
  spawnSync('mkfifo', [fifo]);
  // Held open both ways, as PulseAudio does, so neither end waits on the other
  const writer = fs.openSync(fifo, 'r+');
  const { base } = await bridge({ fifo });
  const res = await ask(base, '/audio');
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const second = Buffer.alloc(FRAME_BYTES * 50);
  for (let i = 0; i < second.length; i++) second[i] = i % 251;
  // Half a sample short, which waits for the rest. More than a pipe holds, so it's written off the main thread while the bridge reads
  const writing = promisify(fs.write)(writer, second.subarray(0, second.length - 2));
  const started = Date.now();
  const got = [];
  let length = 0;
  void writing.then(() => setTimeout(() => fs.writeSync(writer, second.subarray(second.length - 2)), 300));
  while (length < second.length) {
    const { value } = await reader.read();
    assert.equal(value.length % 4, 0, 'whole samples only');
    got.push(value);
    length += value.length;
  }
  const took = Date.now() - started;
  assert.ok(took > 800, `paced to about a second of audio, took ${took} ms`);
  assert.ok(Buffer.concat(got).equals(second));
  await reader.cancel();
  fs.closeSync(writer);
});

const song = (n, extra = {}) => ({ uri: `spotify:track:${String(n).padStart(22, '0')}`, title: `Song ${n}`, artist: 'Band', durationMs: 4000, ...extra });
const fetchSong = (base, body) => ask(base, '/fetch', { method: 'POST', body: JSON.stringify(body) });
const runs = (dataDir) => (fs.existsSync(path.join(dataDir, 'runs.log')) ? fs.readFileSync(path.join(dataDir, 'runs.log'), 'utf8').trim().split('\n') : []);

test('with Spotify playback off, Soloist isn’t touched and YouTube still works', async () => {
  const dataDir = temp();
  const { b, base } = await bridge({ dataDir, spotifyPlayback: false });
  assert.equal(b.status.state, 'off');
  assert.deepEqual(b.status.youtube, { ready: true, version: '2026.10.26', message: '' });
  assert.ok(!fs.existsSync(path.join(dataDir, 'bin')), 'nothing was downloaded from Spotify');
  const res = await fetchSong(base, song(1));
  assert.equal(res.status, 200);
  const answer = await res.json();
  assert.equal(answer.source, 'youtube');
  assert.equal(fs.statSync(path.join(dataDir, 'audio', answer.file)).size, 4 * 1024);
});

test('each song is fetched once, however often or at once it’s asked for, and kept', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir, spotifyPlayback: false });
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
  const { base } = await bridge({ dataDir, spotifyPlayback: false, cacheBytes: 9 * 1024 });
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
  const { base } = await bridge({ dataDir, spotifyPlayback: false, cacheBytes: 1024 });
  const { file } = await (await fetchSong(base, song(1))).json();
  assert.ok(fs.existsSync(path.join(dataDir, 'audio', file)));
});

test('a song with no match, a failing yt-dlp and an odd answer each say so', async () => {
  const dataDir = temp();
  const { base } = await bridge({ dataDir, spotifyPlayback: false });
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
  const { base } = await bridge({ dataDir, spotifyPlayback: false });
  const url = 'https://www.youtube.com/watch?v=abc';
  const info = await ask(base, '/lookup', { method: 'POST', body: JSON.stringify({ url }) });
  assert.deepEqual(await info.json(), { url, title: 'A Video', artist: 'Someone', durationMs: 61000, cover: null });
  assert.equal(fs.readdirSync(path.join(dataDir, 'audio')).length, 0);
  assert.equal((await fetchSong(base, { url })).status, 200);
  assert.deepEqual(runs(dataDir), [`${url} info`, url]);
});

test('without a working yt-dlp, fetching says why', async () => {
  const { b, base } = await bridge({ spotifyPlayback: false, versionCommand: [process.execPath, '-e', 'process.exit(1)'], updateCommand: [process.execPath, '-e', 'process.exit(1)'] });
  assert.equal(b.status.youtube.ready, false);
  const res = await fetchSong(base, song(1));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /yt-dlp didn’t run/);
});
