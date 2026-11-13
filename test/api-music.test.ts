import './helpers.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { config } from '../src/config.ts';
import { recentActivity } from '../src/activity.ts';
import { addTracks, AUTOPLAY, MOST_FILES_BYTES } from '../src/features/music.ts';
import { resetSpotify } from '../src/spotify.ts';
import { GUILD, call, guild, ok, refused, wav } from './apiFixture.ts';

// The music queue

test('a file from the page uploads, then goes in the queue with Play next or Add to end', async (t) => {
  const folder = path.join(process.env.DATA_DIR!, 'music-files');
  const leftovers = () => (existsSync(folder) ? readdirSync(folder) : []);
  const url = (name: string) => `/guilds/${GUILD}/music/file?name=${encodeURIComponent(name)}`;
  t.after(() => ok(`/guilds/${GUILD}/music/stop`, { method: 'POST' }));

  const { file } = await ok(url('My Song.wav'), { method: 'POST', body: wav(2) as BodyInit });
  assert.deepEqual([file.title, file.artist], ['My Song', 'Uploaded file']);
  assert.ok(Math.abs(file.durationMs - 2000) < 100, String(file.durationMs));
  assert.deepEqual(leftovers(), [file.id]);
  assert.deepEqual((await ok(`/guilds/${GUILD}/music`)).queue, [], 'it waits to be added');
  let music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { file: file.id } });
  assert.equal(music.message, 'Added My Song.');
  assert.deepEqual(
    music.queue.map((r: any) => [r.title, r.artist, r.uri, r.addedBy]),
    [['My Song', 'Uploaded file', `file:${file.id}`, 'Web UI']],
  );
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Added the file **My Song** to the music queue');
  assert.match(await refused(404, `/guilds/${GUILD}/music/queue`, { method: 'POST', json: { file: file.id } }), /upload is gone/);

  // Thrown away instead of added
  const other = (await ok(url('Other.wav'), { method: 'POST', body: wav(1) as BodyInit })).file;
  await ok(`/guilds/${GUILD}/music/file/${other.id}`, { method: 'DELETE' });
  assert.match(await refused(404, `/guilds/${GUILD}/music/file/${other.id}`, { method: 'DELETE' }), /upload is gone/);
  assert.deepEqual(leftovers(), [file.id]);
  // Taken out of the queue, it waits again for Undo to put it back, then can be thrown away
  await ok(`/guilds/${GUILD}/music/queue/${music.queue[0].id}`, { method: 'DELETE' });
  music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { file: file.id } });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['My Song']);
  await ok(`/guilds/${GUILD}/music/queue/${music.queue[0].id}`, { method: 'DELETE' });
  await ok(`/guilds/${GUILD}/music/file/${file.id}`, { method: 'DELETE' });
  assert.deepEqual(leftovers(), []);

  assert.match(await refused(400, url('notes.txt'), { method: 'POST', body: 'hello' }), /isn’t a file the bot can play/);
  assert.match(await refused(400, url('fake.mp3'), { method: 'POST', body: 'hello' }), /doesn’t have any audio/);
  const huge = 61 * 1024 * 1024;
  assert.match(await refused(400, url('huge.mp3'), { method: 'POST', headers: { 'content-length': String(huge) }, body: Buffer.alloc(huge) as BodyInit }), /over 60 MB/);
  // Sent in pieces, with no length up front, it's counted as it arrives
  const pieces = (chunks: Uint8Array[]) =>
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
  const big = Array.from({ length: 62 }, () => new Uint8Array(1024 * 1024));
  assert.match(await refused(413, url('huge.mp3'), { method: 'POST', body: pieces(big), duplex: 'half' } as RequestInit), /over 60 MB/);
  assert.deepEqual(leftovers(), [], 'nothing refused is kept');

  // Each server's uploads take 500 MB at most, counting those in the queue (this one takes no real room)
  const full = 'aaaaaaaaaaaaaaaa.mp3';
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, full), '');
  truncateSync(path.join(folder, full), MOST_FILES_BYTES - 1000);
  addTracks(GUILD, [{ uri: `file:${full}`, title: 'Long Mix', artist: 'Uploaded file', album: '', cover: null, durationMs: 60_000 }], 'u1');
  assert.match(await refused(400, url('more.wav'), { method: 'POST', body: wav(1) as BodyInit }), /500 MB for each server/);
  assert.match(await refused(400, url('more.wav'), { method: 'POST', body: pieces([new Uint8Array(wav(1))]), duplex: 'half' } as RequestInit), /500 MB for each server/, 'or once it’s arrived');
  assert.deepEqual(leftovers(), [full]);
  await ok(`/guilds/${GUILD}/music/stop`, { method: 'POST' });
  assert.deepEqual(leftovers(), [], 'stopping the music empties the queue and its files');
});

