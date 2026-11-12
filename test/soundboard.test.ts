import './helpers.ts';
import { getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import { db } from '../src/db.ts';
import { link } from '../src/discordSounds.ts';
import { recentActivity } from '../src/activity.ts';
import { cantJoin, leaveIfAlone, onPlaybackStop, play } from '../src/features/voiceAudio.ts';
import { dropMissingEmoji, recordDiscordPlay, listSounds, saveUpload, soundGain } from '../src/features/soundLibrary.ts';
import { joinSounds, playJoinSound, setJoinSound } from '../src/features/joinSounds.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { Mixer } from '../src/mixer.ts';
import { setSetting } from '../src/settings.ts';

/** A voice channel that never answers, like one the bot gets no reply from */
function channel(guildId: string, options: { missing?: bigint[]; joinable?: boolean } = {}) {
  return {
    id: 'voice',
    name: 'General',
    joinable: options.joinable ?? true,
    toString: () => '#General',
    permissionsFor: () => ({ has: (flag: bigint) => !options.missing?.includes(flag) }),
    guild: {
      id: guildId,
      name: 'Server',
      members: { me: {} },
      voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
    },
  } as never;
}

test('names the permissions the bot is missing', () => {
  const problem = cantJoin(channel('g', { missing: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] }));
  assert.match(problem!, /View Channel/);
  assert.match(problem!, /Connect/);
  assert.doesNotMatch(problem!, /Speak/);
});

test('says when a channel is full', () => {
  assert.match(cantJoin(channel('g', { joinable: false }))!, /full/);
  assert.equal(cantJoin(channel('g')), null);
});

test('refuses straight away instead of waiting on a channel it can’t join', async () => {
  const problem = await play(channel('blocked', { missing: [PermissionFlagsBits.Connect] }), 'x.wav');
  assert.match(problem!, /Connect/);
  assert.equal(getVoiceConnection('blocked'), undefined);
});

test('a join that times out reports it and doesn’t leave a stuck connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const clicks = [play(channel('timeout'), 'x.wav'), play(channel('timeout'), 'x.wav')];
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(getVoiceConnection('timeout'));
  t.mock.timers.tick(15_000);
  for (const problem of await Promise.all(clicks)) assert.match(problem!, /couldn’t connect/);
  assert.equal(getVoiceConnection('timeout'), undefined);
  assert.equal(errors.mock.callCount(), 2);
  errors.mock.restore();
});

test('a voice network error is logged, not thrown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const click = play(channel('neterror'), 'x.wav');
  const connection = getVoiceConnection('neterror')!;
  assert.doesNotThrow(() => connection.emit('error', new Error('socket hang up')));
  assert.equal(errors.mock.callCount(), 1);
  t.mock.timers.tick(15_000);
  await click;
  errors.mock.restore();
});

test('a connection disconnected by someone is cleared up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const click = play(channel('kicked'), 'x.wav');
  const connection = getVoiceConnection('kicked')!;
  // What the library does when Discord closes the connection because the bot was disconnected
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Disconnected, reason: 0, closeCode: 4014 } });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(getVoiceConnection('kicked'), undefined);
  t.mock.timers.tick(15_000);
  await click;
  errors.mock.restore();
});

test('leaves as soon as the last person has gone, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const click = play(channel('alone'), 'x.wav');
  const members = new Map([['u', { user: { bot: false } }], ['bot', { user: { bot: true } }]]);
  const voice = { isVoiceBased: () => true, members };
  const guild = { id: 'alone', channels: { cache: new Map([['voice', voice]]) } } as never;

  leaveIfAlone(guild);
  assert.ok(getVoiceConnection('alone'));
  members.delete('u');
  leaveIfAlone(guild);
  assert.equal(getVoiceConnection('alone'), undefined);

  t.mock.timers.tick(15_000);
  await click;
  errors.mock.restore();
});

test('leaves voice when the bot shuts down', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  const click = play(channel('stopping'), 'x.wav');
  assert.ok(getVoiceConnection('stopping'));
  soundboard.shutdown!();
  assert.equal(getVoiceConnection('stopping'), undefined);
  t.mock.timers.tick(15_000);
  await click;
  errors.mock.restore();
});

