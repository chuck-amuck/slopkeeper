import './helpers.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { feeds } from '../src/changes.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { forgetSpoken, serverVoice } from '../src/features/say.ts';
import { forgetVoiceStates, voiceContainerHas, voicesVersion } from '../src/features/voices.ts';
import { addProfile, builtIn, fieldsOf, profileById, removeProfile } from '../src/features/chatProfiles.ts';
import { setSetting, storedSetting } from '../src/settings.ts';
import { GUILD, base, call, ok, refused, wav } from './apiFixture.ts';

// The voices added in the web UI: adding, changing, removing, export and import, and keeping the voice container's list

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const VOICE_URL = 'http://voice.test';
const PAGE = 'https://huggingface.co/someone/voices/blob/main/en/narrator.onnx';
const FILE = 'https://huggingface.co/someone/voices/resolve/main/en/narrator.onnx';
const before = config.voiceUrl;

/** A voice container that keeps the list it's sent, with the voices in `ready` downloaded and the rest on their way */
function fakeContainer(t: TestContext, ready = new Set<string>()) {
  const real = fetch;
  const container = { version: '', voices: [] as { id: string; model: string; config: string | null; sha256: string | null }[], posts: 0, synthesized: [] as Record<string, unknown>[] };
  const report = () => ({
    version: container.version,
    voices: Object.fromEntries(
      container.voices.map((v) => [v.id, ready.has(v.id) ? { state: 'ready', file: `voice-${v.id}-0123456789ab`, speakers: [{ id: 0, name: 'calm' }, { id: 1, name: 'loud' }] } : { state: 'downloading', percent: 40 }]),
    ),
  });
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    if (url === `${VOICE_URL}/models` && init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      container.version = body.version;
      container.voices = body.voices;
      container.posts++;
      return Response.json(report());
    }
    if (url === `${VOICE_URL}/models`) return Response.json(report());
    if (url === `${VOICE_URL}/synthesize`) {
      container.synthesized.push(JSON.parse(init!.body as string));
      return new Response(wav(0.3));
    }
    throw new Error(`unexpected ${url}`);
  });
  return container;
}

const list = async () => (await ok(`/guilds/${GUILD}/voices`)).voices as any[];
const add = (json: unknown) => call(`/guilds/${GUILD}/voices`, { method: 'POST', json });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  config.voiceUrl = VOICE_URL;
  db.exec('DELETE FROM voices');
  forgetVoiceStates();
  forgetSpoken();
});
afterEach(() => {
  config.voiceUrl = before;
});

test('a voice added by its Hugging Face page is sent to the voice container, and offered once it’s downloaded', async (t) => {
  const ready = new Set<string>();
  const container = fakeContainer(t, ready);
  const { voice } = await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: ' The  Narrator ', model: PAGE, group: 'Accents' } });
  assert.equal(voice.id, 'the-narrator');
  assert.equal(voice.name, 'The Narrator');
  assert.equal(voice.model, FILE, 'the page’s /blob/ is the file’s /resolve/');
  await settle();
  assert.deepEqual(container.voices, [{ id: 'the-narrator', model: FILE, config: null, sha256: null, configSha256: null }]);
  assert.equal(container.version, voicesVersion());
  assert.deepEqual((await list()).map((v) => [v.state, v.percent]), [['downloading', 40]]);
  const say = async () => (await ok(`/guilds/${GUILD}/say`)).voices.map((v: any) => v.id) as string[];
  assert.ok(!(await say()).includes('the-narrator'), 'not offered while it downloads');

  const before = feeds.speech.version(GUILD);
  ready.add('the-narrator');
  const [listed] = await list();
  assert.equal(listed.state, 'ready');
  assert.notEqual(feeds.speech.version(GUILD), before, 'the Say boxes hear it’s ready');
  assert.deepEqual(listed.speakers, [{ id: 0, name: 'calm' }, { id: 1, name: 'loud' }]);
  assert.ok((await say()).includes('the-narrator'));
  const { entries: activity } = await ok(`/guilds/${GUILD}/activity`);
  assert.equal(activity[0].action, 'Added the voice The Narrator');
});

