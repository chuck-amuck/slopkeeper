import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { config } from '../src/config.ts';
import type { LoopProgram } from '../src/loopBot.ts';
import { Mixer } from '../src/mixer.ts';
import {
  applySoundVolume,
  checkLoopRoom,
  findSound,
  leaveIfAlone,
  loopBotStatus,
  noteLoopRoom,
  play,
  refreshLoopRoom,
  removeSound,
  renameSound,
  saveUpload,
  setLoopSpeaker,
  soundboard,
  soundGain,
  stopPlayback,
  syncLoopBot,
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
    ['speech', 1],
    ['music', 0.4],
  ], 'a new mixer starts at every group’s volume');
  setSetting(id, 'soundVolume', 150);
  applySoundVolume(id);
  assert.deepEqual(set.mock.calls.at(-1)!.arguments, ['sound', 1.5]);
});

test('a sound that isn’t a WAV loops from a WAV copy on the data volume, made once and replaced when the sound changes', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops } = await server(t);
  const hum = (frequency: number) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.2`, '-f', 'mp3', 'pipe:1']);
  await saveUpload(id, 'hum', '.mp3', hum(440));
  setSetting(id, 'loopRoom', 'therapy');
  setSetting(id, 'loopSound', 'hum');
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  const copy = loops()[0].file;
  assert.equal(path.dirname(copy), path.join(config.dataDir, 'loop-cache'));
  assert.ok(copy.endsWith('.wav') && existsSync(copy));
  loops()[0].end!();
  await checkLoopRoom(guild);
  assert.equal(loops()[1].file, copy, 'reused');
  loops()[1].end!();
  await saveUpload(id, 'drone', '.mp3', hum(220));
  setSetting(id, 'loopSound', 'drone');
  await checkLoopRoom(guild);
  assert.notEqual(loops()[2].file, copy);
  assert.ok(!existsSync(copy), 'the old copy goes');
  assert.deepEqual(readdirSync(path.join(config.dataDir, 'loop-cache')).filter((f) => f.startsWith(`${id}-`)), [path.basename(loops()[2].file)]);
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

test('looping speech plays alongside the sound, or alone, at the loop volume, with its own gap', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  const made: string[] = [];
  setLoopSpeaker(async (_guild, text, _voice, file) => {
    made.push(text);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.3', file]);
  });
  t.after(() => setLoopSpeaker(undefined as never));
  turnOn();
  setSetting(id, 'loopText', 'stay a while');
  setSetting(id, 'loopTextEvery', '2.5');
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  const [sound, speech] = [loops().find((l) => l.file.endsWith('.wav') && !l.file.includes('loop-speech')), loops().find((l) => l.file.includes('loop-speech'))];
  assert.ok(sound && speech, `both play, got ${loops().map((l) => l.file).join(', ')}`);
  assert.deepEqual([speech.gain, speech.everyMs, sound.everyMs], [0.5, 2500, undefined]);
  // The sound ending (Stop does this) leaves the speech, and checking again brings back only the sound
  sound.end!();
  await checkLoopRoom(guild);
  assert.equal(loops().length, 3);
  assert.equal(made.length, 1, 'the speech isn’t made again');
  // With no sound set, the speech plays alone
  for (const l of loops()) l.end?.();
  setSetting(id, 'loopSound', '');
  await checkLoopRoom(guild);
  assert.deepEqual(loops().slice(3).map((l) => l.file.includes('loop-speech')), [true]);
});

test('speech that can’t be made leaves the sound playing', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  setLoopSpeaker(async () => {
    throw new Error('The voice container isn’t answering');
  });
  t.after(() => setLoopSpeaker(undefined as never));
  const errors = t.mock.method(console, 'error', () => {});
  turnOn();
  setSetting(id, 'loopText', 'stay a while');
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  assert.equal(loops().length, 1);
  assert.match(String(errors.mock.calls[0].arguments.join(' ')), /Looping speech .* couldn’t be prepared: The voice container/);
});

/** The room from `server`, with a chime from the library as its intro */
async function withIntro(t: TestContext, delayMs = 0) {
  const room = await server(t);
  await saveUpload(room.id, 'chime', '.wav', execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.2', '-f', 'wav', 'pipe:1']));
  room.turnOn();
  setSetting(room.id, 'loopIntro', 'chime');
  setSetting(room.id, 'loopIntroDelayMs', delayMs);
  const intros = () => room.adds.filter((a) => a.file === findSound(room.id, 'chime')!.file);
  const finish = (add: { end?: () => void }) => (add.end as (byItself: boolean) => void)(true);
  const state = (channelId: string | null, who: string) => ({ channelId, guild: room.guild, member: { user: { bot: false } }, id: who }) as never;
  return { ...room, intros, finish, state };
}

test('the intro plays after its delay, at the sound’s own level, and the loop starts once it ends', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, intros, finish } = await withIntro(t, 150);
  enter(therapy, 'ana');
  const started = checkLoopRoom(guild);
  await sleep(60);
  assert.equal(intros().length, 0, 'not before the delay');
  await sleep(250);
  assert.equal(intros().length, 1);
  assert.deepEqual([intros()[0].loop, intros()[0].gain], [false, soundGain(id, 'chime')]);
  assert.equal(loops().length, 0, 'the loop waits for the intro');
  await checkLoopRoom(guild);
  assert.equal(intros().length, 1, 'checking again during the intro changes nothing');
  finish(intros()[0]);
  await started;
  assert.equal(loops().length, 1);
});

test('someone else coming in stops the loop and starts again from the intro', { skip: !hasFfmpeg }, async (t) => {
  const { guild, therapy, enter, loops, intros, finish, state } = await withIntro(t);
  const stopped = t.mock.method(Mixer.prototype, 'stopLoops');
  enter(therapy, 'ana');
  noteLoopRoom(state(null, 'ana'), state('therapy', 'ana'));
  const first = checkLoopRoom(guild);
  await sleep(50);
  finish(intros()[0]);
  await first;
  const [old] = loops();
  enter(therapy, 'ben');
  noteLoopRoom(state('lounge', 'ben'), state('therapy', 'ben'));
  assert.equal(stopped.mock.callCount(), 1);
  const again = checkLoopRoom(guild);
  await sleep(50);
  assert.equal(intros().length, 2);
  assert.equal(loops().length, 1, 'the loop waits for the intro again');
  // The stopped loop ending late doesn't free the new run's place
  old.end!();
  finish(intros()[1]);
  await again;
  assert.equal(loops().length, 2);
  await checkLoopRoom(guild);
  assert.equal(loops().length, 2, 'no second copy');
  // Muting, or someone leaving, isn't someone coming in
  noteLoopRoom(state('therapy', 'ana'), state('therapy', 'ana'));
  noteLoopRoom(state('therapy', 'ben'), state(null, 'ben'));
  assert.equal(stopped.mock.callCount(), 1);
});

test('someone coming in during the intro starts it over, and only one loop follows', { skip: !hasFfmpeg }, async (t) => {
  const { guild, therapy, enter, loops, intros, finish, state } = await withIntro(t, 100);
  enter(therapy, 'ana');
  const first = checkLoopRoom(guild);
  await sleep(20);
  enter(therapy, 'ben');
  noteLoopRoom(state(null, 'ben'), state('therapy', 'ben'));
  const second = checkLoopRoom(guild);
  await sleep(200);
  await first;
  assert.equal(intros().length, 1, 'the first run gave up during its delay');
  finish(intros()[0]);
  await second;
  assert.equal(loops().length, 1);
});

test('Stop or everyone leaving during the intro means no loop', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, intros, finish } = await withIntro(t, 100);
  enter(therapy, 'ana');
  const stopping = checkLoopRoom(guild);
  await sleep(150);
  stopPlayback(id);
  (intros()[0].end as (byItself: boolean) => void)(false);
  await stopping;
  assert.equal(loops().length, 0);
  await checkLoopRoom(guild);
  assert.equal(intros().length, 1, 'still silenced');

  const { guild: other, therapy: room, enter: arrive, intros: otherIntros } = await withIntro(t, 100);
  arrive(room, 'ana');
  const leaving = checkLoopRoom(other);
  await sleep(20);
  room.members.clear();
  await leaving;
  assert.equal(otherIntros().length, 0, 'gone before the delay was up');
  void finish;
});

test('changing a loop setting doesn’t replay the intro', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, intros, finish } = await withIntro(t);
  enter(therapy, 'ana');
  const started = checkLoopRoom(guild);
  await sleep(50);
  finish(intros()[0]);
  await started;
  loops()[0].end!();
  setSetting(id, 'loopVolume', 80);
  await refreshLoopRoom(guild);
  assert.equal(intros().length, 1);
  assert.deepEqual(loops().map((l) => l.gain), [0.5 * soundGain(id, 'rain'), 0.8 * soundGain(id, 'rain')]);
});

test('without an intro, someone coming in leaves the loop playing', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  const stopped = t.mock.method(Mixer.prototype, 'stopLoops');
  turnOn();
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  enter(therapy, 'ben');
  noteLoopRoom({ channelId: null } as never, { channelId: 'therapy', guild, member: { user: { bot: false } }, id: 'ben' } as never);
  await checkLoopRoom(guild);
  assert.deepEqual([stopped.mock.callCount(), loops().length], [0, 1]);
  void id;
});

test('renaming the intro’s sound keeps it, and removing it turns the intro off', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild } = await withIntro(t);
  assert.equal(await renameSound(guild, findSound(id, 'chime')!, 'bell'), null);
  assert.equal(setting(id, 'loopIntro'), 'bell');
  await removeSound(guild, findSound(id, 'bell')!);
  assert.equal(setting(id, 'loopIntro'), '');
  assert.equal(setting(id, 'loopSound'), 'rain');
});

test('the speech has its own volume, apart from the sound’s', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  setLoopSpeaker(async (_guild, _text, _voice, file) => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.3', file]);
  });
  t.after(() => setLoopSpeaker(undefined as never));
  turnOn();
  setSetting(id, 'loopText', 'stay a while');
  setSetting(id, 'loopVolume', 80);
  setSetting(id, 'loopTextVolume', 120);
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  const speech = loops().find((l) => l.file.includes('loop-speech'))!;
  const sound = loops().find((l) => !l.file.includes('loop-speech'))!;
  assert.deepEqual([sound.gain, speech.gain], [0.8 * soundGain(id, 'rain'), 1.2]);
});

test('the sound and the speech each wait their own delay after the intro', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, intros, finish } = await withIntro(t);
  setLoopSpeaker(async (_guild, _text, _voice, file) => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.3', file]);
  });
  t.after(() => setLoopSpeaker(undefined as never));
  setSetting(id, 'loopText', 'stay a while');
  setSetting(id, 'loopSoundDelayMs', 100);
  setSetting(id, 'loopTextDelayMs', 400);
  enter(therapy, 'ana');
  const started = checkLoopRoom(guild);
  await sleep(50);
  finish(intros()[0]);
  const at = Date.now();
  const kinds = () => loops().map((l) => (l.file.includes('loop-speech') ? 'speech' : 'sound'));
  await sleep(250);
  assert.deepEqual(kinds(), ['sound'], 'the sound comes in first');
  await started;
  assert.deepEqual(kinds(), ['sound', 'speech']);
  assert.ok(Date.now() - at >= 400, 'the speech waited its delay');
  // Changing a setting takes it up straight away, without the delays
  for (const l of loops()) l.end!();
  await refreshLoopRoom(guild);
  assert.deepEqual(kinds().slice(2).sort(), ['sound', 'speech']);
});

test('Stop or someone coming in during a delay means that part doesn’t start late', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, intros, finish, state } = await withIntro(t);
  setSetting(id, 'loopSoundDelayMs', 200);
  enter(therapy, 'ana');
  const stopping = checkLoopRoom(guild);
  await sleep(50);
  finish(intros()[0]);
  await sleep(50);
  stopPlayback(id);
  await stopping;
  assert.equal(loops().length, 0, 'Stop during the delay');

  enter(therapy, 'ben');
  noteLoopRoom(state(null, 'ben'), state('therapy', 'ben'));
  const first = checkLoopRoom(guild);
  await sleep(50);
  finish(intros()[1]);
  await sleep(50);
  enter(therapy, 'cy');
  noteLoopRoom(state(null, 'cy'), state('therapy', 'cy'));
  const second = checkLoopRoom(guild);
  await first;
  assert.equal(loops().length, 0, 'the restarted run’s sound never came in');
  await sleep(50);
  finish(intros()[2]);
  await second;
  assert.equal(loops().length, 1);
});

/** A loop bot that keeps what it's sent, and answers as told */
async function fakeLoopBot(t: TestContext) {
  const sent: { method: string; url: string; auth?: string; program?: LoopProgram }[] = [];
  const answer: { status: number; body: unknown; down: boolean } = { status: 200, body: { ok: true }, down: false };
  const status = { ready: true, name: 'Slopkeeper Loop', guilds: [] as string[] };
  const bot = createServer(async (req, res) => {
    if (answer.down) return void res.destroy();
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/status') return void res.writeHead(200).end(JSON.stringify(status));
    sent.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, ...(body && { program: JSON.parse(body) }) });
    res.writeHead(answer.status).end(JSON.stringify(answer.body));
  }).listen(0);
  await new Promise((resolve) => bot.once('listening', resolve));
  config.loopBotUrl = `http://127.0.0.1:${(bot.address() as AddressInfo).port}`;
  config.loopToken = 'shared';
  t.after(() => {
    config.loopBotUrl = null;
    config.loopToken = null;
    bot.close();
  });
  return { sent, answer, status };
}