test('clears custom emoji the server no longer has', () => {
  const add = db.prepare(`INSERT INTO sound_emoji (guild_id, name, emoji) VALUES ('emoji', ?, ?)`);
  add.run('kept', '<:kept:11111111111111111>');
  add.run('deleted', '<:gone:22222222222222222>');
  add.run('plain', '📯');
  const guild = { id: 'emoji', emojis: { cache: new Map([['11111111111111111', {}]]) } } as never;
  assert.equal(dropMissingEmoji(guild), true);
  const left = db.prepare(`SELECT name FROM sound_emoji WHERE guild_id = 'emoji' ORDER BY name`).all() as { name: string }[];
  assert.deepEqual(left.map((r) => r.name), ['kept', 'plain']);
  assert.equal(dropMissingEmoji(guild), false);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = () => path.join(process.env.DATA_DIR!, 'sounds', 'uploads');
const audio = () => {
  const file = path.join(process.env.DATA_DIR!, 'tone.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', file]);
  return readFileSync(file);
};

test('a file that isn’t audio is turned down, and keeps the sound it would have replaced', { skip: !hasFfmpeg }, async () => {
  assert.equal(await saveUpload('uploads', 'horn', '.wav', audio()), true);
  assert.equal(await saveUpload('uploads', 'horn', '.mp3', Buffer.from('this is not audio')), false);
  assert.deepEqual(readdirSync(dir()), ['horn.wav']);
});

test('replacing a sound with another format leaves only the new file', { skip: !hasFfmpeg }, async () => {
  assert.equal(await saveUpload('uploads', 'bell', '.wav', audio()), true);
  assert.equal(await saveUpload('uploads', 'bell', '.ogg', audio()), true);
  assert.equal(existsSync(path.join(dir(), 'bell.wav')), false);
  assert.equal(existsSync(path.join(dir(), 'bell.ogg')), true);
});

test('a sound played from Discord’s own soundboard counts, under its library name if it’s a copy, but not the bot’s or other bots’', () => {
  const guild = {
    id: 'discord-plays',
    client: { user: { id: 'the-bot' } },
    members: { cache: new Map([['ana', { user: { bot: false } }], ['robot', { user: { bot: true } }]]) },
    soundboardSounds: { cache: new Map([['s-horn', { name: 'horn' }], ['s-theirs', { name: 'Big Bell' }]]) },
  } as never;
  link('discord-plays', 'airhorn', 's-horn');
  recordDiscordPlay(guild, 'ana', 's-horn');
  recordDiscordPlay(guild, 'ana', 's-theirs');
  // One of Discord's built-in sounds, which has no name here
  recordDiscordPlay(guild, 'ana', '3');
  recordDiscordPlay(guild, 'robot', 's-horn');
  recordDiscordPlay(guild, 'the-bot', 's-horn');
  const rows = db.prepare(`SELECT user_id, name FROM sound_plays WHERE guild_id = 'discord-plays' ORDER BY rowid`).all() as { user_id: string; name: string }[];
  assert.deepEqual(rows.map((r) => `${r.user_id}:${r.name}`), ['ana:airhorn', 'ana:Big Bell']);
});

test('plays are counted for the recap, whether from a panel or /sound play, and failures aren’t', { skip: !hasFfmpeg }, async (t) => {
  // The audio loop and the leave-when-idle timer would otherwise keep the test process going
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = mock.method(console, 'error', () => {});
  assert.equal(await saveUpload('counted', 'horn', '.wav', audio()), true);
  const voice = channel('counted');
  const connection = joinVoiceChannel({ channelId: 'voice', guildId: 'counted', adapterCreator: (voice as { guild: { voiceAdapterCreator: never } }).guild.voiceAdapterCreator });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });

  const plays = () => (db.prepare(`SELECT user_id, name FROM sound_plays WHERE guild_id = 'counted'`).all() as { user_id: string; name: string }[]).map((r) => `${r.user_id}:${r.name}`);
  const shared = { inCachedGuild: () => true, guildId: 'counted', channelId: 'text', message: { id: 'panel' }, member: { voice: { channel: voice } } };
  const click = (user: string, member = shared.member) =>
    soundboard.onButton!({ ...shared, member, customId: 'sb:horn', user: { id: user }, deferUpdate: async () => {}, followUp: async () => {} } as never);

  const type = (user: string, member = shared.member) =>
    soundboard.commands![0].run({
      ...shared,
      member,
      user: { id: user },
      options: { getSubcommand: () => 'play', getString: () => 'horn' },
      deferReply: async () => {},
      editReply: async () => {},
    } as never);
  // After the test, pass or fail, so a failure doesn't leave audio running and hang the run
  t.after(async () => {
    await soundboard.onButton!({ ...shared, customId: 'sb:#stop', user: { id: 'clicker' }, deferUpdate: async () => {} } as never);
    soundboard.shutdown!();
    errors.mock.restore();
  });

  await click('clicker');
  await type('typer');
  assert.deepEqual(plays(), ['clicker:horn', 'typer:horn']);

  const blocked = { voice: { channel: channel('counted', { missing: [PermissionFlagsBits.Connect] }) } };
  await click('blocked', blocked);
  await type('blocked', blocked);
  assert.deepEqual(plays(), ['clicker:horn', 'typer:horn']);
});

