import './helpers.ts';
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import {
  addTracks,
  clearQueue,
  MOST_QUEUED,
  moveTrack,
  music,
  musicState,
  onSpotify,
  pauseMusic,
  queueOf,
  removeTrack,
  resetMusic,
  skipMusic,
  startMusic,
  stopMusic,
  type PlayerStatus,
} from '../src/features/music.ts';
import { soundboard, stopPlayback } from '../src/features/soundboard.ts';
import type { Track } from '../src/spotify.ts';

const RUNNING: PlayerStatus = { state: 'running', message: '', loggedIn: true, account: 'someone', active: false, version: '1.3.10.51', expiresAt: null };

config.musicUrl = 'http://music.test';
config.musicToken = 'music-token';

// The music container: commands are kept, and the audio is a stream the test can end
const commands: Record<string, unknown>[] = [];
let audio: ReadableStreamDefaultController<Uint8Array> | undefined;
let refuseCommands = false;
mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
  assert.ok(url.startsWith('http://music.test/'), `only the music container is asked, not ${url}`);
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer music-token');
  const where = url.slice('http://music.test'.length);
  if (where === '/command') {
    if (refuseCommands) return new Response('{}', { status: 503 });
    commands.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response('{}');
  }
  if (where === '/audio') return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (audio = c) }));
  // Events are fed straight to onSpotify instead
  if (where === '/events') return new Promise<Response>(() => {});
  throw new Error(`unexpected ${where}`);
});

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
function server() {
  const id = `music-${nextGuild++}`;
  accepting.add(id);
  const guild = {
    id,
    name: 'Server',
    members: { me: {}, cache: new Map() },
    roles: { cache: new Map() },
    channels: { cache: new Map() },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  };
  const channel = { id: 'voice', name: 'General', joinable: true, toString: () => '#General', permissionsFor: () => ({ has: () => true }), guild };
  return { id, guild: guild as never as import('discord.js').Guild, channel: channel as never as import('discord.js').VoiceBasedChannel };
}

