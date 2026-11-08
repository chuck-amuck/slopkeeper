// The music container: runs Spotify Soloist, Spotify's own headless player, and hands its audio and controls to the bot.
// Soloist can't be shipped in a public image, so it's downloaded from Spotify on start, once the host has accepted its terms
import { execFile, spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

// 20 ms of 48 kHz 16-bit stereo, the frame the bot mixes
export const FRAME_BYTES = 3840;
const FRAME_MS = 20;
const DAY = 86_400_000;
// Builds stop working this long after they're made, and are replaced well before then
const LIFETIME_DAYS = 90;
const REFRESH_DAYS = 14;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const CDN = 'https://soloist-builds.spotifycdn.com/soloist_release_{arch}.tar.gz';
// Node's name for the CPU → Spotify's name for the build, and the ELF machine number the binary must have
const ARCHES = { x64: { name: 'x86_64', machine: 0x3e }, arm64: { name: 'arm64', machine: 0xb7 } };
// Soloist exits with this once its build has expired
const EXPIRED = 10;
const COMMANDS = new Set(['play', 'pause', 'skip_next', 'skip_prev', 'seek', 'set_volume', 'activate', 'deactivate', 'add_to_queue', 'get_state', 'get_queue']);

/** A gzipped tar's regular files and folders. Only plain names are kept, so nothing can be written outside where it's unpacked */
export function untar(gz) {
  const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_ARCHIVE * 4 });
  const entries = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const text = (from, len) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const prefix = text(345, 155);
    const name = path.posix.normalize((prefix ? `${prefix}/` : '') + text(0, 100)).replace(/^\.\//, '').replace(/\/$/, '');
    const type = text(156, 1) || '0';
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (name.startsWith('/') || name.split('/').includes('..') || name === '.') continue;
    if (type === '0' || type === '5') entries.push({ name, dir: type === '5', data, mode: parseInt(text(100, 8).trim() || '644', 8) });
  }
  return entries;
}

