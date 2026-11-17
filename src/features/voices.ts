import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { db, getKv, setKv, transaction } from '../db.ts';

/**
 * The voices added in the web UI, shared by every server on the bot. The voice container (voice/models.py) downloads their
 * models from the list the bot sends it, and says how each download is going. A voice is offered once its model is there.
 *
 * Each change gets a new version. The container keeps the version it was last sent and shows it in /stats, which the bot
 * polls, so a container that lost its list or missed a change is sent it again
 */

db.exec(`
  -- Voices added in the web UI, for every server. noise and noise_w are Piper's, or null for the model's own
  CREATE TABLE IF NOT EXISTS voices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    grp TEXT NOT NULL,
    model_url TEXT NOT NULL,
    config_url TEXT,
    sha256 TEXT,
    config_sha256 TEXT,
    speaker INTEGER,
    volume REAL NOT NULL DEFAULT 0,
    pace REAL NOT NULL DEFAULT 1,
    noise REAL,
    noise_w REAL,
    curve TEXT NOT NULL DEFAULT 'character',
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
  );
`);
// Added later. tune: 'auto' takes the measured speed curve and loudness, 'manual' keeps what someone set. Voices from
// before measuring keep theirs. measured: the last measurement, as JSON (see Measured)
for (const [column, type] of [
  ['tune', "TEXT NOT NULL DEFAULT 'manual'"],
  ['measured', 'TEXT'],
] as const) {
  if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('voices', column)) db.exec(`ALTER TABLE voices ADD COLUMN ${column} ${type}`);
}

export const GROUPS = ['Characters', 'Accents'] as const;
export type VoiceGroup = (typeof GROUPS)[number];
/** Which measured speed curve a voice follows (see the Stretches in say.ts). Character suits most community models */
export const CURVES = ['character', 'default', 'middle', 'low'] as const;
export type Curve = (typeof CURVES)[number];
export const TUNES = ['auto', 'manual'] as const;
export type Tune = (typeof TUNES)[number];

/** What measuring a voice found (see voiceTuning.ts) */
export interface Measured {
  /** The model file, speaker and noise it was measured with: a change to any of them measures it again */
  key: string;
  curve: Curve;
  /** How far the voice's stretching is from the curve's, on average: 0.02 is 2% */
  fit: number;
  /** dB that make it as loud as the default model's voices */
  volume: number;
  at: number;
}

export interface AddedVoice {
  id: string;
  name: string;
  group: VoiceGroup;
  model: string;
  config: string | null;
  sha256: string | null;
  configSha256: string | null;
  speaker: number | null;
  /** dB, after the effects and before levelling */
  volume: number;
  /** Multiplies the length_scale */
  pace: number;
  noise: [number, number] | null;
  curve: Curve;
  tune: Tune;
  measured: Measured | null;
  addedBy: string;
  addedAt: number;
  changedAt: number;
}

/** What the voice container says about a voice's model */
export interface VoiceState {
  state: 'waiting' | 'downloading' | 'ready' | 'failed' | 'unknown';
  percent?: number;
  error?: string;
  /** The model's name in the container, once it's there */
  file?: string;
  speakers?: { id: number; name: string }[];
}

interface Row {
  id: string;
  name: string;
  grp: string;
  model_url: string;
  config_url: string | null;
  sha256: string | null;
  config_sha256: string | null;
  speaker: number | null;
  volume: number;
  pace: number;
  noise: number | null;
  noise_w: number | null;
  curve: string;
  tune: string;
  measured: string | null;
  added_by: string;
  added_at: number;
  changed_at: number;
}

