import './helpers.ts';
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test, type TestContext } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { recentActivity } from '../src/activity.ts';
import { feeds } from '../src/changes.ts';
import { config } from '../src/config.ts';
import { db, getKv } from '../src/db.ts';
import { Mixer, type VoiceOptions } from '../src/mixer.ts';
import {
  addTracks,
  clearQueue,
  fileUploadPath,
  coversFilled,
  fillCovers,
  MOST_QUEUED,
  moveTrack,
  music,
  musicCard,
  musicState,
  onStatus,
  pauseMusic,
  playFile,
  queueFrom,
  queueOf,
  removeTrack,
  resetMusic,
  restoreCards,
  resumeAfterRestart,
  shuffleQueue,
  seekFile,
  seekMusic,
  skipMusic,
  startMusic,
  stopFile,
  stopMusic,
  type PlayerStatus,
} from '../src/features/music.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { stopPlayback } from '../src/features/voiceAudio.ts';
import { setSetting } from '../src/settings.ts';
import type { Track } from '../src/spotify.ts';

// yt-dlp is ready
const RUNNING: PlayerStatus = { youtube: { ready: true, version: '2026.10.26', message: '' } };

config.musicUrl = 'http://music.test';
config.musicToken = 'music-token';
config.musicAudioDir = '/audio';

// The music container. Songs are "downloaded" unless `youtube` says a song is missing, fails, or waits until the test lets it go on
const fetched: string[] = [];
const youtube = new Map<string, 'missing' | 'fail' | Promise<void>>();
// Spotify's oEmbed, for album covers. Every song has one, unless `covers` says it has none, Spotify is limiting or down once, or the test holds it
const looked: string[] = [];
const covers = new Map<string, 'none' | 'limited' | 'down' | Promise<void>>();
const coverOf = (n: number) => `https://i.scdn.co/image/ab67616d00001e02${String(n).padStart(22, '0')}`;
mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
  if (url.startsWith('https://open.spotify.com/oembed?')) {
    const id = new URL(url).searchParams.get('url')!.replace('https://open.spotify.com/track/', '');
    looked.push(id);
    const how = covers.get(id);
    if (how instanceof Promise) await how;
    if (how === 'none') return new Response('{}', { status: 404 });
    if (how === 'down') {
      covers.delete(id);
      return new Response('', { status: 502 });
    }
    if (how === 'limited') {
      covers.delete(id);
      return new Response('', { status: 429, headers: { 'retry-after': '1' } });
    }
    return Response.json({ type: 'rich', thumbnail_url: `https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e02${id}` });
  }
  assert.ok(url.startsWith('http://music.test/'), `only the music container is asked, not ${url}`);
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer music-token');
  const where = url.slice('http://music.test'.length);
  if (where === '/fetch') {
    const body = JSON.parse(init.body as string) as { uri?: string; url?: string };
    const key = body.uri ?? body.url!;
    fetched.push(key);
    const how = youtube.get(key);
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
  // Status changes are set by the tests instead
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
  const channel = { id: 'voice', name: 'General', joinable: true, members: new Map<string, unknown>(), isVoiceBased: () => true, toString: () => '#General', permissionsFor: () => ({ has: () => true }), guild: undefined as unknown };
  const guild = {
    id,
    name: 'Server',
    members: { me: {}, cache: new Map() },
    roles: { cache: new Map() },
    channels: { cache: new Map([['voice', channel]]) },
    voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  };
  channel.guild = guild;
  /** Someone joins the channel, which a restart checks for before carrying the music on */
  const join = () => channel.members.set(`member-${channel.members.size}`, { user: { bot: false } });
  return { id, guild: guild as never as import('discord.js').Guild, channel: channel as never as import('discord.js').VoiceBasedChannel, join };
}

