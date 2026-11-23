import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioPlayer, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { audio, connect, listeningChanged, talkingChanged } from '../src/features/voiceAudio.ts';
import { setSetting } from '../src/settings.ts';
import { HOLD_MS, OPEN_MIC_MS, Talking } from '../src/talking.ts';
import { join } from '../src/voiceJoin.ts';

function tracker(bots: string[] = []) {
  const heard: boolean[] = [];
  return { heard, talking: new Talking((id) => !bots.includes(id), (on) => heard.push(on)) };
}

test('someone talking turns it on, and it goes off a moment after the last one stops', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { heard, talking } = tracker();
  talking.start('a');
  talking.start('b');
  assert.deepEqual(heard, [true]);
  talking.end('a');
  talking.end('b');
  t.mock.timers.tick(HOLD_MS - 1);
  assert.deepEqual(heard, [true], 'held through a gap between sentences');
  talking.start('a');
  talking.end('a');
  t.mock.timers.tick(HOLD_MS - 1);
  assert.deepEqual(heard, [true], 'talking again starts the wait over');
  t.mock.timers.tick(1);
  assert.deepEqual(heard, [true, false]);
});

test('other bots don’t count, and nor does a microphone left open', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { heard, talking } = tracker(['loop-bot']);
  talking.start('loop-bot');
  assert.deepEqual(heard, []);
  talking.start('open-mic');
  t.mock.timers.tick(OPEN_MIC_MS);
  t.mock.timers.tick(HOLD_MS);
  assert.deepEqual(heard, [true, false]);
  // Once they pause, they count again
  talking.end('open-mic');
  talking.start('open-mic');
  assert.deepEqual(heard, [true, false, true]);
  talking.stop();
  assert.deepEqual(heard, [true, false, true, false], 'stopping forgets everyone at once');
});

const networking = { state: {}, on() {}, off() {}, prepareAudioPacket() {}, dispatchAudio: () => true, setSpeaking() {}, destroy() {} };

test('the bot joins undeafened to notice people talking, music drops under them, and turning it off deafens it again', async (t) => {
  // Any sound from a microphone, which goes by when Discord says each person starts and stops
  setSetting('talking-server', 'musicDucksFor', 'any');
  const deaf: boolean[] = [];
  const inVoice = (bot: boolean) => ({ channelId: 'room', member: { user: { bot } } });
  const guild = {
    id: 'talking-server',
    name: 'Server',
    members: { me: {} },
    voiceStates: { cache: new Map<string, { channelId: string | null; member: { user: { bot: boolean } } | null }>([['loop-bot', inVoice(true)], ['a', inVoice(false)], ['left', { channelId: null, member: null }]]) },
    voiceAdapterCreator: () => ({ sendPayload: (p: { d: { self_deaf: boolean } }) => deaf.push(p.d.self_deaf) > 0, destroy() {} }),
  };
  const room = { id: 'room', name: 'room', guild, joinable: true, permissionsFor: () => ({ has: () => true }), toString: () => '<#room>' } as never;
  t.after(() => {
    getVoiceConnection(guild.id)?.destroy();
    audio.delete(guild.id);
    setSetting(guild.id, 'musicDucksForPeople', undefined);
    setSetting(guild.id, 'musicDucksFor', undefined);
  });
  const joining = connect(room);
  const connection = getVoiceConnection(guild.id)!;
  connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready, networking } as never;
  assert.equal(await joining, null);
  assert.deepEqual(deaf, [false], 'undeafened, as it’s on by default');
  const talking = () => audio.get(guild.id)!.talking!.on;

  connection.receiver.speaking.emit('start', 'loop-bot');
  connection.receiver.speaking.emit('start', 'left');
  connection.receiver.speaking.emit('start', 'stranger');
  assert.equal(talking(), false, 'a bot, or anyone not known to be in voice here, doesn’t count');
  connection.receiver.speaking.emit('start', 'a');
  assert.equal(talking(), true);

  setSetting(guild.id, 'musicDucksForPeople', false);
  listeningChanged(guild.id);
  assert.deepEqual(deaf, [false, true], 'deafened where it is, without leaving');
  assert.equal(talking(), false, 'and the music comes back up');
  connection.receiver.speaking.emit('end', 'a');
  connection.receiver.speaking.emit('start', 'a');
  assert.equal(talking(), false, 'nobody counts while it’s off');
});

test('a change to listening waits until the bot has connected, so it doesn’t start connecting over', async (t) => {
  const deaf: boolean[] = [];
  const guild = { id: 'talking-connecting', name: 'Server', members: { me: {} }, voiceAdapterCreator: () => ({ sendPayload: (p: { d: { self_deaf: boolean } }) => deaf.push(p.d.self_deaf) > 0, destroy() {} }) };
  const room = { id: 'room', name: 'room', guild, joinable: true, permissionsFor: () => ({ has: () => true }) } as never;
  t.after(() => {
    getVoiceConnection(guild.id)?.destroy();
    setSetting(guild.id, 'musicDucksForPeople', undefined);
  });
  const joining = join(room, createAudioPlayer(), { listen: true });
  setSetting(guild.id, 'musicDucksForPeople', false);
  listeningChanged(guild.id);
  assert.deepEqual(deaf, [false], 'nothing sent while connecting');
  const connection = getVoiceConnection(guild.id)!;
  connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready, networking } as never;
  assert.deepEqual(await joining, { fresh: true });
  // The next connect puts it right
  assert.deepEqual(await join(room, createAudioPlayer(), { listen: false }), { fresh: false });
  assert.deepEqual(deaf, [false, true]);
});

