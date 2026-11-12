import './helpers.ts';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { config } from '../src/config.ts';
import { recentActivity } from '../src/activity.ts';
import { Mixer } from '../src/mixer.ts';
import { addTracks, AUTOPLAY } from '../src/features/music.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { resetSpotify } from '../src/spotify.ts';
import { GUILD, call, guild, ok, permitted, refused, wav } from './apiFixture.ts';

// The music queue

test('a file from the page plays once at the music volume, and is deleted after', async (t) => {
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });
  const added = t.mock.method(Mixer.prototype, 'add', (_file: string, _gain: number, onEnd: () => void) => onEnd);
  const folder = path.join(process.env.DATA_DIR!, 'music-files');
  const leftovers = () => (existsSync(folder) ? readdirSync(folder) : []);
  const url = (name: string, channelId = '702') => `/guilds/${GUILD}/music/file?name=${encodeURIComponent(name)}&channelId=${channelId}`;

  let music = await ok(url('My Song.wav'), { method: 'POST', body: wav(2) as BodyInit });
  assert.equal(music.file.name, 'My Song');
  assert.ok(Math.abs(music.file.durationMs - 2000) < 100, String(music.file.durationMs));
  const [file, gain, , options] = added.mock.calls[0].arguments;
  assert.deepEqual([gain, options], [1, { group: 'music', lasting: true }], 'at the music volume, and sounds can’t push it out');
  assert.ok(existsSync(file));
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Played the file **My Song**');

  await ok(url('Another.wav'), { method: 'POST', body: wav(1) as BodyInit });
  assert.ok(!existsSync(file), 'a second file stops the first, which is deleted');
  music = await ok(`/guilds/${GUILD}/music/file/stop`, { method: 'POST' });
  assert.equal(music.file, null);
  assert.deepEqual(leftovers(), []);
  assert.match(await refused(409, `/guilds/${GUILD}/music/file/stop`, { method: 'POST' }), /No file is playing/);
  assert.match(await refused(400, `/guilds/${GUILD}/music/seek`, { method: 'POST', json: { positionMs: 'half' } }), /positionMs must be a number/);
  assert.match(await refused(400, `/guilds/${GUILD}/music/seek`, { method: 'POST', json: { positionMs: 1000 } }), /Nothing is playing/);

  assert.match(await refused(400, url('notes.txt'), { method: 'POST', body: 'hello' }), /isn’t a file the bot can play/);
  assert.match(await refused(400, url('fake.mp3'), { method: 'POST', body: 'hello' }), /doesn’t have any audio/);
  assert.match(await refused(400, url('song.mp3', 'v1'), { method: 'POST', body: 'hello' }), /Nobody’s in voice/);
  const huge = 61 * 1024 * 1024;
  assert.match(await refused(400, url('huge.mp3'), { method: 'POST', headers: { 'content-length': String(huge) }, body: Buffer.alloc(huge) as BodyInit }), /over 60 MB/);
  // Sent in pieces, with no length up front, it's counted as it arrives
  const pieces = new ReadableStream({
    start(c) {
      for (let i = 0; i < 62; i++) c.enqueue(new Uint8Array(1024 * 1024));
      c.close();
    },
  });
  assert.match(await refused(413, url('huge.mp3'), { method: 'POST', body: pieces, duplex: 'half' } as RequestInit), /over 60 MB/);
  assert.deepEqual(leftovers(), [], 'nothing refused is kept');
  assert.equal(added.mock.callCount(), 2);
});

