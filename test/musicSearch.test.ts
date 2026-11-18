import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { music, queueFrom, queueOf } from '../src/features/music.ts';
import { checkSetting } from '../src/features/setup.ts';
import { knownTrack, resetMusicSearch, searchReady, searchSongs, searchSource } from '../src/musicSearch.ts';
import { setSetting } from '../src/settings.ts';
import { resetSpotify } from '../src/spotify.ts';

const spotifySong = (n: number) => ({
  uri: `spotify:track:${String(n).padStart(22, '0')}`,
  name: `Spotify Song ${n}`,
  duration_ms: 200_000,
  artists: [{ name: 'Band' }],
  album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/mid', width: 300 }] },
});
const ytmSong = (id: string, extra = {}) => ({ id, title: `YTM ${id}`, artists: ['Band', 'Friend'], album: 'Record', albumId: 'MPREb_x', seconds: 194, explicit: false, cover: 'https://yt3.googleusercontent.com/abc=w300-h300-l90-rj', ...extra });

type Answer = 'none' | 'fail' | 'limited' | 'found';
/**
 * Spotify and the music container's YouTube Music search, each finding a song, nothing, failing, or (Spotify only)
 * asking the bot to wait two minutes, as `answers` says. What each was asked is kept
 */
function fakeServices(t: TestContext, answers: { spotify?: Answer; ytm?: Answer | 'gone' } = {}) {
  const asked = { spotify: [] as string[], ytm: [] as Record<string, unknown>[] };
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.host === 'accounts.spotify.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.host === 'api.spotify.com') {
      asked.spotify.push(url.searchParams.get('q')!);
      const how = answers.spotify ?? 'found';
      if (how === 'fail') return new Response('{}', { status: 500 });
      if (how === 'limited') return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
      return Response.json({ tracks: { items: how === 'found' ? [spotifySong(1)] : [], next: null } });
    }
    assert.equal(input, 'http://music.test/search');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer music-token');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    asked.ytm.push(body);
    const how = answers.ytm ?? 'found';
    if (how === 'gone') throw new TypeError('fetch failed');
    if (how === 'fail') return Response.json({ error: 'YouTube Music’s page didn’t have what was expected' }, { status: 502 });
    // One that isn't a video, or has no length, and a picture from somewhere else, are left out
    const results =
      how === 'found' ? [ytmSong('Bn-lcvrMOlc'), ytmSong('../evil'), ytmSong('nolength111', { seconds: null }), ytmSong('hO4-QAjkpSA', { cover: 'https://evil.test/x.jpg', album: null, seconds: 151 })] : [];
    return Response.json({ results });
  });
  return asked;
}

const GUILD = 'g-search';
beforeEach(() => {
  resetSpotify();
  resetMusicSearch();
  Object.assign(config, { spotifyClientId: 'id', spotifyClientSecret: 'secret', spotifyRefreshToken: null, musicUrl: 'http://music.test', musicToken: 'music-token' });
  setSetting(GUILD, 'musicSearch', undefined);
  setSetting(GUILD, 'musicSearchFallback', undefined);
});

test('Spotify is asked first, and YouTube Music only when Spotify fails or finds nothing', async (t) => {
  let asked = fakeServices(t);
  let searched = await searchSongs(GUILD, '  last   nite ');
  assert.deepEqual([searched.from, searched.found.map((s) => s.title), asked.ytm.length], ['spotify', ['Spotify Song 1'], 0]);
  assert.deepEqual(asked.spotify, ['last nite']);
  assert.equal(searchSource(GUILD), 'Spotify');

  t.mock.restoreAll();
  asked = fakeServices(t, { spotify: 'none' });
  searched = await searchSongs(GUILD, 'last nite');
  assert.equal(searched.from, 'youtube-music');
  assert.deepEqual(asked.ytm, [{ search: 'last nite', kind: 'song', limit: 10 }]);
  // Queued by its YouTube Music link, which plays as found, with every artist, and no picture from elsewhere
  assert.deepEqual(searched.found, [
    { uri: 'https://music.youtube.com/watch?v=Bn-lcvrMOlc', title: 'YTM Bn-lcvrMOlc', artist: 'Band, Friend', album: 'Record', cover: 'https://yt3.googleusercontent.com/abc=w300-h300-l90-rj', durationMs: 194_000 },
    { uri: 'https://music.youtube.com/watch?v=hO4-QAjkpSA', title: 'YTM hO4-QAjkpSA', artist: 'Band, Friend', album: '', cover: null, durationMs: 151_000 },
  ]);

  t.mock.restoreAll();
  fakeServices(t, { spotify: 'fail' });
  assert.equal((await searchSongs(GUILD, 'x')).from, 'youtube-music');
});