test('with a loop bot, the room is sent there, and this bot stays out of it', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn, joined } = await server(t);
  const { sent } = await fakeLoopBot(t);
  turnOn();
  setSetting(id, 'loopSoundDelayMs', 300);
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  assert.deepEqual([loops().length, joined.length], [0, 0]);
  assert.deepEqual(sent.map((r) => [r.method, r.url, r.auth]), [['PUT', `/guilds/${id}/loop`, 'Bearer shared']]);
  assert.deepEqual(sent[0].program, {
    run: 0,
    channelId: 'therapy',
    intro: null,
    parts: [{ file: path.resolve(findSound(id, 'rain')!.file), gain: soundGain(id, 'rain') * 0.5, everyMs: 0, delayMs: 300 }],
  });
  // Stop on the soundboard leaves it alone
  stopPlayback(id);
  await checkLoopRoom(guild);
  assert.deepEqual(sent.map((r) => r.method), ['PUT', 'PUT'], 'the same program again, which it ignores');
  // Once the room empties it's told to leave, once
  therapy.members.clear();
  await checkLoopRoom(guild);
  await checkLoopRoom(guild);
  assert.deepEqual(sent.map((r) => r.method), ['PUT', 'PUT', 'DELETE']);
});

test('with a loop bot, someone coming in starts a new run when there’s an intro, and a setting change keeps the run', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, turnOn } = await server(t);
  const { sent } = await fakeLoopBot(t);
  await saveUpload(id, 'chime', '.wav', execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.2', '-f', 'wav', 'pipe:1']));
  turnOn();
  const state = (channelId: string | null, who: string) => ({ channelId, guild, member: { user: { bot: false } }, id: who }) as never;
  enter(therapy, 'ana');
  noteLoopRoom(state(null, 'ana'), state('therapy', 'ana'));
  await checkLoopRoom(guild);
  assert.equal(sent[0].program!.intro, null);
  setSetting(id, 'loopIntro', 'chime');
  setSetting(id, 'loopIntroDelayMs', 400);
  setSetting(id, 'soundVolume', 50);
  await refreshLoopRoom(guild);
  assert.deepEqual(sent[1].program!.intro, { file: path.resolve(findSound(id, 'chime')!.file), gain: soundGain(id, 'chime') * 0.5, delayMs: 400 });
  assert.equal(sent[1].program!.parts[0].gain, soundGain(id, 'rain') * 0.5 * 0.5, 'the soundboard volume is in the gain');
  assert.equal(sent[1].program!.run, sent[0].program!.run, 'a change keeps the run, so it’s taken up without the intro');
  enter(therapy, 'ben');
  noteLoopRoom(state('lounge', 'ben'), state('therapy', 'ben'));
  await checkLoopRoom(guild);
  assert.equal(sent[2].program!.run, sent[0].program!.run + 1);
  noteLoopRoom(state('therapy', 'ben'), state('therapy', 'ben'));
  await checkLoopRoom(guild);
  assert.equal(sent[3].program!.run, sent[2].program!.run, 'muting isn’t coming in');
});