/** A server with a sound called horn, which is someone's join sound. Nothing answers the bot, so a play never finishes: whether it started is the thing to check */
async function joiner(t: { after(fn: () => void): void }, guildId: string) {
  await saveUpload(guildId, 'horn', '.wav', wav());
  setJoinSound(guildId, 'person', 'horn');
  setSetting(guildId, 'joinSoundDelayMs', 0);
  const voice = channel(guildId) as any;
  voice.guild.afkChannelId = 'afk';
  voice.guild.voiceStates = { cache: new Map([['person', { channelId: 'voice' }]]) };
  t.after(() => getVoiceConnection(guildId)?.destroy());
  const state = (channelId: string | null, bot = false) => ({ id: 'person', channelId, channel: channelId ? { ...voice, id: channelId } : null, guild: voice.guild, member: { user: { bot } } }) as never;
  /** Whether this change of voice state makes the bot head for a channel, and which */
  const headsFor = async (from: string | null, to: string | null, bot = false) => {
    void playJoinSound(state(from, bot), state(to, bot));
    await new Promise((resolve) => setImmediate(resolve));
    const connection = getVoiceConnection(guildId);
    const target = connection?.joinConfig.channelId ?? null;
    connection?.destroy();
    return target;
  };
  return { headsFor, state, here: voice.guild.voiceStates.cache as Map<string, { channelId: string }> };
}

function wav() {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-f', 'wav', 'pipe:1']);
}

test('joining voice plays your join sound', async (t) => {
  const { headsFor } = await joiner(t, 'join-plays');
  assert.equal(await headsFor(null, 'voice'), 'voice');
});

for (const [what, from, to, bot] of [
  ['switching channels', 'voice', 'other', false],
  ['muting', 'voice', 'voice', false],
  ['leaving', 'voice', null, false],
  ['the AFK channel', null, 'afk', false],
  ['a bot joining', null, 'voice', true],
] as const) {
  test(`${what} doesn’t play it`, async (t) => {
    const { headsFor } = await joiner(t, `join-not-${what.replaceAll(' ', '-')}`);
    assert.equal(await headsFor(from, to, bot), null);
  });
}

test('nothing plays with join sounds turned off', async (t) => {
  const { headsFor } = await joiner(t, 'join-off');
  setSetting('join-off', 'joinSounds', false);
  assert.equal(await headsFor(null, 'voice'), null);
  setSetting('join-off', 'joinSounds', true);
  assert.equal(await headsFor(null, 'voice'), 'voice');
});

test('nothing plays for someone without a join sound', async (t) => {
  const { headsFor } = await joiner(t, 'join-none');
  setJoinSound('join-none', 'person', null);
  assert.equal(await headsFor(null, 'voice'), null);
});

test('the cooldown stops hopping in and out from spamming it', async (t) => {
  const { headsFor } = await joiner(t, 'join-cooldown');
  assert.equal(await headsFor(null, 'voice'), 'voice');
  assert.equal(await headsFor(null, 'voice'), null);
});

test('a cooldown of zero means every time', async (t) => {
  const { headsFor } = await joiner(t, 'join-always');
  setSetting('join-always', 'joinSoundCooldownMin', 0);
  assert.equal(await headsFor(null, 'voice'), 'voice');
  assert.equal(await headsFor(null, 'voice'), 'voice');
});

test('it won’t pull the bot away from another channel', async (t) => {
  const { headsFor } = await joiner(t, 'join-busy');
  // Discord is what moves the bot, so what counts is whether it gets asked to
  const asked: (string | null)[] = [];
  const sendPayload = (payload: any) => {
    asked.push(payload.d.channel_id);
    return true;
  };
  joinVoiceChannel({ channelId: 'elsewhere', guildId: 'join-busy', adapterCreator: () => ({ sendPayload, destroy() {} }) });
  await headsFor(null, 'voice');
  assert.equal(asked.includes('voice'), false, String(asked));
  assert.ok(asked.includes('elsewhere'));
});

