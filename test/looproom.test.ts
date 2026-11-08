import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { Mixer } from '../src/mixer.ts';
import {
  applySoundVolume,
  checkLoopRoom,
  findSound,
  leaveIfAlone,
  noteLoopRoom,
  play,
  removeSound,
  renameSound,
  saveUpload,
  soundboard,
  soundGain,
  stopPlayback,
} from '../src/features/soundboard.ts';
import { setSetting, setting } from '../src/settings.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// A voice connection that's ready and swallows audio, since there's no real Discord to connect to
const networking = { state: {}, on() {}, off() {}, prepareAudioPacket() {}, dispatchAudio: () => true, setSpeaking() {}, destroy() {} };
const accepting = new Set<string>();
const discord = setInterval(() => {
  for (const id of accepting) {
    const c = getVoiceConnection(id);
    if (c && c.state.status !== VoiceConnectionStatus.Ready && c.state.status !== VoiceConnectionStatus.Destroyed) c.state = { ...c.state, status: VoiceConnectionStatus.Ready, networking } as never;
  }
}, 2);
after(() => {
  clearInterval(discord);
  soundboard.shutdown!();
});

let nextGuild = 0;
/** A server with a therapy room, a lounge and a sound called rain, both settings unset */
async function server(t: TestContext) {
  const id = `loop-${nextGuild++}`;
  accepting.add(id);
  const joined: string[] = [];
  const guild: any = {
    id,
    name: 'Server',
    afkChannelId: 'afk',
    members: { me: {}, cache: new Map() },
    channels: { cache: new Map() },
    voiceStates: { cache: new Map() },
    voiceAdapterCreator: () => ({ sendPayload: (p: { d: { channel_id: string } }) => joined.push(p.d.channel_id) > 0, destroy() {} }),
  };
  const room = (roomId: string) => {
    const channel = {
      id: roomId,
      name: roomId,
      guild,
      joinable: true,
      members: new Map<string, { user: { bot: boolean } }>(),
      isVoiceBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      toString: () => `#${roomId}`,
    };
    guild.channels.cache.set(roomId, channel);
    return channel;
  };
  const therapy = room('therapy');
  const lounge = room('lounge');
  await saveUpload(id, 'rain', '.wav', execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-f', 'wav', 'pipe:1']));
  const adds: { file: string; gain: number; loop: boolean; everyMs?: number; end?: () => void }[] = [];
  t.mock.method(Mixer.prototype, 'add', (file: string, gain = 1, onEnd?: () => void, options: { loop?: boolean; everyMs?: number } = {}) => void adds.push({ file, gain, loop: options.loop ?? false, everyMs: options.everyMs, end: onEnd }));
  t.after(() => getVoiceConnection(id)?.destroy());
  const enter = (channel: typeof therapy, who: string, bot = false) => channel.members.set(who, { user: { bot } });
  const turnOn = () => {
    setSetting(id, 'loopRoom', 'therapy');
    setSetting(id, 'loopSound', 'rain');
  };
  const loops = () => adds.filter((a) => a.loop);
  return { id, guild, therapy, lounge, joined, adds, loops, enter, turnOn };
}

test('nothing loops until both the room and the sound are set', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops } = await server(t);
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  setSetting(id, 'loopRoom', 'therapy');
  await checkLoopRoom(guild);
  setSetting(id, 'loopRoom', '');
  setSetting(id, 'loopSound', 'rain');
  await checkLoopRoom(guild);
  assert.equal(loops().length, 0);
  assert.equal(getVoiceConnection(id), undefined);
});

test('the first person in starts the loop at the loop volume, and the last out takes the bot with them', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn, joined } = await server(t);
  turnOn();
  await checkLoopRoom(guild);
  assert.equal(loops().length, 0, 'an empty room plays nothing');
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  await checkLoopRoom(guild);
  assert.equal(loops().length, 1, 'once, however often it’s checked');
  assert.equal(joined.at(-1), 'therapy');
  assert.equal(loops()[0].file, findSound(id, 'rain')!.file);
  assert.ok(Math.abs(loops()[0].gain - soundGain(id, 'rain') * 0.5) < 1e-9);
  therapy.members.clear();
  leaveIfAlone(guild);
  assert.equal(getVoiceConnection(id), undefined);
});

test('bots in the room don’t count', { skip: !hasFfmpeg }, async (t) => {
  const { guild, therapy, enter, loops, turnOn } = await server(t);
  turnOn();
  enter(therapy, 'another-bot', true);
  await checkLoopRoom(guild);
  assert.equal(loops().length, 0);
});

