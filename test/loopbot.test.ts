import './helpers.ts';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { createLoopApi, LoopRoom, readProgram, type LoopProgram } from '../src/loopBot.ts';
import { Mixer } from '../src/mixer.ts';

const ROOT = path.resolve('/data');
const file = (name: string) => path.join(ROOT, name);

// A voice connection that's ready and swallows audio, since there's no real Discord to connect to
const networking = { state: {}, on() {}, off() {}, prepareAudioPacket() {}, dispatchAudio: () => true, setSpeaking() {}, destroy() {} };
const accepting = new Set<string>();
const discord = setInterval(() => {
  for (const id of accepting) {
    const c = getVoiceConnection(id);
    if (c && c.state.status !== VoiceConnectionStatus.Ready && c.state.status !== VoiceConnectionStatus.Destroyed) c.state = { ...c.state, status: VoiceConnectionStatus.Ready, networking } as never;
  }
}, 2);
after(() => clearInterval(discord));

let nextGuild = 0;
/** A server the loop bot is in, with a therapy room that has someone in it, and what the mixer was given */
function server(t: TestContext) {
  const id = String(700_000 + nextGuild++);
  accepting.add(id);
  const joined: string[] = [];
  const guild: any = {
    id,
    name: 'Server',
    members: { me: {} },
    channels: { cache: new Map() },
    voiceAdapterCreator: () => ({ sendPayload: (p: { d: { channel_id: string } }) => joined.push(p.d.channel_id) > 0, destroy() {} }),
  };
  const room = (roomId: string, canSpeak = true) => {
    const channel = { id: roomId, name: `room-${roomId}`, guild, joinable: true, members: new Map([['ana', { user: { bot: false } }]]), isVoiceBased: () => true, permissionsFor: () => ({ has: () => canSpeak }) };
    guild.channels.cache.set(roomId, channel);
    return channel;
  };
  const therapy = room('111');
  room('222');
  room('333', false);
  const adds: { file: string; gain: number; loop: boolean; everyMs?: number; end?: (byItself: boolean) => void; stopped: boolean; at: number }[] = [];
  t.mock.method(Mixer.prototype, 'add', (f: string, gain = 1, onEnd?: (byItself: boolean) => void, options: { loop?: boolean; everyMs?: number } = {}) => {
    const add = { file: f, gain, loop: options.loop ?? false, everyMs: options.everyMs, end: onEnd, stopped: false, at: Date.now() };
    adds.push(add);
    return () => {
      add.stopped = true;
    };
  });
  const stopAll = t.mock.method(Mixer.prototype, 'stopAll', () => {});
  const loopRoom = new LoopRoom(guild);
  t.after(() => loopRoom.stop());
  const playing = () => adds.filter((a) => !a.stopped);
  return { id, guild, therapy, joined, adds, playing, stopAll, loopRoom };
}

const program = (over: Partial<LoopProgram> = {}): LoopProgram => ({
  run: 0,
  channelId: '111',
  intro: null,
  parts: [
    { file: file('rain.wav'), gain: 0.5, everyMs: 0, delayMs: 0 },
    { file: file('loop-speech/line.wav'), gain: 0.4, everyMs: 2500, delayMs: 0 },
  ],
  ...over,
});

test('a program has to name files on the data volume, with sensible numbers', () => {
  assert.deepEqual(readProgram(program(), ROOT), program());
  assert.match(readProgram(program({ parts: [{ file: '/etc/passwd', gain: 1, everyMs: 0, delayMs: 0 }] }), ROOT) as string, /parts/);
  assert.match(readProgram(program({ parts: [{ file: file('../etc/passwd'), gain: 1, everyMs: 0, delayMs: 0 }] }), ROOT) as string, /parts/);
  assert.match(readProgram(program({ parts: [{ file: file('a.wav'), gain: 11, everyMs: 0, delayMs: 0 }] }), ROOT) as string, /parts/);
  assert.match(readProgram(program({ parts: [{ file: file('a.wav'), gain: 1, everyMs: -1, delayMs: 0 }] }), ROOT) as string, /parts/);
  assert.match(readProgram(program({ parts: [] }), ROOT) as string, /one to four/);
  assert.match(readProgram(program({ intro: { file: '/tmp/x.wav', gain: 1, delayMs: 0 } }), ROOT) as string, /intro/);
  assert.match(readProgram(program({ channelId: 'lounge' }), ROOT) as string, /channel/);
  assert.match(readProgram({ ...program(), run: 1.5 }, ROOT) as string, /run/);
  assert.match(readProgram(null, ROOT) as string, /Send a program/);
});

