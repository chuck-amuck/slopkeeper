import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAudioPlayer, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { PermissionFlagsBits } from 'discord.js';
import { loopVoice } from '../src/features/health.ts';
import { cantJoin } from '../src/features/voiceAudio.ts';
import * as perf from '../src/perf.ts';
import { CONNECT_TIMEOUT_MS, join, loopVoiceTotals, RECONNECT_TIMEOUT_MS, voiceProblem } from '../src/voiceJoin.ts';

// Discord isn't there, so a connection gets ready only when the test says so
const networking = { state: {}, on() {}, off() {}, prepareAudioPacket() {}, dispatchAudio: () => true, setSpeaking() {}, destroy() {} };
const ready = (guildId: string) => {
  const c = getVoiceConnection(guildId)!;
  c.state = { ...c.state, status: VoiceConnectionStatus.Ready, networking } as never;
};

let next = 0;
function channel({ missing = [] as bigint[], joinable = true } = {}) {
  const sent: string[] = [];
  const guild = {
    id: `join-${next++}`,
    name: 'Server',
    members: { me: {} },
    voiceAdapterCreator: () => ({ sendPayload: (p: { d: { channel_id: string | null } }) => sent.push(String(p.d.channel_id)) > 0, destroy() {} }),
  };
  const make = (id: string) => ({ id, name: `room-${id}`, guild, joinable, permissionsFor: () => ({ has: (flag: bigint) => !missing.includes(flag) }), toString: () => `<#${id}>` }) as never;
  return { guild, sent, room: make('a'), other: make('b') };
}

test('both bots see the same problems with a channel, each in its own words', () => {
  assert.equal(voiceProblem(channel().room), null);
  assert.deepEqual(voiceProblem(channel({ missing: [PermissionFlagsBits.Speak, PermissionFlagsBits.Connect] }).room), { missing: ['Connect', 'Speak'] });
  assert.equal(voiceProblem(channel({ joinable: false }).room), 'full');
  assert.match(cantJoin(channel({ missing: [PermissionFlagsBits.Speak] }).room)!, /give my role \*\*Speak\*\*/);
  assert.match(cantJoin(channel({ joinable: false }).room)!, /it’s full/);
});

test('a join that never gets ready gives up, cleans up and is counted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = t.mock.method(console, 'error', () => {});
  const { guild, room } = channel();
  const failures = () => perf.counterValue('voice_connect_failures_total', { bot: 'loop' });
  const before = failures();
  const joining = join(room, createAudioPlayer(), { bot: 'loop' });
  t.mock.timers.tick(CONNECT_TIMEOUT_MS);
  assert.equal(await joining, null);
  assert.equal(getVoiceConnection(guild.id), undefined, 'so the next try starts clean');
  assert.equal(failures(), before + 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /timed out/);
});

test('joining the same channel again reuses the connection, and another one moves it', async () => {
  const { guild, sent, room, other } = channel();
  const player = createAudioPlayer();
  const first = join(room, player);
  ready(guild.id);
  assert.deepEqual(await first, { fresh: true });
  const connection = getVoiceConnection(guild.id);
  assert.deepEqual(await join(room, player), { fresh: false });
  assert.equal(sent.length, 1, 'nothing sent to Discord the second time');
  const moving = join(other, player);
  ready(guild.id);
  assert.deepEqual(await moving, { fresh: true });
  assert.equal(getVoiceConnection(guild.id), connection, 'the same connection, moved');
  assert.equal(sent.at(-1), 'b');
  connection!.destroy();
});