const song = (n: number, durationMs = 200_000): Track => ({ uri: `spotify:track:${String(n).padStart(22, '0')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: null, durationMs });
const audioFile = (n: number) => `/audio/yt-${String(n).padStart(4, '0')}.webm`;
const titles = (guildId: string) => queueOf(guildId).map((r) => r.title);
/** Lets the clock move, for where a song has got to */
const clock = (t: TestContext) => {
  let now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  return (ms: number) => t.mock.timers.setTime((now += ms));
};

music.setup!({} as never);
beforeEach(() => {
  resetMusic(RUNNING);
  fetched.length = 0;
  played.length = 0;
  youtube.clear();
  covers.clear();
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

test('shuffling mixes up the songs waiting and leaves the one playing first', async () => {
  const { id, guild, channel } = server();
  assert.equal(shuffleQueue(id, 'u1'), 0, 'nothing to shuffle');
  const songs = Array.from({ length: 12 }, (_, n) => song(n + 1));
  addTracks(id, songs, 'u1');
  await startMusic(guild, channel);
  const before = titles(id);
  let shuffled = before;
  // 11 songs waiting come back in the same order once in 40 million shuffles, so a few tries is plenty
  for (let tries = 0; tries < 3 && JSON.stringify(shuffled) === JSON.stringify(before); tries++) {
    assert.equal(shuffleQueue(id, 'u1'), 11);
    shuffled = titles(id);
  }
  assert.notDeepEqual(shuffled, before);
  assert.equal(shuffled[0], 'Song 1', 'the song playing stays first');
  assert.deepEqual([...shuffled].sort(), [...before].sort(), 'the same songs, none lost or doubled');
  assert.equal(recentActivity(id, 1)[0].action, 'Shuffled the music queue');
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

test('songs added without a cover get one from Spotify, the next song first, and a song with none isn’t asked about again', async () => {
  await fillCovers();
  looked.length = 0;
  const { id } = server();
  let hold!: () => void;
  covers.set(song(90).uri.slice(-22), new Promise<void>((resolve) => (hold = resolve)));
  addTracks(id, [song(90)], 'u1');
  addTracks(id, [song(1), song(2), song(3), song(5)], 'u1');
  addTracks(id, [{ ...song(6), cover: 'https://i.scdn.co/image/chosen' }], 'u1');
  addTracks(id, [song(4)], 'u1', true);
  covers.set(song(5).uri.slice(-22), 'none');
  const queued = feeds.music.version(id);
  hold();
  await coversFilled();
  assert.notEqual(feeds.music.version(id), queued, 'the page hears of the covers');
  assert.deepEqual(
    looked.map((uri) => Number(uri)),
    [90, 4, 1, 2, 3, 5],
    'one at a time while busy, then from the front of the queue',
  );
  const coverByTitle = Object.fromEntries(queueOf(id).map((r) => [r.title, r.cover]));
  assert.deepEqual(coverByTitle, {
    'Song 4': coverOf(4),
    'Song 90': coverOf(90),
    'Song 1': coverOf(1),
    'Song 2': coverOf(2),
    'Song 3': coverOf(3),
    'Song 5': null,
    'Song 6': 'https://i.scdn.co/image/chosen',
  });

  // The same song in another server gets its cover too, and the one with none isn't looked up again
  const other = server();
  looked.length = 0;
  addTracks(other.id, [song(5), song(7)], 'u2');
  await coversFilled();
  assert.deepEqual(looked.map(Number), [7]);
  assert.deepEqual(
    queueOf(other.id).map((r) => r.cover),
    [null, coverOf(7)],
  );

  // Spotify being down isn't the same as no cover, so the song is tried again when more are added
  covers.set(song(9).uri.slice(-22), 'down');
  looked.length = 0;
  addTracks(other.id, [song(9)], 'u2');
  await coversFilled();
  assert.equal(queueOf(other.id)[2]!.cover, null);
  addTracks(other.id, [song(10)], 'u2');
  await coversFilled();
  assert.deepEqual(looked.map(Number), [9, 9, 10]);
  assert.deepEqual(
    queueOf(other.id).map((r) => r.cover),
    [null, coverOf(7), coverOf(9), coverOf(10)],
  );
});

test('when Spotify limits cover lookups, they wait as long as it asks and then carry on', async () => {
  await fillCovers();
  looked.length = 0;
  const { id } = server();
  covers.set(song(8).uri.slice(-22), 'limited');
  const started = Date.now();
  addTracks(id, [song(8)], 'u1');
  await coversFilled();
  assert.ok(Date.now() - started >= 1000, 'waited the second Spotify asked for');
  assert.deepEqual(looked.map(Number), [8, 8]);
  assert.equal(queueOf(id)[0]!.cover, coverOf(8));
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
  const state = musicState(id);
  assert.deepEqual([state.phase, state.channelId, state.via], ['playing', 'voice', 'youtube']);
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

test('a song YouTube doesn’t have is skipped and says so', async () => {
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

test('the web UI’s Stop leaves the music playing', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1)], 'u1');
  await startMusic(guild, channel);
  stopPlayback(id, true);
  assert.deepEqual([musicState(id).phase, lastPlayed().stopped], ['playing', false]);
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

// ---------- carrying on after a restart ----------

/** The bot restarting: it saves where the music was, exits, and starts again knowing only the database */
async function restart(guild: import('discord.js').Guild, next: PlayerStatus | null = RUNNING, beforeStarting = () => {}) {
  music.saveForRestart!();
  resetMusic(next);
  beforeStarting();
  return resumeAfterRestart({ guilds: { cache: new Map([[guild.id, guild]]) } } as never);
}
const savedPlace = () => JSON.parse(getKv('musicSessions') ?? '[]') as { songId: number; positionMs: number; playing: boolean }[];

test('a restart carries the music on from the same second, in the same channel', async (t) => {
  const tick = clock(t);
  const logged = t.mock.method(console, 'log', () => {});
  const { id, guild, channel, join } = server();
  join();
  addTracks(id, [song(1), song(2)], 'u1');
  assert.equal(await startMusic(guild, channel), null);
  assert.deepEqual(savedPlace().map((p) => [p.positionMs, p.playing]), [[0, true]], 'saved as soon as it plays, in case the bot crashes');
  tick(83_000);
  const before = played.length;
  await restart(guild);
  assert.equal(played.length, before + 1);
  assert.deepEqual([lastPlayed().file, lastPlayed().options], [audioFile(1), { group: 'music', lasting: true, startMs: 83_000 }]);
  assert.equal(musicState(id).phase, 'playing');
  assert.deepEqual(titles(id), ['Song 1', 'Song 2'], 'the queue is untouched');
  assert.ok(logged.mock.calls.some((c) => /carried on Song 1 in #General from 1:23/.test(String(c.arguments[0]))));
  stopMusic(id, 'u1');
  assert.deepEqual(savedPlace(), [], 'stopping forgets it');
});

test('paused music stays paused through a restart, and carries on from where it paused', async (t) => {
  const tick = clock(t);
  const { id, guild, channel, join } = server();
  join();
  addTracks(id, [song(1)], 'u1');
  await startMusic(guild, channel);
  tick(30_000);
  assert.equal(pauseMusic(id), null);
  assert.deepEqual(savedPlace().map((p) => [p.positionMs, p.playing]), [[30_000, false]]);
  tick(60_000);
  const before = played.length;
  await restart(guild);
  assert.equal(played.length, before, 'nothing plays by itself');
  assert.equal(musicState(id).phase, 'paused');
  assert.equal(musicState(id).positionMs, 30_000);
  assert.equal(await startMusic(guild, channel), null);
  assert.equal(lastPlayed().options.startMs, 30_000);
  stopMusic(id, 'u1');
});

test('the music doesn’t carry on after a long gap, without its song, or to an empty channel, and the queue is kept', async (t) => {
  const tick = clock(t);
  t.mock.method(console, 'log', () => {});
  const { id, guild, channel, join } = server();
  addTracks(id, [song(1), song(2)], 'u1');
  await startMusic(guild, channel);
  tick(20_000);

  const before = played.length;
  await restart(guild);
  assert.equal(played.length, before, 'nobody is listening');
  assert.equal(musicState(id).phase, 'paused');
  assert.equal(musicState(id).positionMs, 20_000, 'but play carries on from there');
  assert.match(musicState(id).note!, /nobody was in General/);

  join();
  await startMusic(guild, channel);
  await restart(guild, RUNNING, () => tick(11 * 60_000));
  assert.equal(played.length, before + 1, 'only the start above');
  assert.equal(musicState(id).phase, 'stopped', 'too long ago');

  await startMusic(guild, channel);
  await restart(guild, RUNNING, () => db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND title = ?').run(id, 'Song 1'));
  assert.equal(musicState(id).phase, 'stopped', 'its song went');
  assert.deepEqual(titles(id), ['Song 2']);
  stopMusic(id, 'u1');
});

test('after a restart the music waits for the music player to start, and someone pressing play first wins', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { id, guild, channel, join } = server();
  join();
  addTracks(id, [song(1)], 'u1');
  await startMusic(guild, channel);
  const before = played.length;
  const resuming = restart(guild, null);
  await sleep(50);
  assert.equal(played.length, before, 'the player isn’t up yet');
  assert.equal(musicState(id).phase, 'paused');
  onStatus(RUNNING);
  await resuming;
  assert.equal(played.length, before + 1);
  assert.equal(musicState(id).phase, 'playing');

  const again = restart(guild, null);
  await sleep(50);
  onStatus(RUNNING);
  assert.equal(await startMusic(guild, channel), null, 'someone pressed play');
  await again;
  assert.equal(played.length, before + 2, 'played once, not twice');
  stopMusic(id, 'u1');
});

// ---------- the music card ----------

const cardJson = (card: ReturnType<typeof musicCard>) => ({
  embed: card.embeds[0].toJSON(),
  buttons: card.components.flatMap((row) => row.toJSON().components.map((c: any) => [c.custom_id, c.label, Boolean(c.disabled)])),
});

/** Someone in a server, who can control the music unless the server has a DJ role they don't have */
const person = (guildId: string, channel: unknown = null, roles: string[] = []) => ({
  guild: { id: guildId },
  roles: { cache: new Set(roles) },
  permissions: { has: () => false },
  voice: { channel },
});

/** Presses a button on a music card */
async function pressCard(guild: import('discord.js').Guild, customId: string, member = person(guild.id)) {
  const out = { updates: [] as any[], replies: [] as any[], followUps: [] as any[] };
  await music.onButton!({
    customId,
    guildId: guild.id,
    guild,
    member,
    user: { id: 'u1', toString: () => '<@u1>' },
    inCachedGuild: () => true,
    update: async (r: unknown) => out.updates.push(r),
    editReply: async (r: unknown) => out.updates.push(r),
    deferUpdate: async () => {},
    reply: async (r: unknown) => out.replies.push(r),
    followUp: async (r: unknown) => out.followUps.push(r),
  } as never);
  return out;
}

test('the card shows what’s playing, how far in, and a page of what’s next', async (t) => {
  const tick = clock(t);
  const { id, guild, channel } = server();
  let card = cardJson(musicCard(id));
  assert.equal(card.embed.description, 'The queue is empty. Add songs with /music play.');
  assert.deepEqual(card.buttons.filter(([, , off]) => off).map(([, label]) => label), ['Play', 'Skip', 'Shuffle', 'Stop'], 'nothing to control');

  addTracks(id, Array.from({ length: 23 }, (_, n) => song(n + 1, 180_000)), 'u1');
  card = cardJson(musicCard(id));
  assert.equal(card.embed.title, '🎵 Music');
  assert.equal(card.embed.fields![0].name, 'Up next: 23 songs, 69 min');

  await startMusic(guild, channel);
  tick(60_000);
  card = cardJson(musicCard(id));
  assert.equal(card.embed.author!.name, '▶ Now playing');
  assert.deepEqual([card.embed.title, card.embed.url], ['Song 1', `https://open.spotify.com/track/${'1'.padStart(22, '0')}`]);
  assert.equal(card.embed.description, `Band · 3:00\nEnds <t:${Math.round((Date.now() + 120_000) / 1000)}:R> in <#voice>`);
  assert.equal(card.embed.fields![0].name, 'Up next: 22 songs, 66 min');
  assert.match(card.embed.fields![0].value, /^1\. \*\*Song 2\*\*/);
  assert.deepEqual(card.buttons.map(([idText]) => idText), ['music:toggle:0', 'music:skip:0', 'music:shuffle:0', 'music:stop:0', 'music:show:0', 'music:show:-1', 'music:page', 'music:show:1']);
  assert.equal(card.buttons[0][1], 'Pause');

  card = cardJson(musicCard(id, 9));
  assert.match(card.embed.fields![0].value, /^21\. \*\*Song 22\*\*/, 'a page past the end shows the last');
  assert.deepEqual(card.buttons.slice(5).map(([, label, off]) => [label, off]), [['Earlier', false], ['Page 3 of 3', true], ['Later', true]]);

  pauseMusic(id);
  card = cardJson(musicCard(id));
  assert.deepEqual([card.embed.author!.name, card.buttons[0][1]], ['⏸ Paused', 'Play']);
  assert.match(card.embed.description!, /Paused at 1:00 of 3:00 in <#voice>/);
  stopMusic(id, 'u1');
});

test('the card’s buttons control the music, and only for the DJs', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2), song(3)], 'u1');
  let out = await pressCard(guild, 'music:toggle:0');
  assert.match(out.followUps[0].content, /Join a voice channel first/);
  assert.equal(musicState(id).phase, 'stopped');

  out = await pressCard(guild, 'music:toggle:0', person(id, channel));
  assert.equal(musicState(id).phase, 'playing');
  assert.equal(cardJson(out.updates[0]).embed.title, 'Song 1', 'the card is redrawn');
  await pressCard(guild, 'music:toggle:0');
  assert.equal(musicState(id).phase, 'paused');
  await pressCard(guild, 'music:toggle:0');
  assert.equal(musicState(id).phase, 'playing', 'carries on in its own channel without the presser in voice');
  await pressCard(guild, 'music:skip:0');
  assert.deepEqual(titles(id), ['Song 2', 'Song 3']);

  setSetting(id, 'musicDjRole', 'dj');
  out = await pressCard(guild, 'music:skip:0');
  assert.match(out.replies[0].content, /Only <@&dj>/);
  assert.equal(titles(id).length, 2);
  out = await pressCard(guild, 'music:show:0');
  assert.equal(out.updates.length, 1, 'anyone can look');

  const dj = person(id, null, ['dj']);
  out = await pressCard(guild, 'music:stop:0', dj);
  assert.match(out.replies[0].content, /Stop the music and clear the queue of 2 songs\?/);
  assert.equal(musicState(id).phase, 'playing', 'nothing stops until it’s confirmed');
  out = await pressCard(guild, 'music:stop-yes:0', dj);
  assert.deepEqual([musicState(id).phase, titles(id)], ['stopped', []]);
  assert.equal(out.followUps[0].content, '<@u1> stopped the music and cleared the queue.');
});

