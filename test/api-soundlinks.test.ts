import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { LONGEST_PART, partProblem, resetDownloads } from '../src/features/soundLinks.ts';
import { GUILD, activityText, call, ok, panelEdits, refused, sounds, upload } from './apiFixture.ts';

// Sounds cut from part of a video or track that the music container downloads

const music = mkdtempSync(path.join(tmpdir(), 'slopkeeper-links-'));
const clips = path.join(music, 'clips');
mkdirSync(clips);
Object.assign(config, { musicUrl: 'http://music.test', musicToken: 'music-token', musicAudioDir: path.join(music, 'audio') });

/** A video of a tone, made once, and an audio-only track */
const VIDEO = 'TikTok-1.mp4';
const TRACK = 'Soundcloud-2.m4a';
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', path.join(clips, VIDEO)]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'aac', path.join(clips, TRACK)]);

const TIKTOK = 'https://www.tiktok.com/@someone/video/1';
const SOUNDCLOUD = 'https://soundcloud.com/someone/track';

/** Stands in for the music container. Returns the links it was asked for */
function fakeMusic(t: TestContext, answer: (url: string) => Response = (url) => Response.json(url === SOUNDCLOUD ? { file: TRACK, url, title: 'A Track', artist: 'Band', source: 'soundcloud', durationMs: 8000, video: false } : { file: VIDEO, url, title: 'A Clip', artist: 'Someone', source: 'tiktok', durationMs: 12000, video: true })) {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  resetDownloads();
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('http://music.test/')) return realFetch(url, init);
    assert.equal(String(url), 'http://music.test/clip');
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer music-token');
    const { url: link } = JSON.parse(init!.body as string);
    asked.push(link);
    return answer(link);
  });
  return asked;
}

const download = (url: string) => ok(`/guilds/${GUILD}/sound-links`, { method: 'POST', json: { url } });
const savePart = (id: string, json: Record<string, unknown>) => call(`/guilds/${GUILD}/sound-links/${id}`, { method: 'PUT', json: { discord: false, ...json } });