test('it plays if the bot is already in that channel', async (t) => {
  const { headsFor } = await joiner(t, 'join-same');
  joinVoiceChannel({ channelId: 'voice', guildId: 'join-same', adapterCreator: () => ({ sendPayload: () => true, destroy() {} }) });
  const spawned = mock.method(console, 'error', () => {});
  assert.equal(await headsFor(null, 'voice'), 'voice');
  spawned.mock.restore();
  assert.equal(await headsFor(null, 'voice'), null, 'the first one counted towards the cooldown');
});

/** Starts a join with a delay, once `person` is in voice, and returns how to finish connecting and what's been played */
async function delayedJoin(t: TestContext, guildId: string, ms: number) {
  const { state, here, headsFor } = await joiner(t, guildId);
  const added = t.mock.method(Mixer.prototype, 'add', () => {});
  setSetting(guildId, 'joinSoundDelayMs', ms);
  const finished = playJoinSound(state(null), state('voice'));
  await new Promise((resolve) => setImmediate(resolve));
  const connected = () => {
    const connection = getVoiceConnection(guildId)!;
    connection.state = { ...connection.state, status: VoiceConnectionStatus.Ready } as never;
  };
  return { finished, connected, played: () => added.mock.callCount(), here, headsFor, state };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the bot connects straight away, and the delay starts once it has', async (t) => {
  const { finished, connected, played } = await delayedJoin(t, 'join-delay', 30);
  assert.equal(getVoiceConnection('join-delay')?.joinConfig.channelId, 'voice', 'it joined without waiting');
  await pause(60);
  assert.equal(played(), 0, 'still connecting, so the delay hasn’t begun');
  connected();
  await pause(5);
  assert.equal(played(), 0, 'connected, and waiting');
  await finished;
  assert.equal(played(), 1);
});

test('a sound plays right after connecting when there’s no delay', async (t) => {
  const { finished, connected, played } = await delayedJoin(t, 'join-now', 0);
  assert.equal(played(), 0);
  connected();
  await finished;
  assert.equal(played(), 1);
});

test('leaving during the delay plays nothing, and doesn’t use up the cooldown', async (t) => {
  const { finished, connected, played, here, state } = await delayedJoin(t, 'join-left', 10);
  connected();
  here.delete('person');
  await finished;
  assert.equal(played(), 0);
  setSetting('join-left', 'joinSoundDelayMs', 0);
  here.set('person', { channelId: 'voice' });
  await playJoinSound(state(null), state('voice'));
  assert.equal(played(), 1);
});

test('moving to another channel during the delay plays nothing', async (t) => {
  const { finished, connected, played, here } = await delayedJoin(t, 'join-moved', 10);
  connected();
  here.set('person', { channelId: 'other' });
  await finished;
  assert.equal(played(), 0);
});

test('a bot sent elsewhere during the delay doesn’t play there', async (t) => {
  const { finished, connected, played } = await delayedJoin(t, 'join-taken', 10);
  connected();
  getVoiceConnection('join-taken')!.joinConfig.channelId = 'elsewhere';
  await finished;
  assert.equal(played(), 0);
});

test('joining twice before it plays plays once', async (t) => {
  const { finished, connected, played, state } = await delayedJoin(t, 'join-twice', 10);
  await playJoinSound(state(null), state('voice'));
  connected();
  await finished;
  assert.equal(played(), 1);
});

test('the bot doesn’t stay forever after a sound it never played', async (t) => {
  const { finished, connected, here } = await delayedJoin(t, 'join-idle', 10);
  const timers = t.mock.method(globalThis, 'setTimeout');
  connected();
  here.delete('person');
  await finished;
  assert.ok(timers.mock.calls.some((c) => c.arguments[1] === 5 * 60_000), 'the idle timer is running');
});

/** Runs a /sound subcommand and returns what it replied */
async function slash(guildId: string, sub: string, values: Record<string, unknown>) {
  let reply: any;
  const answer = async (r: unknown) => void (reply = r);
  await soundboard.commands![0].run({
    inCachedGuild: () => true,
    guildId,
    guild: { id: guildId },
    user: { id: 'person' },
    options: { getSubcommand: () => sub, getString: (name: string) => values[name] ?? null, getInteger: (name: string) => values[name] ?? null },
    reply: answer,
    deferReply: async () => {},
    editReply: answer,
  } as never);
  return (reply.content ?? reply) as string;
}