test('the loop bot stays deafened, as it has nothing to hear', async () => {
  const deaf: boolean[] = [];
  const guild = { id: 'talking-loop', name: 'Server', members: { me: {} }, voiceAdapterCreator: () => ({ sendPayload: (p: { d: { self_deaf: boolean } }) => deaf.push(p.d.self_deaf) > 0, destroy() {} }) };
  const room = { id: 'room', name: 'room', guild, joinable: true, permissionsFor: () => ({ has: () => true }) } as never;
  const joining = join(room, createAudioPlayer(), { bot: 'loop' });
  const connection = getVoiceConnection(guild.id)!;
  connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready, networking } as never;
  assert.deepEqual(await joining, { fresh: true });
  assert.deepEqual(deaf, [true]);
  connection.destroy();
});

/** 20 ms of a tone `db` under full scale, as Discord would send it from someone's microphone */
function frames(encoder: OpusScript, db: number, count: number) {
  const amplitude = 32767 * Math.SQRT2 * 10 ** (db / 20);
  return Array.from({ length: count }, (_, f) => {
    const pcm = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(amplitude * Math.sin(((f * 960 + i) * 2 * Math.PI * 220) / 48_000));
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    return encoder.encode(pcm, 960);
  });
}

test('measured, music drops for talking, not for quiet noise or a click, and only while music plays', async (t) => {
  const inVoice = (bot: boolean) => ({ channelId: 'room', member: { user: { bot } } });
  const guild = {
    id: 'measured-server',
    name: 'Server',
    members: { me: {} },
    voiceStates: { cache: new Map([['loop-bot', inVoice(true)], ['a', inVoice(false)], ['b', inVoice(false)]]) },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  };
  const room = { id: 'room', name: 'room', guild, joinable: true, permissionsFor: () => ({ has: () => true }), toString: () => '<#room>' } as never;
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
  t.after(() => {
    getVoiceConnection(guild.id)?.destroy();
    audio.delete(guild.id);
    encoder.delete();
    setSetting(guild.id, 'musicDucksFor', undefined);
  });
  const joining = connect(room);
  const connection = getVoiceConnection(guild.id)!;
  connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready, networking } as never;
  assert.equal(await joining, null);
  const a = audio.get(guild.id)!;
  const ducked: boolean[] = [];
  const mixer = { hasMusic: false, finished: false, setPeopleTalking: (on: boolean) => ducked.push(on) };
  a.mixer = mixer as never;
  const talking = () => a.talking!.on;
  const subscribed = (id: string) => connection.receiver.subscriptions.get(id);
  const send = async (id: string, packets: Buffer[]) => {
    await new Promise((r) => setImmediate(r));
    for (const p of packets) subscribed(id)?.push(p);
    await new Promise((r) => setImmediate(r));
  };

  connection.receiver.speaking.emit('start', 'a');
  assert.equal(subscribed('a'), undefined, 'nothing decoded without music');
  connection.receiver.speaking.emit('end', 'a');

  mixer.hasMusic = true;
  connection.receiver.speaking.emit('start', 'loop-bot');
  assert.equal(subscribed('loop-bot'), undefined, 'nor for a bot');
  connection.receiver.speaking.emit('start', 'a');
  assert.ok(subscribed('a'));
  await send('a', frames(encoder, -60, 40));
  assert.equal(talking(), false, 'quiet background noise, however long, leaves the music alone');
  await send('a', frames(encoder, -20, 4));
  await send('a', frames(encoder, -60, 20));
  assert.equal(talking(), false, 'and so does a click');
  connection.receiver.speaking.emit('end', 'a');
  assert.equal(talking(), false);
  await send('a', frames(encoder, -20, 10));
  assert.equal(talking(), true, 'talking drops it');
  assert.deepEqual(ducked, [true]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  connection.receiver.speaking.emit('end', 'a');
  t.mock.timers.tick(HOLD_MS - 1);
  assert.deepEqual(ducked, [true]);
  t.mock.timers.tick(1);
  assert.deepEqual(ducked, [true, false], 'back up as long after Discord says they stopped as without measuring');
  t.mock.timers.reset();

  mixer.hasMusic = false;
  await send('a', frames(encoder, -20, 1));
  assert.equal(subscribed('a'), undefined, 'the measuring stops with the music');

  mixer.hasMusic = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  connection.receiver.speaking.emit('start', 'a');
  assert.ok(subscribed('a'));
  t.mock.timers.tick(500);
  await send('a', []);
  assert.equal(subscribed('a'), undefined, 'and when nothing comes');
  t.mock.timers.reset();

  // Changing what counts starts over
  mixer.hasMusic = true;
  connection.receiver.speaking.emit('start', 'b');
  await send('b', frames(encoder, -20, 10));
  assert.ok(subscribed('b'));
  setSetting(guild.id, 'musicDucksFor', 'loud');
  talkingChanged(guild.id);
  assert.equal(talking(), false);
  // Straight away, while the last one is still closing
  connection.receiver.speaking.emit('start', 'b');
  await send('b', frames(encoder, -40, 30));
  assert.ok(subscribed('b'));
  assert.equal(talking(), false, 'only loud talking counts on loud');
  await send('b', frames(encoder, -20, 12));
  assert.equal(talking(), true);
});
