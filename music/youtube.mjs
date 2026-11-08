// Finds songs on YouTube Music, YouTube or SoundCloud with yt-dlp, and keeps their audio in a folder the bot reads.
// yt-dlp needs updating as YouTube changes, so it's updated when the container starts and daily after that
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const DAY = 86_400_000;
// Searching, then downloading, rarely takes more than a few seconds
const FETCH_TIMEOUT_MS = 3 * 60_000;
const MAX_ANSWER = 64 * 1024;
// A song being played and the next one being fetched, without running many yt-dlps at once
const AT_ONCE = 2;
const SAFE_FILE = /^[\w.-]+$/;

/**
 * `o.audioDir` holds the audio, `o.cacheBytes` caps it, `o.fetchCommand` runs fetch.py with a request on stdin,
 * `o.versionCommand` prints yt-dlp's version and `o.updateCommand` updates it
 */
export function createFetcher(o) {
  const indexFile = path.join(o.audioDir, 'index.json');
  const state = { ready: false, version: null, message: 'Starting yt-dlp' };
  const pending = new Map();
  const waiting = [];
  let running = 0;
  let updateTimer;
  let onChange = () => {};

  const setState = (changes) => {
    Object.assign(state, changes);
    onChange(state);
  };

  function readIndex() {
    try {
      return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeIndex(index) {
    fs.writeFileSync(`${indexFile}.new`, JSON.stringify(index));
    fs.renameSync(`${indexFile}.new`, indexFile);
  }

  /** Waits for a turn, so only a few downloads run at once */
  async function turn() {
    if (running >= AT_ONCE) await new Promise((resolve) => waiting.push(resolve));
    running++;
  }

  function done() {
    running--;
    waiting.shift()?.();
  }

  /** Runs fetch.py once with a request, and returns its answer */
  async function run(request) {
    await turn();
    try {
      const [command, ...args] = o.fetchCommand;
      const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: FETCH_TIMEOUT_MS, killSignal: 'SIGKILL' });
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk) => (out = (out + chunk).slice(0, MAX_ANSWER)));
      proc.stderr.on('data', (chunk) => (err = (err + chunk).slice(-2000)));
      proc.stdin.end(JSON.stringify({ ...request, dir: o.audioDir }));
      const code = await new Promise((resolve) => {
        proc.once('exit', resolve);
        proc.once('error', () => resolve(-1));
      });
      try {
        return JSON.parse(out.trim().split('\n').at(-1));
      } catch {
        throw new Error(`yt-dlp stopped without an answer (exit ${code}): ${err.trim().slice(-300) || 'no output'}`);
      }
    } finally {
      done();
    }
  }

  /** Deletes the least recently played audio until the folder is under its cap */
  function trim(keep) {
    const index = readIndex();
    const files = fs
      .readdirSync(o.audioDir)
      .filter((name) => name !== 'index.json' && !name.endsWith('.new') && !name.endsWith('.part'))
      .map((name) => {
        const stat = fs.statSync(path.join(o.audioDir, name));
        return { name, size: stat.size, used: stat.mtimeMs };
      })
      .sort((a, b) => a.used - b.used);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files) {
      if (total <= o.cacheBytes) break;
      if (f.name === keep) continue;
      fs.rmSync(path.join(o.audioDir, f.name), { force: true });
      total -= f.size;
    }
    const left = new Set(fs.readdirSync(o.audioDir));
    for (const [key, entry] of Object.entries(index)) if (!left.has(entry.file)) delete index[key];
    writeIndex(index);
  }

  /** Audio for a song or link, from the folder if it's there, or found and downloaded. Only one fetch runs per song */
  async function fetchAudio(request) {
    const key = request.uri ?? request.url;
    const kept = readIndex()[key];
    if (kept && fs.existsSync(path.join(o.audioDir, kept.file))) {
      // Marks it as just used, so it's the last to go
      const now = new Date();
      fs.utimesSync(path.join(o.audioDir, kept.file), now, now);
      return kept;
    }
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      const answer = await run(request);
      if (answer.error) return answer;
      if (typeof answer.file !== 'string' || !SAFE_FILE.test(answer.file)) throw new Error('yt-dlp named the file oddly');
      const entry = { file: answer.file, source: answer.source ?? null, url: answer.url ?? null, title: answer.title ?? null, durationMs: answer.durationMs ?? null };
      writeIndex({ ...readIndex(), [key]: entry });
      trim(answer.file);
      return entry;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  async function checkVersion() {
    const [command, ...args] = o.versionCommand;
    const { stdout } = await promisify(execFile)(command, args, { timeout: 60_000 });
    return stdout.trim().split('\n').at(-1);
  }

  async function update() {
    if (o.updateCommand) {
      const [command, ...args] = o.updateCommand;
      await promisify(execFile)(command, args, { timeout: 5 * 60_000 });
    }
    const version = await checkVersion();
    if (version !== state.version) o.log(`yt-dlp ${version}`);
    setState({ ready: true, version, message: '' });
  }

  return {
    state,
    fetchAudio,
    /** `listener` hears every change to whether yt-dlp is ready */
    onChange: (listener) => (onChange = listener),
    async start() {
      try {
        fs.mkdirSync(o.audioDir, { recursive: true });
        fs.accessSync(o.audioDir, fs.constants.W_OK);
      } catch {
        return setState({ ready: false, message: `The music container can’t write to ${o.audioDir}` });
      }
      // What's there already works straight away; the update only makes it better
      await checkVersion().then(
        (version) => setState({ ready: true, version, message: '' }),
        (err) => setState({ ready: false, message: `yt-dlp didn’t run: ${err.message}` }),
      );
      const updating = () =>
        update().catch((err) => {
          o.log('yt-dlp update failed:', err.message);
          if (!state.ready) setState({ message: `yt-dlp didn’t run: ${err.message}` });
        });
      void updating();
      updateTimer = setInterval(updating, DAY);
      updateTimer.unref?.();
    },
    /** What a YouTube or SoundCloud link is, without downloading it */
    lookup: (url) => run({ url, info: true }),
    stop() {
      clearInterval(updateTimer);
    },
  };
}
