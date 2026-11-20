import './helpers.ts';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { PermissionFlagsBits } from 'discord.js';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { Mixer } from '../src/mixer.ts';
import * as perf from '../src/perf.ts';
import { announceAloud, CURVE_STRETCHES, heldWords, previewSpeech, readable, effects, forgetSpoken, lengthFor, moveEffectVoices, NO_EFFECT, oldEffectVoice, phrases, previewPart, readMessage, removePhrase, savePhrase, say, sayOut, missingVoice, serverEffect, serverVoice, speak, speechFor, voiceGroup, voices } from '../src/features/say.ts';
import { effectGain, forgetEffectGains, setEffectGain, soundKey } from '../src/features/effectGains.ts';
import { addVoice, removeVoice, syncVoices, voiceFields, voicesVersion } from '../src/features/voices.ts';
import { addProfile, builtIn, fieldsOf, removeProfile } from '../src/features/chatProfiles.ts';
import { applySpeechVolume, stopPlayback } from '../src/features/voiceAudio.ts';
import { loopSpeechProblem } from '../src/features/loopRoom.ts';
import { playJoinSound, setJoinSound } from '../src/features/joinSounds.ts';
import { saveUpload } from '../src/features/soundLibrary.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { stopTuning } from '../src/features/voiceTuning.ts';
import { setSetting, storedSetting } from '../src/settings.ts';
import { holdSounds } from '../src/loudness.ts';
import { markStarted, STARTING_RETRY_MS } from '../src/util.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(path.join(process.env.DATA_DIR!, 'speech-'));
const speechFile = path.join(dir, 'line.wav');
if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.15', speechFile]);

const NO_URL = config.voiceUrl;
const STOPPED = 'Stopped before that was said.';
const UNAVAILABLE = 'The voice isn’t available right now. Try again in a moment.';

// A voice connection that's ready and swallows audio, since there's no real Discord to connect to
const networking = { state: {}, on() {}, off() {}, prepareAudioPacket() {}, dispatchAudio: () => true, setSpeaking() {}, destroy() {} };
const accepting = new Set<string>();
const discord = setInterval(() => {
  for (const id of accepting) {
    const c = getVoiceConnection(id);
    if (c && c.state.status !== VoiceConnectionStatus.Ready && c.state.status !== VoiceConnectionStatus.Destroyed) c.state = { ...c.state, status: VoiceConnectionStatus.Ready, networking } as never;
  }
}, 2);

let nextGuild = 0;
function channel(options: { missing?: bigint[] } = {}) {
  const id = `say-${nextGuild++}`;
  accepting.add(id);
  // Most tests aren't about the wait
  setSetting(id, 'ttsCooldownSec', 0);
  return {
    id: 'voice',
    name: 'General',
    joinable: true,
    toString: () => '#General',
    permissionsFor: () => ({ has: (flag: bigint) => !options.missing?.includes(flag) }),
    guild: {
      id,
      name: 'Server',
      members: { me: { roles: { botRole: { id: '400' } } }, cache: new Map() },
      roles: { cache: new Map() },
      channels: { cache: new Map() },
      voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
    },
  } as never as import('discord.js').VoiceBasedChannel;
}

/** A voice container, which keeps what it was asked for */
function fakeVoice(t: TestContext, answer?: (text: string, signal: AbortSignal) => Promise<Response>) {
  const asked: { text: string; model?: string; speaker?: number; length: number }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'http://voice.test/synthesize');
    const body = JSON.parse(init.body as string) as { text: string; voice?: string; speaker_id?: number; length_scale: number };
    asked.push({ text: body.text, model: body.voice, speaker: body.speaker_id, length: body.length_scale });
    return answer ? answer(body.text, init.signal!) : new Response(readFileSync(speechFile));
  });
  return asked;
}

const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith('slopkeeper-say-')).flatMap((f) => readdirSync(path.join(tmpdir(), f)));

speak.setup!({ on() {}, guilds: { cache: new Map() } } as never);
// Measuring added voices has its own tests (voiceTuning.test.ts), and would ask the fake voice container for more here
stopTuning();
beforeEach(() => {
  config.voiceUrl = 'http://voice.test';
  // Each test counts what the voice container is asked for
  forgetSpoken();
});
afterEach(() => void (config.voiceUrl = NO_URL));
after(() => {
  clearInterval(discord);
  soundboard.shutdown!();
});

test('reads out a line in the server’s voice, or the one asked for, and logs who said it', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  assert.equal(await say(voice, 'hello there', undefined, 'ana'), null);
  await sleep(300);
  // Robot was a voice before effects were picked apart from voices: it's the voice it was made on, through the effect
  assert.equal(await say(voice, 'and again', 'robot', 'ben'), null);
  await sleep(300);
  assert.deepEqual(asked, [
    { text: 'hello there', model: 'southern_male', speaker: 0, length: 1.25 },
    { text: 'and again', model: undefined, speaker: 400, length: lengthFor(85) },
  ]);
  const lines = recentActivity(voice.guild.id, 5).map((r) => `${r.actor}: ${r.action}`).toReversed();
  assert.deepEqual(lines, ['ana: Said “hello there” in <#voice>', 'ben: Said “and again” in <#voice>']);
  assert.deepEqual(leftovers(), []);
  // For Stats: who, the voice and how long, never the words
  const kept = db.prepare('SELECT * FROM speech_lines WHERE guild_id = ? ORDER BY at').all(voice.guild.id) as any[];
  assert.deepEqual(
    kept.map(({ user_id, voice, characters, kind, effect }) => ({ user_id, voice, characters, kind, effect })),
    [
      { user_id: 'ana', voice: 'southern-man', characters: 11, kind: 'say', effect: null },
      { user_id: 'ben', voice: 'american-man', characters: 9, kind: 'say', effect: 'robot' },
    ],
  );
  assert.deepEqual(Object.keys(kept[0]).sort(), ['at', 'characters', 'effect', 'guild_id', 'kind', 'user_id', 'voice']);
});

test('a slow line keeps how long each step took, with its voice and length but never its words', { skip: !hasFfmpeg }, async (t) => {
  perf.testing();
  perf.keep(true);
  t.after(() => perf.keep(false));
  // The voice container takes five seconds, as the clock sees it
  const real = performance.now.bind(performance);
  let ahead = 0;
  t.mock.method(performance, 'now', () => real() + ahead);
  fakeVoice(t, async () => {
    ahead = 5000;
    return new Response(readFileSync(speechFile), { headers: { 'server-timing': 'load;dur=0, synth;dur=812.5, total;dur=820' } });
  });
  const voice = channel();
  assert.equal(await say(voice, 'secret plans', 'scottish', 'ana'), null);
  await sleep(300);
  const { slow } = perf.take(true);
  assert.equal(slow.length, 1);
  assert.deepEqual([slow[0].what, slow[0].guildId, slow[0].detail], ['Speech', voice.guild.id, { voice: 'scottish', effect: null, characters: 12, waitingAhead: 0, kept: false }]);
  assert.deepEqual(
    slow[0].steps.map(([name, , of]) => (of ? `${of} > ${name}` : name)),
    ['waiting', 'making > voice container', 'voice container > saying it', 'making > levelling and effects', 'making', 'starting'],
  );
  assert.ok(slow[0].seconds >= 5);
  assert.doesNotMatch(JSON.stringify(slow), /secret|plans/);
  const text = perf.prometheus();
  assert.match(text, /^slopkeeper_speech_seconds_count 1$/m);
  assert.match(text, /^slopkeeper_voice_synth_seconds_sum\{voice="scottish"\} 0.8125$/m);
  assert.match(text, /^slopkeeper_speech_make_seconds_count\{length="short"\} 1$/m);
  assert.match(text, /^slopkeeper_audio_start_seconds_count\{kind="speech"\} 1$/m);
  assert.doesNotMatch(text, /voice_model_load_seconds_count/, 'a model already loaded took no loading');
});

test('a line said again soon in the same voice and speed is made once, and a new speed makes it again', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  for (const text of ['gg', 'gg', 'gg']) {
    assert.equal(await say(voice, text, 'irish', 'ana'), null);
    await sleep(300);
  }
  assert.equal(asked.length, 1);
  assert.equal(await say(voice, 'gg', 'scottish', 'ana'), null);
  await sleep(300);
  setSetting(voice.guild.id, 'ttsSpeed', 120);
  assert.equal(await say(voice, 'gg', 'irish', 'ana'), null);
  await sleep(300);
  assert.deepEqual(asked.map((a) => a.model), ['jenny', 'alba', 'jenny']);
  assert.deepEqual(leftovers(), []);
});

test('the same line asked for in two servers at once is made once', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t, async () => (await sleep(100), new Response(readFileSync(speechFile))));
  const [one, two] = [channel(), channel()];
  assert.deepEqual(await Promise.all([say(one, 'gg', 'scottish', 'ana'), say(two, 'gg', 'scottish', 'ben')]), [null, null]);
  await sleep(400);
  assert.equal(asked.length, 1);
  assert.deepEqual(leftovers(), []);
});

