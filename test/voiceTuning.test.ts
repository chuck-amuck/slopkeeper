import './helpers.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { CURVE_STRETCHES } from '../src/features/say.ts';
import { forgetVoiceStates, voiceFields } from '../src/features/voices.ts';
import { nearestCurve, SCALES, speechSeconds, startTuning, stopTuning, stretchAt, volumeFor } from '../src/features/voiceTuning.ts';
import { CURVES } from '../src/features/voices.ts';
import { base, call, GUILD, ok } from './apiFixture.ts';

// Measuring added voices: which speed curve each follows and how loud it is next to the default model's voices

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const VOICE_URL = 'http://voice.test';
const FILE = 'https://huggingface.co/someone/voices/resolve/main/en/narrator.onnx';
const RATE = 22050;
const before = config.voiceUrl;

/** A 16-bit WAV of a tone `seconds` long between a fifth of a second of silence each side */
function tone(seconds: number, amplitude: number) {
  const pad = Math.round(RATE * 0.2);
  const count = pad * 2 + Math.round(RATE * seconds);
  const out = Buffer.alloc(44 + count * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + count * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(count * 2, 40);
  for (let i = pad; i < count - pad; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude * 32767), 44 + i * 2);
  return out;
}

/**
 * A voice container with the voices in `ready` downloaded. The default model's voices are a tone at 0.3 of full scale, and
 * every added one a quieter tone whose length stretches along the middle curve
 */
function fakeContainer(t: TestContext, ready: Set<string>, onSynth?: (body: Record<string, any>) => void, silent = false) {
  const real = fetch;
  const container = { voices: [] as { id: string }[], synthesized: [] as Record<string, any>[] };
  const report = (version: string) => ({
    version,
    voices: Object.fromEntries(container.voices.map((v) => [v.id, ready.has(v.id) ? { state: 'ready', file: `voice-${v.id}-0123456789ab`, speakers: [] } : { state: 'downloading', percent: 40 }])),
  });
  let version = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    if (url === `${VOICE_URL}/models` && init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      version = body.version;
      container.voices = body.voices;
      return Response.json(report(version));
    }
    if (url === `${VOICE_URL}/models`) return Response.json(report(version));
    if (url === `${VOICE_URL}/synthesize`) {
      const body = JSON.parse(init!.body as string);
      container.synthesized.push(body);
      onSynth?.(body);
      if (silent && body.voice) return new Response(new Uint8Array(tone(0, 0)));
      const audio = body.voice ? tone(stretchAt(CURVE_STRETCHES.middle, body.length_scale), 0.1) : tone(body.length_scale, 0.3);
      return new Response(new Uint8Array(audio));
    }
    throw new Error(`unexpected ${url}`);
  });
  return container;
}

const list = async () => (await ok(`/guilds/${GUILD}/voices`)).voices as any[];