test('nothing found anywhere says where it looked, and both failing gives the first one’s reason', async (t) => {
  fakeServices(t, { spotify: 'none', ytm: 'none' });
  await assert.rejects(queueFrom(GUILD, 'zzzz', 'u1', false), /Nothing on Spotify or YouTube Music matches “zzzz”/);
  t.mock.restoreAll();
  fakeServices(t, { spotify: 'fail', ytm: 'none' });
  // Spotify might have had it, so they hear why it didn't answer
  await assert.rejects(queueFrom(GUILD, 'zzzz', 'u1', false), { message: 'Nothing on YouTube Music matches “zzzz”. Spotify didn’t answer (HTTP 500). Try again in a moment.' });
  t.mock.restoreAll();
  fakeServices(t, { spotify: 'fail', ytm: 'gone' });
  await assert.rejects(queueFrom(GUILD, 'zzzz', 'u1', false), /Spotify didn’t answer \(HTTP 500\)/);
});

test('when Spotify asks the bot to wait, it isn’t asked again until then, and YouTube Music answers', async (t) => {
  const asked = fakeServices(t, { spotify: 'limited' });
  const warned: string[] = [];
  t.mock.method(console, 'warn', (line: string) => void warned.push(line));
  assert.equal((await searchSongs(GUILD, 'one')).from, 'youtube-music');
  assert.equal((await searchSongs(GUILD, 'two')).from, 'youtube-music');
  assert.deepEqual(asked.spotify, ['one'], 'not asked while it’s waiting');
  // Said once, not for every search
  assert.deepEqual(warned, ['Music search: Spotify is making the bot wait 120 s, so YouTube Music was asked']);

  // Two minutes on, it's asked again
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 121_000 });
  await searchSongs(GUILD, 'three');
  assert.deepEqual(asked.spotify, ['one', 'three']);
});

test('with the fallback off, only the picked service is asked, and its reason is the answer', async (t) => {
  setSetting(GUILD, 'musicSearchFallback', false);
  const asked = fakeServices(t, { spotify: 'limited' });
  await assert.rejects(searchSongs(GUILD, 'one'), /Spotify is limiting the bot right now\. Try again in 120 seconds\./);
  await assert.rejects(searchSongs(GUILD, 'two'), /Try again in 1[12]\d seconds/);
  assert.equal(asked.ytm.length, 0);
  assert.equal(asked.spotify.length, 1);
});

test('YouTube Music can come first, with Spotify after it', async (t) => {
  setSetting(GUILD, 'musicSearch', 'youtube-music');
  assert.equal(searchSource(GUILD), 'YouTube Music');
  let asked = fakeServices(t);
  assert.equal((await searchSongs(GUILD, 'x')).from, 'youtube-music');
  assert.equal(asked.spotify.length, 0);
  t.mock.restoreAll();
  asked = fakeServices(t, { ytm: 'fail' });
  assert.equal((await searchSongs(GUILD, 'x')).from, 'spotify');
  t.mock.restoreAll();
  setSetting(GUILD, 'musicSearchFallback', false);
  fakeServices(t, { ytm: 'gone' });
  await assert.rejects(searchSongs(GUILD, 'x'), /YouTube Music didn’t answer the search/);
});