test('the built-in voices ask for their own model, speaker and speed', { skip: !hasFfmpeg }, async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(readFileSync(speechFile));
  });
  const voice = channel();
  const ids = ['scottish', 'northern', 'irish', 'broadcast', 'russian', 'spanish', 'german'];
  for (const id of [...ids, 'southern-woman', 'southern-man', 'australian-woman', 'demon', 'giant']) {
    assert.equal(await say(voice, 'good news everyone', id, id), null);
    await sleep(300);
  }
  assert.deepEqual(bodies, [
    // The character curve: 85% speed takes 18% longer, which these models give at 1.25, and the middle curve between
    { text: 'good news everyone', voice: 'alba', length_scale: 1.25, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'northern', length_scale: 1.31, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'jenny', length_scale: 1.25, sentence_silence: 0.2 },
    // The accents: KSS 15% slower than the character curve, Dmitri on its own curve, and the German model's neutral speaker
    { text: 'good news everyone', voice: 'kss', length_scale: 1.44, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'dmitri', length_scale: 1.31, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'davefx', length_scale: 1.25, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'thorsten', speaker_id: 4, length_scale: 1.25, sentence_silence: 0.2 },
    // The low-quality model on its own curve, and the speakers picked from models with several
    { text: 'good news everyone', voice: 'southern_female', length_scale: 1.29, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'southern_male', speaker_id: 0, length_scale: 1.25, sentence_silence: 0.2 },
    { text: 'good news everyone', voice: 'australian', speaker_id: 7, length_scale: 1.31, sentence_silence: 0.2 },
    // Effect styles are the default model's speakers, at their own pace
    { text: 'good news everyone', speaker_id: 499, length_scale: 1.5, sentence_silence: 0.2 },
    { text: 'good news everyone', speaker_id: 499, length_scale: 1.63, sentence_silence: 0.2 },
  ]);
  // Effects take a moment longer to run than the 300 ms above, and longer still with the whole suite running
  for (let tries = 0; leftovers().length && tries < 100; tries++) await sleep(100);
  assert.deepEqual(leftovers(), []);
});

test('every voice’s model is one the voice container fetches, and the English accents are grouped as accents', () => {
  const fetched = new Set([...readFileSync(path.join(import.meta.dirname, '../voice/start.sh'), 'utf8').matchAll(/^fetch (\S+) /gm)].map((m) => m[1]));
  for (const voice of voices()) if (voice.model) assert.ok(fetched.has(voice.model), `${voice.name} needs voice/start.sh to fetch ${voice.model}`);
  const group = (id: string) => voiceGroup(voices().find((v) => v.id === id)!);
  assert.deepEqual(['scottish', 'irish', 'australian-man', 'russian', 'american-deep'].map(group), ['Accents', 'Accents', 'Accents', 'Accents', 'Accents']);
  // Effects are picked beside a voice, and aren't voices
  assert.ok(!voices().some((v) => effects().some((e) => e.id === v.id)));
  // Characters are added in the web UI, so the public image carries none
  assert.ok(!voices().some((v) => voiceGroup(v) === 'Characters'));
});

test('an effect goes with any voice, at its own pace, and a line is made again when only its effect changes', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  const said = async (effect?: string) => {
    const problem = await say(voice, 'hi there', 'scottish', 'cy', effect);
    await sleep(300);
    return problem;
  };
  assert.equal(await said('helium'), null);
  assert.equal(await said('Walkie-talkie'), null, 'by name, as typed into /say');
  assert.equal(await said(NO_EFFECT), null);
  assert.equal(await said(NO_EFFECT), null);
  assert.equal(await said('sparkles'), 'Pick an effect from the list.');
  // Helium is 10% quicker and the walkie-talkie 5%, on top of the voice's own curve. The same line without one is kept
  const scottish = lengthFor(85, CURVE_STRETCHES.character);
  assert.deepEqual(
    asked.map((a) => [a.model, a.length]),
    [
      ['alba', Math.round(scottish * 0.9 * 100) / 100],
      ['alba', Math.round(scottish * 0.95 * 100) / 100],
      ['alba', scottish],
    ],
  );
  const lines = db.prepare('SELECT effect FROM speech_lines WHERE guild_id = ? ORDER BY at').all(voice.guild.id) as { effect: string | null }[];
  assert.deepEqual(lines.map((l) => l.effect), ['helium', 'radio', null, null]);
});

test('the server’s default effect is used when nobody picks one, and no effect is a pick of its own', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  setSetting(voice.guild.id, 'ttsEffect', 'giant');
  assert.equal(serverEffect(voice.guild.id)?.id, 'giant');
  assert.equal(await say(voice, 'one', 'scottish', 'cy'), null);
  await sleep(300);
  assert.equal(await say(voice, 'two', 'scottish', 'cy', NO_EFFECT), null);
  await sleep(300);
  assert.equal(await sayOut(voice, 'three'), null);
  await sleep(300);
  const scottish = lengthFor(85, CURVE_STRETCHES.character);
  assert.deepEqual(asked.map((a) => a.length), [Math.round(scottish * 1.2 * 100) / 100, scottish, 1.5]);
  const lines = db.prepare('SELECT effect, kind FROM speech_lines WHERE guild_id = ? ORDER BY at').all(voice.guild.id) as { effect: string | null; kind: string }[];
  assert.deepEqual(lines.map((l) => [l.kind, l.effect]), [['say', 'giant'], ['say', null], ['announcement', 'giant']]);
});

test('picks of the old effect voices move to the voice each was made on and the effect', () => {
  setSetting('moving-1', 'ttsVoice', 'demon');
  setSetting('moving-1', 'loopVoice', 'ghost');
  setSetting('moving-1', 'loopEffect', NO_EFFECT);
  setSetting('moving-2', 'ttsVoice', 'scottish');
  moveEffectVoices();
  assert.deepEqual(['ttsVoice', 'ttsEffect', 'loopVoice', 'loopEffect'].map((k) => storedSetting('moving-1', k as never)), ['american-deep', 'demon', 'american-woman', NO_EFFECT], 'an effect already picked stays');
  assert.deepEqual([storedSetting('moving-2', 'ttsVoice'), storedSetting('moving-2', 'ttsEffect')], ['scottish', undefined]);
  // One still named somewhere, as TTS_VOICE or a device's last pick might, brings its effect unless one is picked
  assert.deepEqual(oldEffectVoice('Trailer narrator'), { voice: 'american-deep', effect: 'trailer' });
  assert.equal(oldEffectVoice('scottish'), null);
  assert.equal(oldEffectVoice('loudspeaker'), null, 'new as an effect, so never a voice');
  setSetting('moving-3', 'ttsVoice', 'helium');
  assert.deepEqual([serverVoice('moving-3').id, serverEffect('moving-3')?.id], ['american-man', 'helium']);
  assert.equal(missingVoice('helium'), null, 'not a problem to show in Settings');
  setSetting('moving-3', 'ttsEffect', NO_EFFECT);
  assert.equal(serverEffect('moving-3'), null);
  assert.equal(serverEffect('moving-3', undefined, 'radio')?.id, 'radio', 'a voice picked as the old one brings it');
  assert.equal(serverEffect('moving-3', NO_EFFECT, 'radio'), null, 'unless no effect is picked with it');
  // Lines said in them are moved too, for Stats
  db.prepare("INSERT INTO speech_lines (guild_id, at, user_id, voice, characters, kind) VALUES ('moving-1', 1, NULL, 'ghost', 5, 'say')").run();
  moveEffectVoices();
  assert.deepEqual({ ...(db.prepare("SELECT voice, effect FROM speech_lines WHERE guild_id = 'moving-1'").get() as object) }, { voice: 'american-woman', effect: 'ghost' });
});

test('an effect is turned up or down by what was measured on that voice, or its typical amount until then', { skip: !hasFfmpeg }, async (t) => {
  forgetEffectGains();
  t.after(forgetEffectGains);
  const scottish = voices().find((v) => v.id === 'scottish')!;
  const underwater = effects().find((e) => e.id === 'underwater')!;
  assert.equal(effectGain(scottish, underwater), underwater.typical);
  setEffectGain(soundKey(scottish), 'underwater', underwater.effects, 4.5);
  assert.equal(effectGain(scottish, underwater), 4.5);
  setEffectGain(soundKey(scottish), 'underwater', 'an older chain', 4.5);
  assert.equal(effectGain(scottish, underwater), underwater.typical, 'measured with the effect as it was, so not any more');
  // Once it's measured, a line said before is made again at the new loudness
  const asked = fakeVoice(t);
  const voice = channel();
  for (const gain of [null, null, 3]) {
    if (gain !== null) setEffectGain(soundKey(scottish), 'underwater', underwater.effects, gain);
    assert.equal(await say(voice, 'deep down', 'scottish', 'cy', 'underwater'), null);
    await sleep(300);
  }
  assert.equal(asked.length, 2);
});