/** Waits for every voice to be measured */
async function measured(within = 30_000) {
  const until = Date.now() + within;
  for (;;) {
    const voices = await list();
    if (voices.every((v) => !v.tuning)) return voices;
    if (Date.now() > until) throw new Error('measuring never finished');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(() => {
  config.voiceUrl = VOICE_URL;
  db.exec('DELETE FROM voices');
  forgetVoiceStates();
});
afterEach(() => {
  stopTuning();
  config.voiceUrl = before;
});

test('a curve’s stretch is read off its table, between its points and past its ends', () => {
  const table = [
    [0.5, 0.4],
    [1, 1],
    [2, 3],
  ] as const;
  assert.equal(stretchAt(table, 1), 1);
  assert.equal(stretchAt(table, 2), 1.5);
  assert.equal(stretchAt(table, 0.1), 0.5, 'below the table, its first stretch');
  assert.equal(stretchAt(table, 9), 2, 'above it, its last');
});

test('each speed curve is recognised from its own stretching', () => {
  for (const curve of CURVES) {
    const found = nearestCurve(
      SCALES.map((scale) => stretchAt(CURVE_STRETCHES[curve], scale)),
      CURVE_STRETCHES,
    );
    assert.equal(found.curve, curve);
    assert.ok(found.fit < 1e-9, `${curve} fits itself exactly`);
  }
  const off = nearestCurve(
    SCALES.map((scale) => stretchAt(CURVE_STRETCHES.middle, scale) * (scale === 1 ? 1 : 1.1)),
    CURVE_STRETCHES,
  );
  assert.ok(off.fit > 0.05, 'stretching no curve follows is a loose fit');
});

test('speech is timed from its first sound to its last, leaving out the silence around it', () => {
  assert.ok(Math.abs(speechSeconds(tone(1.5, 0.5)) - 1.5) < 0.01);
  assert.throws(() => speechSeconds(tone(0, 0)), /said nothing/);
  assert.throws(() => speechSeconds(Buffer.from('not a wav')), /WAV/);
});

test('the loudness search finds the volume though levelling squeezes loud speech, and stops at the end of the range', async () => {
  const tries: number[] = [];
  // Each dB up adds less and less, as a limiter would
  const squeezed = async (volume: number) => {
    tries.push(volume);
    return -20 + 8 * Math.tanh(volume / 10);
  };
  const volume = await volumeFor(squeezed, -15);
  assert.ok(Math.abs(-20 + 8 * Math.tanh(volume / 10) - -15) < 0.5, `${volume} dB lands near the target`);
  assert.ok(tries.length <= 5, `${tries.length} tries`);
  assert.equal(await volumeFor(async () => -40, -15), 20, 'too quiet to reach, it stays at the most');
  assert.equal(await volumeFor(async (v) => -15 + v, -15), 0, 'already right, it stays');
});

test('a voice is measured unless someone said how loud it is or which curve it follows', () => {
  const fields = (input: Record<string, unknown>) => voiceFields({ name: 'Narrator', model: FILE, ...input }, new Set());
  assert.equal((fields({}) as any).tune, 'auto');
  assert.equal((fields({ volume: -3 }) as any).tune, 'manual');
  assert.equal((fields({ curve: 'low' }) as any).tune, 'manual');
  assert.equal((fields({ volume: -3, tune: 'auto' }) as any).tune, 'auto', 'unless it says so');
  assert.match(fields({ tune: 'sometimes' }) as string, /auto or manual/);
});

test('an added voice is measured once it’s downloaded, takes what was found, and keeps what someone sets by hand', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const ready = new Set(['narrator']);
  const container = fakeContainer(t, ready);
  let busy = true;
  startTuning({ curves: CURVE_STRETCHES, busy: () => busy });
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await list())[0].tuning, true, 'waiting to be measured');
  assert.equal(container.synthesized.length, 0, 'not while speech is being made');
  busy = false;

  let [voice] = await measured();
  assert.equal(voice.tune, 'auto');
  assert.equal(voice.measured.curve, 'middle');
  assert.ok(voice.measured.fit < 0.02, `fits closely: ${voice.measured.fit}`);
  // 0.1 of full scale against 0.3 is about 9.5 dB quieter
  assert.ok(Math.abs(voice.measured.volume - 9.5) <= 1, `${voice.measured.volume} dB`);
  assert.equal(voice.curve, 'middle', 'auto takes the curve');
  assert.equal(voice.volume, voice.measured.volume, 'and the loudness');
  const passages = container.synthesized.filter((s) => s.voice).map((s) => s.length_scale);
  assert.deepEqual(passages.slice(0, SCALES.length), [...SCALES], 'timed at each point, then rendered for loudness');

  // Setting the loudness by hand keeps it, and the measurement stays to go back to
  ({ voice } = await ok(`/guilds/${GUILD}/voices/narrator`, { method: 'PUT', json: { volume: 3 } }));
  assert.equal(voice.tune, 'manual');
  assert.equal(voice.volume, 3);
  assert.equal(voice.measured.curve, 'middle');
  ({ voice } = await ok(`/guilds/${GUILD}/voices/narrator`, { method: 'PUT', json: { tune: 'auto' } }));
  assert.equal(voice.volume, voice.measured.volume, 'Use measured puts it back');

  // Measure again starts over
  const asked = container.synthesized.length;
  ({ voice } = await ok(`/guilds/${GUILD}/voices/narrator/measure`, { method: 'POST' }));
  assert.equal(voice.measured, null);
  [voice] = await measured();
  assert.equal(voice.measured.curve, 'middle');
  assert.ok(container.synthesized.length > asked);

  // A new speaker is a new voice to measure
  const again = container.synthesized.length;
  await ok(`/guilds/${GUILD}/voices/narrator`, { method: 'PUT', json: { speaker: 1 } });
  [voice] = await measured();
  assert.ok(container.synthesized.length > again, 'measured with the new speaker');
  assert.ok(container.synthesized.slice(again).filter((s) => s.voice).every((s) => s.speaker_id === 1));
});