test('with a loop bot, the speech goes as a part of its own', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter } = await server(t);
  const { sent } = await fakeLoopBot(t);
  setLoopSpeaker(async (_guild, _text, _voice, file) => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.3', file]);
  });
  t.after(() => setLoopSpeaker(undefined as never));
  setSetting(id, 'loopRoom', 'therapy');
  setSetting(id, 'loopText', 'stay a while');
  setSetting(id, 'loopTextVolume', 70);
  setSetting(id, 'loopTextEvery', 2.5);
  setSetting(id, 'loopTextDelayMs', 900);
  enter(therapy, 'ana');
  await checkLoopRoom(guild);
  const [speech] = sent[0].program!.parts;
  assert.match(speech.file, /loop-speech/);
  assert.deepEqual([speech.gain, speech.everyMs, speech.delayMs], [0.7, 2500, 900]);
});

test('with a loop bot that’s down or refuses, the room stays quiet and the log says why', { skip: !hasFfmpeg }, async (t) => {
  const { id, guild, therapy, enter, loops, turnOn } = await server(t);
  const { answer } = await fakeLoopBot(t);
  const logged = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  turnOn();
  enter(therapy, 'ana');
  answer.status = 502;
  answer.body = { error: 'The loop bot can’t join therapy, it’s full.' };
  await checkLoopRoom(guild);
  assert.match(String(logged.mock.calls.at(-1)!.arguments[0]), /didn’t play: The loop bot can’t join therapy/);
  answer.down = true;
  await syncLoopBot(guild);
  assert.match(String(errors.mock.calls.at(-1)!.arguments[0]), /loop bot couldn’t be reached/);
  assert.equal(loops().length, 0, 'no playing it here instead');
  void id;
});

test('Settings says how the loop bot is doing', async (t) => {
  assert.equal(await loopBotStatus('anywhere'), null, 'nothing without one');
  const { status, answer } = await fakeLoopBot(t);
  assert.match((await loopBotStatus('g1'))!.note, /Slopkeeper Loop, isn’t in this server yet/);
  status.guilds = ['g1'];
  assert.deepEqual(await loopBotStatus('g1'), { ok: true, note: 'Slopkeeper Loop plays this room, so Slopkeeper stays free for everything else. Stop on the soundboard doesn’t stop it.' });
  status.ready = false;
  assert.match((await loopBotStatus('g1'))!.note, /starting, or can’t log in/);
  answer.down = true;
  assert.deepEqual(await loopBotStatus('g1'), { ok: false, note: 'The loop bot isn’t answering, so the room is quiet.' });
});
