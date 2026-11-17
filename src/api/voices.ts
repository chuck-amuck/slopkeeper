import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { asVoice, FIXED_VOICES, previewSpeech, TooSoon } from '../features/say.ts';
import {
  type AddedVoice,
  addedVoices,
  addVoice,
  editVoice,
  EXPORT_FORMAT,
  exported,
  importVoices,
  MOST_VOICES,
  newVoiceId,
  planImport,
  refreshVoiceStates,
  removeVoice,
  takenNames,
  voiceFields,
  voiceState,
} from '../features/voices.ts';
import { plural } from '../features/gamestats.ts';
import { measureAgain, voiceTuning } from '../features/voiceTuning.ts';
import { type Ask, Refused, by, readJson, whoDid } from './common.ts';

// The management API for the voices added in the web UI, which every server on the bot shares

const LONGEST_PREVIEW = 300;

function listed(ask: Ask, v: AddedVoice) {
  const state = voiceState(v.id);
  const measured = v.measured && { curve: v.measured.curve, fit: v.measured.fit, volume: v.measured.volume, at: v.measured.at };
  return {
    ...exported(v),
    state: state.state,
    percent: state.percent,
    error: state.error,
    speakers: state.speakers ?? [],
    tuning: voiceTuning(v.id),
    measured,
    addedBy: whoDid(ask.guild, v.addedBy),
    addedAt: v.addedAt,
  };
}

const find = (id: string | undefined) => {
  const voice = addedVoices().find((v) => v.id === id);
  if (!voice) throw new Refused(404, 'That voice isn’t there any more.');
  return voice;
};

/**
 * The voice's settings with the ones given put over them, checked. Setting the loudness or curve to something else
 * makes it `manual`, unless the change says otherwise
 */
function merged(voice: AddedVoice, changes: Record<string, unknown>) {
  const set = (key: 'volume' | 'curve', fallback: number | string) => key in changes && (changes[key] ?? fallback) !== voice[key];
  const tune = !('tune' in changes) && (set('volume', 0) || set('curve', 'character')) ? { tune: 'manual' } : {};
  const fields = voiceFields({ ...exported(voice), volume: voice.volume, curve: voice.curve, ...changes, ...tune }, takenNames(FIXED_VOICES, voice.id));
  if (typeof fields === 'string') throw new Refused(400, fields);
  return fields;
}

export async function voiceRoutes(ask: Ask) {
  const { guild, req, res, rest } = ask;
  const [id, action] = rest;
  if (!config.voiceUrl) throw new Refused(409, 'Text to speech isn’t set up on this bot. It needs VOICE_URL.');

  if (!id && req.method === 'GET') {
    // Only asked while one is on its way, so a list that's settled answers at once
    if (addedVoices().some((v) => !['ready', 'failed'].includes(voiceState(v.id).state))) await refreshVoiceStates();
    return { voices: addedVoices().map((v) => listed(ask, v)), most: MOST_VOICES };
  }

  if (!id && req.method === 'POST') {
    if (addedVoices().length >= MOST_VOICES) throw new Refused(409, `There are already ${MOST_VOICES} added voices, the most there can be. Remove one first.`);
    const fields = voiceFields(await readJson(req), takenNames(FIXED_VOICES));
    if (typeof fields === 'string') throw new Refused(400, fields);
    const newId = newVoiceId(fields.name, [...FIXED_VOICES, ...addedVoices()].map((v) => v.id));
    addVoice(newId, fields, by());
    logActivity(guild.id, by(), `Added the voice ${fields.name}`);
    return { voice: listed(ask, find(newId)) };
  }

  if (id === 'export' && !action && req.method === 'GET') {
    const body = JSON.stringify({ format: EXPORT_FORMAT, version: 1, voices: addedVoices().map(exported) }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="slopkeeper-voices.json"', 'cache-control': 'no-store' });
    res.end(body);
    return null;
  }

  if (id === 'import' && !action && req.method === 'POST') {
    const { voices, replace, dryRun } = await readJson(req);
    const plan = planImport(voices, FIXED_VOICES, replace === true);
    if (typeof plan === 'string') throw new Refused(400, plan);
    const nameOf = (voiceId: string) => addedVoices().find((v) => v.id === voiceId)?.name ?? voiceId;
    const summary = {
      added: plan.add.map((a) => a.fields.name),
      changed: plan.change.map((c) => c.fields.name),
      unchanged: plan.unchanged,
      removed: plan.remove.map(nameOf),
      skipped: plan.skipped,
    };
    if (dryRun !== false) return summary;
    if (!plan.add.length && !plan.change.length && !plan.remove.length) return summary;
    importVoices(plan.add, plan.change, plan.remove, by());
    const parts = [plan.add.length && `${plural(plan.add.length, 'voice')} added`, plan.change.length && `${plan.change.length} changed`, plan.remove.length && `${plan.remove.length} removed`].filter(Boolean);
    logActivity(guild.id, by(), `Imported voices: ${parts.join(', ')}`);
    return summary;
  }

  if (id && !action && req.method === 'PUT') {
    const voice = find(id);
    const fields = merged(voice, await readJson(req));
    editVoice(id, fields);
    logActivity(guild.id, by(), fields.name === voice.name ? `Changed the voice ${voice.name}` : `Changed the voice ${voice.name}, now called ${fields.name}`);
    return { voice: listed(ask, find(id)) };
  }

  if (id && !action && req.method === 'DELETE') {
    const voice = find(id);
    const picks = removeVoice(id);
    logActivity(guild.id, by(), `Removed the voice ${voice.name}${picks ? `, and ${picks === 1 ? '1 server’s pick' : `${picks} servers’ picks`} of it` : ''}`);
    return { picks };
  }

  if (id && action === 'measure' && !rest[2] && req.method === 'POST') {
    const voice = find(id);
    if (voiceState(id).state !== 'ready') throw new Refused(409, `${voice.name} isn’t downloaded yet.`);
    measureAgain(id);
    return { voice: listed(ask, find(id)) };
  }

  if (id && action === 'preview' && !rest[2] && req.method === 'POST') {
    const voice = find(id);
    const state = voiceState(id);
    if (state.state !== 'ready' || !state.file) throw new Refused(409, `${voice.name} isn’t downloaded yet.`);
    const { text, ...changes } = await readJson(req);
    const fields = merged(voice, changes);
    const typed = typeof text === 'string' ? text.slice(0, LONGEST_PREVIEW) : '';
    // A changed link isn't downloaded yet, so a preview is of the model that's there, with the settings given
    const audio = await previewSpeech(guild, typed, asVoice({ ...voice, ...fields }, state.file)).catch((err: unknown) => {
      if (err instanceof TooSoon) throw new Refused(429, err.message);
      if (err instanceof Error && err.message.startsWith('There’s nothing')) throw new Refused(400, err.message);
      console.error(`Web UI: a preview of the added voice ${voice.name} failed:`, err);
      throw new Refused(502, 'The voice container isn’t answering. Try again in a moment.');
    });
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' });
    res.end(audio);
    return null;
  }

  throw new Refused(404, 'Not found.');
}
