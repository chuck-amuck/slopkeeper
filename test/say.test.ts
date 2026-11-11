import './helpers.ts';
import assert from 'node:assert/strict';
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
import { announceAloud, lengthFor, phrases, readMessage, removePhrase, savePhrase, say, sayOut, speak, speechFor } from '../src/features/say.ts';
import { loopSpeechProblem, playJoinSound, saveUpload, setJoinSound, soundboard, stopPlayback } from '../src/features/soundboard.ts';
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

speak.setup!({ on() {} } as never);
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
  assert.deepEqual(asked, [{ text: 'hello there', speaker: 400, length: lengthFor(85) }, { text: 'and again', speaker: 0, length: lengthFor(85) }]);
  const lines = recentActivity(voice.guild.id, 5).map((r) => `${r.actor}: ${r.action}`).toReversed();
  assert.deepEqual(lines, ['ana: Said “hello there” in <#voice>', 'ben: Said “and again” in <#voice>']);
  assert.deepEqual(leftovers(), []);
});

test('the racer, GLaDOS and HAL ask for their own model, delivery and speed, and the racer’s effect runs', { skip: !hasFfmpeg }, async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(readFileSync(speechFile));
  });
  const voice = channel();
  for (const id of ['racer', 'glados', 'hal']) {
    assert.equal(await say(voice, 'scrib doon', id, id), null);
    await sleep(300);
  }
  assert.deepEqual(bodies, [
    { text: 'scrib doon', speaker_id: 632, length_scale: lengthFor(85), noise_scale: 0.667, noise_w_scale: 0.6 },
    // Their own curve: 85% speed takes 18% longer, which these models give at 1.25
    { text: 'scrib doon', voice: 'glados', length_scale: 1.25 },
    { text: 'scrib doon', voice: 'hal', length_scale: 1.25 },
  ]);
  assert.deepEqual(leftovers(), []);
});

test('a server’s speed setting changes how long speech takes', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const voice = channel();
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

/** Which voice channels lines went to, and what was said */
function heard(t: TestContext) {
  const asked = fakeVoice(t);
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => onEnd?.());
  return { said: async () => (await sleep(150), asked.map((a) => a.text)) };
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
  for (const content of ['', 'https://example.test/a', '🎉', '||secret||', '```\nconst a = 1;\n```', 'x'.repeat(21)]) await readMessage(message(content));
  await readMessage(message('from a bot', { author: { id: 'b', bot: true } }));
  await readMessage(message('from a webhook', { webhookId: 'w' }));
  await readMessage(message('joined', { system: true }));
  await readMessage(message('in a DM', { inGuild: () => false }));
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
  assert.equal(savePhrase(guild, '  good   game  ', '2'), null);
  assert.deepEqual(phrases(guild.id).map(({ text, voice }) => [text, voice]), [['good game', '2']]);
  assert.equal(savePhrase(guild, 'good game', '9'), null);
  assert.equal(phrases(guild.id).length, 1, 'saving it twice does nothing');
  assert.equal(phrases(other.id).length, 0);
  assert.match(savePhrase(guild, '🎉', '2')!, /nothing in that/);
  assert.match(savePhrase(guild, 'x'.repeat(201), '2')!, /201 characters/);
  assert.match(savePhrase(guild, 'hello', 'nope')!, /Pick a voice/);
  for (let n = 1; n < 25; n++) assert.equal(savePhrase(guild, `line ${n}`, '2'), null);
  assert.match(savePhrase(guild, 'one too many', '2')!, /keep 25 lines/);
  assert.equal(savePhrase(guild, 'good game', '2'), null, 'one already saved isn’t refused for being over');
  const [first] = phrases(guild.id);
  assert.equal(removePhrase(other.id, first.id), false, 'not from another server');
  assert.equal(removePhrase(guild.id, first.id), true);
  assert.equal(removePhrase(guild.id, first.id), false);
  assert.equal(phrases(guild.id).length, 24);
  assert.equal(savePhrase(guild, 'room again', '2'), null);
});

test('/say picks a saved line, with its own voice, under the usual rules', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  t.mock.method(Mixer.prototype, 'add', (_file: string, _gain?: number, onEnd?: () => void) => onEnd?.());
  const voice = channel();
  savePhrase(voice.guild, 'good game', '2');
  const saved = String(phrases(voice.guild.id)[0].id);
  assert.equal(await run(t, voice, { text: null }), 'Type something to say, or pick a saved line.');
  assert.equal(await run(t, voice, { text: null, saved: 'something typed' }), 'Pick a saved line from the list.');
  assert.equal(await run(t, voice, { text: null, saved }), 'Said it.');
  assert.equal(await run(t, voice, { text: null, saved, pick: '9' }), 'Said it.');
  assert.equal(await run(t, voice, { text: 'typed wins', saved }), 'Said it.');
  await sleep(200);
  assert.deepEqual(asked.map((a) => [a.text, a.speaker]), [['good game', 100], ['good game', 800], ['typed wins', 400]]);
  setSetting(voice.guild.id, 'ttsCooldownSec', 3600);
  await run(t, voice, { text: null, saved });
  assert.match(await run(t, voice, { text: null, saved }), /^Wait /);
  assert.ok(recentActivity(voice.guild.id, 5).some((r) => r.action.includes('Said “good game”')));
});

test('/say suggests saved lines as you type', async () => {
  const voice = channel();
  savePhrase(voice.guild, 'Good game', '2');
  savePhrase(voice.guild, 'gotta go', '2');
  savePhrase(voice.guild, 'y'.repeat(150), '2');
  const suggest = async (typed: string, guildId: string | null = voice.guild.id) => {
    let answer: { name: string; value: string }[] = [];
    await speak.commands![0].autocomplete!({ guildId, options: { getFocused: () => typed }, respond: async (a: typeof answer) => (answer = a) } as never);
    return answer;
  };
  assert.deepEqual((await suggest('GOOD')).map((a) => a.name), ['Good game']);
  assert.equal((await suggest('')).length, 3);
  assert.equal((await suggest('yyy'))[0].name.length, 100);
  assert.equal((await suggest('gotta'))[0].value, String(phrases(voice.guild.id)[1].id));
  assert.deepEqual(await suggest('good', null), []);
});

test('the looping room’s speech is made once in its own voice, and remade when the line, voice or speed changes', { skip: !hasFfmpeg }, async (t) => {
  const asked = fakeVoice(t);
  const { guild: server, id } = chat();
  const guild = server as never as import('discord.js').Guild;
  assert.equal(await loopSpeechProblem(guild), null, 'nothing to make without a line');
  setSetting(id, 'loopText', 'stay a while');
  setSetting(id, 'ttsVoice', '2');
  assert.equal(await loopSpeechProblem(guild), null);
  assert.deepEqual(asked.map((a) => [a.text, a.speaker]), [['stay a while', 100]], 'the default voice until one’s picked');
  assert.equal(await loopSpeechProblem(guild), null);
  assert.equal(asked.length, 1, 'made once, then reused');
  setSetting(id, 'loopVoice', '9');
  await loopSpeechProblem(guild);
  setSetting(id, 'ttsSpeed', 120);
  await loopSpeechProblem(guild);
  assert.deepEqual(asked.slice(1).map((a) => a.speaker), [800, 800]);
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
