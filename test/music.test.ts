import './helpers.ts';
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test, type TestContext } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { Mixer, type VoiceOptions } from '../src/mixer.ts';
import {
  addTracks,
  clearQueue,
  fileUploadPath,
  MOST_QUEUED,
  moveTrack,
  music,
  musicState,
  onSpotify,
  pauseMusic,
  playFile,
  queueFrom,
  queueOf,
  removeTrack,
  resetMusic,
  seekFile,
  seekMusic,
  skipMusic,
  startMusic,
  stopFile,
  stopMusic,
  type PlayerStatus,
} from '../src/features/music.ts';
import { soundboard, stopPlayback } from '../src/features/soundboard.ts';
import type { Track } from '../src/spotify.ts';

const CANT_PLAY_MS = 5_000;
// yt-dlp works and Spotify playback is off, as it is by default
const RUNNING: PlayerStatus = { state: 'off', message: '', loggedIn: false, account: null, active: false, version: null, expiresAt: null, youtube: { ready: true, version: '2026.10.26', message: '' } };
// Spotify signed in, to play what YouTube doesn't have
const WITH_SPOTIFY: PlayerStatus = { ...RUNNING, state: 'running', loggedIn: true, account: 'someone', version: '1.3.10.51' };

config.musicUrl = 'http://music.test';
config.musicToken = 'music-token';
config.musicAudioDir = '/audio';

// The music container. Commands are kept, Spotify's audio is a stream the test can end, and songs are "downloaded" unless
// `youtube` says a song is missing, fails, or waits until the test lets it go on
const commands: Record<string, unknown>[] = [];
const fetched: string[] = [];
let audio: ReadableStreamDefaultController<Uint8Array> | undefined;
let refuseCommands = false;
const youtube = new Map<string, 'missing' | 'fail' | Promise<void>>();
let missingByDefault = false;
mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
  assert.ok(url.startsWith('http://music.test/'), `only the music container is asked, not ${url}`);
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer music-token');
  const where = url.slice('http://music.test'.length);
  if (where === '/command') {
    if (refuseCommands) return new Response('{}', { status: 503 });
    commands.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response('{}');
  }
  if (where === '/fetch') {
    const body = JSON.parse(init.body as string) as { uri?: string; url?: string };
    const key = body.uri ?? body.url!;
    fetched.push(key);
    const how = youtube.get(key) ?? (missingByDefault ? 'missing' : undefined);
    if (how instanceof Promise) await how;
    if (how === 'missing') return Response.json({ error: 'No match on YouTube or SoundCloud.' }, { status: 404 });
    if (how === 'fail') return Response.json({ error: 'Sign in to confirm you’re not a bot' }, { status: 502 });
    return Response.json({ file: `yt-${key.slice(-4)}.webm`, source: 'youtube' });
  }
  if (where === '/lookup') {
    const { url: link } = JSON.parse(init.body as string) as { url: string };
    if (link.includes('list=')) return Response.json({ error: 'Playlists from YouTube and SoundCloud can’t be added.' }, { status: 404 });
    return Response.json({ url: link, title: 'A Video', artist: 'Someone', durationMs: 61_000, cover: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' });
  }
  if (where === '/audio') return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (audio = c) }));
  // Events are fed straight to onSpotify instead
  if (where === '/events') return new Promise<Response>(() => {});
  throw new Error(`unexpected ${where}`);
});

// What the mixer is asked to play, instead of playing it. `end` finishes it as a song ending would
interface Played {
  file: string;
  options: VoiceOptions;
  stopped: boolean;
  end: () => void;
}
const played: Played[] = [];
mock.method(Mixer.prototype, 'add', (file: string, _gain: number, onEnd: (byItself: boolean) => void, options: VoiceOptions) => {
  const voice: Played = { file, options, stopped: false, end: () => onEnd(true) };
  played.push(voice);
  return () => {
    voice.stopped = true;
    onEnd(false);
  };
});
const lastPlayed = () => played.at(-1)!;

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
  const channel = { id: 'voice', name: 'General', joinable: true, isVoiceBased: () => true, toString: () => '#General', permissionsFor: () => ({ has: () => true }), guild: undefined as unknown };
  const guild = {
    id,
    name: 'Server',
    members: { me: {}, cache: new Map() },
    roles: { cache: new Map() },
    channels: { cache: new Map([['voice', channel]]) },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  };
  channel.guild = guild;
  return { id, guild: guild as never as import('discord.js').Guild, channel: channel as never as import('discord.js').VoiceBasedChannel };
}