test('plays the intro after its delay, then each part after its own', async (t) => {
  const { therapy, joined, adds, loopRoom } = server(t);
  assert.equal(await loopRoom.play(program({ intro: { file: file('chime.wav'), gain: 0.9, delayMs: 80 }, parts: [{ ...program().parts[0], delayMs: 50 }, { ...program().parts[1], delayMs: 200 }] })), null);
  assert.equal(joined.at(-1), therapy.id);
  assert.equal(adds.length, 0, 'not before the intro’s delay');
  await sleep(150);
  assert.deepEqual(adds.map((a) => [a.file, a.gain, a.loop]), [[file('chime.wav'), 0.9, false]]);
  const ended = Date.now();
  adds[0].end!(true);
  await sleep(120);
  assert.deepEqual(adds.slice(1).map((a) => a.file), [file('rain.wav')], 'the sound’s shorter delay');
  await sleep(200);
  assert.deepEqual(adds.slice(1).map((a) => [a.file, a.loop, a.everyMs]), [
    [file('rain.wav'), true, undefined],
    [file('loop-speech/line.wav'), true, 2500],
  ]);
  assert.ok(adds[1].at - ended >= 45 && adds[2].at - ended >= 195);
});

test('the same program again is nothing new, and the same run with changes takes them up without the intro', async (t) => {
  const { adds, playing, loopRoom } = server(t);
  const first = program({ intro: { file: file('chime.wav'), gain: 1, delayMs: 0 }, parts: [{ ...program().parts[0], delayMs: 100 }] });
  await loopRoom.play(first);
  adds[0].end!(true);
  await sleep(150);
  await loopRoom.play(first);
  assert.equal(adds.length, 2);
  await loopRoom.play({ ...first, parts: [{ ...first.parts[0], gain: 0.8 }] });
  assert.deepEqual(adds.map((a) => [a.file, a.gain, a.stopped]), [
    [file('chime.wav'), 1, false],
    [file('rain.wav'), 0.5, true],
    [file('rain.wav'), 0.8, false],
  ], 'straight away, with no delay');
  // A new run starts over
  await loopRoom.play({ ...first, run: 1 });
  assert.deepEqual(playing().map((a) => a.file), [file('chime.wav'), file('chime.wav')]);
  assert.ok(adds[2].stopped);
});

test('a change during the intro waits for it, and plays with what was sent last', async (t) => {
  const { adds, loopRoom } = server(t);
  const first = program({ intro: { file: file('chime.wav'), gain: 1, delayMs: 0 } });
  await loopRoom.play(first);
  await loopRoom.play({ ...first, parts: [{ ...first.parts[0], gain: 0.2 }] });
  assert.equal(adds.length, 1, 'still the intro');
  adds[0].end!(true);
  assert.deepEqual(adds.slice(1).map((a) => a.gain), [0.2]);
});