test('the card /music play posts follows the music, and a newer one takes over', async () => {
  const { id, guild, channel } = server();
  const edits: [string, any][] = [];
  const client = { channels: { fetch: async () => ({ isTextBased: () => true, messages: { edit: async (messageId: string, r: unknown) => void edits.push([messageId, r]) } }) } };
  let posted = 0;
  const play = async () => {
    let answer: any;
    await music.commands![0].run({
      inCachedGuild: () => true,
      guildId: id,
      guild,
      client,
      member: person(id, channel),
      user: { id: 'u1' },
      deferred: false,
      options: { getSubcommand: () => 'play', getString: () => null, getBoolean: () => null },
      async deferReply() {
        (this as { deferred: boolean }).deferred = true;
      },
      editReply: async (r: unknown) => ((answer = r), { channelId: 'text', id: `card-${++posted}` }),
    } as never);
    return answer;
  };
  addTracks(id, [song(1), song(2)], 'u1');
  const first = await play();
  assert.equal(first.content, 'Playing **Song 1** in #General.');
  assert.equal(cardJson(first).embed.title, 'Song 1');

  await skipMusic(id, 'u1');
  await sleep(1_700);
  const [messageId, redrawn] = edits.at(-1)!;
  assert.equal(messageId, 'card-1');
  assert.equal(cardJson(redrawn).embed.title, 'Song 2', 'redrawn once the song changed');

  pauseMusic(id);
  edits.length = 0;
  await play();
  await sleep(10);
  assert.deepEqual(edits.map(([messageId, r]) => [messageId, r.components.length]), [['card-1', 0]], 'the older card loses its buttons');
  stopMusic(id, 'u1');
  await sleep(1_700);
  assert.equal(edits.at(-1)![0], 'card-2');
  assert.equal(cardJson(edits.at(-1)![1]).embed.description, 'The queue is empty. Add songs with /music play.');
});