const MODEL = 'https://huggingface.co/someone/voice/resolve/main/voice.onnx';

test('just after the bot starts, a voice container that isn’t answering yet is sent the voices again quietly, and warned about a minute on', async (t) => {
  let up = false;
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'http://voice.test/models');
    sent++;
    if (!up) throw new TypeError('fetch failed');
    return Response.json({ version: voicesVersion(), voices: {} });
  });
  const warned = t.mock.method(console, 'warn', () => {});
  t.after(() => markStarted(0));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  markStarted();
  await syncVoices();
  assert.deepEqual([sent, warned.mock.callCount()], [1, 0]);
  up = true;
  t.mock.timers.tick(STARTING_RETRY_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([sent, warned.mock.callCount()], [2, 0], 'tried again by itself, and fine');

  markStarted(Date.now() - 61_000);
  up = false;
  await syncVoices();
  t.mock.timers.tick(STARTING_RETRY_MS);
  assert.deepEqual([sent, warned.mock.callCount()], [3, 1], 'not tried again: the health check sends it once the container answers');
  assert.match(String(warned.mock.calls[0].arguments[0]), /Couldn't send the added voices to the voice container: fetch failed/);
  up = true;
  await syncVoices();
});

test('an added voice speaks its own model once the voice container has it, with its settings, and not before', { skip: !hasFfmpeg }, async (t) => {
  const asked: { text: string; model?: string; speaker?: number; length: number; noise?: number }[] = [];
  let ready = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === 'http://voice.test/models') {
      const file = 'voice-narrator-0123456789ab';
      return Response.json({ version: voicesVersion(), voices: { narrator: ready ? { state: 'ready', file, speakers: [] } : { state: 'downloading', percent: 40 } } });
    }
    const body = JSON.parse(init!.body as string) as { text: string; voice?: string; speaker_id?: number; length_scale: number; noise_scale?: number };
    asked.push({ text: body.text, model: body.voice, speaker: body.speaker_id, length: body.length_scale, noise: body.noise_scale });
    return new Response(readFileSync(speechFile));
  });
  const fields = voiceFields({ name: 'Narrator', model: MODEL, group: 'Accents', speaker: 3, volume: -2.5, pace: 1.1, noise: [0.5, 0.3], curve: 'middle' }, new Set());
  assert.ok(typeof fields !== 'string');
  addVoice('narrator', fields, 'a');
  t.after(() => removeVoice('narrator'));
  await syncVoices();
  assert.equal(voices().find((v) => v.id === 'narrator'), undefined, 'not while it downloads');
  const voice = channel();
  setSetting(voice.guild.id, 'ttsVoice', 'narrator');
  assert.match(missingVoice('narrator')!, /Narrator is still downloading/);
  ready = true;
  await syncVoices();
  const narrator = voices().find((v) => v.id === 'narrator')!;
  assert.equal(voiceGroup(narrator), 'Accents');
  assert.equal(missingVoice('narrator'), null);
  assert.equal(await say(voice, 'once upon a time', undefined, 'a'), null);
  await sleep(300);
  assert.deepEqual(asked, [{ text: 'once upon a time', model: 'voice-narrator-0123456789ab', speaker: 3, length: Math.round(lengthFor(85, narrator.stretches) * 1.1 * 100) / 100, noise: 0.5 }]);
});

test('a server whose voice was removed talks in the default voice, but asking for an unknown one is refused', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  setSetting(voice.guild.id, 'ttsVoice', 'racer');
  assert.equal(await say(voice, 'still here', undefined, 'a'), null);
  await sleep(300);
  assert.equal(await sayOut(voice, 'and here'), null);
  await sleep(300);
  assert.equal(await say(voice, 'not this', 'racer', 'b'), 'Pick a voice from the list.');
  assert.deepEqual(asked.map((a) => [a.text, a.model]), [['still here', 'southern_male'], ['and here', 'southern_male']]);
});

test('the bot’s own lines are in its profile’s voice, while lines people say keep the server’s', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  const id = addProfile({ ...fieldsOf(builtIn()), name: 'Scot', personality: 'A Scot.', voice: 'scottish' }, 'u1');
  t.after(() => removeProfile(id));
  setSetting(voice.guild.id, 'chatProfile', id);
  assert.equal(await sayOut(voice, 'its own'), null);
  await sleep(300);
  assert.equal(await say(voice, 'somebody else', undefined, 'a'), null);
  await sleep(300);
  assert.deepEqual(
    asked.map((a) => [a.text, a.model]),
    [
      ['its own', 'alba'],
      ['somebody else', 'southern_male'],
    ],
  );
});

test('a pick of a voice that’s gone is kept, and falls back to the server’s own default, then the bot’s', () => {
  setSetting('old-numbered', 'ttsVoice', '5');
  setSetting('old-loop', 'ttsVoice', 'scottish');
  setSetting('old-loop', 'loopVoice', '9');
  assert.equal(serverVoice('old-loop', '9').id, 'scottish', 'the server’s default, not the bot’s');
  assert.equal(serverVoice('old-numbered').id, 'southern-man');
  assert.equal(storedSetting('old-numbered', 'ttsVoice'), '5', 'kept, in case it comes back');
  assert.match(missingVoice('5')!, /5 isn’t a voice any more/);
});

test('a voice typed by its name instead of picked from the list still works', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  assert.equal(await say(voice, 'boo', 'Demon', 'a'), null);
  await sleep(300);
  assert.equal(await say(voice, 'over', ' walkie-talkie ', 'a'), null);
  await sleep(300);
  assert.deepEqual(asked.map((a) => a.speaker), [499, 400]);
});

test('a server’s speed setting changes how long speech takes', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  setSetting(voice.guild.id, 'ttsVoice', 'robot');
  for (const speed of [100, 50, 150]) {
    setSetting(voice.guild.id, 'ttsSpeed', speed);
    assert.equal(await say(voice, 'hello', undefined, String(speed)), null);
  }
  assert.deepEqual(asked.map((a) => a.length), [1, 2.5, 0.5]);
});

test('a speed means what it says, despite Piper not being proportional', () => {
  assert.equal(lengthFor(100), 1);
  // Measured: 1.3 takes 13% longer, and 1.4 takes 21% longer
  assert.ok(lengthFor(85) > 1.3 && lengthFor(85) < 1.4, String(lengthFor(85)));
  assert.equal(lengthFor(50), 2.5);
  assert.equal(lengthFor(150), 0.5);
  const lengths = Array.from({ length: 101 }, (_, n) => lengthFor(50 + n));
  assert.ok(lengths.every((length, n) => n === 0 || length <= lengths[n - 1]), 'faster never takes longer');
});

test('a server’s speech volume sets how loud lines play, including one being said', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const added = t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => onEnd?.());
  const set = t.mock.method(Mixer.prototype, 'setGroupGain');
  const voice = channel();
  setSetting(voice.guild.id, 'ttsVolume', 150);
  assert.equal(await say(voice, 'hello', undefined, 'a'), null);
  assert.deepEqual(added.mock.calls.map((c) => [c.arguments[1], c.arguments[3]?.group]), [[1, 'speech']], 'the line plays at full gain in the speech group');
  assert.deepEqual(set.mock.calls.find((c) => c.arguments[0] === 'speech')?.arguments, ['speech', 1.5], 'the group starts at the setting');
  setSetting(voice.guild.id, 'ttsVolume', 50);
  applySpeechVolume(voice.guild.id);
  assert.deepEqual(set.mock.calls.at(-1)!.arguments, ['speech', 0.5], 'and follows it when it changes');
});

test('audio that can’t be read counts as the voice being unavailable, and leaves nothing behind', { skip: !hasFfmpeg }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const before = leftovers();
  fakeVoice(t, async () => new Response('not audio'));
  assert.equal(await say(channel(), 'hello', undefined, 'x'), UNAVAILABLE);
  assert.deepEqual(leftovers().filter((f) => !before.includes(f)), []);
});

test('lines wait their turn', { skip: !hasFfmpeg }, async (t) => {
  const order: string[] = [];
  fakeVoice(t, async (text) => {
    order.push(`made ${text}`);
    return new Response(readFileSync(speechFile));
  });
  const voice = channel();
  await Promise.all(['one', 'two', 'three'].map((text) => say(voice, text, undefined, text).then(() => order.push(`started ${text}`))));
  assert.deepEqual(order, ['made one', 'started one', 'made two', 'started two', 'made three', 'started three']);
});