const fromRow = (r: Row): AddedVoice => ({
  id: r.id,
  name: r.name,
  group: (GROUPS as readonly string[]).includes(r.grp) ? (r.grp as VoiceGroup) : 'Characters',
  model: r.model_url,
  config: r.config_url,
  sha256: r.sha256,
  configSha256: r.config_sha256,
  speaker: r.speaker,
  volume: r.volume,
  pace: r.pace,
  noise: r.noise === null || r.noise_w === null ? null : [r.noise, r.noise_w],
  curve: (CURVES as readonly string[]).includes(r.curve) ? (r.curve as Curve) : 'character',
  tune: r.tune === 'auto' ? 'auto' : 'manual',
  measured: readMeasured(r.measured),
  addedBy: r.added_by,
  addedAt: r.added_at,
  changedAt: r.changed_at,
});

function readMeasured(text: string | null): Measured | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Measured;
    return typeof m.key === 'string' && (CURVES as readonly string[]).includes(m.curve) && Number.isFinite(m.volume) && Number.isFinite(m.fit) ? m : null;
  } catch {
    return null;
  }
}

let cached: AddedVoice[] | null = null;

/** Every added voice, by name */
export function addedVoices(): readonly AddedVoice[] {
  cached ??= (db.prepare('SELECT * FROM voices ORDER BY name COLLATE NOCASE').all() as unknown as Row[]).map(fromRow);
  return cached;
}

const VERSION_KEY = 'voices_version';
const STATES_KEY = 'voices_states';

/** The list's version, which changes with every change to it */
export const voicesVersion = () => getKv(VERSION_KEY) ?? '';

/** The container's last word on each voice, kept so a restart offers the ready ones straight away */
let states: Record<string, VoiceState> = (() => {
  try {
    const kept = JSON.parse(getKv(STATES_KEY) ?? '{}') as unknown;
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Record<string, VoiceState>) : {};
  } catch {
    return {};
  }
})();
/** The version the container last said it had, or null before it's said */
let containerVersion: string | null = null;
let generation = 0;
/** Goes up with every change to what's offered, for anything that keeps a list built from them */
export const voicesGeneration = () => generation;

const listeners: (() => void)[] = [];

function changed() {
  generation++;
  for (const listener of listeners) listener();
}

/** Called after any change to the voices or what the container has of them */
export function onVoicesChanged(listener: () => void) {
  listeners.push(listener);
}

export function voiceState(id: string): VoiceState {
  return states[id] ?? { state: 'unknown' };
}

const STATE_NAMES = new Set(['waiting', 'downloading', 'ready', 'failed']);

/** Takes the container's report of each voice's state */
function takeReport(report: unknown) {
  if (!report || typeof report !== 'object') return;
  const { version, voices } = report as { version?: unknown; voices?: unknown };
  if (typeof version === 'string') containerVersion = version;
  if (!voices || typeof voices !== 'object') return;
  const next: Record<string, VoiceState> = {};
  for (const voice of addedVoices()) {
    const said = (voices as Record<string, unknown>)[voice.id] as Record<string, unknown> | undefined;
    if (!said || typeof said !== 'object' || !STATE_NAMES.has(said.state as string)) continue;
    const state: VoiceState = { state: said.state as VoiceState['state'] };
    if (typeof said.percent === 'number') state.percent = Math.max(0, Math.min(100, Math.round(said.percent)));
    if (typeof said.error === 'string') state.error = said.error.slice(0, 300);
    if (typeof said.file === 'string' && /^voice-[a-z0-9_-]+$/.test(said.file)) state.file = said.file;
    if (Array.isArray(said.speakers)) {
      state.speakers = said.speakers
        .filter((s): s is { id: number; name: string } => Number.isInteger(s?.id) && typeof s?.name === 'string')
        .map((s) => ({ id: s.id, name: s.name.slice(0, 60) }))
        .slice(0, 1000);
    }
    next[voice.id] = state;
  }
  const readyBefore = JSON.stringify(Object.entries(states).filter(([, s]) => s.state === 'ready').map(([id, s]) => [id, s.file]));
  states = next;
  setKv(STATES_KEY, JSON.stringify(states));
  const readyNow = JSON.stringify(Object.entries(states).filter(([, s]) => s.state === 'ready').map(([id, s]) => [id, s.file]));
  if (readyBefore !== readyNow) changed();
}