test('a voice given its loudness by hand is measured too, but keeps its own', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  fakeContainer(t, new Set(['quiet-one']));
  startTuning({ curves: CURVE_STRETCHES, busy: () => false });
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Quiet one', model: FILE, volume: -4, curve: 'low' } });
  const [voice] = await measured();
  assert.equal(voice.tune, 'manual');
  assert.equal(voice.measured.curve, 'middle');
  assert.equal(voice.volume, -4);
  assert.equal(voice.curve, 'low');
});

test('Measure again during a measurement measures it again, rather than keeping the one under way', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  let busy = false;
  let paused = false;
  // Holds the first measurement after its first rendering of the voice, so Measure again lands in the middle of it
  const container = fakeContainer(t, new Set(['narrator']), (body) => {
    if (body.voice && !paused) busy = paused = true;
  });
  startTuning({ curves: CURVE_STRETCHES, busy: () => busy });
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  while (!paused) await new Promise((resolve) => setTimeout(resolve, 20));
  await ok(`/guilds/${GUILD}/voices/narrator/measure`, { method: 'POST' });
  busy = false;
  const [voice] = await measured();
  assert.equal(voice.measured.curve, 'middle');
  const timings = container.synthesized.filter((s) => s.voice && s.length_scale === 0.5).length;
  assert.equal(timings, 2, 'measured twice: the one under way, then again');
});

test('a voice that says nothing isn’t measured over and over', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const container = fakeContainer(t, new Set(['narrator']), undefined, true);
  t.mock.method(console, 'error', () => {});
  startTuning({ curves: CURVE_STRETCHES, busy: () => false });
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  const [voice] = await measured();
  assert.equal(voice.measured, null);
  const asked = container.synthesized.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(container.synthesized.length, asked, 'it waits before trying again');
});

test('a voice container that isn’t up yet holds measuring back, rather than counting against the voice', { skip: !hasFfmpeg && 'needs ffmpeg' }, async (t) => {
  const container = fakeContainer(t, new Set(['narrator']));
  const answering = globalThis.fetch;
  let up = false;
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => (up || !String(url).endsWith('/synthesize') ? answering(url, init) : Promise.reject(new TypeError('fetch failed'))));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = t.mock.method(console, 'error', () => {});
  startTuning({ curves: CURVE_STRETCHES, busy: () => false });
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.mock.callCount(), 0, 'not logged as the voice’s failure');
  assert.equal((await list())[0].tuning, true, 'still waiting to be measured');
  up = true;
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  const [voice] = await measured();
  assert.equal(voice.measured.curve, 'middle');
  assert.ok(container.synthesized.length > 0);
});

test('an import that doesn’t say how a voice is tuned leaves it as it was', async (t) => {
  fakeContainer(t, new Set());
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE, volume: 0, curve: 'character' } });
  assert.equal((await list())[0].tune, 'manual');
  // A file from before measuring: no volume or curve, as they're the defaults, and no tune
  const plan = await ok(`/guilds/${GUILD}/voices/import`, { method: 'POST', json: { voices: [{ name: 'Narrator', model: FILE }, { name: 'Pirate', model: 'https://example.com/pirate.onnx' }] } });
  assert.deepEqual([plan.unchanged, plan.added], [['Narrator'], ['Pirate']]);
  await ok(`/guilds/${GUILD}/voices/import`, { method: 'POST', json: { voices: [{ name: 'Pirate', model: 'https://example.com/pirate.onnx' }], dryRun: false } });
  assert.equal((await list()).find((v) => v.name === 'Pirate').tune, 'auto', 'a new one is measured');
});

test('measuring again needs the voice downloaded first', async (t) => {
  fakeContainer(t, new Set());
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  const res = await call(`/guilds/${GUILD}/voices/narrator/measure`, { method: 'POST' });
  assert.equal(res.status, 409);
});
