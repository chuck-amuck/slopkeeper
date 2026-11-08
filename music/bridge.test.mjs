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
    log: quiet,
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