/** Runs /sound add as someone allowed to change sounds, and returns what it replied */
async function slashAdd(guildId: string, name: string) {
  let reply: any;
  const answer = async (r: unknown) => void (reply = r);
  await soundboard.commands![0].run({
    inCachedGuild: () => true,
    guildId,
    guild: { id: guildId },
    user: { id: 'person' },
    options: { getSubcommand: () => 'add', getString: (key: string) => (key === 'name' ? name : null), getAttachment: () => ({ name: 'new.mp3', size: 100, url: 'http://files/new.mp3' }) },
    reply: answer,
    deferReply: async () => {},
    editReply: answer,
  } as never);
  return reply;
}

/** Presses a button on what /sound add asked, and returns everything said after */
async function answerAdd(guildId: string, customId: string) {
  const said: { update: any[]; followUp: any[]; deleted: boolean } = { update: [], followUp: [], deleted: false };
  await soundboard.onButton!({
    customId,
    inCachedGuild: () => true,
    guildId,
    guild: { id: guildId },
    user: { id: 'person' },
    client: { channels: { cache: new Map(), fetch: async () => null } },
    update: async (r: unknown) => void said.update.push(r),
    followUp: async (r: unknown) => void said.followUp.push(r),
    deleteReply: async () => void (said.deleted = true),
  } as never);
  return said;
}

test('/sound add asks before replacing a sound, and can keep both or leave it be', { skip: !hasFfmpeg }, async (t) => {
  const guild = 'slash-ask';
  await saveUpload(guild, 'horn', '.wav', wav());
  // Not audio, so nothing goes near Discord's soundboard and the sound it would replace is kept
  t.mock.method(globalThis, 'fetch', async () => new Response('not audio'));

  const asked = await slashAdd(guild, 'horn');
  assert.match(asked.content, /already a sound called \*\*horn\*\*.*\*\*horn-2\*\*/);
  assert.equal(asked.flags, MessageFlags.Ephemeral);
  const ids = asked.components[0].toJSON().components.map((c: { custom_id: string }) => c.custom_id);
  assert.deepEqual(ids.map((id: string) => id.split(':').at(-1)), ['replace', 'keep', 'cancel']);

  const cancelled = await answerAdd(guild, ids[2]);
  assert.deepEqual(cancelled.update, [{ content: 'Left **horn** as it was.', components: [] }]);
  assert.equal((await answerAdd(guild, ids[1])).update[0].content, 'That upload timed out. Run /sound add again.');

  const keepId = (await slashAdd(guild, 'horn')).components[0].toJSON().components[1].custom_id;
  const kept = await answerAdd(guild, keepId);
  assert.equal(kept.update[0].content, 'Adding it…');
  assert.match(kept.followUp[0], /\*\*new\.mp3\*\* doesn’t have any audio/);
  assert.equal(kept.deleted, true);
  assert.deepEqual(listSounds(guild).map((s) => s.name), ['horn']);

  // A new name doesn't ask
  assert.match(await slashAdd(guild, 'bell'), /new\.mp3\*\* doesn’t have any audio/);
});

test('Stop on a panel stops sounds and speech but leaves the music playing', async () => {
  const heard: [string, boolean][] = [];
  onPlaybackStop((guildId, keepMusic) => void heard.push([guildId, keepMusic]));
  await soundboard.onButton!({
    customId: 'sb:#stop',
    inCachedGuild: () => true,
    guildId: 'panel-stop',
    channelId: 'text',
    message: { id: 'panel-stop-msg' },
    deferUpdate: async () => {},
  } as never);
  assert.deepEqual(heard.filter(([id]) => id === 'panel-stop'), [['panel-stop', true]]);
});

test('/sound join sets, changes and clears your own join sound, and it’s recorded', async () => {
  await saveUpload('slash-join', 'horn', '.wav', wav());
  assert.match(await slash('slash-join', 'join', { name: 'horn' }), /horn\*\* plays when you join/);
  assert.deepEqual(joinSounds('slash-join').map((r) => [r.user_id, r.name]), [['person', 'horn']]);
  assert.match(await slash('slash-join', 'join', { name: 'nope' }), /No sound by that name/);
  assert.deepEqual(joinSounds('slash-join').map((r) => [r.user_id, r.name]), [['person', 'horn']]);
  assert.match(await slash('slash-join', 'join', {}), /don’t have a join sound/);
  assert.deepEqual(joinSounds('slash-join'), []);
  assert.deepEqual(recentActivity('slash-join', 5).map((r) => [r.actor, r.action]), [['person', 'Cleared their join sound'], ['person', 'Set their join sound to **horn**']]);
});