test('Stop ends the line being said and everything waiting', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  // Lines from the tests before this one may still be playing
  const before = leftovers();
  const lines = ['one', 'two', 'three'].map((text) => say(voice, text, undefined, text));
  assert.equal(await lines[0], null);
  stopPlayback(voice.guild.id);
  assert.deepEqual(await Promise.all(lines.slice(1)), [STOPPED, STOPPED]);
  assert.deepEqual(asked.map((a) => a.text), ['one']);
  await sleep(50);
  assert.deepEqual(leftovers().filter((f) => !before.includes(f)), []);
  assert.equal(recentActivity(voice.guild.id, 5).length, 1, 'only what was said is logged');
  assert.equal(await say(voice, 'after', undefined, 'x'), null, 'the queue still works');
});

test('Stop cancels a line that’s still being made, without calling that a failure', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  fakeVoice(t, (_, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  const voice = channel();
  const line = say(voice, 'hello', undefined, 'x');
  await sleep(10);
  stopPlayback(voice.guild.id);
  assert.equal(await line, STOPPED);
  assert.equal(errors.mock.callCount(), 0);
});

test('Stop just after a line is made means it’s never played', { skip: !hasFfmpeg }, async (t) => {
  let made!: () => void;
  const ready = new Promise<void>((resolve) => (made = resolve));
  fakeVoice(t, async () => {
    made();
    return new Response(readFileSync(speechFile));
  });
  const voice = channel();
  const line = say(voice, 'hello', undefined, 'x');
  await ready;
  stopPlayback(voice.guild.id);
  assert.equal(await line, STOPPED);
  assert.equal(getVoiceConnection(voice.guild.id), undefined, 'it never joined');
});

test('a voice container that’s down or broken is reported, and the next line still gets its turn', { skip: !hasFfmpeg }, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  fakeVoice(t, async (text) => {
    if (text === 'down') throw new TypeError('fetch failed');
    return text === 'broken' ? new Response('nope', { status: 500 }) : new Response(readFileSync(speechFile));
  });
  const voice = channel();
  assert.deepEqual(await Promise.all([say(voice, 'down', undefined, 'a'), say(voice, 'broken', undefined, 'b'), say(voice, 'fine', undefined, 'c')]), [UNAVAILABLE, UNAVAILABLE, null]);
  assert.equal(errors.mock.callCount(), 2);
  assert.deepEqual(recentActivity(voice.guild.id, 5).map((r) => r.actor), ['c']);
});

test('gives up on a voice container that doesn’t answer', async (t) => {
  t.mock.method(console, 'error', () => {});
  const timedOut = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => timedOut.signal);
  fakeVoice(t, (_, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timed out')))));
  const line = say(channel(), 'hello', undefined, 'x');
  await sleep(10);
  assert.equal(timeout.mock.calls[0].arguments[0], 15_050, '15 s, and 10 ms for each of its 5 characters');
  timedOut.abort();
  assert.equal(await line, UNAVAILABLE);
});

test('a channel it can’t join is reported, and leaves no file behind', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  // Lines from the tests before this one may still be playing
  const before = leftovers();
  const problem = await say(channel({ missing: [PermissionFlagsBits.Connect] }), 'hello', undefined, 'x');
  assert.match(problem!, /Connect/);
  assert.deepEqual(leftovers().filter((f) => !before.includes(f)), []);
});

test('refuses without asking the voice container when a line can’t be said', async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  const { id } = voice.guild;
  assert.equal(await say(voice, 'hi', 'nope', 'x'), 'Pick a voice from the list.');
  assert.equal(await say(voice, '   ', undefined, 'x'), 'There’s nothing in that to read out.');
  assert.equal(await say(voice, '🎉🎉 👍🏽 ❤️', undefined, 'x'), 'There’s nothing in that to read out.');

  setSetting(id, 'ttsMaxChars', 20);
  assert.equal(await say(voice, `${'xy'.repeat(10)}x`, undefined, 'x'), 'That’s 21 characters, and the limit here is 20.');

  setSetting(id, 'tts', false);
  assert.equal(await say(voice, 'hi', undefined, 'x'), 'Text to speech is off in this server.');
  setSetting(id, 'tts', true);

  config.voiceUrl = null;
  assert.match((await say(voice, 'hi', undefined, 'x'))!, /VOICE_URL/);
  assert.equal(asked.length, 0);
});

test('the limit counts what’s read out, not the markup', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  setSetting(voice.guild.id, 'ttsMaxChars', 20);
  voice.guild.members.cache.set('123456789012345678', { displayName: 'Ana' } as never);
  assert.equal(await say(voice, 'hi <@123456789012345678> <@123456789012345678>', undefined, 'x'), null);
  assert.equal(asked[0].text, 'hi Ana Ana');
});

test('each person waits between lines, and a refused line doesn’t restart the wait', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const voice = channel();
  setSetting(voice.guild.id, 'ttsCooldownSec', 5);
  const realNow = Date.now;
  let now = realNow();
  t.mock.method(Date, 'now', () => now);
  assert.equal(await say(voice, 'one', undefined, 'ana'), null);
  now += 3200;
  assert.equal(await say(voice, 'two', undefined, 'ana'), 'Wait 2 more seconds first.');
  assert.equal(await say(voice, 'hello', undefined, 'ben'), null, 'someone else doesn’t wait');
  now += 1000;
  assert.equal(await say(voice, 'two', undefined, 'ana'), 'Wait 1 more second first.');
  now += 900;
  assert.equal(await say(voice, 'three', undefined, 'ana'), null);
});

test('only so many lines can wait', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const voice = channel();
  const lines = ['a', 'b', 'c', 'd', 'e', 'f'].map((text) => say(voice, text, undefined, text));
  assert.match((await say(voice, 'g', undefined, 'g'))!, /already 5 lines waiting/);
  stopPlayback(voice.guild.id);
  await Promise.all(lines);
});

test('reads mentions, emoji and links as words', () => {
  const guild = {
    members: { cache: new Map([['1', { displayName: 'Ana' }]]) },
    roles: { cache: new Map([['2', { name: 'Gamers' }]]) },
    channels: { cache: new Map([['3', { name: 'general' }]]) },
  } as never;
  assert.equal(speechFor(guild, 'hey <@1> and <@!1>, <@&2> in <#3>'), 'hey Ana and Ana, Gamers in general');
  assert.equal(speechFor(guild, '<@9> <@&9> <#9>'), 'someone a role a channel');
  // As a chat answer has them once they're made readable, or as someone typed them
  assert.equal(speechFor(guild, 'Esteemed @Ana, (@Bo) see #general.'), 'Esteemed Ana, (Bo) see general.');
  assert.equal(speechFor(guild, 'mail ana@example.test, we’re #1 and @ 5'), 'mail ana@example.test, we’re #1 and @ 5');
  assert.equal(speechFor(guild, 'nice <:big_brain:1234> <a:party:5678> 🎉 👍🏽'), 'nice big brain party');
  assert.equal(speechFor(guild, 'see https://example.test/a?b=1 now'), 'see link now');
  assert.equal(speechFor(guild, '**bold** ~~gone~~ `code` ||secret|| _lean_'), 'bold gone code secret lean');
  // A capital, as Piper doesn't break a sentence before a small letter
  assert.equal(speechFor(guild, '  two\n\n lines  '), 'two. Lines');
});

test('a line break after a heading or unfinished line is a pause, and one after a sentence stays as it was', () => {
  const guild = { members: { cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } } as never;
  assert.equal(speechFor(guild, 'Preamble\n\nWe the people.\nArticle I. The Council\nAll powers.'), 'Preamble. We the people. Article I. The Council. All powers.');
  assert.equal(speechFor(guild, 'THE BILL (selected)\r\n\r\nI. One, two,\nthree'), 'THE BILL (selected). I. One, two, three');
});