test('the music queue can be filled, reordered and emptied from the page', async () => {
  const track = (n: number) => ({ uri: `spotify:track:${String(n).padStart(22, 'a')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: 'https://evil.example/x.png', durationMs: 180_000 });
  let music = await ok(`/guilds/${GUILD}/music`);
  assert.deepEqual(music.queue, []);
  assert.equal(music.phase, 'stopped');
  assert.match(music.problem, /MUSIC_URL/);
  assert.equal(music.volume, 40);
  const before = music.version;
  for (const n of [1, 2, 3]) music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(n) } });
  assert.ok(before && music.version && music.version !== before, 'each answer says which version of the music it is, so the page can tell it from an older one');
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
  addTracks(GUILD, [{ ...track(3), uri: 'https://www.youtube.com/watch?v=ddddddddddd' }], AUTOPLAY);
  const [, one, three] = (await ok(`/guilds/${GUILD}/music`)).queue;
  assert.match(await refused(409, `/guilds/${GUILD}/music/queue/${three.id}/move`, { method: 'POST', json: { to: 0 } }), /one of Autoplay’s/);

  // Kept, one of Autoplay's songs joins the people's, after them
  music = await ok(`/guilds/${GUILD}/music/queue/${three.id}/keep`, { method: 'POST' });
  assert.equal(music.message, 'Added Song 3 to the queue.');
  assert.deepEqual(music.queue.map((r: any) => [r.title, r.addedBy, r.autoplay]), [['Song 2', 'Web UI', false], ['Song 3', 'Web UI', false], ['Song 1', 'Autoplay', true]]);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Added **Song 3** to the music queue from Autoplay');
  assert.match(await refused(404, `/guilds/${GUILD}/music/queue/${three.id}/keep`, { method: 'POST' }), /isn’t one of Autoplay’s/);

  await ok(`/guilds/${GUILD}/settings/musicAutoplay`, { method: 'PUT', json: { value: false } });
  music = await ok(`/guilds/${GUILD}/music`);
  assert.deepEqual([music.autoplay, music.queue.map((r: any) => r.title)], [false, ['Song 2', 'Song 3']], 'turning it off takes its songs out');
  assert.ok(!music.queue.some((r: any) => r.id === one.id));
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
});

test('Play next with nothing queued plays the song now, in the channel the page picked', async () => {
  const track = (n: number) => ({ uri: `spotify:track:${String(n).padStart(22, 'e')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: null, durationMs: 180_000 });
  const add = (n: number, json: Record<string, unknown>) => ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(n), ...json } });
  let music = await add(1, { next: true, channelId: 'v1' });
  assert.equal(music.message, 'Added Song 1 to play next. Join a voice channel in Discord, then press Play.', 'nobody’s in that channel');
  music = await add(2, { next: true, channelId: '701' });
  assert.equal(music.message, 'Added Song 2 to play next.', 'with a song already queued, it only goes first');
  music = await add(3, { channelId: '701' });
  assert.equal(music.message, 'Added Song 3.');
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
  music = await add(4, { next: true, channelId: '701' });
  assert.match(music.message, /^Added Song 4 to play next\. Music isn’t set up on this bot\./, 'it tried to play, which this bot can’t');
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
});
