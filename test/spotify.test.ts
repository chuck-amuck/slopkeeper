import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { isShortLink, MOST_FROM_LINK, parseLink, resetSpotify, search, SpotifyError, tracksFor } from '../src/spotify.ts';
import { queueFrom, queueOf } from '../src/features/music.ts';

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const apiTrack = (n: number, extra = {}) => ({
  uri: `spotify:track:${String(n).padStart(22, '0')}`,
  name: `Song ${n}`,
  duration_ms: 200_000 + n,
  artists: [{ name: 'Band' }, { name: 'Friend' }],
  album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/small', width: 64 }, { url: 'https://i.scdn.co/image/mid', width: 300 }] },
  ...extra,
});

/** Spotify's sign-in and Web API, answering from `routes` by path */
function fakeSpotify(t: TestContext, routes: Record<string, (url: URL) => unknown>) {
  const asked: string[] = [];
  let tokens = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.host === 'accounts.spotify.com') {
      tokens++;
      assert.equal((init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
      return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
    }
    assert.equal(url.host, 'api.spotify.com');
    asked.push(url.pathname + url.search);
    const route = routes[url.pathname];
    if (!route) return new Response('{}', { status: 404 });
    const body = route(url);
    return body instanceof Response ? body : Response.json(body);
  });
  return { asked, tokens: () => tokens };
}

beforeEach(() => {
  resetSpotify();
  config.spotifyClientId = 'id';
  config.spotifyClientSecret = 'secret';
});

test('reads song, album and playlist links and URIs, and nothing else', () => {
  assert.deepEqual(parseLink(`https://open.spotify.com/track/${ID}?si=abc`), { kind: 'track', id: ID });
  assert.deepEqual(parseLink(`https://open.spotify.com/intl-de/album/${ID}`), { kind: 'album', id: ID });
  assert.deepEqual(parseLink(`spotify:playlist:${ID}`), { kind: 'playlist', id: ID });
  assert.deepEqual(parseLink(`  https://open.spotify.com/embed/playlist/${ID}  `), { kind: 'playlist', id: ID });
  assert.equal(parseLink(`https://open.spotify.com/artist/${ID}`), null);
  assert.equal(parseLink(`https://evil.example/track/${ID}`), null);
  assert.equal(parseLink('never gonna give you up'), null);
  assert.equal(isShortLink('https://spotify.link/abc'), true);
});

test('search finds songs, with every artist and the smallest sharp cover, and skips what can’t play', async (t) => {
  const spotify = fakeSpotify(t, {
    '/v1/search': () => ({ tracks: { items: [apiTrack(1), apiTrack(2, { is_playable: false }), apiTrack(3)], next: null } }),
  });
  const found = await search('  some song ');
  assert.deepEqual(
    found.map((t) => t.title),
    ['Song 1', 'Song 3'],
  );
  assert.deepEqual(found[0], { uri: apiTrack(1).uri, title: 'Song 1', artist: 'Band, Friend', album: 'Album', cover: 'https://i.scdn.co/image/mid', durationMs: 200_001 });
  assert.match(spotify.asked[0], /^\/v1\/search\?type=track&limit=10&market=US&q=some%20song$/);
  await search('again');
  assert.equal(spotify.tokens(), 1, 'the token is kept until it runs out');
  assert.deepEqual(await search('   '), []);
});

test('an album or playlist link adds every song that can play, up to the limit', async (t) => {
  const many = Array.from({ length: 150 }, (_, n) => apiTrack(n));
  fakeSpotify(t, {
    [`/v1/albums/${ID}`]: () => ({ name: 'The Album', images: [{ url: 'https://i.scdn.co/image/album', width: 300 }], tracks: { items: many.slice(0, 50).map(({ album, ...rest }) => rest), next: `https://api.spotify.com/v1/albums/${ID}/tracks?offset=50` } }),
    [`/v1/albums/${ID}/tracks`]: () => ({ items: many.slice(50, 60).map(({ album, ...rest }) => rest), next: null }),
    [`/v1/playlists/${ID}`]: () => ({ name: 'The List' }),
    [`/v1/playlists/${ID}/items`]: (url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const items = [
        { item: { ...apiTrack(999), is_local: true, uri: 'spotify:local:a:b:c:1' } },
        { item: { ...apiTrack(998), uri: 'spotify:episode:abc' } },
        { item: null },
        ...many.slice(offset, offset + 100).map((track, n) => (n % 2 ? { item: track } : { track })),
      ];
      return { items, next: offset ? null : `https://api.spotify.com/v1/playlists/${ID}/items?offset=100` };
    },
  });
  const album = await tracksFor({ kind: 'album', id: ID });
  assert.equal(album.name, 'The Album');
  assert.equal(album.tracks.length, 60);
  assert.equal(album.tracks[0].cover, 'https://i.scdn.co/image/album', 'album songs carry the album’s cover');
  const list = await tracksFor({ kind: 'playlist', id: ID });
  assert.equal(list.name, 'The List');
  assert.equal(list.tracks.length, MOST_FROM_LINK - 3, 'local files, podcasts and gaps are left out');
  assert.ok(list.tracks.every((t) => t.uri.startsWith('spotify:track:')));
});

test('Spotify’s refusals become messages for whoever asked', async (t) => {
  config.spotifyClientId = '';
  await assert.rejects(search('x'), (err: Error) => err instanceof SpotifyError && /SPOTIFY_CLIENT_ID/.test(err.message));
  config.spotifyClientId = 'id';
  fakeSpotify(t, {
    '/v1/search': () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
  });
  await assert.rejects(search('x'), /Try again in 7 seconds/);
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /Daily Mixes/);
});

test('a link is added to the queue with what it was, and words add the top result', async (t) => {
  fakeSpotify(t, {
    [`/v1/tracks/${ID}`]: () => apiTrack(7),
    '/v1/search': () => ({ tracks: { items: [apiTrack(8)], next: null } }),
  });
  assert.equal(await queueFrom('sp', `https://open.spotify.com/track/${ID}`, 'u1', false), 'Added **Song 7**.');
  assert.equal(await queueFrom('sp', 'eight', 'u1', true), 'Added **Song 8 by Band, Friend**.');
  assert.deepEqual(
    queueOf('sp').map((r) => r.title),
    ['Song 8', 'Song 7'],
  );
  await assert.rejects(queueFrom('sp', 'https://spotify.link/abc', 'u1', false), /open\.spotify\.com/);
  await assert.rejects(queueFrom('sp', 'https://youtube.com/watch?v=1', 'u1', false), /isn’t a Spotify/);
});