test('what Piper reads oddly is fixed first', () => {
  // A full stop breaks a sentence only before a capital, and "..." ran the words together
  assert.equal(readable('No. stop'), 'No. Stop');
  assert.equal(readable('wait... what'), 'wait. What');
  assert.equal(readable('wait…what'), 'wait. What');
  assert.equal(readable('...and then'), 'and then');
  assert.equal(readable('really?... ok'), 'really? ok');
  // But not after a single letter or a stop that isn't an end
  assert.equal(readable('e.g. this one, apples etc. and cats vs. dogs'), 'e.g. this one, apples etc. and cats vs. dogs');
  // Money as it's said
  assert.equal(readable('It costs $5.'), 'It costs 5 dollars.');
  assert.equal(readable('$5.50 now, $1 then, $0.50 or $1,000.00'), '5 dollars 50 now, 1 dollar then, 50 cents or 1,000 dollars');
  assert.equal(readable('£20 and €1.01 and £0.01'), '20 pounds and 1 euro 1 and 1 penny');
  assert.equal(readable('$5.505 stays'), '$5.505 stays');
  assert.equal(readable('worth $5k, a $2B deal, $1.5m or €3bn'), 'worth 5 thousand dollars, a 2 billion dollars deal, 1.5 million dollars or 3 billion euros');
  assert.equal(readable("it's $5, ok? $5, $10 or $20"), "it's 5 dollars, ok? 5 dollars, 10 dollars or 20 dollars");
  assert.equal(readable('$5kg and $5.5'), '$5kg and 5 dollars 50');
  // Titles don't end a sentence
  // Sounds with no vowel were spelled out. A hum keeps its length, to be held
  assert.equal(readable('hm, Hmm. mm mmm HMMM hrm'), 'hmm, Hmm. Hmm hmmm HMMM hmm');
  assert.equal(readable('Hmph! hmmph, shhh Shh, brrr grr GRRR'), 'Humph! humph, shushhh Shush, burrr gurr GURRR');
  // One typed long is held
  assert.deepEqual(heldWords(readable('mmmm grrr shhhh brrrrr')), {
    text: 'hmm gur shush bur',
    held: [
      { word: 'hmm', nth: 0, sound: 'end', vowel: -1, seconds: 0.8 },
      { word: 'gur', nth: 0, sound: 'end', vowel: -1, seconds: 0.6 },
      { word: 'shush', nth: 0, sound: 'end', vowel: -1, seconds: 0.8 },
      { word: 'bur', nth: 0, sound: 'end', vowel: -1, seconds: 1 },
    ],
  });
  // Millimetres, short forms, words with them in, and ones joined by a dash stay
  assert.equal(readable('a 9 mm, 5mm or 3 mmm; HM and MM; hmmus mmkay mm-hmm shhh-ing'), 'a 9 mm, 5mm or 3 mmm; HM and MM; hmmus mmkay mm-hmm shhh-ing');
  assert.equal(readable('Dr. Smith met Mr. and Mrs. Jones on St. Mark’s'), 'Dr Smith met Mr and Mrs Jones on St Mark’s');
  assert.equal(readable('Ms. Lee and Ms Park'), 'Miz Lee and Miz Park');
  assert.equal(readable('the end, Dr.'), 'the end, Dr.');
  // After a name they're Street and Drive, which can end a sentence
  assert.equal(readable('I live on Elm St. It is nice'), 'I live on Elm St. It is nice');
  assert.equal(readable('Elm St. it is nice'), 'Elm St. It is nice');
  // Drawn-out words are left as typed, to be held when they're said
  assert.equal(readable('nooo yesssss'), 'nooo yesssss');
  // Brackets are read as typed: Piper can't act out a stage direction, so nothing is taken for one
  assert.equal(readable('(whispers) come here (sighs heavily). fine'), '(whispers) come here (sighs heavily). Fine');
  assert.equal(readable('I am (not) coming'), 'I am (not) coming');
  assert.equal(readable('he said "go." then (it ended.) after'), 'he said "go." Then (it ended.) After');
  // A space before a stop stays where nothing was taken out
  assert.equal(readable('it took .5 seconds to edit the .env file'), 'it took .5 seconds to edit the .env file');
});

test('drawn-out words are said as the word, holding the sound that was stretched', () => {
  const vowel = (word: string, seconds: number, nth = 0, which = -1) => ({ word, nth, sound: 'vowel', vowel: which, seconds });
  const end = (word: string, seconds: number, nth = 0) => ({ word, nth, sound: 'end', vowel: -1, seconds });
  // A vowel at the end goes to one letter and holds the last vowel sound, longer with each letter, up to 1.5 seconds. Each
  // says which time the word is said, so the drawn-out one is held and not the one before
  assert.deepEqual(heldWords('oh nooo, nooooo and noooooooooooooo'), { text: 'oh no, no and no', held: [vowel('no', 0.6), vowel('no', 1, 1), vowel('no', 1.5, 2)] });
  assert.deepEqual(heldWords('No, no, NOooooo'), { text: 'No, no, NO', held: [vowel('NO', 1.2, 2)] });
  assert.deepEqual(heldWords('NOOOO sooo byeee'), { text: 'NO so bye', held: [vowel('NO', 0.8), vowel('so', 0.6), vowel('bye', 0.6)] });
  // Other letters at the end hold the last sound, with m's at two
  assert.deepEqual(heldWords('yesssss hmmmm'), { text: 'yes hmm', held: [end('yes', 1), end('hmm', 0.8)] });
  // In the middle, a vowel goes to two letters and holds that vowel; other letters aren't held, and three of them stay
  assert.deepEqual(heldWords('goooood Schifffahrt Brrrrrown'), { text: 'good Schifffahrt Brrown', held: [vowel('good', 1, 0, 0)] });
  assert.deepEqual(heldWords('baaaaby amaaaazing yeeeah bueeeno'), {
    text: 'baaby amaazing yeeah bueeno',
    held: [vowel('baaby', 0.8, 0, 0), vowel('amaazing', 0.8, 0, 1), vowel('yeeah', 0.6, 0, 0), vowel('bueeno', 0.6, 0, 0)],
  });
  // Left alone: plain words, Roman numerals, words of one letter and Piper's own phonemes
  assert.deepEqual(heldWords('good cool World War III, AAA batteries, xxx'), { text: 'good cool World War III, AAA batteries, xxx', held: [] });
  assert.deepEqual(heldWords('[[ nˈoːːː ]] nooo'), { text: '[[ nˈoːːː ]] no', held: [vowel('no', 0.6)] });
  // At most ten a line, and none longer than the voice container looks for
  assert.equal(heldWords('nooo '.repeat(12)).held.length, 10);
  assert.deepEqual(heldWords(`${'ab'.repeat(25)}ooo nooo`).held, [vowel('no', 0.6)]);
});

test('a held sound is stretched at most 100 times', { skip: !hasFfmpeg }, async () => {
  const out = path.join(dir, 'held-most.wav');
  await holdSounds(speechFile, out, [{ start: 100, end: 110, seconds: 3 }], 44_100);
  const wav = readFileSync(out);
  const seconds = (wav.length - 44) / (wav.readUInt32LE(24) * wav.readUInt16LE(22) * (wav.readUInt16LE(34) / 8));
  assert.ok(Math.abs(seconds - (0.15 + (10 / 44_100) * 99)) < 0.01, `${seconds} s`);
});

test('a drawn-out word’s sound is held where the voice container says it is', { skip: !hasFfmpeg }, async (t) => {
  const bodies: { text: string; held?: unknown }[] = [];
  let spans = '2000:4000';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(readFileSync(speechFile), { headers: { 'x-held': spans } });
  });
  const seconds = (wav: Buffer) => (wav.length - 44) / (wav.readUInt32LE(24) * wav.readUInt16LE(22) * (wav.readUInt16LE(34) / 8));
  const guild = (id: string) => ({ id, members: { cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } }) as never;
  const plain = seconds(await previewSpeech(guild('held-1'), 'no', 'scottish'));
  const held = seconds(await previewSpeech(guild('held-2'), 'nooooo', 'scottish'));
  assert.deepEqual(bodies.map((b) => [b.text, b.held]), [['no', undefined], ['no', [{ word: 'no', nth: 0, sound: 'vowel', vowel: -1 }]]]);
  // A second at normal speed, slower at the default 85%, in place of the 45 ms the sound took
  const longer = held - plain;
  assert.ok(Math.abs(longer - (1 / 0.85 - 2000 / 44100)) < 0.05, `${longer} s longer`);
  // Said normally when it isn't found
  spans = '-';
  const missing = seconds(await previewSpeech(guild('held-3'), 'noooo', 'scottish'));
  assert.ok(Math.abs(missing - plain) < 0.02, `${missing} s against ${plain} s`);
});

test('the pause between sentences goes with each line and makes it again when changed', { skip: !hasFfmpeg }, async (t) => {
  const bodies: { sentence_silence?: number }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(readFileSync(speechFile));
  });
  const voice = channel();
  t.after(() => setSetting(voice.guild.id, 'ttsPauseMs', undefined));
  assert.equal(await say(voice, 'One. Two.', 'scottish', 'ana'), null);
  await sleep(300);
  setSetting(voice.guild.id, 'ttsPauseMs', 450);
  assert.equal(await say(voice, 'One. Two.', 'scottish', 'ana'), null);
  await sleep(300);
  assert.deepEqual(
    bodies.map((b) => b.sentence_silence),
    [0.2, 0.45],
  );
});

test('a preview of a long line says its first sentences, or its first words', () => {
  const sentences = 'This is the first sentence of a paragraph. '.repeat(10).trim();
  const part = previewPart(sentences);
  assert.ok(part.length <= 300 && part.endsWith('paragraph.'), part);
  const words = 'word '.repeat(100).trim();
  assert.equal(previewPart(words), 'word '.repeat(60).trim());
  assert.equal(previewPart('Short.'), 'Short.');
});