test('a voice needs a name of its own and a link to a model', async (t) => {
  fakeContainer(t);
  const refusedAdd = (json: unknown) => refused(400, `/guilds/${GUILD}/voices`, { method: 'POST', json });
  assert.match(await refusedAdd({ name: 'scottish', model: FILE }), /already a voice called scottish/);
  assert.match(await refusedAdd({ name: 'X', model: FILE.replace('https', 'http') }), /starting https/);
  assert.match(await refusedAdd({ name: 'X', model: 'https://huggingface.co/someone/voices' }), /\.onnx file/);
  assert.match(await refusedAdd({ name: 'X', model: FILE, volume: 30 }), /loudness/);
  assert.match(await refusedAdd({ name: 'X', model: FILE, curve: 'fast' }), /speed curve/);
  assert.match(await refusedAdd({ name: '', model: FILE }), /name needs/);
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  assert.match(await refusedAdd({ name: 'NARRATOR', model: FILE }), /already a voice called/);
  // A name that makes a taken id gets another
  const { voice } = await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Demon!', model: FILE } });
  assert.equal(voice.id, 'demon-2');
  config.voiceUrl = null;
  assert.match(await refused(409, `/guilds/${GUILD}/voices`), /VOICE_URL/);
});

test('changing a voice’s settings keeps its download, and a new link downloads it again', async (t) => {
  const ready = new Set(['narrator']);
  const container = fakeContainer(t, ready);
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  await settle();
  const put = (json: unknown) => call(`/guilds/${GUILD}/voices/narrator`, { method: 'PUT', json });
  const { voice } = await (await put({ volume: -3, pace: 1.2, speaker: 1, noise: [0.333, 0.333], curve: 'low', name: 'Old narrator' })).json();
  assert.deepEqual([voice.volume, voice.pace, voice.speaker, voice.noise, voice.curve, voice.name, voice.state], [-3, 1.2, 1, [0.333, 0.333], 'low', 'Old narrator', 'ready']);
  const spoken = serverVoice(GUILD, 'narrator');
  assert.deepEqual([spoken.effects, spoken.pace, spoken.speaker], ['volume=-3dB', 1.2, 1]);
  assert.match(await refused(400, `/guilds/${GUILD}/voices/narrator`, { method: 'PUT', json: { name: 'Russian' } }), /already a voice called Russian/);

  ready.delete('narrator');
  const moved = (await (await put({ model: 'https://example.com/other.onnx' })).json()).voice;
  assert.equal(moved.state, 'waiting');
  await settle();
  assert.equal(container.voices[0].model, 'https://example.com/other.onnx');
  assert.equal(serverVoice(GUILD, 'narrator').id, 'southern-man', 'not offered until the new one is downloaded');
  assert.equal(await refused(404, `/guilds/${GUILD}/voices/nobody`, { method: 'PUT', json: {} }), 'That voice isn’t there any more.');
});

test('removing a voice takes it from the container and puts servers that picked it back on their default', async (t) => {
  const container = fakeContainer(t, new Set(['narrator']));
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  await settle();
  setSetting(GUILD, 'ttsVoice', 'narrator');
  setSetting('elsewhere', 'loopVoice', 'narrator');
  setSetting('other', 'ttsVoice', 'scottish');
  // And a profile that speaks in it speaks in the server's default instead
  const profile = addProfile({ ...fieldsOf(builtIn()), name: 'Teller', personality: 'A storyteller.', voice: 'narrator' }, 'u1');
  t.after(() => removeProfile(profile));
  assert.deepEqual(await ok(`/guilds/${GUILD}/voices/narrator`, { method: 'DELETE' }), { picks: 2, profiles: 1 });
  assert.equal(profileById(profile)!.voice, null);
  await settle();
  assert.deepEqual(container.voices, []);
  assert.deepEqual([storedSetting(GUILD, 'ttsVoice'), storedSetting('elsewhere', 'loopVoice'), storedSetting('other', 'ttsVoice')], [undefined, undefined, 'scottish']);
  const { entries: activity } = await ok(`/guilds/${GUILD}/activity`);
  assert.equal(activity[0].action, 'Removed the voice Narrator, and 2 servers’ picks and 1 profile’s use of it');
});

test('a voice that isn’t downloaded yet shows in Settings as the one it’s standing in for', async (t) => {
  fakeContainer(t);
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  setSetting(GUILD, 'ttsVoice', 'narrator');
  const { problems } = await ok(`/guilds/${GUILD}/settings`);
  assert.deepEqual(
    problems.filter((p: any) => p.key === 'ttsVoice').map((p: any) => p.text),
    ['The default voice: Narrator is still downloading, so it’s **Southern English man** for now.'],
  );
});