test('Stop silences it until someone else joins, or the room empties', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  turnOn();
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  stopPlayback(id);
  loops()[0].end!();
  await checkLoopRoom(guild);
  assert.equal(loops().length, 1, 'still silenced');
  const state = (channelId: string | null, who: string, bot = false) => ({ channelId, guild, member: { user: { bot } }, id: who }) as never;
  noteLoopRoom(state('therapy', 'ana'), state('therapy', 'ana'));
  noteLoopRoom(state(null, 'helper', true), state('therapy', 'helper', true));
  await checkLoopRoom(guild);
  assert.equal(loops().length, 1, 'muting or a bot joining isn’t someone new');
  enter(therapy, 'ben');
  noteLoopRoom(state(null, 'ben'), state('therapy', 'ben'));
  await checkLoopRoom(guild);
  assert.equal(loops().length, 2);

  stopPlayback(id);
  loops()[1].end!();
  therapy.members.clear();
  noteLoopRoom(state('therapy', 'ana'), state(null, 'ana'));
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  assert.equal(loops().length, 3, 'an emptied room starts fresh');
});

test('the room waits while people are using the bot elsewhere, then gets it once it’s free', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, lounge, enter, loops, turnOn, joined } = await server(t);
  turnOn();
  enter(lounge, 'cat');
  joinVoiceChannel({ channelId: 'lounge', guildId: id, adapterCreator: guild.voiceAdapterCreator } as never);
  await sleep(10);
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  assert.equal(loops().length, 0);
  lounge.members.clear();
  await checkLoopRoom(guild);
  assert.equal(loops().length, 1);
  assert.equal(joined.at(-1), 'therapy');
});

test('playing in another channel stops the loop, and it comes back once the bot’s free', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, lounge, enter, loops, turnOn } = await server(t);
  const stops = t.mock.method(Mixer.prototype, 'stopLoops', function (this: Mixer) {
    for (const loop of loops()) loop.end?.();
  });
  turnOn();
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  enter(lounge, 'cat');
  // The test's connection never reports the move, so it's made by hand as Discord would
  getVoiceConnection(id)!.joinConfig.channelId = 'therapy';
  assert.equal(await play(lounge as never, findSound(id, 'rain')!.file), null);
  assert.equal(stops.mock.callCount(), 1);
  getVoiceConnection(id)!.joinConfig.channelId = 'lounge';
  await checkLoopRoom(guild);
  assert.equal(loops().length, 1, 'not while the lounge is using it');
  lounge.members.clear();
  await checkLoopRoom(guild);
  assert.equal(loops().length, 2);
});

test('renaming the sound keeps the loop, and removing it turns the loop off', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, turnOn } = await server(t);
  turnOn();
  assert.equal(await renameSound(guild, findSound(id, 'rain')!, 'storm'), null);
  assert.equal(setting(id, 'loopSound'), 'storm');
  await removeSound(guild, findSound(id, 'storm')!);
  assert.equal(setting(id, 'loopSound'), '');
});

test('the soundboard volume reaches sounds already playing, and new ones', { skip: !hasFfmpeg }, async (t) => {
  const { id, lounge, enter } = await server(t);
  const set = t.mock.method(Mixer.prototype, 'setGroupGain');
  enter(lounge, 'cat');
  setSetting(id, 'soundVolume', 40);
  await play(lounge as never, findSound(id, 'rain')!.file);
  assert.deepEqual(set.mock.calls.map((c) => c.arguments), [
    ['sound', 0.4],
    ['music', 0.4],
  ], 'a new mixer starts at both volumes');
  setSetting(id, 'soundVolume', 150);
  applySoundVolume(id);
  assert.deepEqual(set.mock.calls.at(-1)!.arguments, ['sound', 1.5]);
});

test('a sound that isn’t a WAV loops from a copy, which goes once the loop ends', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops } = await server(t);
  await saveUpload(id, 'hum', '.mp3', execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-f', 'mp3', 'pipe:1']));
  setSetting(id, 'loopRoom', 'therapy');
  setSetting(id, 'loopSound', 'hum');
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  const copy = loops()[0].file;
  assert.match(copy, /slopkeeper-loop-.*\.wav$/);
  assert.ok(existsSync(copy));
  loops()[0].end!();
  assert.ok(!existsSync(copy));
});

test('a gap set layers fresh copies that often, rather than looping without one', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  turnOn();
  setSetting(id, 'loopEvery', '0.5');
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  assert.deepEqual([loops().length, loops()[0].everyMs], [1, 500]);
  loops()[0].end!();
  setSetting(id, 'loopEvery', '0');
  await checkLoopRoom(guild);
  assert.equal(loops()[1].everyMs, undefined, '0 loops without a gap');
});