const song = (n: number, durationMs = 200_000): Track => ({ uri: `spotify:track:${String(n).padStart(22, '0')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: null, durationMs });
const audioFile = (n: number) => `/audio/yt-${String(n).padStart(4, '0')}.webm`;
const titles = (guildId: string) => queueOf(guildId).map((r) => r.title);
const sent = (name: string) => commands.filter((c) => c.command === name);
/** Spotify says where it's got to in the song */
const at = (ms: number, speed = 1) => onSpotify({ type: 'position_sync', position: { position_ms: ms, timestamp_ms: Date.now(), speed } });
const changed = (n: number) => onSpotify({ type: 'track_changed', item: { uri: song(n).uri } });
/** Has YouTube find nothing, with Spotify signed in to play instead, for the tests of Spotify's side */
const onlySpotify = () => {
  missingByDefault = true;
  resetMusic(WITH_SPOTIFY);
};
/** Lets the clock move, for where a song has got to */
const clock = (t: TestContext) => {
  let now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  return (ms: number) => t.mock.timers.setTime((now += ms));
};

music.setup!({} as never);
beforeEach(() => {
  resetMusic(RUNNING);
  commands.length = 0;
  fetched.length = 0;
  played.length = 0;
  youtube.clear();
  missingByDefault = false;
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
  await removeTrack(id, queueOf(id)[0].id, 'u2');
  assert.deepEqual(titles(id), ['Song 2', 'Song 4']);
  assert.equal(lastPlayed().file, audioFile(2), 'removing the song playing skips it');
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

test('playing fetches the first song and plays it, fetching the next ahead, then carries on where it paused', async (t) => {
  const tick = clock(t);
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(played.map((p) => [p.file, p.options]), [[audioFile(1), { group: 'music', lasting: true }]]);
  assert.deepEqual(fetched, [song(1).uri, song(2).uri, song(1).uri], 'the first two are fetched once queued, so play starts from what’s already there');
  assert.deepEqual(commands, [], 'Spotify isn’t asked for anything');
  const state = musicState(id);
  assert.deepEqual([state.phase, state.channelId, state.via, state.account], ['playing', 'voice', 'youtube', null]);
  tick(30_000);
  assert.equal(musicState(id).positionMs, 30_000);
  assert.equal(pauseMusic(id), null);
  assert.equal(lastPlayed().stopped, true);
  tick(60_000);
  assert.deepEqual([musicState(id).phase, musicState(id).positionMs], ['paused', 30_000]);
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(lastPlayed().options, { group: 'music', lasting: true, startMs: 30_000 }, 'resumes where it paused');
  assert.equal(await startMusic(guild, channel), null, 'already playing there');
  assert.equal(played.length, 2);
  stopMusic(id, 'u1');
  assert.equal(lastPlayed().stopped, true);
});

test('queueing fetches the first two songs ahead, each once, and the next as the queue moves', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2), song(3), song(4)], 'u1');
  assert.deepEqual(fetched, [song(1).uri, song(2).uri], 'not the whole queue');
  addTracks(id, [song(5)], 'u1', true);
  // Put next with nothing playing, it goes first
  assert.deepEqual(fetched.slice(2), [song(5).uri], 'a song put first is fetched, and the ones already asked for aren’t asked again');
  fetched.length = 0;
  await startMusic(guild, channel);
  await skipMusic(id, 'u1');
  assert.deepEqual(fetched, [song(5).uri, song(1).uri], 'each song played is asked for; song 2, next, was fetched when it was queued');
  addTracks(id, [song(6)], 'u1', true);
  assert.deepEqual(fetched.slice(2), [song(6).uri], 'a song put next while one plays is fetched ahead');
  stopMusic(id, 'u1');
});

test('a song ending plays the next, and the music stops after the last', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  lastPlayed().end();
  await sleep(5);
  assert.deepEqual(titles(id), ['Song 2']);
  assert.equal(lastPlayed().file, audioFile(2));
  assert.equal(musicState(id).phase, 'playing');
  lastPlayed().end();
  await sleep(5);
  assert.deepEqual(titles(id), []);
  assert.equal(musicState(id).phase, 'stopped');
});

test('skipping plays the next song, or stops after the last', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  assert.equal(await skipMusic(id, 'u3'), null);
  assert.equal(played[0].stopped, true);
  assert.equal(lastPlayed().file, audioFile(2));
  assert.equal(recentActivity(id, 1)[0].action, 'Skipped **Song 1**');
  await skipMusic(id, 'u3');
  assert.equal(musicState(id).phase, 'stopped');
  assert.equal(await skipMusic(id, 'u3'), 'Nothing is playing.');
});

test('seeking jumps within the song, playing or paused, and not past its ends', async (t) => {
  const tick = clock(t);
  const { id, guild, channel } = server();
  assert.equal(await seekMusic(id, 1000), 'Nothing is playing.');
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  assert.equal(await seekMusic(id, 90_000), null);
  assert.equal(played[0].stopped, true);
  assert.deepEqual([lastPlayed().file, lastPlayed().options], [audioFile(1), { group: 'music', lasting: true, startMs: 90_000 }], 'the same song, from there');
  tick(5_000);
  assert.deepEqual([musicState(id).phase, musicState(id).positionMs, titles(id)], ['playing', 95_000, ['Song 1', 'Song 2']]);
  tick(500_000);
  assert.equal(musicState(id).positionMs, 200_000, 'never past the end, if the file runs a little long');
  await seekMusic(id, 90_000);
  await seekMusic(id, 10_000_000);
  assert.equal(lastPlayed().options.startMs, 194_000, 'not right up to the end, which would only skip it');
  await seekMusic(id, -50);
  assert.equal(lastPlayed().options.startMs, undefined, 'from the top');
  pauseMusic(id);
  const count = played.length;
  assert.equal(await seekMusic(id, 60_000), null);
  assert.deepEqual([played.length, musicState(id).phase, musicState(id).positionMs], [count, 'paused', 60_000], 'paused, it only moves where it’ll resume');
  tick(30_000);
  assert.equal(musicState(id).positionMs, 60_000, 'and stays there while paused');
  await startMusic(guild, channel);
  assert.equal(lastPlayed().options.startMs, 60_000);
  stopMusic(id, 'u1');
});

test('seeking while a song is still starting starts it from there instead', async () => {
  const { id, guild, channel } = server();
  let release!: () => void;
  addTracks(id, [song(1), song(2)], 'u1');
  youtube.set(song(1).uri, new Promise<void>((resolve) => (release = resolve)));
  const starting = startMusic(guild, channel);
  await sleep(5);
  const seeking = seekMusic(id, 40_000);
  release();
  assert.deepEqual(await Promise.all([starting, seeking]), [null, null]);
  assert.deepEqual(played.map((p) => p.options.startMs), [40_000], 'played once, from there');
  stopMusic(id, 'u1');
});

test('skipping while paused waits on the next song until play is pressed', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  pauseMusic(id);
  await skipMusic(id, 'u1');
  assert.deepEqual([titles(id), musicState(id).phase, played.length], [['Song 2'], 'paused', 1]);
  await startMusic(guild, channel);
  assert.deepEqual(lastPlayed().options, { group: 'music', lasting: true }, 'from the top of the new song');
  stopMusic(id, 'u1');
});

test('a song YouTube doesn’t have is skipped and says so, or plays through Spotify when that’s on', async () => {
  const { id, guild, channel } = server();
  youtube.set(song(1).uri, 'missing');
  addTracks(id, [song(1), song(2)], 'u1');
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(titles(id), ['Song 2']);
  assert.equal(lastPlayed().file, audioFile(2));
  assert.equal(musicState(id).note, 'Couldn’t find Song 1 on YouTube or SoundCloud, so it was skipped.');
  stopMusic(id, 'u1');
  // Nothing left to play says so straight away
  addTracks(id, [song(1)], 'u1');
  assert.match((await startMusic(guild, channel))!, /Couldn’t find Song 1/);
  assert.equal(musicState(id).phase, 'stopped');

  resetMusic(WITH_SPOTIFY);
  addTracks(id, [song(1, 30_000), song(2)], 'u1');
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(commands, [{ command: 'activate' }, { command: 'play', uri: song(1).uri }]);
  assert.equal(musicState(id).via, 'spotify');
  assert.equal(musicState(id).account, 'someone');
  // It ends, and the next one comes from YouTube, with Spotify paused
  await at(28_000);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:suggestedsuggestedsugge' } });
  assert.deepEqual(titles(id), ['Song 2']);
  assert.equal(lastPlayed().file, audioFile(2));
  assert.deepEqual(commands.at(-1), { command: 'pause' });
  assert.equal(musicState(id).via, 'youtube');
  await onSpotify({ type: 'playback_changed', status: 'paused' });
  assert.equal(musicState(id).phase, 'playing', 'Spotify going quiet doesn’t touch YouTube’s song');
  stopMusic(id, 'u1');
});

test('when several songs in a row are missing, the note names the last one skipped', async () => {
  const { id, guild, channel } = server();
  youtube.set(song(1).uri, 'missing');
  youtube.set(song(2).uri, 'missing');
  addTracks(id, [song(1), song(2), song(3)], 'u1');
  await startMusic(guild, channel);
  assert.equal(lastPlayed().file, audioFile(3));
  assert.equal(musicState(id).note, 'Couldn’t find Song 2 on YouTube or SoundCloud, so it was skipped.');
  stopMusic(id, 'u1');
});

test('a song that can’t be fetched pauses and says why', async () => {
  const { id, guild, channel } = server();
  youtube.set(song(1).uri, 'fail');
  addTracks(id, [song(1), song(2)], 'u1');
  const errors = mock.method(console, 'error', () => {});
  assert.match((await startMusic(guild, channel))!, /couldn’t get Song 1/);
  errors.mock.restore();
  assert.equal(musicState(id).phase, 'paused');
  assert.match(musicState(id).note!, /couldn’t get Song 1/);
  assert.deepEqual(titles(id), ['Song 1', 'Song 2'], 'nothing is skipped, as it may work in a moment');
  stopMusic(id, 'u1');
});

test('pausing or skipping while a song downloads drops the download rather than playing it late', async () => {
  const { id, guild, channel } = server();
  let release!: () => void;
  youtube.set(song(1).uri, new Promise<void>((resolve) => (release = resolve)));
  addTracks(id, [song(1), song(2), song(3)], 'u1');
  const starting = startMusic(guild, channel);
  await sleep(5);
  assert.equal(musicState(id).phase, 'starting');
  pauseMusic(id);
  release();
  assert.equal(await starting, null);
  assert.deepEqual([musicState(id).phase, played.length], ['paused', 0]);

  youtube.set(song(2).uri, new Promise<void>((resolve) => (release = resolve)));
  await skipMusic(id, 'u1');
  const playing = startMusic(guild, channel);
  await sleep(5);
  const skipping = skipMusic(id, 'u1');
  release();
  await Promise.all([playing, skipping]);
  assert.deepEqual(played.map((p) => p.file), [audioFile(3)], 'only the song skipped to plays');
  stopMusic(id, 'u1');
});

test('Stop on the soundboard, or the song being cut off, pauses and keeps the queue', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  stopPlayback(id);
  assert.deepEqual([musicState(id).phase, musicState(id).note, lastPlayed().stopped], ['paused', null, true]);
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  await startMusic(guild, channel);
  // The bot was pulled out of voice, say
  const [voice] = played.slice(-1);
  voice.stopped = true;
  (Mixer.prototype.add as unknown as { mock: { calls: { arguments: [string, number, (byItself: boolean) => void] }[] } }).mock.calls.at(-1)!.arguments[2](false);
  assert.equal(musicState(id).phase, 'paused');
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  stopMusic(id, 'u1');
});

test('music plays in several servers at once', async () => {
  const a = server();
  const b = server();
  addTracks(a.id, [song(1)], 'u1');
  addTracks(b.id, [song(2)], 'u1');
  assert.equal(await startMusic(a.guild, a.channel), null);
  assert.equal(await startMusic(b.guild, b.channel), null);
  assert.deepEqual([musicState(a.id).phase, musicState(b.id).phase], ['playing', 'playing']);
  stopMusic(a.id, 'u1');
  assert.equal(musicState(b.id).phase, 'playing');
  stopMusic(b.id, 'u1');
});

test('a YouTube or SoundCloud link adds what it is, and plays from the link', async () => {
  const { id, guild, channel } = server();
  const link = 'https://www.youtube.com/watch?v=abc';
  assert.equal(await queueFrom(id, link, 'u1', false), 'Added **A Video by Someone**.');
  const [row] = queueOf(id);
  assert.deepEqual([row.uri, row.title, row.artist, row.cover, row.duration_ms], [link, 'A Video', 'Someone', 'https://i.ytimg.com/vi/abc/hqdefault.jpg', 61_000]);
  await startMusic(guild, channel);
  assert.equal(fetched[0], link);
  await assert.rejects(queueFrom(id, 'https://www.youtube.com/playlist?list=x', 'u1', false), /Playlists from YouTube/);
  await assert.rejects(queueFrom(id, 'https://vimeo.com/1', 'u1', false), /isn’t a Spotify, YouTube or SoundCloud link/);
  stopMusic(id, 'u1');
});

test('says why music can’t play', async () => {
  const { id, guild, channel } = server();
  assert.match((await startMusic(guild, channel))!, /queue is empty/);
  addTracks(id, [song(1)], 'u1');
  resetMusic(null);
  assert.match((await startMusic(guild, channel))!, /isn’t answering/);
  resetMusic({ ...RUNNING, youtube: { ready: false, version: null, message: 'yt-dlp didn’t run: no python' } });
  assert.match((await startMusic(guild, channel))!, /can’t reach YouTube: yt-dlp didn’t run/);
  resetMusic({ ...RUNNING, youtube: undefined });
  assert.match((await startMusic(guild, channel))!, /still starting/);
  // Spotify's own problems don't stop YouTube
  resetMusic({ ...RUNNING, state: 'no-key' });
  assert.equal(await startMusic(guild, channel), null);
  stopMusic(id, 'u1');
});

test('the page is told playlists exist only with the Spotify account signed in', (t) => {
  const { id } = server();
  t.after(() => Object.assign(config, { spotifyClientId: null, spotifyClientSecret: null, spotifyRefreshToken: null }));
  Object.assign(config, { spotifyClientId: 'id', spotifyClientSecret: 'secret', spotifyRefreshToken: null });
  assert.deepEqual([musicState(id).searchReady, musicState(id).playlistsReady], [true, false], 'search alone doesn’t show anyone’s playlists');
  config.spotifyRefreshToken = 'refresh';
  assert.equal(musicState(id).playlistsReady, true);
});

// ---------- songs played through Spotify, when YouTube doesn't have them ----------

test('Spotify starts the song on this speaker, then carries on where it paused', async () => {
  onlySpotify();
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(commands, [{ command: 'activate' }, { command: 'play', uri: song(1).uri }]);
  assert.equal(musicState(id).phase, 'playing');
  await at(40_000);
  assert.equal(pauseMusic(id), null);
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

test('seeking a song playing through Spotify asks Spotify, and paused, it starts from there on resume', async () => {
  onlySpotify();
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  assert.equal(await seekMusic(id, 80_000), null);
  assert.deepEqual(commands.at(-1), { command: 'seek', position_ms: 80_000 });
  assert.equal(musicState(id).positionMs >= 80_000, true);
  pauseMusic(id);
  await seekMusic(id, 30_000);
  commands.length = 0;
  await startMusic(guild, channel);
  assert.deepEqual(commands, [{ command: 'activate' }, { command: 'play', uri: song(1).uri }, { command: 'seek', position_ms: 30_000 }]);
  stopMusic(id, 'u1');
});

test('the music stops at the end of the queue rather than playing Spotify’s suggestions', async () => {
  onlySpotify();
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
  onlySpotify();
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
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:anothercopyanothercopy' } });
  assert.equal(musicState(id).phase, 'playing');
  stopMusic(id, 'u1');
});

test('a song picked from Spotify’s app, mid-song, pauses and keeps the queue', async (t) => {
  onlySpotify();
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  // Long enough after the bot asked for its song that this is someone's choice
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + CANT_PLAY_MS + 5_000 });
  await at(20_000);
  await onSpotify({ type: 'track_changed', item: { uri: 'spotify:track:somethingelsesomething' } });
  assert.equal(musicState(id).phase, 'paused');
  assert.match(musicState(id).note!, /started on this speaker from Spotify/);
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  commands.length = 0;
  await startMusic(guild, channel);
  assert.deepEqual(sent('play')[0], { command: 'play', uri: song(1).uri }, 'starts the queue’s song again rather than resuming the other one');
  assert.deepEqual(sent('seek'), [{ command: 'seek', position_ms: 20_000 }], 'from where it was');
  stopMusic(id, 'u1');
});

test('Spotify pausing, or moving to another speaker, pauses; pausing at the very end moves on', async () => {
  onlySpotify();
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

test('Spotify’s audio dropping pauses, and Spotify signing out pauses with a reason', async () => {
  onlySpotify();
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  await sleep(20);
  audio!.close();
  await sleep(20);
  assert.equal(musicState(id).phase, 'paused');
  await startMusic(guild, channel);
  refuseCommands = true;
  const errors = mock.method(console, 'error', () => {});
  pauseMusic(id);
  assert.match((await startMusic(guild, channel))!, /didn’t start/);
  errors.mock.restore();
  assert.equal(musicState(id).phase, 'paused');
  stopMusic(id, 'u1');
});

test('Spotify stands in for one server at a time', async () => {
  onlySpotify();
  const a = server();
  const b = server();
  addTracks(a.id, [song(1)], 'u1');
  addTracks(b.id, [song(2), song(3)], 'u1');
  youtube.set(song(3).uri, 'fail');
  missingByDefault = true;
  await startMusic(a.guild, a.channel);
  assert.equal(musicState(a.id).via, 'spotify');
  assert.match((await startMusic(b.guild, b.channel))!, /couldn’t get Song 3/);
  assert.equal(musicState(b.id).note, 'The music player couldn’t get Song 3, so the music paused. Try again in a moment.');
  assert.deepEqual(titles(b.id), ['Song 3'], 'song 2 was skipped, as Spotify was busy');
  stopMusic(a.id, 'u1');
  stopMusic(b.id, 'u1');
});

test('a file played from the page pauses the music, and the music takes over from it', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const { id, guild, channel } = server();
  const tone = (seconds: number) => {
    const file = fileUploadPath('.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file]);
    return file;
  };
  addTracks(id, [song(1)], 'u1');
  await startMusic(guild, channel);
  const song1 = lastPlayed();
  const file = tone(1);
  assert.equal(await playFile(guild, channel, file, 'Tone', 'u1'), null);
  assert.equal(song1.stopped, true);
  assert.equal(musicState(id).phase, 'paused');
  assert.match(musicState(id).note!, /Paused for a file/);
  assert.deepEqual([musicState(id).file?.name, lastPlayed().file], ['Tone', file]);
  // Jumping within it starts it again from there, and keeps the file
  assert.equal(await seekFile(id, 500), null);
  assert.deepEqual([lastPlayed().file, lastPlayed().options.startMs], [file, 500]);
  assert.ok(existsSync(file));
  assert.ok(Math.abs(musicState(id).file!.positionMs - 500) < 50);
  await seekFile(id, 60_000);
  assert.equal(lastPlayed().options.startMs, 500, 'not right up to the end');
  await seekFile(id, -5);
  assert.equal(lastPlayed().options.startMs, undefined, 'from the top');
  assert.equal(await startMusic(guild, channel), null);
  assert.equal(musicState(id).file, null, 'Resume stops the file rather than play over it');
  assert.equal(await seekFile(id, 0), 'No file is playing.');
  assert.ok(!existsSync(file));
  assert.equal(stopFile(id), false);

  // One that ends by itself is deleted, and the state says nothing's playing
  const short = tone(0.3);
  await playFile(guild, channel, short, 'Short', 'u1');
  lastPlayed().end();
  assert.equal(musicState(id).file, null);
  assert.ok(!existsSync(short));

  const long = fileUploadPath('.ogg');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '1201', '-c:a', 'libvorbis', '-q:a', '0', long]);
  assert.match((await playFile(guild, channel, long, 'Long', 'u1'))!, /over 20 minutes/);
  assert.ok(!existsSync(long));
  stopMusic(id, 'u1');
});