function run(t: TestContext, voice: unknown, options: { text?: string | null; pick?: string; saved?: string; role?: string; roles?: string[]; manager?: boolean } = {}) {
  const guild = (voice as { guild?: { id: string } } | null)?.guild ?? { id: 'say-role' };
  const replies: { content: string }[] = [];
  return speak.commands![0]
    .run({
      inCachedGuild: () => true,
      guildId: guild.id,
      guild,
      user: { id: 'me' },
      memberPermissions: { has: () => options.manager ?? false },
      member: { voice: { channel: voice }, roles: { cache: new Map((options.roles ?? []).map((r) => [r, {}])) } },
      options: { getString: (name: string) => (name === 'saved' ? (options.saved ?? null) : name === 'text' ? (options.text === undefined ? 'hello' : options.text) : (options.pick ?? null)) },
      reply: async (r: { content: string }) => replies.push(r),
      deferReply: async () => {},
      editReply: async (r: string) => replies.push({ content: r }),
    } as never)
    .then(() => replies[0].content);
}

test('/say needs a voice channel', async (t) => {
  assert.equal(await run(t, null), 'Join a voice channel first.');
});

test('/say says it, or says why not', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  assert.equal(await run(t, voice, { pick: 'demon' }), 'Said it.');
  assert.equal(asked[0].speaker, 499);
  setSetting(voice.guild.id, 'tts', false);
  assert.equal(await run(t, voice), 'Text to speech is off in this server.');
});

test('with a role set, /say takes that role or Manage Server', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const voice = channel();
  setSetting(voice.guild.id, 'ttsRole', 'talkers');
  assert.match(await run(t, voice), /Only <@&talkers> and people with \*\*Manage Server\*\*/);
  assert.equal(await run(t, voice, { roles: ['talkers'] }), 'Said it.');
  assert.equal(await run(t, voice, { manager: true }), 'Said it.');
});

/** A server with people in voice, and a message in its read-aloud channel */
function chat(options: { writerIn?: string | null; rooms?: Record<string, string[]>; afk?: string; roles?: string[]; manager?: boolean } = {}) {
  const voice = channel();
  const { guild } = voice as never as { guild: { id: string; afkChannelId?: string; channels: { cache: Map<string, unknown> }; voiceAdapterCreator: unknown } };
  const joined: string[] = [];
  guild.voiceAdapterCreator = () => ({ sendPayload: (p: { d: { channel_id: string } }) => joined.push(p.d.channel_id) > 0, destroy() {} });
  setSetting(guild.id, 'ttsChannel', 'general');
  guild.afkChannelId = options.afk;
  const rooms = new Map<string, unknown>();
  for (const [id, people] of Object.entries(options.rooms ?? { lounge: ['someone'] })) {
    const members = new Map(people.map((p) => [p, { id: p, user: { bot: p.startsWith('bot') } }]));
    const room = { ...(voice as object), id, members, isVoiceBased: () => true };
    rooms.set(id, room);
    guild.channels.cache.set(id, room);
  }
  guild.channels.cache.set('general', { isVoiceBased: () => false });
  const message = (content: string, extra: Record<string, unknown> = {}) =>
    ({
      inGuild: () => true,
      guild,
      channelId: 'general',
      content,
      system: false,
      webhookId: null,
      author: { id: 'ana', bot: false, displayName: 'ana' },
      client: { user: { id: '100' } },
      mentions: { repliedUser: null },
      reference: null,
      member: {
        displayName: 'Ana',
        voice: { channel: options.writerIn ? rooms.get(options.writerIn) : null },
        roles: { cache: new Map((options.roles ?? []).map((r) => [r, {}])) },
        permissions: { has: () => options.manager ?? false },
      },
      ...extra,
    }) as never;
  return { message, id: guild.id, joined, guild };
}

/** What was said, as it reached the call rather than the voice container, as a line said again soon isn't made again */
function heard(t: TestContext) {
  fakeVoice(t);
  const played: string[] = [];
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void, options?: { group?: string; label?: string }) => {
    if (options?.group === 'speech' && options.label) played.push(options.label);
    onEnd?.();
  });
  return { said: async () => (await sleep(150), [...played]) };
}

test('reads the chosen channel, saying who it is, and nothing else', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message } = chat();
  await readMessage(message('hello everyone'));
  await readMessage(message('not this one', { channelId: 'elsewhere' }));
  assert.deepEqual(await said(), ['Ana says, hello everyone']);
});

test('reads nothing until a channel is picked, or with speech off or unset', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message, id } = chat();
  setSetting(id, 'ttsChannel', '');
  await readMessage(message('one'));
  setSetting(id, 'ttsChannel', 'general');
  setSetting(id, 'tts', false);
  await readMessage(message('two'));
  setSetting(id, 'tts', true);
  config.voiceUrl = null;
  await readMessage(message('three'));
  config.voiceUrl = 'http://voice.test';
  assert.deepEqual(await said(), []);
});

test('skips what can’t or shouldn’t be read', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message, id } = chat();
  setSetting(id, 'ttsMaxChars', 20);
  for (const content of ['', 'https://example.test/a', '🎉', '||secret||', '```\nconst a = 1;\n```', `${'xy'.repeat(10)}x`]) await readMessage(message(content));
  await readMessage(message('from a bot', { author: { id: 'b', bot: true } }));
  await readMessage(message('from a webhook', { webhookId: 'w' }));
  await readMessage(message('joined', { system: true }));
  await readMessage(message('in a DM', { inGuild: () => false }));
  // Asking the bot something in chat: an @mention, of it or its role, or a reply to one of its answers
  await readMessage(message('<@100> queue the strokes'));
  await readMessage(message('<@&400> play the wall'));
  const answer = { author: { id: '100' }, type: 19 };
  await readMessage(message('thanks', { mentions: { repliedUser: { id: '100' } }, reference: { messageId: 'a' }, fetchReference: async () => answer }));
  assert.deepEqual(await said(), []);
});

test('leaves out spoilers and code, and says a link in a sentence', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message } = chat();
  await readMessage(message('the killer is ||Ben|| and see https://example.test/a ```x = 1```'));
  assert.deepEqual(await said(), ['Ana says, the killer is and see link']);
});

test('only says a name again after a pause, or when someone else talks', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message } = chat();
  const real = Date.now();
  let now = real;
  t.mock.method(Date, 'now', () => now);
  const ben = { author: { id: 'ben', bot: false }, member: { displayName: 'Ben', voice: { channel: null }, roles: { cache: new Map() } } };
  await readMessage(message('one'));
  now += 29_000;
  await readMessage(message('two'));
  await readMessage(message('three', ben));
  await readMessage(message('four'));
  now += 31_000;
  await readMessage(message('five'));
  assert.deepEqual(await said(), ['Ana says, one', 'two', 'Ben says, three', 'Ana says, four', 'Ana says, five']);
});

test('plays where the writer is, then where the bot is, then the busiest channel', { skip: !hasFfmpeg }, async (t) => {
  heard(t);
  const played = t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => onEnd?.());
  const rooms = { small: ['a'], big: ['b', 'c', 'bot1', 'bot2'], bigger: ['d', 'e', 'f'], empty: ['bot3'], afk: ['g', 'h', 'i', 'j'] };
  const where = async (setup: Parameters<typeof chat>[0], bot?: string) => {
    const { message, id, joined, guild } = chat({ rooms, afk: 'afk', ...setup });
    if (bot) {
      joinVoiceChannel({ channelId: bot, guildId: id, adapterCreator: guild.voiceAdapterCreator } as never);
      await sleep(10);
    }
    await readMessage(message('hello'));
    return joined.at(-1);
  };
  assert.equal(await where({ writerIn: 'small' }), 'small');
  assert.equal(await where({ writerIn: 'afk' }), 'bigger', 'the AFK channel doesn’t count, even with the writer in it');
  assert.equal(await where({}), 'bigger');
  assert.equal(await where({}, 'small'), 'small');
  assert.equal(await where({}, 'empty'), 'bigger', 'the bot sitting alone doesn’t count');
  assert.ok(played.mock.callCount() >= 4);
});

test('reads nothing with nobody in voice', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message } = chat({ rooms: { empty: ['bot1'] } });
  await readMessage(message('hello'));
  assert.deepEqual(await said(), []);
});

test('can be limited to people in voice', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { message, id } = chat();
  setSetting(id, 'ttsChannelWho', 'voice');
  await readMessage(message('not in voice'));
  assert.deepEqual(await said(), []);
  const inVoice = chat({ writerIn: 'lounge' });
  setSetting(inVoice.id, 'ttsChannelWho', 'voice');
  await readMessage(inVoice.message('in voice'));
  assert.deepEqual(await said(), ['Ana says, in voice']);
});

