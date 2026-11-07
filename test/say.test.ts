import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { PermissionFlagsBits } from 'discord.js';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { Mixer } from '../src/mixer.ts';
import { say, speak, speechFor } from '../src/features/say.ts';
import { soundboard, stopPlayback } from '../src/features/soundboard.ts';
import { setSetting } from '../src/settings.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(path.join(tmpdir(), 'slopkeeper-speech-'));
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
      members: { me: {}, cache: new Map() },
      roles: { cache: new Map() },
      channels: { cache: new Map() },
      voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
    },
  } as never as import('discord.js').VoiceBasedChannel;
}

/** A voice container, which keeps what it was asked for */
function fakeVoice(t: TestContext, answer?: (text: string, signal: AbortSignal) => Promise<Response>) {
  const asked: { text: string; speaker: number; length: number }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'http://voice.test/synthesize');
    const body = JSON.parse(init.body as string) as { text: string; speaker_id: number; length_scale: number };
    asked.push({ text: body.text, speaker: body.speaker_id, length: body.length_scale });
    return answer ? answer(body.text, init.signal!) : new Response(readFileSync(speechFile));
  });
  return asked;
}

const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith('slopkeeper-say-')).flatMap((f) => readdirSync(path.join(tmpdir(), f)));

speak.setup!({} as never);
beforeEach(() => void (config.voiceUrl = 'http://voice.test'));
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
  assert.equal(await say(voice, 'and again', '1', 'ben'), null);
  await sleep(300);
  assert.deepEqual(asked, [{ text: 'hello there', speaker: 400, length: 1.18 }, { text: 'and again', speaker: 0, length: 1.18 }]);
  const lines = recentActivity(voice.guild.id, 5).map((r) => `${r.actor}: ${r.action}`).toReversed();
  assert.deepEqual(lines, ['ana: Said “hello there” in <#voice>', 'ben: Said “and again” in <#voice>']);
  assert.deepEqual(leftovers(), []);
});

test('a server’s speed setting changes how long speech takes', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
  for (const speed of [100, 50, 150]) {
    setSetting(voice.guild.id, 'ttsSpeed', speed);
    assert.equal(await say(voice, 'hello', undefined, String(speed)), null);
  }
  assert.deepEqual(asked.map((a) => a.length), [1, 2, 0.67]);
});

test('a server’s volume setting changes how loud a line plays', { skip: !hasFfmpeg }, async (t) => {
  fakeVoice(t);
  const added = t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => onEnd?.());
  const voice = channel();
  assert.equal(await say(voice, 'hello', undefined, 'a'), null);
  setSetting(voice.guild.id, 'ttsVolume', 150);
  assert.equal(await say(voice, 'hello', undefined, 'b'), null);
  assert.deepEqual(added.mock.calls.map((c) => c.arguments[1]), [1, 1.5]);
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
  assert.equal(timeout.mock.calls[0].arguments[0], 15_000);
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
  assert.equal(await say(voice, 'x'.repeat(21), undefined, 'x'), 'That’s 21 characters, and the limit here is 20.');

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
  assert.equal(speechFor(guild, 'nice <:big_brain:1234> <a:party:5678> 🎉 👍🏽'), 'nice big brain party');
  assert.equal(speechFor(guild, 'see https://example.test/a?b=1 now'), 'see link now');
  assert.equal(speechFor(guild, '**bold** ~~gone~~ `code` ||secret|| _lean_'), 'bold gone code secret lean');
  assert.equal(speechFor(guild, '  two\n\n lines  '), 'two lines');
});

function run(t: TestContext, voice: unknown, options: { text?: string; pick?: string; role?: string; roles?: string[]; manager?: boolean } = {}) {
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
      options: { getString: (name: string) => (name === 'text' ? (options.text ?? 'hello') : (options.pick ?? null)) },
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
  assert.equal(await run(t, voice, { pick: '9' }), 'Said it.');
  assert.equal(asked[0].speaker, 800);
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