test('a service that isn’t set up is passed over, whatever’s picked', async (t) => {
  Object.assign(config, { spotifyClientId: null, spotifyClientSecret: null });
  setSetting(GUILD, 'musicSearchFallback', false);
  const asked = fakeServices(t);
  assert.equal(searchSource(GUILD), 'YouTube Music');
  assert.equal((await searchSongs(GUILD, 'x')).from, 'youtube-music');
  assert.equal(asked.spotify.length, 0);

  Object.assign(config, { musicUrl: null, musicToken: null });
  assert.equal(searchReady(), false);
  assert.equal(searchSource(GUILD), null);
  await assert.rejects(searchSongs(GUILD, 'x'), /Searching for music isn’t set up on this bot/);
});

test('suggestions ask only the first service, and a picked one is added as found', async (t) => {
  const offered = async (typed: string) => {
    let answer: { name: string; value: string }[] = [];
    await music.commands![0].autocomplete!({ guildId: GUILD, options: { getSubcommand: () => 'play', getFocused: () => typed }, respond: async (a: typeof answer) => void (answer = a) } as never);
    return answer;
  };
  setSetting(GUILD, 'musicSearch', 'youtube-music');
  const asked = fakeServices(t, { ytm: 'found' });
  const suggestions = await offered('last nite');
  assert.deepEqual(suggestions[0], { name: 'YTM Bn-lcvrMOlc – Band, Friend', value: 'https://music.youtube.com/watch?v=Bn-lcvrMOlc' });
  assert.deepEqual(await offered('https://www.youtube.com/watch?v=x'), [], 'a link isn’t searched for');

  // Picked, it's added as it was found, with its album and length, without asking again
  const before = asked.ytm.length;
  assert.equal(await queueFrom(GUILD, suggestions[0].value, 'u1', false), 'Added **YTM Bn-lcvrMOlc by Band, Friend**.');
  assert.equal(asked.ytm.length, before);
  const row = queueOf(GUILD).at(-1)!;
  assert.deepEqual([row.uri, row.album, row.duration_ms], ['https://music.youtube.com/watch?v=Bn-lcvrMOlc', 'Record', 194_000]);
  assert.ok(knownTrack('https://music.youtube.com/watch?v=Bn-lcvrMOlc'));

  // Suggestions don't wait on a second service: one that fails offers nothing
  t.mock.restoreAll();
  const failing = fakeServices(t, { ytm: 'fail' });
  assert.deepEqual(await offered('something else'), []);
  assert.equal(failing.spotify.length, 0);
});

test('suggestions go straight to YouTube Music while Spotify is making the bot wait', async (t) => {
  const asked = fakeServices(t, { spotify: 'limited' });
  await searchSongs(GUILD, 'first');
  const offered = async (typed: string) => {
    let answer: { name: string; value: string }[] = [];
    await music.commands![0].autocomplete!({ guildId: GUILD, options: { getSubcommand: () => 'play', getFocused: () => typed }, respond: async (a: typeof answer) => void (answer = a) } as never);
    return answer;
  };
  assert.equal((await offered('second'))[0]?.value, 'https://music.youtube.com/watch?v=Bn-lcvrMOlc');
  assert.deepEqual(asked.spotify, ['first']);
});

test('the settings take Spotify or YouTube Music, and on or off', () => {
  const guild = { id: GUILD } as never;
  assert.deepEqual(checkSetting(guild, 'musicSearch', 'youtube-music'), { value: 'youtube-music' });
  assert.deepEqual(checkSetting(guild, 'musicSearch', 'spotify'), { value: 'spotify' });
  assert.match((checkSetting(guild, 'musicSearch', 'tidal') as { error: string }).error, /Spotify or YouTube Music/);
  assert.deepEqual(checkSetting(guild, 'musicSearchFallback', false), { value: false });
});
