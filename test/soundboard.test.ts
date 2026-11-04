import './helpers.ts';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { cantJoin, dropMissingEmoji, leaveIfAlone, play, saveUpload, soundboard } from '../src/features/soundboard.ts';

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
