import { db, transaction } from '../db.ts';

/**
 * How much each effect is turned up or down on each voice, so the pair is as loud as the voice without it. An effect
 * changes some voices' loudness far more than others' (Underwater took one voice 13 dB down and others under 1), so each
 * pair is measured by voiceTuning.ts, and an effect's typical correction stands in until then
 */

/** What a voice sounds by, for knowing when it's changed: say.ts's Voice, without importing it */
export interface Sounding {
  id: string;
  model?: string;
  speaker?: number;
  noise?: readonly [number, number];
  effects?: string;
  key?: string;
}

/** A voice's key in effect_gains: an added voice's own key, which changes with its settings, or what a built-in one sounds by */
export const soundKey = (voice: Sounding) => voice.key ?? JSON.stringify([voice.id, voice.model, voice.speaker, voice.noise, voice.effects]);

const read = db.prepare('SELECT gain FROM effect_gains WHERE voice_key = ? AND effect = ? AND chain = ?');
const write = db.prepare(
  'INSERT INTO effect_gains (voice_key, effect, chain, gain, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(voice_key, effect) DO UPDATE SET chain = excluded.chain, gain = excluded.gain, at = excluded.at',
);

/** Pairs used before they were measured, newest last, which are measured first */
const wanted = new Map<string, { voiceKey: string; effect: string }>();
let onWanted: () => void = () => {};
let onMeasured: (voiceKey: string, effect: string) => void = () => {};

/** The dB to turn an effect up or down by on a voice: measured for the pair, or else the effect's typical */
export function effectGain(voice: Sounding, effect: { id: string; effects: string; typical: number }): number {
  const voiceKey = soundKey(voice);
  const row = read.get(voiceKey, effect.id, effect.effects) as { gain: number } | undefined;
  if (row) return row.gain;
  const key = JSON.stringify([voiceKey, effect.id]);
  if (!wanted.has(key)) {
    wanted.set(key, { voiceKey, effect: effect.id });
    onWanted();
  }
  return effect.typical;
}

/** Whether a pair has been measured with the effect as it is now */
export const gainMeasured = (voiceKey: string, effect: string, chain: string) => read.get(voiceKey, effect, chain) !== undefined;

export function setEffectGain(voiceKey: string, effect: string, chain: string, gain: number) {
  write.run(voiceKey, effect, chain, gain, Date.now());
  wanted.delete(JSON.stringify([voiceKey, effect]));
  onMeasured(voiceKey, effect);
}

/** Tells say.ts when a pair is measured, so the looping room can remake speech made with its typical correction */
export function onGainMeasured(listener: (voiceKey: string, effect: string) => void) {
  onMeasured = listener;
}

/** Pairs someone has used and are still waiting, so measuring starts with their voices */
export const wantedPairs = () => [...wanted.values()];

/** Tells the tuner when a pair is wanted, so it can start */
export function onGainWanted(listener: () => void) {
  onWanted = listener;
}

/** The voice id a key starts with, as both kinds of key do */
const idOf = (voiceKey: string) => {
  try {
    const parsed: unknown = JSON.parse(voiceKey);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
  } catch {
    return null;
  }
};

/**
 * Forgets the measurements of voices that have changed (one on offer now under another key) or are gone (`known` no
 * longer has their id). An added voice that's only briefly not on offer, as when the voice container restarts, keeps them
 */
export function keepGainsFor(current: readonly string[], known: ReadonlySet<string>) {
  const keep = new Set(current);
  const offered = new Set(current.map(idOf));
  const stale = (key: string) => {
    if (keep.has(key)) return false;
    const id = idOf(key);
    return id === null || offered.has(id) || !known.has(id);
  };
  const keys = (db.prepare('SELECT DISTINCT voice_key FROM effect_gains').all() as { voice_key: string }[]).map((r) => r.voice_key).filter(stale);
  const forget = db.prepare('DELETE FROM effect_gains WHERE voice_key = ?');
  transaction(() => {
    for (const key of keys) forget.run(key);
  });
  for (const [key, pair] of wanted) if (stale(pair.voiceKey)) wanted.delete(key);
}

/** For tests */
export function forgetEffectGains() {
  db.exec('DELETE FROM effect_gains');
  wanted.clear();
}