test('a link is downloaded, sent to the page, and a part of it saved as a sound that remembers where it came from', async (t) => {
  const asked = fakeMusic(t);
  const got = await download(TIKTOK);
  assert.equal(got.title, 'A Clip');
  assert.equal(got.video, true);
  assert.ok(Math.abs(got.seconds - 12) < 0.2, 'the length is read from the file');
  assert.deepEqual(asked, [TIKTOK]);

  const media = await call(`/guilds/${GUILD}/sound-links/${got.id}/media`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.ok((await media.arrayBuffer()).byteLength > 1000);
  const { peaks } = await ok(`/guilds/${GUILD}/sound-links/${got.id}/wave`);
  assert.ok(peaks.length >= 1990 && peaks.length <= 2001, `${peaks.length} peaks`);
  assert.equal(Math.max(...peaks), 1);
  assert.ok(peaks.every((p: number) => p >= 0 && p <= 1));

  const res = await savePart(got.id, { name: 'beep', start: 2, end: 4.5 });
  assert.deepEqual(await res.json(), { name: 'beep', replaced: false, discordProblem: null });
  const [sound] = await sounds();
  assert.equal(sound.name, 'beep');
  assert.ok(Math.abs(sound.seconds - 2.5) < 0.1, `kept ${sound.seconds} s`);
  assert.deepEqual(sound.link, { url: TIKTOK, title: 'A Clip', start: 2, end: 4.5 });
  assert.equal(sound.onDiscord, false);
  assert.ok(existsSync(path.join(process.env.DATA_DIR!, 'sounds', GUILD, 'beep.mp3')));
  assert.match(activityText().at(-1)!, /Added sound \*\*beep\*\* from 2\.5 s of “A Clip”/);
  assert.equal(panelEdits.length, 1);

  // Audio on its own is sent as audio
  const track = await download(SOUNDCLOUD);
  assert.equal(track.video, false);
  assert.equal((await call(`/guilds/${GUILD}/sound-links/${track.id}/media`)).headers.get('content-type'), 'audio/mp4');
});

test('a taken name has to be replaced or kept beside, and picking again replaces the sound with the new part', async (t) => {
  fakeMusic(t);
  const { id } = await download(TIKTOK);
  await savePart(id, { name: 'beep', start: 0, end: 1 });
  assert.match(await refused(409, `/guilds/${GUILD}/sound-links/${id}`, { method: 'PUT', json: { name: 'beep', start: 1, end: 2 } }), /already a sound called beep/);

  assert.equal(((await (await savePart(id, { name: 'beep', start: 1, end: 2, keep: true })).json()) as any).name, 'beep-2');
  const replaced = (await (await savePart(id, { name: 'beep', start: 3, end: 6, replace: true })).json()) as any;
  assert.equal(replaced.replaced, true);
  const beep = (await sounds()).find((s) => s.name === 'beep');
  assert.ok(Math.abs(beep.seconds - 3) < 0.1);
  assert.deepEqual([beep.link.start, beep.link.end], [3, 6]);
  const { sounds: binned } = await ok(`/guilds/${GUILD}/deleted-sounds`);
  assert.deepEqual(binned.map((s: any) => s.name), ['beep'], 'the old part is in Recently deleted');
  await ok(`/guilds/${GUILD}/deleted-sounds/${binned[0].id}/restore`, { method: 'POST' });
  const restored = (await sounds()).find((s) => s.name === 'beep-3');
  assert.deepEqual([restored.link.start, restored.link.end], [0, 1], 'with the part it was cut from');
});

test('a sound keeps its link through a rename, and loses it when a file replaces it or it’s deleted', async (t) => {
  fakeMusic(t);
  const { id } = await download(TIKTOK);
  await savePart(id, { name: 'beep', start: 0, end: 1 });
  await ok(`/guilds/${GUILD}/sounds/beep`, { method: 'PATCH', json: { name: 'boop' } });
  assert.equal((await sounds())[0].link.url, TIKTOK);
  assert.equal((await upload('boop', 'clip.wav', undefined, true)).status, 200);
  assert.equal((await sounds())[0].link, null);

  await savePart(id, { name: 'beep', start: 0, end: 1.5 });
  const { binId } = await ok(`/guilds/${GUILD}/sounds/beep`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sound_links WHERE name = ?').get('beep')!.n, 0);
  // Brought back, it can be picked again
  await ok(`/guilds/${GUILD}/deleted-sounds/${binId}/restore`, { method: 'POST' });
  assert.deepEqual((await sounds()).find((s) => s.name === 'beep').link, { url: TIKTOK, title: 'A Clip', start: 0, end: 1.5 });
});

test('a part outside the video, too short, too long or badly named is turned down', async (t) => {
  fakeMusic(t);
  const { id } = await download(TIKTOK);
  const why = (json: Record<string, unknown>) => refused(400, `/guilds/${GUILD}/sound-links/${id}`, { method: 'PUT', json: { name: 'beep', start: 0, end: 1, ...json } });
  assert.match(await why({ end: 13 }), /inside the video/);
  assert.match(await why({ start: 5, end: 4 }), /inside the video/);
  assert.match(await why({ start: '0' }), /numbers of seconds/);
  assert.match(await why({ end: 0.05 }), /at least/);
  assert.match(await why({ name: 'Bad Name' }), /lowercase/);
  assert.equal((await sounds()).length, 0);
  // Only a long video can have a part that's too long
  assert.equal(partProblem(0, LONGEST_PART + 1, 600), 'Keep at most 3 minutes.');
  assert.equal(partProblem(0, LONGEST_PART, 600), null);
});

test('a download the music container deleted is downloaded again to save it', async (t) => {
  const kept = path.join(music, 'kept.m4a');
  execFileSync('cp', [path.join(clips, TRACK), kept]);
  t.after(() => existsSync(path.join(clips, TRACK)) || execFileSync('cp', [kept, path.join(clips, TRACK)]));
  // Asked again, the music container downloads it again
  const asked = fakeMusic(t, (url) => {
    if (!existsSync(path.join(clips, TRACK))) execFileSync('cp', [kept, path.join(clips, TRACK)]);
    return Response.json({ file: TRACK, url, title: 'A Track', artist: 'Band', source: 'soundcloud', durationMs: 8000, video: false });
  });
  const { id } = await download(SOUNDCLOUD);
  rmSync(path.join(clips, TRACK));
  assert.match(await refused(404, `/guilds/${GUILD}/sound-links/${id}/media`), /has gone/);
  assert.equal((await savePart(id, { name: 'track', start: 1, end: 2 })).status, 200);
  assert.deepEqual(asked, [SOUNDCLOUD, SOUNDCLOUD]);
});

test('what the music container can’t get, an unknown download and a bad link each say so', async (t) => {
  fakeMusic(t, () => Response.json({ error: 'Instagram wouldn’t share that one without signing in.' }, { status: 404 }));
  assert.match(await refused(400, `/guilds/${GUILD}/sound-links`, { method: 'POST', json: { url: 'https://www.instagram.com/reel/x/' } }), /without signing in/);
  assert.match(await refused(400, `/guilds/${GUILD}/sound-links`, { method: 'POST', json: { url: 'ftp://example.com/x' } }), /https/);
  assert.match(await refused(404, `/guilds/${GUILD}/sound-links/nope/media`), /has gone/);
  assert.match(await refused(404, `/guilds/${GUILD}/sound-links/nope`, { method: 'PUT', json: { name: 'x', start: 0, end: 1 } }), /has gone/);
  assert.equal((await ok(`/guilds/${GUILD}/sounds`)).links.longest, LONGEST_PART);
});

test('the music container not answering says so, and without one, links aren’t offered', async (t) => {
  fakeMusic(t, () => {
    throw new TypeError('fetch failed');
  });
  assert.match(await refused(400, `/guilds/${GUILD}/sound-links`, { method: 'POST', json: { url: TIKTOK } }), /isn’t answering/);
  t.after(() => Object.assign(config, { musicUrl: 'http://music.test' }));
  config.musicUrl = null;
  assert.equal((await ok(`/guilds/${GUILD}/sounds`)).links, null);
  assert.match(await refused(400, `/guilds/${GUILD}/sound-links`, { method: 'POST', json: { url: TIKTOK } }), /needs the music container/);
});
