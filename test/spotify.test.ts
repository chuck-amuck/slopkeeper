import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { getKv } from '../src/db.ts';
import { isShortLink, MOST_FROM_LINK, myPlaylists, parseLink, resetSpotify, search, SpotifyError, tracksFor } from '../src/spotify.ts';
import { music, queueFrom, queueOf } from '../src/features/music.ts';
import { codeFrom, REDIRECT, signInLink } from '../src/spotify-sign-in.ts';

const ID = '4uLU6hMCjMI75M1A2tKUQC';
const apiTrack = (n: number, extra = {}) => ({
  uri: `spotify:track:${String(n).padStart(22, '0')}`,
  name: `Song ${n}`,
  duration_ms: 200_000 + n,
  artists: [{ name: 'Band' }, { name: 'Friend' }],
  album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/small', width: 64 }, { url: 'https://i.scdn.co/image/mid', width: 300 }] },
  ...extra,
});

/**
 * Spotify's sign-in and Web API, answering from `routes` by path. The app's access tokens are `token-N` and the owner's `owner-N`,
 * and `signIn` can answer the owner's sign-in instead, given the refresh token it was sent
 */
function fakeSpotify(t: TestContext, routes: Record<string, (url: URL) => unknown>, signIn?: (refreshToken: string) => Response | Record<string, unknown>) {
  const asked: string[] = [];
  const as: string[] = [];
  const refreshedWith: string[] = [];
  let tokens = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.host === 'accounts.spotify.com') {
      tokens++;
      assert.equal((init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') === 'client_credentials') return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
      assert.equal(body.get('grant_type'), 'refresh_token');
      refreshedWith.push(body.get('refresh_token')!);
      const answer = signIn?.(body.get('refresh_token')!) ?? { access_token: `owner-${tokens}`, expires_in: 3600 };
      return answer instanceof Response ? answer : Response.json(answer);
    }
    if (url.host === 'open.spotify.com') {
      asked.push(url.href);
      const route = routes[url.pathname];
      if (!route) return new Response('not found', { status: 404 });
      const body = route(url);
      return body instanceof Response ? body : new Response(String(body), { headers: { 'content-type': 'text/html' } });
    }
    assert.equal(url.host, 'api.spotify.com');
    asked.push(url.pathname + url.search);
    as.push((init.headers as Record<string, string>).authorization.replace(/^Bearer (\w+)-\d+$/, '$1'));
    const route = routes[url.pathname];
    if (!route) return new Response('{}', { status: 404 });
    const body = route(url);
    return body instanceof Response ? body : Response.json(body);
  });
  return { asked, as, refreshedWith, tokens: () => tokens };
}

beforeEach(() => {
  resetSpotify();
  config.spotifyClientId = 'id';
  config.spotifyClientSecret = 'secret';
  config.spotifyRefreshToken = null;
});

/** A playlist of `length` songs, served 100 at a time like Spotify does */
const playlistRoutes = (length: number, name = 'Road Trip') => {
  const songs = Array.from({ length }, (_, n) => apiTrack(n));
  return {
    [`/v1/playlists/${ID}`]: () => ({ name }),
    [`/v1/playlists/${ID}/items`]: (url: URL) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return { items: songs.slice(offset, offset + 100).map((item) => ({ item })), next: offset + 100 < length ? `https://api.spotify.com/v1/playlists/${ID}/items?offset=${offset + 100}` : null };
    },
  };
};

/** Spotify's embed player page for a public playlist, with `length` songs (it never lists more than 100) */
const embedPage = (length: number, name = 'Top Hits', extra: unknown[] = []) => {
  const trackList = [
    ...extra,
    ...Array.from({ length }, (_, n) => ({ uri: `spotify:track:${String(n).padStart(22, '0')}`, uid: `u${n}`, title: `Hit ${n}`, subtitle: 'Singer, Other', duration: 180_000 + n, isPlayable: true, entityType: 'track' })),
  ].slice(0, 100);
  const data = { props: { pageProps: { state: { data: { entity: { type: 'playlist', name, trackList } }, settings: {} } } } };
  return `<!DOCTYPE html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
};
const embedRoute = (page: () => unknown) => ({ [`/embed/playlist/${ID}`]: page });
/** What the embed page shows for a playlist that's private or gone */
const MISSING_PAGE = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { status: 404, title: 'Page not found' } } })}</script></html>`;

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
  config.spotifyRefreshToken = 'first';
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
  await assert.rejects(tracksFor({ kind: 'album', id: ID }), /couldn’t find that/);
});