test('the role limit applies', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  for (const [options, text] of [[{}, 'no role'], [{ roles: ['talkers'] }, 'has it'], [{ manager: true }, 'manager']] as [Parameters<typeof chat>[0], string][]) {
    const { message, id } = chat(options);
    setSetting(id, 'ttsRole', 'talkers');
    await readMessage(message(text));
  }
  assert.deepEqual(await said(), ['Ana says, has it', 'Ana says, manager']);
});

test('there’s no wait between messages, but fast chat can’t pile up, and Stop clears it', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const added: (() => void)[] = [];
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => void added.push(onEnd!));
  const { message, id } = chat();
  setSetting(id, 'ttsCooldownSec', 3600);
  const sent = ['1', '2', '3', '4', '5', '6', '7', '8'].map((text) => readMessage(message(text)));
  await sleep(100);
  assert.equal(added.length, 1, 'one playing');
  stopPlayback(id);
  for (const end of added) end();
  await Promise.all(sent);
  assert.equal(added.length, 1, 'the 5 waiting were cleared, and the rest were never queued');
  assert.equal(recentActivity(id, 5).length, 0, 'not logged');
});

test('fast chat stops at 5 lines waiting, and the ones before that all get read', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const added: (() => void)[] = [];
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => void added.push(onEnd!));
  const { message } = chat();
  const sent = ['1', '2', '3', '4', '5', '6', '7', '8'].map((text) => readMessage(message(text)));
  for (let played = 0; played < 8; played++) {
    await sleep(120);
    added.shift()?.();
  }
  await Promise.all(sent);
  assert.deepEqual(asked.map((a) => a.text), ['Ana says, 1', '2', '3', '4', '5', '6']);
});

test('a problem joining voice is logged, as nobody’s there to tell', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const errors = t.mock.method(console, 'error', () => {});
  const voice = chat({ rooms: { locked: ['a'] } });
  const locked = (voice.message('x') as { guild: { channels: { cache: Map<string, { permissionsFor: unknown }> } } }).guild.channels.cache.get('locked')!;
  locked.permissionsFor = () => ({ has: () => false });
  await readMessage(voice.message('hello'));
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /Couldn’t read a message out/);
});

/** Someone joining voice in a server where the bot can greet them */
function joining(options: { greet?: boolean; rooms?: Record<string, string[]>; afk?: string } = {}) {
  const { guild, id, joined } = chat({ rooms: options.rooms ?? { lounge: ['someone'], other: ['someone else'] }, afk: options.afk });
  const server = guild as never as { voiceStates: { cache: Map<string, { channelId: string }> }; channels: { cache: Map<string, unknown> } };
  server.voiceStates = { cache: new Map([['ana', { channelId: 'lounge' }]]) };
  setSetting(id, 'joinSoundDelayMs', 0);
  if (options.greet !== false) setSetting(id, 'ttsGreet', true);
  const member = (name = 'Ana', username = 'ana', bot = false) => ({ id: 'ana', displayName: name, user: { bot, username }, guild });
  const state = (channelId: string | null, who: unknown) => ({ id: 'ana', channelId, channel: channelId ? server.channels.cache.get(channelId) : null, guild, member: who });
  const join = (from: string | null = null, to: string | null = 'lounge', who: unknown = member()) => playJoinSound(state(from, who) as never, state(to, who) as never);
  return { id, joined, guild, member, join, here: server.voiceStates.cache };
}

test('says who joined, only once it’s turned on', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { join, id } = joining({ greet: false });
  await join();
  assert.deepEqual(await said(), []);
  setSetting(id, 'ttsGreet', true);
  await join();
  assert.deepEqual(await said(), ['Ana joined']);
});

test('the greeting can be reworded, and copes with odd names', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const lines = [
    ['Welcome back {name}, {name}!', 'Ana', 'ana', 'Welcome back Ana, Ana!'],
    ['{name} joined', '$& Bo', 'bo', '$& Bo joined'],
    ['{name} joined', '🎉✨', 'cat_lover', 'cat lover joined'],
  ];
  for (const [greeting, name, username] of lines) {
    const { join, id, member } = joining();
    setSetting(id, 'ttsGreeting', greeting);
    await join(null, 'lounge', member(name, username));
  }
  const nameless = joining();
  await nameless.join(null, 'lounge', nameless.member('🎉', '🎉'));
  assert.deepEqual(await said(), lines.map((line) => line[3]));
});

for (const [what, from, to, bot] of [
  ['switching channels', 'lounge', 'other', false],
  ['muting', 'lounge', 'lounge', false],
  ['leaving', 'lounge', null, false],
  ['the AFK channel', null, 'other', false],
  ['a bot joining', null, 'lounge', true],
] as const) {
  test(`${what} isn’t greeted`, { skip: !hasFfmpeg }, async (t) => {
    const { said } = heard(t);
    const { join, member } = joining({ afk: 'other' });
    await join(from, to, member('Ana', 'ana', bot));
    assert.deepEqual(await said(), []);
  });
}

test('someone with a join sound hears that instead, unless join sounds are off', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { join, id } = joining();
  await saveUpload(id, 'horn', '.wav', readFileSync(speechFile));
  setJoinSound(id, 'ana', 'horn');
  await join();
  assert.deepEqual(await said(), []);
  setSetting(id, 'joinSounds', false);
  setSetting(id, 'joinSoundCooldownMin', 0);
  await join();
  assert.deepEqual(await said(), ['Ana joined']);
});

test('greetings use the join sound cooldown', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { join, id } = joining();
  await join();
  await join();
  assert.deepEqual(await said(), ['Ana joined'], 'not twice in the cooldown');
  setSetting(id, 'joinSoundCooldownMin', 0);
  await join();
  assert.deepEqual(await said(), ['Ana joined', 'Ana joined']);
});

test('a greeting won’t pull the bot from another channel', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { join, id, guild } = joining();
  joinVoiceChannel({ channelId: 'other', guildId: id, adapterCreator: guild.voiceAdapterCreator } as never);
  await join();
  assert.deepEqual(await said(), []);
});

test('leaving during the delay drops the greeting, and they can be greeted next time', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { join, id, here } = joining();
  setSetting(id, 'joinSoundDelayMs', 30);
  const joined = join();
  here.delete('ana');
  await joined;
  assert.deepEqual(await said(), []);
  here.set('ana', { channelId: 'lounge' });
  await join();
  assert.deepEqual(await said(), ['Ana joined']);
});

test('the bot doesn’t stay behind when a greeting fails', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t, async () => new Response('', { status: 500 }));
  t.mock.method(console, 'error', () => {});
  const logged = t.mock.method(console, 'log', () => {});
  const timers = t.mock.method(globalThis, 'setTimeout');
  const { join } = joining();
  await join();
  assert.match(String(logged.mock.calls.at(-1)!.arguments[0]), /^Greeting in .* didn’t play: The voice isn’t available/);
  assert.ok(timers.mock.calls.some((c) => c.arguments[1] === 300_000), 'set to leave when idle');
});

test('announcements are said in a channel with people, once they’re turned on', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { guild, id } = chat({ rooms: { lounge: ['someone'], empty: ['bot1'] } });
  const room = (name: string) => (guild as never as { channels: { cache: Map<string, never> } }).channels.cache.get(name)!;
  await announceAloud(room('lounge'), 'off for now', 'ttsHopOn');
  setSetting(id, 'ttsHopOn', true);
  await announceAloud(room('lounge'), 'wrong setting', 'ttsNightReminders');
  await announceAloud(room('empty'), 'nobody there', 'ttsHopOn');
  await announceAloud(room('lounge'), 'hop on', 'ttsHopOn');
  assert.deepEqual(await said(), ['hop on']);
});

test('an announcement won’t pull the bot from another channel, but plays in the one it’s in', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { guild, id } = chat({ rooms: { lounge: ['someone'], other: ['someone else'] } });
  setSetting(id, 'ttsHopOn', true);
  joinVoiceChannel({ channelId: 'other', guildId: id, adapterCreator: guild.voiceAdapterCreator } as never);
  const room = (name: string) => (guild as never as { channels: { cache: Map<string, never> } }).channels.cache.get(name)!;
  await announceAloud(room('lounge'), 'elsewhere', 'ttsHopOn');
  await announceAloud(room('other'), 'here', 'ttsHopOn');
  assert.deepEqual(await said(), ['here']);
});

test('a line nobody typed still needs the voice to be on, and can’t pile up', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const added: (() => void)[] = [];
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => void added.push(onEnd!));
  const voice = channel();
  setSetting(voice.guild.id, 'tts', false);
  assert.ok(await sayOut(voice, 'off'));
  setSetting(voice.guild.id, 'tts', true);
  assert.ok(await sayOut(voice, '🎉'));
  config.voiceUrl = null;
  assert.ok(await sayOut(voice, 'no voice'));
  config.voiceUrl = 'http://voice.test';
  const lines = ['1', '2', '3', '4', '5', '6'].map((line) => sayOut(voice, line));
  assert.ok(await sayOut(voice, 'too many'));
  for (let played = 0; played < 6; played++) {
    await sleep(120);
    added.shift()?.();
  }
  assert.deepEqual(await Promise.all(lines), [null, null, null, null, null, null]);
  assert.deepEqual(asked.map((a) => a.text), ['1', '2', '3', '4', '5', '6']);
});