test('starting over or stopping cancels what was waiting', async (t) => {
  const { adds, stopAll, loopRoom, id } = server(t);
  await loopRoom.play(program({ intro: { file: file('chime.wav'), gain: 1, delayMs: 50 } }));
  await loopRoom.play(program({ run: 1, intro: { file: file('chime.wav'), gain: 1, delayMs: 50 } }));
  await sleep(100);
  assert.equal(adds.length, 1, 'one intro, from the second run');
  // The parts wait after the intro, and Stop comes before they start
  await loopRoom.play(program({ run: 2, parts: [{ ...program().parts[0], delayMs: 50 }], intro: { file: file('chime.wav'), gain: 1, delayMs: 0 } }));
  adds[1].end!(true);
  loopRoom.stop();
  await sleep(100);
  assert.deepEqual(adds.map((a) => a.file), [file('chime.wav'), file('chime.wav')]);
  assert.ok(stopAll.mock.callCount() > 0, 'silenced');
  assert.equal(getVoiceConnection(id), undefined, 'left');
  // An intro from before ending late starts nothing
  adds[0].end!(true);
  assert.equal(adds.length, 2);
});

test('moving to another room starts over there, and a room it can’t use says why', async (t) => {
  const { joined, adds, loopRoom } = server(t);
  await loopRoom.play(program());
  await loopRoom.play(program({ channelId: '222' }));
  assert.deepEqual(joined.slice(-1), ['222']);
  assert.equal(adds.filter((a) => !a.stopped).length, 2);
  assert.match((await loopRoom.play(program({ channelId: '333' })))!, /needs \*\*View Channel\*\*, \*\*Connect\*\*, \*\*Speak\*\*/);
  assert.match((await loopRoom.play(program({ channelId: '444' })))!, /isn’t a voice channel/);
});

test('leaves a room that stays empty, but not one someone comes back to', async (t) => {
  const { id, therapy, loopRoom } = server(t);
  await loopRoom.play(program());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  therapy.members.clear();
  loopRoom.checkEmpty();
  t.mock.timers.tick(20_000);
  therapy.members.set('ana', { user: { bot: false } });
  loopRoom.checkEmpty();
  t.mock.timers.tick(20_000);
  assert.ok(getVoiceConnection(id));
  therapy.members.set('ana', { user: { bot: true } } as never);
  loopRoom.checkEmpty();
  t.mock.timers.tick(30_000);
  assert.equal(getVoiceConnection(id), undefined, 'a bot doesn’t count');
});

test('the API needs the password, and plays, stops and reports', async (t) => {
  const { guild, adds } = server(t);
  const client = { isReady: () => true, user: { displayName: 'Slopkeeper Loop' }, guilds: { cache: new Map([[guild.id, guild]]) } } as never;
  const api = createLoopApi(client, 'secret', ROOT).listen(0);
  t.after(() => api.close());
  await new Promise((resolve) => api.once('listening', resolve));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const call = async (pathname: string, init: RequestInit = {}, token = 'secret') => {
    const res = await fetch(base + pathname, { ...init, headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('/status', {}, 'wrong')).status, 401);
  assert.deepEqual(await call('/status'), { status: 200, body: { ready: true, name: 'Slopkeeper Loop', guilds: [guild.id] } });
  assert.equal((await call(`/guilds/${guild.id}/loop`, { method: 'PUT', body: JSON.stringify(program({ parts: [{ file: '/etc/passwd', gain: 1, everyMs: 0, delayMs: 0 }] })) })).status, 400);
  assert.equal((await call(`/guilds/${guild.id}/loop`, { method: 'PUT', body: '{' })).status, 400);
  assert.match((await call('/guilds/123/loop', { method: 'PUT', body: JSON.stringify(program()) })).body.error, /isn’t in that server/);
  assert.equal((await call(`/guilds/${guild.id}/loop`, { method: 'PUT', body: JSON.stringify(program()) })).status, 200);
  assert.equal(adds.length, 2);
  assert.equal((await call(`/guilds/${guild.id}/loop`, { method: 'PUT', body: JSON.stringify(program({ channelId: '333' })) })).status, 502);
  assert.equal((await call(`/guilds/${guild.id}/loop`, { method: 'DELETE' })).status, 200);
  assert.equal(getVoiceConnection(guild.id), undefined);
  assert.equal((await call('/elsewhere')).status, 404);
});
