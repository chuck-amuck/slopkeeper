import './helpers.ts';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { cantJoin, play } from '../src/features/soundboard.ts';

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