test('lines can be saved, with limits, separately for each server', () => {
  const { guild } = channel();
  const other = channel().guild;
  assert.equal(savePhrase(guild, '  good   game  '), null);
  assert.deepEqual(phrases(guild.id).map(({ text }) => text), ['good game']);
  assert.equal(savePhrase(guild, 'good game'), null);
  assert.equal(phrases(guild.id).length, 1, 'saving it twice does nothing');
  assert.equal(phrases(other.id).length, 0);
  assert.match(savePhrase(guild, '🎉')!, /nothing in that/);
  assert.match(savePhrase(guild, `${'xy'.repeat(2000)}x`)!, /4001 characters/);
  for (let n = 1; n < 25; n++) assert.equal(savePhrase(guild, `line ${n}`), null);
  assert.match(savePhrase(guild, 'one too many')!, /keep 25 lines/);
  assert.equal(savePhrase(guild, 'good game'), null, 'one already saved isn’t refused for being over');
  const [first] = phrases(guild.id);
  assert.equal(removePhrase(other.id, first.id), false, 'not from another server');
  assert.equal(removePhrase(guild.id, first.id), true);
  assert.equal(removePhrase(guild.id, first.id), false);
  assert.equal(phrases(guild.id).length, 24);
  assert.equal(savePhrase(guild, 'room again'), null);
});

test('/say picks a saved line, in the voice picked or the server’s, under the usual rules', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => onEnd?.());
  const voice = channel();
  savePhrase(voice.guild, 'good game');
  const saved = String(phrases(voice.guild.id)[0].id);
  assert.equal(await run(t, voice, { text: null }), 'Type something to say, or pick a saved line.');
  assert.equal(await run(t, voice, { text: null, saved: 'something typed' }), 'Pick a saved line from the list.');
  assert.equal(await run(t, voice, { text: null, saved }), 'Said it.');
  assert.equal(await run(t, voice, { text: null, saved, pick: 'demon' }), 'Said it.');
  assert.equal(await run(t, voice, { text: 'typed wins', saved }), 'Said it.');
  await sleep(200);
  assert.deepEqual(asked.map((a) => [a.text, a.model ?? a.speaker]), [['good game', 'southern_male'], ['good game', 499], ['typed wins', 'southern_male']]);
  setSetting(voice.guild.id, 'ttsCooldownSec', 3600);
  await run(t, voice, { text: null, saved });
  assert.match(await run(t, voice, { text: null, saved }), /^Wait /);
  assert.ok(recentActivity(voice.guild.id, 5).some((r) => r.action.includes('Said “good game”')));
});

test('/say suggests saved lines and voices as you type', async () => {
  const voice = channel();
  savePhrase(voice.guild, 'Good game');
  savePhrase(voice.guild, 'gotta go');
  savePhrase(voice.guild, 'y'.repeat(150));
  const suggest = async (typed: string, guildId: string | null = voice.guild.id, name = 'saved') => {
    let answer: { name: string; value: string }[] = [];
    const focused = (full?: boolean) => (full ? { name, value: typed } : typed);
    await speak.commands![0].autocomplete!({ guildId, options: { getFocused: focused }, respond: async (a: typeof answer) => (answer = a) } as never);
    return answer;
  };
  assert.deepEqual((await suggest('GOOD')).map((a) => a.name), ['Good game']);
  assert.equal((await suggest('')).length, 3);
  assert.equal((await suggest('yyy'))[0].name.length, 100);
  assert.equal((await suggest('gotta'))[0].value, String(phrases(voice.guild.id)[1].id));
  assert.deepEqual(await suggest('good', null), []);
  // Voices are searched, as there are more than Discord's 25 choices would allow to grow
  assert.deepEqual(await suggest('RO', voice.guild.id, 'voice'), [{ name: 'State broadcast', value: 'broadcast' }]);
  assert.equal((await suggest('', voice.guild.id, 'voice')).length, voices().length);
  assert.deepEqual(await suggest('alba', voice.guild.id, 'voice'), [], 'not by model');
  assert.deepEqual(await suggest('irish', voice.guild.id, 'voice'), [{ name: 'Irish (Jenny)', value: 'irish' }], 'and by id');
  // Effects too, with none first
  assert.deepEqual((await suggest('', voice.guild.id, 'effect')).slice(0, 2), [
    { name: 'No effect', value: 'none' },
    { name: 'Demon', value: 'demon' },
  ]);
  assert.equal((await suggest('', voice.guild.id, 'effect')).length, effects().length + 1);
  assert.deepEqual(await suggest('radio', voice.guild.id, 'effect'), [{ name: 'Walkie-talkie', value: 'radio' }], 'by id as well');
});

test('the looping room’s speech is made once in its own voice, and remade when the line, voice or speed changes', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const { guild: server, id } = chat();
  const guild = server as never as import('discord.js').Guild;
  assert.equal(await loopSpeechProblem(guild), null, 'nothing to make without a line');
  setSetting(id, 'loopText', 'stay a while');
  setSetting(id, 'ttsVoice', 'alien');
  assert.equal(await loopSpeechProblem(guild), null);
  assert.deepEqual(asked.map((a) => [a.text, a.speaker]), [['stay a while', 0]], 'the default voice until one’s picked');
  assert.equal(await loopSpeechProblem(guild), null);
  assert.equal(asked.length, 1, 'made once, then reused');
  setSetting(id, 'loopVoice', 'demon');
  await loopSpeechProblem(guild);
  setSetting(id, 'ttsSpeed', 120);
  await loopSpeechProblem(guild);
  assert.deepEqual(asked.slice(1).map((a) => a.speaker), [499, 499]);
  assert.ok(asked[2].length < asked[1].length, 'faster');
  const kept = readdirSync(path.join(config.dataDir, 'loop-speech')).filter((f) => f.startsWith(`${id}-`));
  assert.equal(kept.length, 1, 'only the line in use is kept');
});

test('the looping room’s speech says why it can’t be made', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t, async () => new Response('down', { status: 503 }));
  const { guild: server, id } = chat();
  const guild = server as never as import('discord.js').Guild;
  setSetting(id, 'loopText', 'stay a while');
  assert.match((await loopSpeechProblem(guild))!, /voice container isn’t answering/);
  setSetting(id, 'loopText', '🎉🎉');
  assert.match((await loopSpeechProblem(guild))!, /nothing in that to say/);
  config.voiceUrl = null;
  setSetting(id, 'loopText', 'hi');
  assert.match((await loopSpeechProblem(guild))!, /isn’t set up/);
});

test('no join sound or greeting in the looping room', { skip: !hasFfmpeg }, async (t) => {
  const { said } = heard(t);
  const { join, id } = joining();
  setSetting(id, 'loopRoom', 'lounge');
  await join();
  assert.deepEqual(await said(), []);
  setSetting(id, 'loopRoom', 'other');
  await join();
  assert.deepEqual(await said(), ['Ana joined'], 'anywhere else, as before');
});

/** Uses Say this aloud on a message */
function sayMessage(voice: unknown, message: { content: string; author: string; name?: string }) {
  const guild = (voice as { guild?: { id: string } } | null)?.guild ?? { id: 'say-app' };
  const replies: string[] = [];
  return speak.menus![0]
    .run({
      isMessageContextMenuCommand: () => true,
      inCachedGuild: () => true,
      guildId: guild.id,
      guild,
      user: { id: 'me' },
      memberPermissions: { has: () => false },
      member: { voice: { channel: voice }, roles: { cache: new Map() } },
      targetMessage: { content: message.content, author: { id: message.author, displayName: message.author }, member: message.name ? { displayName: message.name } : null },
      reply: async (r: { content: string }) => replies.push(r.content),
      deferReply: async () => {},
      editReply: async (r: string) => replies.push(r),
    } as never)
    .then(() => replies[0]);
}

test('Say this aloud reads a message out, saying whose it is', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  assert.equal(await sayMessage(null, { content: 'hi', author: 'me' }), 'Join a voice channel first.');
  assert.equal(await sayMessage(voice, { content: '||spoiler|| https://example.test', author: 'them' }), 'There’s nothing in that message to read out.');
  assert.equal(await sayMessage(voice, { content: 'gg everyone ||it was me||', author: 'them', name: 'Sam' }), 'Said it.');
  assert.equal(await sayMessage(voice, { content: 'my own words', author: 'me' }), 'Said it.');
  assert.deepEqual(asked.map((a) => a.text), ['Sam says, gg everyone', 'my own words']);
});