test('after a restart the card is picked up again and redrawn, and one that was deleted is let go', async () => {
  const { id, guild, channel } = server();
  const edits: [string, any][] = [];
  let deleted = false;
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: {
          edit: async (messageId: string, r: unknown) => {
            if (deleted) throw new Error('Unknown Message');
            edits.push([messageId, r]);
          },
        },
      }),
    },
  };
  addTracks(id, [song(1), song(2)], 'u1');
  await music.commands![0].run({
    inCachedGuild: () => true,
    guildId: id,
    guild,
    client,
    member: person(id, channel),
    user: { id: 'u1' },
    deferred: true,
    options: { getSubcommand: () => 'play', getString: () => null, getBoolean: () => null },
    deferReply: async () => {},
    editReply: async () => ({ channelId: 'text', id: 'kept-card' }),
  } as never);
  const saved = () => (JSON.parse(getKv('musicCards') ?? '[]') as { guildId: string; messageId: string }[]).filter((c) => c.guildId === id);
  assert.deepEqual(saved().map((c) => c.messageId), ['kept-card']);

  // The bot restarts, and the music moved on while it was away
  resetMusic(RUNNING);
  addTracks(id, [song(3)], 'u1');
  restoreCards(client as never);
  await sleep(1_700);
  const [messageId, redrawn] = edits.at(-1)!;
  assert.equal(messageId, 'kept-card');
  assert.equal(cardJson(redrawn).embed.fields![0].name, 'Up next: 3 songs, 10 min');

  // Deleted while the bot was away
  resetMusic(RUNNING);
  deleted = true;
  restoreCards(client as never);
  await sleep(1_700);
  assert.deepEqual(saved(), []);
});