const CANT_PLAY_MS = 5_000;
const song = (n: number, durationMs = 200_000): Track => ({ uri: `spotify:track:${String(n).padStart(22, '0')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: null, durationMs });
const titles = (guildId: string) => queueOf(guildId).map((r) => r.title);
const sent = (name: string) => commands.filter((c) => c.command === name);
/** Spotify says where it's got to in the song */
const at = (ms: number, speed = 1) => onSpotify({ type: 'position_sync', position: { position_ms: ms, timestamp_ms: Date.now(), speed } });
const changed = (n: number) => onSpotify({ type: 'track_changed', item: { uri: song(n).uri } });

music.setup!({} as never);
beforeEach(() => {
  resetMusic(RUNNING);
  commands.length = 0;
  refuseCommands = false;
});
after(() => {
  clearInterval(discord);
  music.shutdown!();
  soundboard.shutdown!();
});

test('songs go on the end, or after the one playing with play next, and each server has its own queue', async () => {
  const a = server();
  const b = server();
  addTracks(a.id, [song(1), song(2)], 'u1');
  addTracks(b.id, [song(9)], 'u1');
  // Nothing playing yet, so play next goes first
  addTracks(a.id, [song(3)], 'u1', true);
  assert.deepEqual(titles(a.id), ['Song 3', 'Song 1', 'Song 2']);
  assert.equal(await startMusic(a.guild, a.channel), null);
  addTracks(a.id, [song(4), song(5)], 'u1', true);
  assert.deepEqual(titles(a.id), ['Song 3', 'Song 4', 'Song 5', 'Song 1', 'Song 2'], 'after the song playing, in order');
  // Each goes between the song playing and the last one added, which would run out of room without renumbering
  for (let n = 100; n < 160; n++) addTracks(a.id, [song(n)], 'u1', true);
  assert.deepEqual(titles(a.id).slice(0, 4), ['Song 3', 'Song 159', 'Song 158', 'Song 157']);
  assert.deepEqual(titles(a.id).slice(-5), ['Song 100', 'Song 4', 'Song 5', 'Song 1', 'Song 2']);
  assert.deepEqual(titles(b.id), ['Song 9']);
  stopMusic(a.id, 'u1');
});

test('the queue reorders around the song playing, which stays first', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2), song(3), song(4)], 'u1');
  const [first, second, , fourth] = queueOf(id);
  assert.ok(moveTrack(id, fourth.id, 1));
  assert.deepEqual(titles(id), ['Song 1', 'Song 4', 'Song 2', 'Song 3']);
  assert.ok(moveTrack(id, second.id, 0), 'anything can go first before it starts');
  assert.deepEqual(titles(id), ['Song 2', 'Song 1', 'Song 4', 'Song 3']);
  await startMusic(guild, channel);
  assert.equal(moveTrack(id, queueOf(id)[0].id, 2), false, 'the song playing can’t move');
  assert.ok(moveTrack(id, first.id, 0));
  assert.deepEqual(titles(id), ['Song 2', 'Song 1', 'Song 4', 'Song 3'], 'nothing goes above the song playing');
  assert.ok(moveTrack(id, first.id, 99));
  assert.deepEqual(titles(id), ['Song 2', 'Song 4', 'Song 3', 'Song 1']);
  stopMusic(id, 'u1');
});

test('removing and clearing keep the song playing, unless it’s the one removed', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2), song(3), song(4)], 'u1');
  await startMusic(guild, channel);
  assert.ok(await removeTrack(id, queueOf(id)[2].id, 'u2'));
  assert.deepEqual(titles(id), ['Song 1', 'Song 2', 'Song 4']);
  assert.equal(recentActivity(id, 1)[0].action, 'Removed **Song 3** from the music queue');
  commands.length = 0;
  await removeTrack(id, queueOf(id)[0].id, 'u2');
  assert.deepEqual(titles(id), ['Song 2', 'Song 4']);
  assert.deepEqual(sent('play').at(-1), { command: 'play', uri: song(2).uri }, 'removing the song playing skips it');
  clearQueue(id, 'u2');
  assert.deepEqual(titles(id), ['Song 2']);
  assert.equal(await removeTrack(id, 12345, 'u2'), null);
  stopMusic(id, 'u1');
});

test('the queue stops filling at its limit', () => {
  const { id } = server();
  assert.equal(addTracks(id, Array.from({ length: MOST_QUEUED + 5 }, (_, n) => song(n)), 'u1'), MOST_QUEUED);
  assert.equal(addTracks(id, [song(1)], 'u1'), 0);
  clearQueue(id, 'u1');
});

test('playing starts the first song on this speaker, then carries on where it paused', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(commands, [{ command: 'activate' }, { command: 'play', uri: song(1).uri }]);
  assert.equal(musicState(id).phase, 'playing');
  assert.equal(musicState(id).channelId, 'voice');
  assert.equal(pauseMusic(id), null);
  assert.equal(musicState(id).phase, 'paused');
  assert.deepEqual(commands.at(-1), { command: 'pause' });
  await onSpotify({ type: 'playback_changed', status: 'paused' });
  assert.equal(musicState(id).note, null, 'its own pause isn’t mistaken for one from Spotify');
  commands.length = 0;
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(commands, [{ command: 'activate' }, { command: 'play' }], 'resumes rather than starting the song again');
  // Paused and played again before Spotify said it had paused: that late word isn't a pause from Spotify
  pauseMusic(id);
  await startMusic(guild, channel);
  await onSpotify({ type: 'playback_changed', status: 'paused' });
  assert.equal(musicState(id).phase, 'playing');
  stopMusic(id, 'u1');
});

test('the next song is handed over just before the end, and the queue moves on when it starts', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1, 60_000), song(2), song(3)], 'u1');
  await startMusic(guild, channel);
  await at(10_000);
  assert.equal(sent('add_to_queue').length, 0, 'not yet, so the queue can still change');
  await at(46_000);
  await sleep(5);
  assert.deepEqual(sent('add_to_queue'), [{ command: 'add_to_queue', uri: song(2).uri }]);
  await changed(2);
  assert.deepEqual(titles(id), ['Song 2', 'Song 3']);
  assert.equal(sent('play').length, 1, 'Spotify went on by itself, so nothing more is asked');
  stopMusic(id, 'u1');
});

test('a change to the queue after the hand-over still plays what’s next in it', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1, 30_000), song(2)], 'u1');
  await startMusic(guild, channel);
  await at(16_000);
  await sleep(5);
  addTracks(id, [song(3)], 'u1', true);
  await at(29_000);
  await changed(2);
  assert.deepEqual(titles(id), ['Song 3', 'Song 2']);
  assert.deepEqual(sent('play').at(-1), { command: 'play', uri: song(3).uri });
  stopMusic(id, 'u1');
});

test('a song ending hands over the one after it only once that one is near its end', async (t) => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1, 60_000), song(2, 60_000), song(3)], 'u1');
  await startMusic(guild, channel);
  // Long after it started, so the change can't be Spotify refusing the song
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + CANT_PLAY_MS + 1 });
  // Spotify's last word on the song and the next one starting arrive together
  await at(58_000);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:suggestedsuggestedsugge' } });
  await sleep(10);
  assert.deepEqual(titles(id), ['Song 2', 'Song 3']);
  assert.deepEqual(sent('play').at(-1), { command: 'play', uri: song(2).uri });
  assert.deepEqual(sent('add_to_queue'), [], 'song 3 waits for song 2 to near its end');
  await at(46_000);
  await sleep(5);
  assert.deepEqual(sent('add_to_queue'), [{ command: 'add_to_queue', uri: song(3).uri }]);
  stopMusic(id, 'u1');
});

test('the music stops at the end of the queue rather than playing Spotify’s suggestions', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1, 30_000)], 'u1');
  await startMusic(guild, channel);
  await at(28_000);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:suggestedsuggestedsugge' } });
  assert.deepEqual(titles(id), []);
  assert.equal(musicState(id).phase, 'stopped');
  assert.deepEqual(commands.at(-1), { command: 'pause' });
});

test('a song Spotify won’t play is skipped, and one it swaps for another copy is kept', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2), song(3)], 'u1');
  await startMusic(guild, channel);
  // Spotify starts what it was asked for, then drops it for something else
  await changed(1);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:somethingelsesomething', decorations: { identity: { name: 'Thriller' } } } });
  assert.deepEqual(titles(id), ['Song 2', 'Song 3']);
  assert.deepEqual(sent('play').at(-1), { command: 'play', uri: song(2).uri });
  assert.equal(musicState(id).phase, 'playing');
  assert.equal(musicState(id).note, 'Spotify wouldn’t play Song 1, so it was skipped.');
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:anothercopyanothercopy', decorations: { identity: { name: 'Song 2' } } } });
  assert.deepEqual(titles(id), ['Song 2', 'Song 3'], 'the same song under another address is still song 2');
  assert.equal(sent('play').length, 2);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:anothercopyanothercopy' } });
  assert.equal(musicState(id).phase, 'playing');
  stopMusic(id, 'u1');
});

test('a song picked from Spotify’s app, mid-song, pauses and keeps the queue', async (t) => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  // Long enough after the bot asked for its song that this is someone's choice
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10_000 });
  await at(20_000);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:somethingelsesomething' } });
  const state = musicState(id);
  assert.equal(state.phase, 'paused');
  assert.match(state.note!, /started on this speaker from Spotify/);
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  commands.length = 0;
  await startMusic(guild, channel);
  assert.deepEqual(sent('play'), [{ command: 'play', uri: song(1).uri }], 'starts the queue’s song again rather than resuming the other one');
  stopMusic(id, 'u1');
});

test('Spotify pausing, or moving to another speaker, pauses; pausing at the very end moves on', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1, 30_000), song(2), song(3)], 'u1');
  await startMusic(guild, channel);
  await at(5_000);
  await onSpotify({ type: 'playback_changed', status: 'paused' });
  assert.match(musicState(id).note!, /paused from Spotify/);
  await startMusic(guild, channel);
  await onSpotify({ type: 'device_changed', is_active: false });
  assert.match(musicState(id).note!, /another speaker/);
  await startMusic(guild, channel);
  // Spotify pausing at the very end is the song finishing
  await at(29_000);
  await onSpotify({ type: 'playback_changed', status: 'paused' });
  assert.equal(musicState(id).phase, 'playing');
  assert.deepEqual(titles(id), ['Song 2', 'Song 3']);
  stopMusic(id, 'u1');
});

test('skipping plays the next song, or stops after the last', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  assert.equal(await skipMusic(id, 'u3'), null);
  assert.deepEqual(sent('play').at(-1), { command: 'play', uri: song(2).uri });
  assert.equal(recentActivity(id, 1)[0].action, 'Skipped **Song 1**');
  await skipMusic(id, 'u3');
  assert.equal(musicState(id).phase, 'stopped');
  assert.equal(await skipMusic(id, 'u3'), 'Nothing is playing.');
});

test('Stop on the soundboard, or the audio dropping, pauses and keeps the queue', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  stopPlayback(id);
  assert.equal(musicState(id).phase, 'paused');
  assert.equal(musicState(id).note, null);
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  await startMusic(guild, channel);
  audio!.close();
  await sleep(20);
  assert.equal(musicState(id).phase, 'paused');
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  stopMusic(id, 'u1');
});

test('music plays in one server at a time', async () => {
  const a = server();
  const b = server();
  addTracks(a.id, [song(1)], 'u1');
  addTracks(b.id, [song(2)], 'u1');
  await startMusic(a.guild, a.channel);
  assert.match((await startMusic(b.guild, b.channel))!, /another server/);
  assert.equal(musicState(b.id).elsewhere, true);
  pauseMusic(a.id);
  assert.equal(await startMusic(b.guild, b.channel), null, 'paused there, so it can move');
  assert.equal(musicState(a.id).phase, 'stopped');
  assert.deepEqual(titles(a.id), ['Song 1'], 'the first server keeps its queue');
  stopMusic(b.id, 'u1');
  clearQueue(a.id, 'u1');
});

test('says why music can’t play', async () => {
  const { id, guild, channel } = server();
  assert.match((await startMusic(guild, channel))!, /queue is empty/);
  addTracks(id, [song(1)], 'u1');
  resetMusic({ ...RUNNING, loggedIn: false });
  assert.match((await startMusic(guild, channel))!, /isn’t paired/);
  resetMusic({ ...RUNNING, state: 'no-consent' });
  assert.match((await startMusic(guild, channel))!, /SOLOIST_ACCEPT_TERMS/);
  resetMusic(null);
  assert.match((await startMusic(guild, channel))!, /isn’t answering/);
  resetMusic(RUNNING);
  refuseCommands = true;
  const errors = mock.method(console, 'error', () => {});
  assert.match((await startMusic(guild, channel))!, /didn’t start/);
  errors.mock.restore();
  assert.equal(musicState(id).phase, 'paused');
  clearQueue(id, 'u1');
});