const SYNC_TIMEOUT_MS = 5_000;

/** What the container needs of each voice */
const forContainer = (v: AddedVoice) => ({ id: v.id, model: v.model, config: v.config, sha256: v.sha256, configSha256: v.configSha256 });

let syncing: Promise<void> | null = null;
let syncAgain = false;
let saidDown = false;

/** Sends the list to the voice container, which starts on what's missing, and takes its report. Never throws */
export function syncVoices(): Promise<void> {
  if (!config.voiceUrl) return Promise.resolve();
  if (syncing) {
    // A change while one is on its way goes in another straight after, so the container ends on the latest
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncAgain = false;
      try {
        const res = await fetch(`${config.voiceUrl}/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: voicesVersion(), voices: addedVoices().map(forContainer) }),
          signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`it answered ${res.status}`);
        takeReport(await res.json());
        saidDown = false;
      } catch (err) {
        if (!saidDown) console.warn(`Couldn't send the added voices to the voice container: ${(err as Error).message}`);
        saidDown = true;
        containerVersion = null;
      }
    } while (syncAgain);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** Asks the container how the downloads are going, for the web UI. Never throws */
export async function refreshVoiceStates(): Promise<void> {
  if (!config.voiceUrl) return;
  if (containerVersion !== voicesVersion()) return syncVoices();
  try {
    const res = await fetch(`${config.voiceUrl}/models`, { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
    if (!res.ok) throw new Error(String(res.status));
    takeReport(await res.json());
    if (containerVersion !== voicesVersion()) await syncVoices();
  } catch {
    containerVersion = null;
  }
}

/** The version the container has, from its /stats: a container that lost or missed the list is sent it again */
export function voiceContainerHas(version: unknown) {
  if (typeof version !== 'string') return;
  if (version !== voicesVersion()) {
    void syncVoices();
    return;
  }
  containerVersion = version;
  // A download under way is followed, so its voice is offered soon after it's done even with nobody watching
  if (addedVoices().some((v) => ['waiting', 'downloading'].includes(voiceState(v.id).state))) void refreshVoiceStates();
}

/** What a voice is set to, as the web UI and an import give it, already checked */
export type VoiceFields = Omit<AddedVoice, 'id' | 'measured' | 'addedBy' | 'addedAt' | 'changedAt'>;

function bump() {
  cached = null;
  setKv(VERSION_KEY, randomUUID());
}

const columns = (f: VoiceFields) => [f.name, f.group, f.model, f.config, f.sha256, f.configSha256, f.speaker, f.volume, f.pace, f.noise?.[0] ?? null, f.noise?.[1] ?? null, f.curve, f.tune];

function insert(id: string, fields: VoiceFields, who: string, now: number) {
  db.prepare(
    `INSERT INTO voices (id, name, grp, model_url, config_url, sha256, config_sha256, speaker, volume, pace, noise, noise_w, curve, tune, added_by, added_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ...columns(fields), who, now, now);
}

function update(id: string, fields: VoiceFields, now: number) {
  db.prepare(
    `UPDATE voices SET name = ?, grp = ?, model_url = ?, config_url = ?, sha256 = ?, config_sha256 = ?, speaker = ?, volume = ?, pace = ?, noise = ?, noise_w = ?, curve = ?, tune = ?, changed_at = ?
     WHERE id = ?`,
  ).run(...columns(fields), now, id);
}

/** Servers' picks of a voice that's gone, which go back to their default. Returns how many */
function forgetPicks(ids: string[]): number {
  if (!ids.length) return 0;
  return Number(db.prepare(`DELETE FROM guild_settings WHERE key IN ('ttsVoice', 'loopVoice') AND value IN (${ids.map(() => '?').join(', ')})`).run(...ids).changes);
}

/** Whether a change to a voice means a new download */
const sameModel = (a: VoiceFields, b: VoiceFields) => a.model === b.model && a.config === b.config && a.sha256 === b.sha256 && a.configSha256 === b.configSha256;

/** Every change goes to the container, which keeps the version and says what's become of each model */
function after() {
  void syncVoices();
  changed();
}

export function addVoice(id: string, fields: VoiceFields, who: string) {
  transaction(() => {
    insert(id, fields, who, Date.now());
    bump();
  });
  states[id] = { state: 'waiting' };
  after();
}

/** The measured curve and loudness put in, for a voice set to take them, if what it was measured with hasn't changed */
function tuned(before: AddedVoice, fields: VoiceFields): VoiceFields {
  const m = before.measured;
  const sameInputs = sameModel(before, fields) && before.speaker === fields.speaker && JSON.stringify(before.noise) === JSON.stringify(fields.noise);
  return fields.tune === 'auto' && m && sameInputs ? { ...fields, curve: m.curve, volume: m.volume } : fields;
}

export function editVoice(id: string, given: VoiceFields) {
  const before = addedVoices().find((v) => v.id === id);
  if (!before) return;
  const fields = tuned(before, given);
  transaction(() => {
    update(id, fields, Date.now());
    bump();
  });
  if (!sameModel(before, fields)) states[id] = { state: 'waiting' };
  after();
}

/** Removes a voice, and servers' picks of it. Returns how many picks went */
export function removeVoice(id: string): number {
  const picks = transaction(() => {
    db.prepare('DELETE FROM voices WHERE id = ?').run(id);
    bump();
    return forgetPicks([id]);
  });
  delete states[id];
  after();
  return picks;
}

/** Applies an import that's been checked: adds, changes, and with `remove`, deletes. Returns how many picks went */
export function importVoices(add: { id: string; fields: VoiceFields }[], change: { id: string; fields: VoiceFields }[], remove: string[], who: string): number {
  const now = Date.now();
  const before = new Map(addedVoices().map((v) => [v.id, v]));
  const picks = transaction(() => {
    for (const { id, fields } of add) insert(id, fields, who, now);
    for (const { id, fields } of change) update(id, tuned(before.get(id)!, fields), now);
    for (const id of remove) db.prepare('DELETE FROM voices WHERE id = ?').run(id);
    bump();
    return forgetPicks(remove);
  });
  for (const { id } of add) states[id] = { state: 'waiting' };
  for (const { id, fields } of change) if (!sameModel(before.get(id)!, fields)) states[id] = { state: 'waiting' };
  for (const id of remove) delete states[id];
  after();
  return picks;
}

/** Keeps what measuring a voice found, and for one set to `auto`, uses its curve and loudness */
export function setMeasured(id: string, measured: Measured | null) {
  const voice = addedVoices().find((v) => v.id === id);
  if (!voice) return;
  transaction(() => {
    db.prepare('UPDATE voices SET measured = ? WHERE id = ?').run(measured && JSON.stringify(measured), id);
    if (measured && voice.tune === 'auto') db.prepare('UPDATE voices SET curve = ?, volume = ?, changed_at = ? WHERE id = ?').run(measured.curve, measured.volume, Date.now(), id);
  });
  cached = null;
  changed();
}

/** For tests: forgets what the container said */
export function forgetVoiceStates() {
  states = {};
  containerVersion = null;
  cached = null;
  setKv(STATES_KEY, '{}');
  changed();
}

const LONGEST_NAME = 40;
/** Each can be up to 500 MB on the voice container's disk */
export const MOST_VOICES = 50;
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEX = /^[0-9a-f]{64}$/i;

type Named = Pick<AddedVoice, 'id' | 'name'>;

/** An https link, with a Hugging Face page's /blob/ turned into the file's own /resolve/, or null */
export function fileLink(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.hostname === 'huggingface.co') url.pathname = url.pathname.replace('/blob/', '/resolve/');
  return url.toString();
}

/** An id made from a name, unlike any taken */
export function newVoiceId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'voice';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

const between = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const given = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * A voice's settings as someone gave them, checked, with what's left out at its default. `names` are the names it
 * mustn't take, lower case. Returns why it can't be used instead, in words for the web UI
 */
export function voiceFields(input: Record<string, unknown>, names: ReadonlySet<string>): VoiceFields | string {
  const { name, group, model, config: settings, sha256, configSha256, speaker, volume, pace, noise, curve, tune } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > LONGEST_NAME) return `A voice’s name needs 1 to ${LONGEST_NAME} characters.`;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (names.has(trimmed.toLowerCase())) return `There’s already a voice called ${trimmed}.`;
  const modelUrl = fileLink(model);
  if (!modelUrl) return `${trimmed} needs a link to its model, starting https://.`;
  if (!new URL(modelUrl).pathname.endsWith('.onnx')) return `${trimmed}’s link needs to be to the model’s .onnx file.`;
  const configUrl = given(settings) ? fileLink(settings) : null;
  if (given(settings) && !configUrl) return `${trimmed}’s settings link needs to start https://.`;
  for (const sha of [sha256, configSha256]) if (given(sha) && !(typeof sha === 'string' && HEX.test(sha))) return `${trimmed}’s sha256 needs to be 64 hex digits.`;
  if (given(group) && !(GROUPS as readonly unknown[]).includes(group)) return `${trimmed}’s group is Characters or Accents.`;
  if (given(speaker) && !(Number.isInteger(speaker) && between(speaker, 0, 9999))) return `${trimmed}’s speaker is a whole number from 0.`;
  if (given(volume) && !between(volume, -20, 20)) return `${trimmed}’s loudness is from -20 to 20 dB.`;
  if (given(pace) && !between(pace, 0.5, 2)) return `${trimmed}’s pace is from 0.5 to 2.`;
  if (given(noise) && !(Array.isArray(noise) && noise.length === 2 && noise.every((n) => between(n, 0, 2)))) return `${trimmed}’s noise is two numbers from 0 to 2.`;
  if (given(curve) && !(CURVES as readonly unknown[]).includes(curve)) return `${trimmed}’s speed curve is one of ${CURVES.join(', ')}.`;
  if (given(tune) && !(TUNES as readonly unknown[]).includes(tune)) return `${trimmed}’s tune is auto or manual.`;
  return {
    name: trimmed,
    group: given(group) ? (group as VoiceGroup) : 'Characters',
    model: modelUrl,
    config: configUrl,
    sha256: given(sha256) ? (sha256 as string).toLowerCase() : null,
    configSha256: given(configSha256) ? (configSha256 as string).toLowerCase() : null,
    speaker: given(speaker) ? (speaker as number) : null,
    volume: given(volume) ? Math.round((volume as number) * 10) / 10 : 0,
    pace: given(pace) ? Math.round((pace as number) * 100) / 100 : 1,
    noise: given(noise) ? [(noise as number[])[0], (noise as number[])[1]] : null,
    curve: given(curve) ? (curve as Curve) : 'character',
    // Measured, unless someone said how loud or which curve
    tune: given(tune) ? (tune as Tune) : given(volume) || given(curve) ? 'manual' : 'auto',
  };
}

/** The names a voice can't take: the fixed voices' and the other added ones' */
export function takenNames(fixed: readonly Named[], except?: string): Set<string> {
  return new Set([...fixed, ...addedVoices().filter((v) => v.id !== except)].map((v) => v.name.toLowerCase()));
}

const FIELD_KEYS = ['name', 'group', 'model', 'config', 'sha256', 'configSha256', 'speaker', 'volume', 'pace', 'noise', 'curve', 'tune'] as const;

const sameFields = (a: VoiceFields, b: VoiceFields) => FIELD_KEYS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));

/** A voice as the export file has it, leaving out what's at its default */
export function exported(v: AddedVoice) {
  return {
    id: v.id,
    name: v.name,
    group: v.group,
    model: v.model,
    ...(v.config && { config: v.config }),
    ...(v.sha256 && { sha256: v.sha256 }),
    ...(v.configSha256 && { configSha256: v.configSha256 }),
    ...(v.speaker !== null && { speaker: v.speaker }),
    ...(v.volume && { volume: v.volume }),
    ...(v.pace !== 1 && { pace: v.pace }),
    ...(v.noise && { noise: v.noise }),
    ...(v.curve !== 'character' && { curve: v.curve }),
    // Always, as an entry without loudness or curve would otherwise be measured
    tune: v.tune,
  };
}

export const EXPORT_FORMAT = 'slopkeeper-voices';

export interface ImportPlan {
  add: { id: string; fields: VoiceFields }[];
  change: { id: string; fields: VoiceFields }[];
  unchanged: string[];
  remove: string[];
  skipped: { what: string; why: string }[];
}

/**
 * What importing a list would do, without doing it. It's an export file's voices, or a bare list. An entry is the added
 * voice with its id, or else its name; with `replace`, the added voices the list doesn't have are removed, except one
 * whose entry couldn't be used
 */
export function planImport(list: unknown, fixed: readonly Named[], replace: boolean): ImportPlan | string {
  if (!Array.isArray(list)) return 'That file has no list of voices.';
  const entries: unknown[] = list;
  if (list.length > MOST_VOICES * 2) return `That’s ${list.length} voices, and the most is ${MOST_VOICES}.`;
  const plan: ImportPlan = { add: [], change: [], unchanged: [], remove: [], skipped: [] };
  const added = addedVoices();
  const fixedNames = new Set(fixed.map((v) => v.name.toLowerCase()));
  const ids = new Set([...fixed, ...added].map((v) => v.id));
  /** Added voices this list has an entry for, used or not */
  const matched = new Set<string>();
  /** Names the list has given so far, which the ones after it can't take */
  const claimed = new Set<string>();
  list.forEach((entry: unknown, i) => {
    const what = entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' ? String((entry as { name: string }).name).slice(0, LONGEST_NAME) : `Entry ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return void plan.skipped.push({ what, why: 'It isn’t a voice.' });
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim().toLowerCase() : '';
    const same = added.find((v) => v.id === e.id) ?? added.find((v) => v.name.toLowerCase() === name);
    if (same) {
      if (matched.has(same.id)) return void plan.skipped.push({ what, why: 'It’s in the list twice.' });
      matched.add(same.id);
    }
    const others = new Set([...fixedNames, ...claimed, ...added.filter((v) => v.id !== same?.id && !(replace && willGo(v))).map((v) => v.name.toLowerCase())]);
    // An entry that doesn't say leaves a voice it matches as it was: files from before measuring don't have it
    const fields = voiceFields(same && !('tune' in e) ? { ...e, tune: same.tune } : e, others);
    if (typeof fields === 'string') return void plan.skipped.push({ what, why: fields });
    claimed.add(fields.name.toLowerCase());
    if (same) {
      if (sameFields(same, fields)) plan.unchanged.push(same.name);
      else plan.change.push({ id: same.id, fields });
      return;
    }
    const id = typeof e.id === 'string' && ID.test(e.id) && !ids.has(e.id) ? e.id : newVoiceId(fields.name, ids);
    ids.add(id);
    plan.add.push({ id, fields });
  });
  // A name the list gives can be one a voice it removes had: decided once every entry is seen
  function willGo(v: AddedVoice) {
    return !entries.some((e) => e && typeof e === 'object' && ((e as Record<string, unknown>).id === v.id || String((e as Record<string, unknown>).name ?? '').trim().toLowerCase() === v.name.toLowerCase()));
  }
  if (replace) plan.remove = added.filter((v) => !matched.has(v.id)).map((v) => v.id);
  if (added.length - plan.remove.length + plan.add.length > MOST_VOICES) return `That would make ${added.length - plan.remove.length + plan.add.length} added voices, and the most is ${MOST_VOICES}.`;
  return plan;
}
