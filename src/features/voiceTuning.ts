import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { feeds } from '../changes.ts';
import { config } from '../config.ts';
import { levelledLoudness } from '../loudness.ts';
import { gainMeasured, keepGainsFor, onGainWanted, setEffectGain, soundKey, wantedPairs } from './effectGains.ts';
// Only the types: say.ts starts measuring, so a value import back would make a cycle
import type { Effect, Stretches, Voice } from './say.ts';
import { type AddedVoice, addedVoices, type Curve, CURVES, type Measured, onVoicesChanged, setMeasured, voiceState } from './voices.ts';

/**
 * Measures each added voice once its model is downloaded: which speed curve it follows and how much to turn it up or
 * down to be as loud as the built-in voices. A voice set to `auto` takes both. Then, for every voice, how much to turn
 * each effect up or down by on it, to be as loud as the voice is without it (effectGains.ts). It runs one voice at a
 * time, through the voice container, and waits before each rendering and each effect while anyone's lines are being
 * made. A rendering already under way shares the container with a line that comes along, as two lines would
 */

// Long enough that one odd sentence doesn't sway the reading: about 25 seconds at the natural speed
const PASSAGE =
  'The quick brown fox jumps over the lazy dog, then naps in the warm afternoon sun. Nobody expected the weather to change so suddenly, ' +
  'but by evening the sky was dark and the wind was howling through the trees. We gathered around the fire, told old stories, and laughed ' +
  'until our sides hurt. Somewhere in the distance, a dog barked twice and fell silent. Good game, everyone, thanks for playing, and see ' +
  'you all tomorrow night at the usual time.';
/** Enough for a loudness reading, about 10 seconds, as each effect's is read several times */
const EFFECT_PASSAGE = PASSAGE.slice(0, PASSAGE.indexOf('We gathered'));
/** The length_scales the stretching is timed at, compared with 1 */
export const SCALES = [0.5, 0.8, 1, 1.5, 2] as const;
/** About the default speed, where loudness is read */
const LOUDNESS_SCALE = 1.25;
/** The default model's voices that loudness is matched to: a woman's, a man's and a deep one's */
const REFERENCE_SPEAKERS = [0, 400, 499];
/** Close enough to the target, in dB, and how many more tries to get there */
const LOUD_ENOUGH = 0.25;
const LOUDNESS_TRIES = 4;
const VOLUME_RANGE = [-20, 20] as const;
/** A voice that couldn't be measured is tried again after this */
const RETRY_MS = 10 * 60_000;
/** How soon to try again when the voice container isn't answering, as when it starts after the bot */
const UNREACHABLE_RETRY_MS = 30_000;
/** How long measuring waits for speech to finish before going ahead anyway */
const LONGEST_WAIT_MS = 5 * 60_000;
const RENDER_TIMEOUT_MS = 60_000;

/** A curve's stretch at a length_scale, read off its table */
export function stretchAt(stretches: Stretches, scale: number): number {
  const next = stretches.findIndex(([, length]) => length >= scale);
  if (next === -1) return stretches.at(-1)![0];
  if (next === 0) return stretches[0][0];
  const [[fromStretch, fromLength], [toStretch, toLength]] = [stretches[next - 1], stretches[next]];
  return fromStretch + ((toStretch - fromStretch) * (scale - fromLength)) / (toLength - fromLength);
}

/** The curve nearest a voice's measured stretching, as `ratios[i]` at SCALES[i], and how far off it is on average */
export function nearestCurve(ratios: readonly number[], curves: Record<Curve, Stretches>): { curve: Curve; fit: number } {
  const scored = CURVES.map((curve) => {
    let off = 0;
    SCALES.forEach((scale, i) => {
      if (scale === 1) return;
      const expected = stretchAt(curves[curve], scale);
      off += Math.abs(ratios[i] - expected) / expected;
    });
    return { curve, fit: off / (SCALES.length - 1) };
  });
  return scored.reduce((best, next) => (next.fit < best.fit ? next : best));
}