test('/sound join says when the server has them turned off', async () => {
  await saveUpload('slash-off', 'horn', '.wav', wav());
  setSetting('slash-off', 'joinSounds', false);
  assert.match(await slash('slash-off', 'join', { name: 'horn' }), /turned off in this server/);
});

test('/sound volume sets one sound’s volume', async () => {
  await saveUpload('slash-volume', 'horn', '.wav', wav());
  assert.match(await slash('slash-volume', 'volume', { name: 'horn', percent: 40 }), /40%/);
  assert.equal(soundGain('slash-volume', 'horn'), 0.4);
  assert.match(await slash('slash-volume', 'volume', { name: 'nope', percent: 40 }), /No sound by that name/);
});

test('/sound remove can be undone with /sound restore', async () => {
  await saveUpload('slash-bin', 'horn', '.wav', wav());
  const guild = 'slash-bin';
  await soundboard.commands![0].run({
    inCachedGuild: () => true,
    guildId: guild,
    guild: { id: guild },
    client: { channels: { cache: new Map() } },
    user: { id: 'person' },
    options: { getSubcommand: () => 'remove', getString: () => 'horn' },
    deferReply: async () => {},
    editReply: async (r: string) => assert.match(r, /within 30 days with `\/sound restore`/),
  } as never);
  let offered: { name: string; value: string }[] = [];
  await soundboard.commands![0].autocomplete!({ guildId: guild, options: { getFocused: () => 'ho', getSubcommand: () => 'restore' }, respond: async (r: typeof offered) => (offered = r) } as never);
  assert.equal(offered[0].name, 'horn');

  const restored = async (value: string) => {
    let reply = '';
    await soundboard.commands![0].run({
      inCachedGuild: () => true,
      guildId: guild,
      guild: { id: guild },
      client: { channels: { cache: new Map() } },
      user: { id: 'person' },
      options: { getSubcommand: () => 'restore', getString: () => value },
      reply: async (r: string | { content: string }) => void (reply = typeof r === 'string' ? r : r.content),
    } as never);
    return reply;
  };
  assert.match(await restored('nope'), /No deleted sound/);
  assert.match(await restored(offered[0].value), /Restored \*\*horn\*\*\./);
  assert.match(await restored(offered[0].value), /No deleted sound/);
  assert.ok(existsSync(path.join(process.env.DATA_DIR!, 'sounds', guild, 'horn.wav')));
  assert.equal(recentActivity(guild, 1)[0].action, 'Restored sound **horn**');
});

test('with a sound managers role, /sound only lets others play, stop, set a join sound and post a panel', async () => {
  const guild = 'slash-managers';
  await saveUpload(guild, 'horn', '.wav', wav());
  setSetting(guild, 'soundManagerRole', 'managers');
  const run = async (sub: string, roles: string[], admin = false) => {
    let reply: any;
    const answer = async (r: unknown) => void (reply = r);
    await soundboard.commands![0].run({
      inCachedGuild: () => true,
      guildId: guild,
      guild: { id: guild },
      channel: { isSendable: () => false },
      client: { channels: { cache: new Map(), fetch: async () => null } },
      user: { id: 'person' },
      member: { voice: { channel: null }, roles: { cache: new Set(roles) } },
      memberPermissions: { has: (flag: bigint) => admin && flag === PermissionFlagsBits.ManageGuild },
      options: { getSubcommand: () => sub, getString: () => 'horn', getInteger: () => 100, getAttachment: () => ({ name: 'x.wav', size: 1, url: 'http://x' }) },
      reply: answer,
      deferReply: async () => {},
      editReply: answer,
    } as never).catch(() => {});
    return String(reply?.content ?? reply);
  };
  const LOCKED = /Only <@&managers> and people with \*\*Manage Server\*\* can change sounds/;
  for (const sub of ['add', 'emoji', 'remove', 'restore', 'volume', 'discord-add', 'discord-remove', 'discord-sync']) assert.match(await run(sub, []), LOCKED, sub);
  assert.ok(existsSync(path.join(process.env.DATA_DIR!, 'sounds', guild, 'horn.wav')), 'nothing was deleted');
  for (const sub of ['play', 'stop', 'join']) assert.doesNotMatch(await run(sub, []), LOCKED, sub);
  assert.doesNotMatch(await run('volume', ['managers']), LOCKED);
  assert.doesNotMatch(await run('emoji', [], true), LOCKED);
});
