import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioPlayer, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { audio, connect, listeningChanged } from '../src/features/voiceAudio.ts';
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