test('a drop that comes back by itself carries on, and one that doesn’t is cleaned up and reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { guild, room } = channel();
  let lost = 0;
  const joining = join(room, createAudioPlayer(), { onLost: () => lost++ });
  ready(guild.id);
  await joining;
  const connection = getVoiceConnection(guild.id)!;
  const drops = perf.counterValue('voice_disconnects_total');
  // The connection's own adapter goes along with each state, as Discord's library expects
  const { adapter } = connection.state as unknown as { adapter: unknown };
  const status = () => (connection.state as { status: VoiceConnectionStatus }).status;
  const dropped = () => (connection.state = { status: VoiceConnectionStatus.Disconnected, reason: 0, closeCode: 4014, adapter } as never);

  // Moved by someone: Discord sends it on, and it's connecting again straight away
  dropped();
  connection.state = { status: VoiceConnectionStatus.Connecting, adapter, networking } as never;
  await sleep(0);
  t.mock.timers.tick(RECONNECT_TIMEOUT_MS);
  await sleep(0);
  assert.equal(lost, 0);
  assert.notEqual(status(), VoiceConnectionStatus.Destroyed);

  // Kicked: nothing comes back
  dropped();
  t.mock.timers.tick(RECONNECT_TIMEOUT_MS);
  await sleep(0);
  await sleep(0);
  assert.equal(lost, 1);
  assert.equal(status(), VoiceConnectionStatus.Destroyed);
  assert.equal(perf.counterValue('voice_disconnects_total'), drops + 2);
});

test('a drop that was left on purpose while it waited doesn’t stop what came after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { guild, room } = channel();
  let lost = 0;
  const joining = join(room, createAudioPlayer(), { onLost: () => lost++ });
  ready(guild.id);
  await joining;
  const connection = getVoiceConnection(guild.id)!;
  const { adapter } = connection.state as unknown as { adapter: unknown };
  connection.state = { status: VoiceConnectionStatus.Disconnected, reason: 0, closeCode: 4014, adapter } as never;
  // Told to stop, and back in the room on a new connection, before the old one's wait ran out
  connection.destroy();
  const again = join(room, createAudioPlayer(), { onLost: () => lost++ });
  ready(guild.id);
  await again;
  t.mock.timers.tick(RECONNECT_TIMEOUT_MS);
  await sleep(0);
  await sleep(0);
  assert.equal(lost, 0);
  const now = getVoiceConnection(guild.id)!;
  assert.notEqual(now, connection);
  assert.equal((now.state as { status: VoiceConnectionStatus }).status, VoiceConnectionStatus.Ready);
  now.destroy();
});

test('the loop bot’s voice troubles reach the health numbers once each, across either bot restarting', () => {
  const total = (name: 'voice_connect_failures_total' | 'voice_disconnects_total') => perf.counterValue(name, { bot: 'loop' });
  const start = { failures: total('voice_connect_failures_total'), drops: total('voice_disconnects_total') };
  const added = () => [total('voice_connect_failures_total') - start.failures, total('voice_disconnects_total') - start.drops];
  // A loop bot this one hasn't heard from: everything since it started is new
  loopVoice({ startedAt: 1000, connectFailures: 2, disconnects: 1 });
  assert.deepEqual(added(), [2, 1]);
  loopVoice({ startedAt: 1000, connectFailures: 3, disconnects: 1 });
  loopVoice({ startedAt: 1000, connectFailures: 3, disconnects: 1 });
  assert.deepEqual(added(), [3, 1]);
  // One answer missing a total, or with a bad one, doesn't count it again afterwards
  loopVoice({ startedAt: 1000, connectFailures: 3 });
  loopVoice({ startedAt: 1000, connectFailures: 'lots', disconnects: 1 });
  loopVoice({ startedAt: 1000, connectFailures: 3, disconnects: 1 });
  assert.deepEqual(added(), [3, 1]);
  // Restarted, and dropped three times since: all three count, though the total's higher than before
  loopVoice({ startedAt: 2000, connectFailures: 0, disconnects: 3 });
  assert.deepEqual(added(), [3, 4]);
  // This bot restarting forgets nothing it kept, so the same totals aren't counted again
  loopVoice({ startedAt: 2000, connectFailures: 0, disconnects: 3 });
  assert.deepEqual(added(), [3, 4]);
  loopVoice(undefined);
  loopVoice({ connectFailures: 9 });
  assert.deepEqual(added(), [3, 4]);
});

test('the loop bot sends its voice counts with when it started', () => {
  const totals = loopVoiceTotals();
  assert.ok(totals.startedAt <= Date.now());
  assert.deepEqual(Object.keys(totals).sort(), ['connectFailures', 'disconnects', 'startedAt']);
});