test('any public playlist is read from Spotify’s embed player, with no sign-in, and a private one says so', async (t) => {
  config.spotifyClientId = '';
  config.spotifyClientSecret = '';
  const unplayable = [
    { uri: 'spotify:episode:abc', title: 'A podcast', subtitle: 'Host', duration: 1, entityType: 'episode' },
    { uri: `spotify:track:${'x'.repeat(22)}`, title: 'Gone', subtitle: 'Nobody', duration: 1, isPlayable: false },
    null,
  ];
  const spotify = fakeSpotify(t, embedRoute(() => embedPage(5, 'Today’s Top Hits', unplayable)));
  const list = await tracksFor({ kind: 'playlist', id: ID });
  assert.equal(list.name, 'Today’s Top Hits');
  assert.equal(list.capped, false);
  assert.deepEqual(list.tracks[0], { uri: `spotify:track:${'0'.repeat(22)}`, title: 'Hit 0', artist: 'Singer, Other', album: '', cover: null, durationMs: 180_000 });
  assert.deepEqual(
    list.tracks.map((s) => s.title),
    ['Hit 0', 'Hit 1', 'Hit 2', 'Hit 3', 'Hit 4'],
    'podcasts, unplayable songs and gaps are left out',
  );
  assert.deepEqual(spotify.asked, [`https://open.spotify.com/embed/playlist/${ID}`], 'no sign-in or Web API needed');
  assert.equal(spotify.tokens(), 0);

  t.mock.restoreAll();
  fakeSpotify(t, embedRoute(() => MISSING_PAGE));
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), (err: Error) => err instanceof SpotifyError && /may be private/.test(err.message));
  t.mock.restoreAll();
  fakeSpotify(t, {});
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /may be private/);

  // A change to Spotify's page fails with the same message, and is logged, unlike a missing playlist
  t.mock.restoreAll();
  const logged = t.mock.method(console, 'error', () => {});
  let page = '<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{}}}}}</script></html>';
  fakeSpotify(t, embedRoute(() => page));
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /may be private/);
  assert.equal(logged.mock.callCount(), 1);
  page = '<html>no data</html>';
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /may be private/);
  assert.equal(logged.mock.callCount(), 2);
  page = MISSING_PAGE;
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /may be private/);
  assert.equal(logged.mock.callCount(), 2);
  t.mock.restoreAll();
  fakeSpotify(t, embedRoute(() => new Response('', { status: 429 })));
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /Try again in a minute/);
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
  await assert.rejects(queueFrom('sp', 'https://vimeo.com/1', 'u1', false), /isn’t a Spotify/);
});