/**
 * The volume, in dB, that brings a voice's levelled speech to `target` LUFS. Levelling squeezes loud speech, so a
 * change of 1 dB moves it by less than that: each try learns by how much from the last
 */
export async function volumeFor(loudness: (volume: number) => Promise<number>, target: number, start = 0): Promise<number> {
  const [low, high] = VOLUME_RANGE;
  let volume = start;
  let heard = await loudness(volume);
  let before: [number, number] | null = null;
  for (let tries = 0; tries < LOUDNESS_TRIES && Math.abs(heard - target) > LOUD_ENOUGH; tries++) {
    const slope = before && before[0] !== volume ? (heard - before[1]) / (volume - before[0]) : 1;
    before = [volume, heard];
    volume = Math.max(low, Math.min(high, volume + (target - heard) / Math.max(slope, 0.2)));
    if (volume === before[0]) break;
    heard = await loudness(volume);
  }
  return Math.round(volume * 2) / 2;
}

/** Seconds from the first sound to the last, so the silence around speech doesn't count */
export function speechSeconds(wav: Buffer): number {
  const data = wav.indexOf('data');
  if (data < 0 || wav.length < 44) throw new Error('The voice container didn’t send a WAV file');
  const rate = wav.readUInt32LE(24);
  const start = data + 8;
  let peak = 0;
  for (let i = start; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  if (!peak) throw new Error('The voice said nothing');
  let first = -1;
  let last = -1;
  for (let i = start; i + 1 < wav.length; i += 2) {
    if (Math.abs(wav.readInt16LE(i)) > peak * 0.02) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return (last - first) / 2 / rate;
}

/** What a voice is measured with: when any of it changes, it's measured again */
export const measureKey = (v: AddedVoice, file: string) => JSON.stringify([file, v.speaker, v.noise]);

let curves: Record<Curve, Stretches> | null = null;
let speechBusy: () => boolean = () => false;
/** Every voice on offer, and the effects, from say.ts */
let voiceList: () => readonly Voice[] = () => [];
let effectList: readonly Effect[] = [];
/** Voices whose effects couldn't be measured, by their key, and when */
const effectsFailed = new Map<string, number>();
/** Measurements of voices that are gone or changed are swept away at most this often */
const SWEEP_MS = 10 * 60_000;
let swept = 0;
/** Loudness of the default model's voices, read once */
let target: number | null = null;
/** The voice being measured now */
let current: string | null = null;
let running = false;
/** Voices that couldn't be measured, by the key they had then, and when */
const failed = new Map<string, { key: string; at: number }>();
/** Goes up when someone asks for a voice to be measured again, so a measurement already under way isn't kept */
const asked = new Map<string, number>();
const retries = new Set<NodeJS.Timeout>();

/** The voice container couldn't be reached at all: no fault of the voice being measured */
class Unreachable extends Error {}

/** The try again soon after the container didn't answer, apart from failures' longer waits */
let soon: NodeJS.Timeout | null = null;

/** Tries again once a failure's wait is over */
function retryLater(ms = RETRY_MS + 1000) {
  const timer = setTimeout(() => {
    retries.delete(timer);
    if (timer === soon) soon = null;
    void tuneAll();
  }, ms).unref();
  retries.add(timer);
  return timer;
}

/** The voice's model file, if the container has it and it hasn't been measured with what it has now */
function due(v: AddedVoice, now = Date.now()): string | null {
  const state = voiceState(v.id);
  if (state.state !== 'ready' || !state.file) return null;
  const key = measureKey(v, state.file);
  if (v.measured?.key === key) return null;
  const failure = failed.get(v.id);
  if (failure?.key === key && now - failure.at < RETRY_MS) return null;
  return state.file;
}

/** Whether a voice is being measured or waiting to be */
export function voiceTuning(id: string): boolean {
  if (!curves) return false;
  if (current === id) return true;
  const voice = addedVoices().find((v) => v.id === id);
  return Boolean(voice && due(voice));
}

async function quiet() {
  const until = Date.now() + LONGEST_WAIT_MS;
  while (speechBusy() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1000).unref());
}

async function render(voice: string | undefined, speaker: number | null | undefined, noise: readonly [number, number] | null | undefined, scale: number, text = PASSAGE): Promise<Buffer> {
  await quiet();
  const res = await fetch(`${config.voiceUrl}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speaker_id: speaker ?? undefined, length_scale: scale, noise_scale: noise?.[0], noise_w_scale: noise?.[1] }),
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  }).catch((err: unknown) => {
    // A rendering that takes too long is the voice's; a refused connection is the container's
    throw err instanceof Error && err.name === 'TimeoutError' ? err : new Unreachable('The voice container isn’t answering');
  });
  if (!res.ok) throw new Error(`The voice container said HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Loudness of a rendering at a volume, through a file ffmpeg can read */
async function loudnessOf(audio: Buffer, folder: string, volume: number) {
  const file = path.join(folder, 'line.wav');
  writeFileSync(file, audio);
  return levelledLoudness(file, volume);
}

async function referenceLoudness(folder: string): Promise<number> {
  if (target !== null) return target;
  const heard: number[] = [];
  for (const speaker of REFERENCE_SPEAKERS) heard.push(await loudnessOf(await render(undefined, speaker, null, LOUDNESS_SCALE), folder, 0));
  target = heard.reduce((sum, l) => sum + l, 0) / heard.length;
  return target;
}

/** Measures one voice's speed curve and loudness */
export async function measureVoice(v: AddedVoice, file: string): Promise<Measured> {
  if (!curves) throw new Error('Voice tuning hasn’t started');
  const folder = mkdtempSync(path.join(tmpdir(), 'slopkeeper-tune-'));
  try {
    const goal = await referenceLoudness(folder);
    const seconds: number[] = [];
    for (const scale of SCALES) seconds.push(speechSeconds(await render(file, v.speaker, v.noise, scale)));
    const natural = seconds[SCALES.indexOf(1)];
    if (!(natural > 0)) throw new Error('It said nothing at its natural speed');
    const { curve, fit } = nearestCurve(
      seconds.map((s) => s / natural),
      curves,
    );
    if (!Number.isFinite(fit)) throw new Error('Its speed couldn’t be timed');
    const sample = await render(file, v.speaker, v.noise, LOUDNESS_SCALE);
    const volume = await volumeFor((dB) => loudnessOf(sample, folder, dB), goal);
    if (!Number.isFinite(volume)) throw new Error('Its loudness couldn’t be read');
    return { key: measureKey(v, file), curve, fit: Math.round(fit * 1000) / 1000, volume, at: Date.now() };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The effects not yet measured on a voice as it is now */
const effectsDue = (voice: Voice) => effectList.filter((e) => !gainMeasured(soundKey(voice), e.id, e.effects));

/** The next voice to measure effects on: one whose pair someone has used first, then any */
function nextEffectVoice(now = Date.now()): Voice | undefined {
  const ready = voiceList().filter((v) => now - (effectsFailed.get(soundKey(v)) ?? -Infinity) >= RETRY_MS && effectsDue(v).length);
  const wanted = new Set(wantedPairs().map((p) => p.voiceKey));
  return ready.find((v) => wanted.has(soundKey(v))) ?? ready[0];
}

/**
 * Measures the effects not yet measured on a voice: how much each needs turning up or down to be as loud as the voice
 * is without it. A rendering of the voice at each pace the effects are said at, as echoes and pitch changes sound
 * different at another speed, then ffmpeg for each effect
 */
export async function measureEffects(voice: Voice) {
  const folder = mkdtempSync(path.join(tmpdir(), 'slopkeeper-effects-'));
  try {
    const key = soundKey(voice);
    const own = path.join(folder, 'own.wav');
    writeFileSync(own, await render(voice.model, voice.speaker, voice.noise, LOUDNESS_SCALE * (voice.pace ?? 1), EFFECT_PASSAGE));
    const target = await levelledLoudness(own, 0, voice.effects);
    const atPace = new Map<number, string>([[1, own]]);
    for (const effect of effectsDue(voice)) {
      const pace = effect.pace ?? 1;
      let file = atPace.get(pace);
      if (!file) {
        file = path.join(folder, `pace-${pace}.wav`);
        writeFileSync(file, await render(voice.model, voice.speaker, voice.noise, LOUDNESS_SCALE * (voice.pace ?? 1) * pace, EFFECT_PASSAGE));
        atPace.set(pace, file);
      }
      await quiet();
      const sample = file;
      const gain = await volumeFor((dB) => levelledLoudness(sample, dB, [voice.effects, effect.effects].filter(Boolean).join(',')), target, effect.typical);
      if (!Number.isFinite(gain)) throw new Error(`The ${effect.name} effect’s loudness couldn’t be read`);
      // Changed or removed while it was being measured: measured again, under its new key, if it's still there
      if (!voiceList().some((v) => soundKey(v) === key)) return;
      setEffectGain(key, effect.id, effect.effects, gain);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Measures every voice that's due, one at a time, then the effects on every voice */
async function tuneAll() {
  if (running || !curves || !config.voiceUrl) return;
  running = true;
  try {
    for (;;) {
      const voice = addedVoices().find((v) => due(v));
      if (!voice) {
        const sounding = nextEffectVoice();
        if (!sounding) {
          if (Date.now() - swept >= SWEEP_MS) {
            swept = Date.now();
            keepGainsFor(voiceList().map(soundKey), new Set([...voiceList().map((v) => v.id), ...addedVoices().map((v) => v.id)]));
          }
          break;
        }
        try {
          await measureEffects(sounding);
        } catch (err) {
          if (err instanceof Unreachable) {
            soon ??= retryLater(UNREACHABLE_RETRY_MS);
            break;
          }
          console.error(`Couldn’t measure the effects on the voice ${sounding.name}:`, err instanceof Error ? err.message : err);
          effectsFailed.set(soundKey(sounding), Date.now());
          retryLater();
        }
        continue;
      }
      const file = due(voice)!;
      current = voice.id;
      // Settings says it's being measured, as when a retry starts after a failure
      feeds.voices.changedEverywhere();
      const round = asked.get(voice.id) ?? 0;
      try {
        // Done with before the outcome's told, so Settings doesn't go on saying it's being measured while the effects are
        const measured = await measureVoice(voice, file).finally(() => (current = null));
        // Changed, removed or asked to be measured again while it was being measured: the next turn measures it again
        const now = addedVoices().find((v) => v.id === voice.id);
        if (now && voiceState(now.id).file === file && measureKey(now, file) === measured.key && (asked.get(voice.id) ?? 0) === round) setMeasured(voice.id, measured);
      } catch (err) {
        if (err instanceof Unreachable) {
          soon ??= retryLater(UNREACHABLE_RETRY_MS);
          break;
        }
        console.error(`Couldn’t measure the voice ${voice.name}:`, err instanceof Error ? err.message : err);
        failed.set(voice.id, { key: measureKey(voice, file), at: Date.now() });
        // Settings stops saying it's being measured
        feeds.voices.changedEverywhere();
        retryLater();
      }
    }
  } finally {
    running = false;
    current = null;
  }
}

/** Starts measuring voices as they're downloaded. say.ts gives it the curves and whether speech is being made */
let listening = false;

export function startTuning(options: { curves: Record<Curve, Stretches>; busy: () => boolean; voices: () => readonly Voice[]; effects: readonly Effect[] }) {
  curves = options.curves;
  speechBusy = options.busy;
  voiceList = options.voices;
  effectList = options.effects;
  swept = 0;
  if (!listening) {
    onVoicesChanged(() => void tuneAll());
    onGainWanted(() => void tuneAll());
  }
  listening = true;
  void tuneAll();
}

/** Measures a voice again, as if it never had been */
export function measureAgain(id: string) {
  failed.delete(id);
  asked.set(id, (asked.get(id) ?? 0) + 1);
  setMeasured(id, null);
}

/** For tests */
export function stopTuning() {
  for (const timer of retries) clearTimeout(timer);
  retries.clear();
  soon = null;
  curves = null;
  target = null;
  failed.clear();
  effectsFailed.clear();
  voiceList = () => [];
  effectList = [];
}