test('/music remove offers the queue as the card numbers it, and takes the song out', async () => {
  const { id, guild, channel } = server();
  addTracks(id, [song(1), song(2), song(3)], 'u1');
  await startMusic(guild, channel);
  let offered: { name: string; value: string }[] = [];
  const ask = (typed: string) =>
    music.commands![0].autocomplete!({ guildId: id, options: { getSubcommand: () => 'remove', getFocused: () => typed }, respond: async (r: typeof offered) => void (offered = r) } as never);
  await ask('');
  assert.deepEqual(offered.map((o) => o.name), ['▶ Song 1 – Band', '1. Song 2 – Band', '2. Song 3 – Band']);
  await ask('song 3');
  assert.deepEqual(offered.map((o) => o.name), ['2. Song 3 – Band']);

  const answers: string[] = [];
  const remove = (value: string) =>
    music.commands![0].run({
      inCachedGuild: () => true,
      guildId: id,
      guild,
      member: person(id, channel),
      user: { id: 'u1' },
      options: { getSubcommand: () => 'remove', getString: () => value },
      reply: async (r: { content: string }) => void answers.push(r.content),
    } as never);
  await remove(offered[0].value);
  assert.deepEqual(titles(id), ['Song 1', 'Song 2']);
  await remove(offered[0].value);
  assert.deepEqual(answers, ['Took **Song 3** out of the queue.', 'That song isn’t in the queue any more. Pick one from the list.']);
  stopMusic(id, 'u1');
});