test('the owner’s own playlists are listed, and a new sign-in from Spotify is kept until the setting changes', async (t) => {
  config.spotifyRefreshToken = 'first';
  const playlist = (id: string, owner: string, extra = {}) => ({ id, name: `List ${id}`, owner: { id: owner }, images: [{ url: `https://i.scdn.co/image/${id}`, width: 300 }], items: { total: 7 }, ...extra });
  let handOut: string | undefined = 'second';
  const spotify = fakeSpotify(
    t,
    {
      '/v1/me': () => ({ id: 'me' }),
      '/v1/me/playlists': (url) =>
        url.searchParams.get('offset')
          ? { items: [playlist('d', 'me', { images: null, items: undefined, tracks: { total: 3 } })], next: null }
          : { items: [playlist('a', 'me'), playlist('b', 'someone'), playlist('c', 'someone', { collaborative: true }), null], next: 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50' },
    },
    () => {
      const answer = { access_token: 'owner-1', expires_in: 3600, ...(handOut && { refresh_token: handOut }) };
      handOut = undefined;
      return answer;
    },
  );
  const lists = await myPlaylists();
  assert.deepEqual(
    lists.map((p) => [p.id, p.songs]),
    [['a', 7], ['c', 7], ['d', 3]],
    'playlists someone else made can’t be read, so they’re left out',
  );
  assert.deepEqual(lists[0], { id: 'a', name: 'List a', cover: 'https://i.scdn.co/image/a', songs: 7 });
  assert.equal(lists[2].cover, null);
  assert.ok(spotify.as.every((who) => who === 'owner'));
  assert.ok(spotify.asked.includes('/v1/me/playlists?limit=50'));
  const askedSoFar = spotify.asked.length;
  await myPlaylists();
  assert.equal(spotify.asked.length, askedSoFar, 'the list is kept for a few minutes');

  resetSpotify();
  await myPlaylists();
  assert.deepEqual(spotify.refreshedWith, ['first', 'second'], 'the refresh token Spotify handed out replaces the setting’s');
  assert.ok(!getKv('spotifyRefreshToken')!.includes('first'), 'the setting itself isn’t stored');
  config.spotifyRefreshToken = 'signed in again';
  resetSpotify();
  await myPlaylists();
  assert.equal(spotify.refreshedWith.at(-1), 'signed in again', 'a new setting wins over the one kept');
});

test('playlists are read as the owner, picked at random from the whole list when shuffled, and others’ come from the embed player', async (t) => {
  config.spotifyRefreshToken = 'first';
  const spotify = fakeSpotify(t, playlistRoutes(350));
  const inOrder = await tracksFor({ kind: 'playlist', id: ID });
  assert.deepEqual(
    inOrder.tracks.map((s) => s.title),
    Array.from({ length: MOST_FROM_LINK }, (_, n) => `Song ${n}`),
  );
  assert.equal(spotify.asked.filter((a) => a.includes('/items')).length, 1, 'only as many pages as it needs');
  assert.ok(spotify.as.every((who) => who === 'owner'));

  const shuffled = await tracksFor({ kind: 'playlist', id: ID }, true);
  const numbers = shuffled.tracks.map((s) => Number(s.title.slice(5)));
  assert.equal(numbers.length, MOST_FROM_LINK);
  assert.equal(new Set(numbers).size, MOST_FROM_LINK, 'no song twice');
  assert.ok(numbers.some((n) => n >= 300), 'picked from the end of the list too');
  assert.notDeepEqual(numbers, [...numbers].sort((a, b) => a - b));

  t.mock.restoreAll();
  fakeSpotify(t, { ...playlistRoutes(5, 'Their Mix'), [`/v1/playlists/${ID}/items`]: () => new Response('{}', { status: 403 }), ...embedRoute(() => embedPage(3, 'Their Mix')) });
  assert.deepEqual((await tracksFor({ kind: 'playlist', id: ID })).tracks.map((s) => s.title), ['Hit 0', 'Hit 1', 'Hit 2'], 'someone else’s playlist');
  t.mock.restoreAll();
  fakeSpotify(t, embedRoute(() => embedPage(2, 'Top 50')));
  assert.equal((await tracksFor({ kind: 'playlist', id: ID })).name, 'Top 50', 'Spotify’s own, which the Web API can’t find');

  t.mock.restoreAll();
  resetSpotify();
  fakeSpotify(t, playlistRoutes(5), () => new Response('{"error":"invalid_grant"}', { status: 400 }));
  await assert.rejects(tracksFor({ kind: 'playlist', id: ID }), /Sign in to Spotify again and update SPOTIFY_REFRESH_TOKEN/);
});

test('shuffling a playlist into the queue says so, and a long one in order says shuffle reaches further', async (t) => {
  config.spotifyRefreshToken = 'first';
  fakeSpotify(t, playlistRoutes(250));
  assert.equal(await queueFrom('shuffled', `spotify:playlist:${ID}`, 'u1', false, true), `Added ${MOST_FROM_LINK} random songs from **Road Trip**.`);
  assert.equal(queueOf('shuffled').length, MOST_FROM_LINK);
  assert.equal(await queueFrom('in order', `https://open.spotify.com/playlist/${ID}`, 'u1', false), `Added ${MOST_FROM_LINK} songs from **Road Trip** (the first ${MOST_FROM_LINK}; shuffle picks from all of it).`);
  t.mock.restoreAll();
  fakeSpotify(t, playlistRoutes(20));
  assert.equal(await queueFrom('short', `spotify:playlist:${ID}`, 'u1', false, true), 'Added 20 random songs from **Road Trip**.');

  config.spotifyRefreshToken = null;
  t.mock.restoreAll();
  fakeSpotify(t, embedRoute(() => embedPage(150, 'All Out 80s')));
  assert.equal(await queueFrom('embed', `https://open.spotify.com/playlist/${ID}?si=abc`, 'u1', false), `Added ${MOST_FROM_LINK} songs from **All Out 80s** (the first ${MOST_FROM_LINK} Spotify shows).`);
  assert.equal(await queueFrom('embed shuffled', `spotify:playlist:${ID}`, 'u1', false, true), `Added ${MOST_FROM_LINK} random songs from **All Out 80s** (the first ${MOST_FROM_LINK} Spotify shows).`);
  const shuffled = queueOf('embed shuffled').map((r) => r.title);
  assert.equal(new Set(shuffled).size, MOST_FROM_LINK);
  assert.notDeepEqual(shuffled, queueOf('embed').map((r) => r.title));
  t.mock.restoreAll();
  fakeSpotify(t, embedRoute(() => embedPage(12, 'Short One')));
  assert.equal(await queueFrom('embed short', `spotify:playlist:${ID}`, 'u1', false), 'Added 12 songs from **Short One**.');
});

test('/music play suggests the owner’s matching playlists first, then songs', async (t) => {
  const offered = async (typed: string) => {
    let answer: { name: string; value: string }[] = [];
    await music.commands![0].autocomplete!({ options: { getFocused: () => typed }, respond: async (a: typeof answer) => void (answer = a) } as never);
    return answer;
  };
  fakeSpotify(t, {
    '/v1/me': () => ({ id: 'me' }),
    '/v1/me/playlists': () => ({ items: [{ id: 'p1', name: 'Road Trip', owner: { id: 'me' }, items: { total: 1 } }, { id: 'p2', name: 'Gym', owner: { id: 'me' }, items: { total: 40 } }], next: null }),
    '/v1/search': () => ({ tracks: { items: [apiTrack(1)], next: null } }),
  });
  assert.deepEqual(await offered('road'), [{ name: 'Song 1 – Band, Friend', value: apiTrack(1).uri }], 'without the sign-in, only songs');
  config.spotifyRefreshToken = 'first';
  assert.deepEqual(await offered('ROAD'), [
    { name: 'Playlist: Road Trip (1 song)', value: 'spotify:playlist:p1' },
    { name: 'Song 1 – Band, Friend', value: apiTrack(1).uri },
  ]);
  assert.deepEqual(await offered('g'), [{ name: 'Playlist: Gym (40 songs)', value: 'spotify:playlist:p2' }], 'too short to search songs, but enough for playlists');
});

test('signing in once asks only to read playlists, and takes the code only from this sign-in', () => {
  const link = new URL(signInLink('id', 'abc'));
  assert.equal(link.host, 'accounts.spotify.com');
  assert.equal(link.searchParams.get('scope'), 'playlist-read-private playlist-read-collaborative');
  assert.equal(link.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(link.searchParams.get('state'), 'abc');
  assert.equal(codeFrom(`  ${REDIRECT}?code=xyz&state=abc `, 'abc'), 'xyz');
  assert.throws(() => codeFrom(`${REDIRECT}?code=xyz&state=old`, 'abc'), /different sign-in/);
  assert.throws(() => codeFrom(`${REDIRECT}?error=access_denied&state=abc`, 'abc'), /access_denied/);
  assert.throws(() => codeFrom(link.href, 'abc'), /no code/);
  assert.throws(() => codeFrom('xyz', 'abc'), /whole address/);
});