test('the voices export, and an import says what it would do before doing it', async (t) => {
  const container = fakeContainer(t);
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE, volume: -2 } });
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Pirate', model: 'https://example.com/pirate.onnx', group: 'Accents' } });
  const res = await call(`/guilds/${GUILD}/voices/export`);
  assert.match(res.headers.get('content-disposition')!, /slopkeeper-voices\.json/);
  const file = await res.json();
  assert.equal(file.format, 'slopkeeper-voices');
  // Given a loudness, it's set by hand, and an export always says so, as an entry without it would be measured
  assert.deepEqual(file.voices[0], { id: 'narrator', name: 'Narrator', group: 'Characters', model: FILE, volume: -2, tune: 'manual' });

  const importing = (json: unknown) => ok(`/guilds/${GUILD}/voices/import`, { method: 'POST', json });
  assert.deepEqual(await importing({ voices: file.voices }), { added: [], changed: [], unchanged: ['Narrator', 'Pirate'], removed: [], skipped: [] });

  // A CUSTOM_VOICES list from before: a bare list, matched by id or name
  const next = [
    { id: 'narrator', name: 'Narrator', model: FILE, volume: 1 },
    { id: 'robo', name: 'Robo', model: 'https://example.com/robo.onnx', noise: [0.5, 0.3] },
    { name: 'Scottish', model: FILE },
    { name: 'Robo', model: FILE },
    { name: 'Odd', model: 'ftp://example.com/odd.onnx' },
  ];
  const planned = await importing({ voices: next, replace: true });
  assert.deepEqual(planned.added, ['Robo']);
  assert.deepEqual(planned.changed, ['Narrator']);
  assert.deepEqual(planned.removed, ['Pirate']);
  assert.deepEqual(
    planned.skipped.map((s: any) => s.what),
    ['Scottish', 'Robo', 'Odd'],
  );
  assert.equal((await list()).length, 2, 'a dry run changes nothing');

  assert.deepEqual(await importing({ voices: next, replace: true, dryRun: false }), planned);
  await settle();
  assert.deepEqual((await list()).map((v) => [v.id, v.volume ?? 0]), [['narrator', 1], ['robo', 0]]);
  assert.deepEqual(container.voices.map((v) => v.id).sort(), ['narrator', 'robo']);
  // Without replace, what the list doesn't have stays
  const merged = await importing({ voices: [{ name: 'Pirate', model: 'https://example.com/pirate.onnx' }], dryRun: false });
  assert.deepEqual([merged.added, merged.removed], [['Pirate'], []]);
  assert.equal((await list()).length, 3);
  assert.match(await refused(400, `/guilds/${GUILD}/voices/import`, { method: 'POST', json: { voices: { name: 'x' } } }), /no list of voices/);
});

test('a voice container that lost the list, or missed a change, is sent it again', async (t) => {
  const container = fakeContainer(t);
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  await settle();
  const posts = container.posts;
  voiceContainerHas(voicesVersion());
  await settle();
  assert.equal(container.posts, posts, 'not when it has it');
  voiceContainerHas('');
  await settle();
  assert.equal(container.posts, posts + 1);
  assert.equal(container.voices[0].id, 'narrator');
});

test('a preview says the voice with settings not saved yet, once it’s downloaded', { skip: !hasFfmpeg }, async (t) => {
  const ready = new Set<string>();
  const container = fakeContainer(t, ready);
  await ok(`/guilds/${GUILD}/voices`, { method: 'POST', json: { name: 'Narrator', model: FILE } });
  await settle();
  const preview = (json: unknown) => call(`/guilds/${GUILD}/voices/narrator/preview`, { method: 'POST', json });
  assert.match(await refused(409, `/guilds/${GUILD}/voices/narrator/preview`, { method: 'POST', json: {} }), /isn’t downloaded yet/);
  ready.add('narrator');
  await list();
  const res = await preview({ text: 'ahoy', speaker: 1, pace: 1.3 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(
    container.synthesized.map((s) => [s.text, s.voice, s.speaker_id]),
    [['ahoy', 'voice-narrator-0123456789ab', 1]],
  );
  // Not saved
  assert.equal((await list())[0].speaker, undefined);
});