test('the music queue can be filled, reordered and emptied from the page', async () => {
  const track = (n: number) => ({ uri: `spotify:track:${String(n).padStart(22, 'a')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: 'https://evil.example/x.png', durationMs: 180_000 });
  let music = await ok(`/guilds/${GUILD}/music`);
  assert.deepEqual(music.queue, []);
  assert.equal(music.phase, 'stopped');
  assert.match(music.problem, /MUSIC_URL/);
  assert.equal(music.volume, 40);
  for (const n of [1, 2, 3]) music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(n) } });
  music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(4), next: true } });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['Song 4', 'Song 1', 'Song 2', 'Song 3']);
  assert.equal(music.queue[0].addedBy, 'Web UI');
  assert.equal(music.queue[0].cover, null, 'only Spotify’s covers are kept');
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Added **Song 4** to the music queue to play next');

  music = await ok(`/guilds/${GUILD}/music/queue/${music.queue[3].id}/move`, { method: 'POST', json: { to: 0 } });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['Song 3', 'Song 4', 'Song 1', 'Song 2']);
  music = await ok(`/guilds/${GUILD}/music/queue/${music.queue[1].id}`, { method: 'DELETE' });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['Song 3', 'Song 1', 'Song 2']);
  assert.equal((await call(`/guilds/${GUILD}/music/queue/99999`, { method: 'DELETE' })).status, 404);
  assert.equal((await call(`/guilds/${GUILD}/music/queue/${music.queue[0].id}/move`, { method: 'POST', json: { to: 'top' } })).status, 400);
  music = await ok(`/guilds/${GUILD}/music/queue/shuffle`, { method: 'POST' });
  assert.deepEqual(music.queue.map((r: any) => r.title).sort(), ['Song 1', 'Song 2', 'Song 3']);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Shuffled the music queue');

  const bad = await call(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: { ...track(5), uri: 'spotify:album:aaaaaaaaaaaaaaaaaaaaaa' } } });
  assert.equal(bad.status, 400);
  const search = await call(`/guilds/${GUILD}/music/search?q=hello`);
  assert.equal(search.status, 502);
  assert.match(((await search.json()) as any).error, /SPOTIFY_CLIENT_ID/);
  assert.match((await ok(`/guilds/${GUILD}/music/playlists`)).problem, /SPOTIFY_REFRESH_TOKEN/);
  const play = await call(`/guilds/${GUILD}/music/play`, { method: 'POST', json: { channelId: 'v1' } });
  assert.equal(play.status, 400);

  music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
  assert.deepEqual(music.queue, []);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Cleared the music queue');
  assert.equal((await call(`/guilds/${GUILD}/music/queue/shuffle`, { method: 'POST' })).status, 409, 'nothing to shuffle');
});

test('the page lists the Spotify account’s own playlists, and can shuffle one into the queue', async (t) => {
  Object.assign(config, { spotifyClientId: 'id', spotifyClientSecret: 'secret', spotifyRefreshToken: 'refresh' });
  t.after(() => {
    Object.assign(config, { spotifyClientId: null, spotifyClientSecret: null, spotifyRefreshToken: null });
    resetSpotify();
  });
  const LIST = 'pppppppppppppppppppppp';
  const songs = Array.from({ length: 150 }, (_, n) => ({ uri: `spotify:track:${String(n).padStart(22, 'b')}`, name: `Tune ${n}`, duration_ms: 1000, artists: [{ name: 'Band' }], album: { name: 'A', images: [] } }));
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === 'accounts.spotify.com') return Response.json({ access_token: 'x', expires_in: 3600 });
    if (url.host !== 'api.spotify.com') return realFetch(input, init);
    if (url.pathname === '/v1/me') return Response.json({ id: 'me' });
    if (url.pathname === '/v1/me/playlists') return Response.json({ items: [{ id: LIST, name: 'Road Trip', owner: { id: 'me' }, images: [], items: { total: 150 } }], next: null });
    if (url.pathname === `/v1/playlists/${LIST}`) return Response.json({ name: 'Road Trip' });
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return Response.json({ items: songs.slice(offset, offset + 100).map((item) => ({ item })), next: offset ? null : `https://api.spotify.com/v1/playlists/${LIST}/items?offset=100` });
  });
  assert.deepEqual(await ok(`/guilds/${GUILD}/music/playlists`), { playlists: [{ id: LIST, name: 'Road Trip', cover: null, songs: 150 }], problem: null });
  const music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { query: `spotify:playlist:${LIST}`, shuffle: true } });
  assert.equal(music.message, 'Added 100 random songs from Road Trip.');
  assert.ok(music.queue.some((r: any) => Number(r.title.slice(5)) >= 100), 'from all of it, not just the first 100');
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
});

test('Autoplay switches from the page, its songs say so, and the page’s songs go ahead of them', async () => {
  const track = (n: number) => ({ uri: `spotify:track:${String(n).padStart(22, 'b')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: null, durationMs: 180_000 });
  assert.equal((await ok(`/guilds/${GUILD}/music`)).autoplay, false);
  await ok(`/guilds/${GUILD}/settings/musicAutoplay`, { method: 'PUT', json: { value: true } });
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Set Autoplay to on');
  addTracks(GUILD, [{ ...track(1), uri: 'https://www.youtube.com/watch?v=ccccccccccc' }], AUTOPLAY);
  let music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(2) } });
  assert.equal(music.autoplay, true);
  assert.deepEqual(music.queue.map((r: any) => [r.title, r.addedBy, r.autoplay]), [['Song 2', 'Web UI', false], ['Song 1', 'Autoplay', true]]);
  await ok(`/guilds/${GUILD}/settings/musicAutoplay`, { method: 'PUT', json: { value: false } });
  music = await ok(`/guilds/${GUILD}/music`);
  assert.deepEqual([music.autoplay, music.queue.map((r: any) => r.title)], [false, ['Song 2']], 'turning it off takes its songs out');
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
});