/** Gzipped tar of these files, for carrying a pairing to another machine */
export function tarGz(files) {
  const blocks = [];
  for (const { name, data } of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000600\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** The files that hold a pairing. The rest of Soloist's data is history and caches it rebuilds */
export const SESSION_FILES = ['.device_id', 'settings', 'cache/client_token', 'cache/device_settings', 'cache/user_settings', 'cache/hosts.bnk', 'cache/dbrts'];

/** Why the file isn't a Linux binary for this CPU, or null if it is */
export function elfProblem(data, machine) {
  if (data.length < 20 || data.readUInt32BE(0) !== 0x7f454c46) return 'not an ELF binary';
  if (data[4] !== 2) return 'not a 64-bit binary';
  if (data.readUInt16LE(18) !== machine) return 'built for another CPU';
  return null;
}

/** Version and build date from `soloist --version` */
export function parseVersion(text) {
  const m = /soloist (\S+) build \d+ \((\d{4})(\d{2})(\d{2})\)/.exec(text);
  return m ? { version: m[1], built: Date.UTC(+m[2], +m[3] - 1, +m[4]) } : null;
}

export function createBridge(options = {}) {
  const env = process.env;
  const o = {
    dataDir: env.DATA_DIR || '/data',
    port: Number(env.PORT || 7700),
    token: env.MUSIC_TOKEN || '',
    apiKey: env.SOLOIST_API_KEY || '',
    consent: env.SOLOIST_ACCEPT_TERMS === 'true',
    session: env.SOLOIST_SESSION || '',
    deviceName: env.MUSIC_DEVICE_NAME || 'Slopkeeper',
    wsPort: 37901,
    cdn: CDN,
    arch: ARCHES[process.arch],
    // How Soloist and PulseAudio are started; tests swap these for fakes
    soloistCommand: undefined,
    pulse: true,
    log: (...args) => console.log(...args),
    ...options,
  };
  const binDir = path.join(o.dataDir, 'bin');
  const binary = path.join(binDir, 'soloist');
  const metaFile = path.join(binDir, 'meta.json');
  const soloistDir = path.join(o.dataDir, 'soloist');
  const runDir = path.join(o.dataDir, 'run');
  const fifo = o.fifo ?? path.join(runDir, 'audio.fifo');
  const socket = path.join(runDir, 'pulse.sock');
  const redact = (text) => (o.apiKey ? text.split(o.apiKey).join('<key>') : text);

  const status = { state: 'starting', message: '', version: null, expiresAt: null, loggedIn: false, account: null, active: false, volume: null, playback: null };
  const sse = new Set();
  const listeners = new Set();
  let ws;
  let soloist;
  let pulse;
  let stopped = false;
  let restartWhenIdle = false;
  let refreshTimer;
  let pingTimer;
  let paceTimer;
  let fifoFd;
  let carry = Buffer.alloc(0);

  const broadcast = (event, data) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(line);
  };
  const setStatus = (changes) => {
    Object.assign(status, changes);
    broadcast('status', status);
  };

  const meta = () => {
    try {
      return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      return {};
    }
  };

  async function versionOf(file) {
    const { stdout } = await promisify(execFile)(file, ['--version'], { timeout: 15_000 });
    const parsed = parseVersion(stdout);
    if (!parsed) throw new Error(`unexpected version output: ${stdout.trim().slice(0, 200)}`);
    return parsed;
  }

  const url = () => o.cdn.replace('{arch}', o.arch.name);

  /** Downloads the current build, checks it, and swaps it in. The old one stays if anything goes wrong */
  async function download() {
    if (status.state !== 'running') setStatus({ state: 'downloading', message: 'Downloading Spotify Soloist' });
    const res = await fetch(url(), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const archive = Buffer.from(await res.arrayBuffer());
    if (archive.length > MAX_ARCHIVE) throw new Error('download is larger than any real build');
    const entry = untar(archive).find((e) => !e.dir && path.posix.basename(e.name) === 'soloist');
    if (!entry) throw new Error('the download has no soloist binary in it');
    const problem = elfProblem(entry.data, o.arch.machine);
    if (problem) throw new Error(`the downloaded soloist is ${problem}`);
    fs.mkdirSync(binDir, { recursive: true });
    const fresh = `${binary}.new`;
    fs.writeFileSync(fresh, entry.data, { mode: 0o755 });
    let info;
    try {
      info = await versionOf(fresh);
    } catch (err) {
      fs.rmSync(fresh, { force: true });
      throw new Error(`the downloaded soloist doesn't run: ${err.message}`);
    }
    fs.renameSync(fresh, binary);
    fs.writeFileSync(metaFile, JSON.stringify({ etag: res.headers.get('etag'), ...info }));
    o.log(`Installed Spotify Soloist ${info.version}`);
    return info;
  }

  /** A build that runs and isn't close to expiring, downloading one if needed. Returns null if there's none */
  async function ensureBinary(force = false) {
    let info = null;
    try {
      if (fs.existsSync(binary)) info = await versionOf(binary);
    } catch (err) {
      o.log('Installed Soloist build failed to run:', err.message);
    }
    const fresh = info && info.built + (LIFETIME_DAYS - REFRESH_DAYS) * DAY > Date.now();
    if (force || !fresh) {
      try {
        info = await download();
      } catch (err) {
        o.log('Soloist download failed:', err.message);
        // An older build still works until it expires
        if (!info || info.built + LIFETIME_DAYS * DAY <= Date.now()) {
          setStatus({ state: 'failed', message: `Couldn’t download Spotify Soloist: ${err.message}` });
          return null;
        }
      }
    }
    setStatus({ version: info.version, expiresAt: info.built + LIFETIME_DAYS * DAY });
    return info;
  }

  /** Daily: picks up a new build from Spotify, and restarts onto it once nothing is playing */
  async function refresh() {
    let changed = false;
    try {
      const res = await fetch(url(), { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
      const etag = res.headers.get('etag');
      changed = !!etag && etag !== meta().etag;
    } catch (err) {
      o.log('Couldn’t check for a new Soloist build:', err.message);
    }
    const before = meta().version;
    const info = await ensureBinary(changed);
    if (!info || info.version === before) return;
    const dueSoon = info && status.expiresAt && status.expiresAt - Date.now() < DAY;
    if (status.playback?.status === 'playing' && !dueSoon) restartWhenIdle = true;
    else restartSoloist();
  }

  /** Puts a pairing made elsewhere in place, if this one has never been paired */
  function importSession() {
    if (!o.session) return;
    const users = path.join(soloistDir, 'settings', 'Users');
    if (fs.existsSync(users) && fs.readdirSync(users).length) return;
    try {
      const entries = untar(Buffer.from(o.session, 'base64')).filter((e) => SESSION_FILES.some((f) => e.name === f || e.name.startsWith(`${f}/`)));
      if (!entries.some((e) => e.name.startsWith('settings/Users/'))) throw new Error('it has no signed-in account in it');
      for (const e of entries) {
        const target = path.join(soloistDir, e.name);
        if (e.dir) fs.mkdirSync(target, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, e.data, { mode: 0o600 });
        }
      }
      o.log('Imported the Spotify pairing from SOLOIST_SESSION');
    } catch (err) {
      o.log('SOLOIST_SESSION couldn’t be used:', err.message);
    }
  }

  async function startPulse() {
    if (!o.pulse) return;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    pulse = spawn(
      'pulseaudio',
      [
        '-n',
        '--daemonize=no',
        '--use-pid-file=no',
        '--exit-idle-time=-1',
        '--disallow-exit',
        '--log-target=stderr',
        '-L',
        `module-native-protocol-unix socket=${socket} auth-anonymous=1`,
        // Its only output is a pipe of exactly what the bot mixes, so nothing needs converting
        '-L',
        `module-pipe-sink file=${fifo} sink_name=music format=s16le rate=48000 channels=2`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: runDir, XDG_RUNTIME_DIR: runDir } },
    );
    let errors = '';
    pulse.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-2000)));
    pulse.once('exit', (code) => {
      if (stopped) return;
      o.log(`PulseAudio exited (${code}): ${errors.trim().split('\n').at(-1) ?? ''}`);
      // Soloist holds on to the dead server, so both start again
      soloist?.kill('SIGTERM');
    });
    for (let i = 0; i < 100 && !(fs.existsSync(socket) && fs.existsSync(fifo)); i++) await sleep(100);
    if (!fs.existsSync(fifo)) throw new Error(`PulseAudio didn’t start: ${errors.trim().slice(-300)}`);
  }

  function spawnSoloist() {
    fs.mkdirSync(soloistDir, { recursive: true, mode: 0o700 });
    const args = ['-n', o.deviceName, '-k', o.apiKey, '-D', soloistDir, '-C', path.join(o.dataDir, 'cache'), '-z', '200', '-i', '100', '-w', `127.0.0.1:${o.wsPort}`];
    const [command, ...prefix] = o.soloistCommand ?? [binary];
    return spawn(command, [...prefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: runDir, PULSE_SERVER: `unix:${socket}`, PULSE_SINK: 'music' },
    });
  }

  let backoff = 2_000;
  async function runSoloist() {
    while (!stopped) {
      if (o.pulse && (!pulse || pulse.exitCode !== null)) await startPulse();
      const started = Date.now();
      soloist = spawnSoloist();
      const lines = (chunk) => {
        for (const line of redact(String(chunk)).split('\n').filter(Boolean)) {
          const account = /logged in as (.+)$/.exec(line);
          if (account) setStatus({ account: account[1].trim() });
          o.log(`soloist: ${line.replace(/^\S+ \S+: /, '')}`);
        }
      };
      soloist.stdout.on('data', lines);
      soloist.stderr.on('data', lines);
      setStatus({ state: 'running', message: '' });
      connectWs();
      const code = await new Promise((resolve) => soloist.once('exit', resolve));
      ws?.close();
      setStatus({ loggedIn: false, active: false, playback: null });
      if (stopped) return;
      o.log(`Soloist exited (${code})`);
      if (code === EXPIRED && !(await ensureBinary(true))) return;
      backoff = Date.now() - started > 60_000 ? 2_000 : Math.min(backoff * 2, 60_000);
      setStatus({ state: 'starting', message: 'Spotify Soloist stopped, starting it again' });
      await sleep(backoff);
    }
  }

  function restartSoloist() {
    restartWhenIdle = false;
    soloist?.kill('SIGTERM');
  }

  function connectWs() {
    // Each run of Soloist gets its own connection, which gives up once that run is over
    const run = soloist;
    const attempt = () => {
      if (stopped || run !== soloist || run.exitCode !== null) return;
      const socket = new WebSocket(`ws://127.0.0.1:${o.wsPort}`);
      socket.onopen = () => (ws = socket);
      socket.onerror = () => {};
      socket.onclose = () => {
        const wasOpen = ws === socket;
        if (wasOpen) ws = undefined;
        setTimeout(attempt, wasOpen ? 1_000 : 300);
      };
      socket.onmessage = (m) => onSoloist(JSON.parse(String(m.data)));
    };
    attempt();
  }

  function onSoloist(msg) {
    switch (msg.type) {
      case 'auth_state':
        setStatus({ loggedIn: !!msg.logged_in, active: !!msg.is_active });
        break;
      case 'device_changed':
        setStatus({ active: !!msg.is_active });
        break;
      case 'volume_changed':
        status.volume = msg.volume;
        break;
      case 'playback_state':
        status.playback = { status: msg.status, item: msg.item ?? null, position: msg.position ?? null };
        if (msg.volume !== undefined) status.volume = msg.volume;
        break;
      case 'playback_changed':
        status.playback = { ...status.playback, status: msg.status };
        if (restartWhenIdle && msg.status !== 'playing') restartSoloist();
        break;
      case 'track_changed':
        status.playback = { ...status.playback, item: msg.item };
        break;
    }
    broadcast('soloist', msg);
    for (const listener of listeners) listener(msg);
  }

  /** Reads Soloist's audio at playback speed. Reading faster starves it and it stutters, so this sets the pace */
  function pace() {
    let next = Date.now();
    const tick = () => {
      paceTimer = setTimeout(tick, Math.max(0, (next = Math.max(next + FRAME_MS, Date.now() - 60)) - Date.now()));
      const frame = readFrame();
      if (!frame) return;
      for (const res of audioClients) {
        // Someone this far behind gets dropped frames rather than an ever-growing delay
        if (res.writableLength < FRAME_BYTES * 25) res.write(frame);
      }
    };
    tick();
  }

  function readFrame() {
    if (fifoFd === undefined) {
      if (!fs.existsSync(fifo)) return null;
      fifoFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    }
    const buf = Buffer.alloc(FRAME_BYTES - carry.length);
    let n = 0;
    try {
      n = fs.readSync(fifoFd, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') return null;
      fs.closeSync(fifoFd);
      fifoFd = undefined;
      return null;
    }
    if (!n) {
      // Nobody's writing, as PulseAudio is starting again with a new pipe
      fs.closeSync(fifoFd);
      fifoFd = undefined;
      return null;
    }
    // Only whole samples go out, so the bot never reads half of one
    const data = Buffer.concat([carry, buf.subarray(0, n)]);
    const whole = data.length - (data.length % 4);
    carry = data.subarray(whole);
    return whole ? data.subarray(0, whole) : null;
  }

  const audioClients = new Set();

  const authorized = (req) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${o.token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const route = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
    if (route === 'GET /status') return json(res, 200, status);
    if (route === 'GET /events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      sse.add(res);
      req.once('close', () => sse.delete(res));
      return;
    }
    if (route === 'GET /audio') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      // Nothing is written while music is stopped, and the bot waits for these before it carries on
      res.flushHeaders();
      audioClients.add(res);
      req.once('close', () => audioClients.delete(res));
      return;
    }
    if (route === 'POST /command') {
      let body;
      try {
        let raw = '';
        for await (const chunk of req) if ((raw += chunk).length > 10_000) throw new Error('too long');
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'bad JSON' });
      }
      if (!COMMANDS.has(body?.command)) return json(res, 400, { error: 'unknown command' });
      if (!ws || ws.readyState !== WebSocket.OPEN) return json(res, 503, { error: status.message || 'Spotify Soloist isn’t running' });
      ws.send(JSON.stringify({ ...body, type: 'command' }));
      return json(res, 202, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  });

  /** Pairs through the Spotify app on this network and returns the pairing, for SOLOIST_SESSION */
  async function pair() {
    if (!o.apiKey || !o.consent) throw new Error('Pairing needs SOLOIST_API_KEY set and SOLOIST_ACCEPT_TERMS=true');
    if (!(await ensureBinary())) throw new Error(status.message);
    fs.rmSync(soloistDir, { recursive: true, force: true });
    fs.mkdirSync(soloistDir, { recursive: true, mode: 0o700 });
    o.log(`Open Spotify on a phone or computer on this network, and pick "${o.deviceName}" as the speaker`);
    const proc = spawn(binary, ['--pair', '-n', o.deviceName, '-k', o.apiKey, '-D', soloistDir, '-C', path.join(o.dataDir, 'cache')], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (chunk) => o.log(redact(String(chunk)).trim()));
    proc.stderr.on('data', (chunk) => o.log(redact(String(chunk)).trim()));
    const code = await new Promise((resolve) => proc.once('exit', resolve));
    if (code !== 0) throw new Error(`Pairing didn’t finish (exit ${code})`);
    const files = [];
    const add = (rel) => {
      const full = path.join(soloistDir, rel);
      if (!fs.existsSync(full)) return;
      if (fs.statSync(full).isDirectory()) for (const child of fs.readdirSync(full)) add(path.posix.join(rel, child));
      else files.push({ name: rel, data: fs.readFileSync(full) });
    };
    for (const f of SESSION_FILES) add(f);
    return tarGz(files).toString('base64');
  }

  return {
    status,
    server,
    pair,
    /** Soloist's messages, for tests */
    onMessage: (listener) => listeners.add(listener),
    async start() {
      if (!o.token) throw new Error('MUSIC_TOKEN is required');
      await new Promise((resolve) => server.listen(o.port, resolve));
      // Fetch gives up on a response that's quiet for five minutes, and nothing happens while music is stopped
      pingTimer = setInterval(() => {
        for (const res of sse) res.write(': ping\n\n');
      }, 15_000);
      pingTimer.unref?.();
      if (!o.arch) return setStatus({ state: 'failed', message: `Spotify Soloist has no build for this CPU (${process.arch})` });
      if (!o.apiKey) return setStatus({ state: 'no-key', message: 'SOLOIST_API_KEY isn’t set' });
      if (!o.consent) return setStatus({ state: 'no-consent', message: 'SOLOIST_ACCEPT_TERMS isn’t true, so Spotify Soloist wasn’t downloaded' });
      importSession();
      pace();
      refreshTimer = setInterval(() => void refresh().catch((err) => o.log('Soloist refresh failed:', err.message)), DAY);
      refreshTimer.unref?.();
      if (!o.soloistCommand && !(await ensureBinary())) return;
      void runSoloist().catch((err) => {
        o.log('Soloist couldn’t start:', err.message);
        setStatus({ state: 'failed', message: err.message });
      });
    },
    refresh,
    async stop() {
      stopped = true;
      clearInterval(refreshTimer);
      clearInterval(pingTimer);
      clearTimeout(paceTimer);
      ws?.close();
      soloist?.kill('SIGTERM');
      pulse?.kill('SIGTERM');
      for (const res of [...sse, ...audioClients]) res.end();
      if (fifoFd !== undefined) fs.closeSync(fifoFd);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.main && process.argv[2] === 'pair') {
  // The pairing goes to stdout and everything else to stderr, so it can be copied into the .env on its own
  const bridge = createBridge({ dataDir: fs.mkdtempSync('/tmp/pair-'), log: (...args) => console.error(...args) });
  bridge.pair().then(
    (session) => console.log(`SOLOIST_SESSION=${session}`),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
} else if (import.meta.main) {
  const bridge = createBridge();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void bridge.stop().then(() => process.exit(0)));
  bridge.start().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
