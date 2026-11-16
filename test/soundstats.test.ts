import { GUILD, ok } from './apiFixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db.ts';
import { setSetting } from '../src/settings.ts';

// Stats → Sounds & music, and the Overview's calendar of days in voice

const HOUR = 3_600_000;
const DAY = 24 * HOUR;


const sound = (user: string, name: string, at: number) => db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)').run(GUILD, user, name, at);
const song = (title: string, artist: string, addedBy: string, at: number, playedMs: number, skipped = 0, source = 'youtube') =>
  db.prepare('INSERT INTO music_plays (guild_id, at, uri, title, artist, source, duration_ms, added_by, played_ms, skipped) VALUES (?, ?, ?, ?, ?, ?, 200000, ?, ?, ?)').run(GUILD, at, `uri:${title}`, title, artist, source, addedBy, playedMs, skipped);
const line = (user: string | null, voice: string, kind: string, at: number) => db.prepare('INSERT INTO speech_lines (guild_id, at, user_id, voice, characters, kind) VALUES (?, ?, ?, ?, 20, ?)').run(GUILD, at, user, voice, kind);

test('sounds, songs and lines are counted with who and what most, members only, and never what was said', async () => {
  const now = Date.now();
  sound('u1', 'airhorn', now - HOUR);
  sound('u1', 'airhorn', now - 2 * HOUR);
  sound('u2', 'bruh', now - 3 * HOUR);
  sound('gone', 'bruh', now - 4 * HOUR);
  song('Song A', 'Artist', 'u1', now - HOUR, 180_000);
  song('Song A', 'Artist', 'autoplay', now - 2 * HOUR, 200_000);
  song('Song B', 'Other', 'gone', now - 3 * HOUR, 10_000, 1, 'file');
  line('u2', 'glados', 'say', now - HOUR);
  line('u2', 'glados', 'message', now - 2 * HOUR);
  line(null, 'hal', 'announcement', now - 3 * HOUR);
  const data = await ok(`/guilds/${GUILD}/stats/sounds?period=week`);
  assert.deepEqual(data.totals, { sounds: 4, songs: 3, listenedMs: 390_000, skipped: 1, lines: 3 });
  assert.deepEqual(data.sounds, [
    { name: 'airhorn', plays: 2 },
    { name: 'bruh', plays: 2 },
  ]);
  assert.deepEqual(data.soundPeople, [
    { id: 'u1', name: 'Ana', plays: 2 },
    { id: 'u2', name: 'Ben', plays: 1 },
  ]);
  assert.deepEqual(data.songs[0], { title: 'Song A', artist: 'Artist', plays: 2, listenedMs: 380_000 });
  assert.deepEqual(data.djs, [
    { id: 'autoplay', name: 'Autoplay', songs: 1 },
    { id: 'u1', name: 'Ana', songs: 1 },
  ]);
  assert.deepEqual(data.sources, [
    { source: 'youtube', songs: 2 },
    { source: 'file', songs: 1 },
  ]);
  assert.deepEqual(data.voices, [
    { voice: 'glados', name: 'GLaDOS', lines: 2 },
    { voice: 'hal', name: 'HAL 9000', lines: 1 },
  ]);
  assert.deepEqual(data.speakers, [{ id: 'u2', name: 'Ben', lines: 2 }]);
  assert.deepEqual(data.kinds, { say: 1, message: 1, announcement: 1 });
  assert.equal(data.activity.sounds.reduce((a: number, b: number) => a + b, 0), 4);
  assert.doesNotMatch(JSON.stringify(data), /"text"|"words"/);
});

test('each kind compares with the stretch before only once its records cover it', async () => {
  const now = Date.now();
  sound('u1', 'airhorn', now - 20 * DAY);
  sound('u1', 'airhorn', now - 10 * DAY);
  sound('u1', 'airhorn', now - HOUR);
  song('Song A', 'Artist', 'u1', now - HOUR, 1000);
  const data = await ok(`/guilds/${GUILD}/stats/sounds?period=week`);
  assert.deepEqual(data.previous, { sounds: 1, songs: null, listenedMs: null, lines: null });
  assert.equal(data.from.speech, null);
  assert.ok(data.from.music > data.since);
  // Records that start partway through the stretch before: nothing to compare with
  assert.equal((await ok(`/guilds/${GUILD}/stats/sounds?period=month`)).previous, null);
});

test('the Overview has each day’s time in voice for ranges of two weeks to a year, and not per game', async () => {
  setSetting(GUILD, 'timezone', 'UTC');
  const now = Date.now();
  const midnight = now - (now % DAY);
  const session = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)").run(GUILD, midnight - 2 * DAY + 20 * HOUR, midnight - 2 * DAY + 22 * HOUR).lastInsertRowid;
  for (const user of ['u1', 'u2']) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, 7200)').run(session, user);
  // Records go back far enough for every day of the month
  db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)").run(GUILD, now - 60 * DAY, now - 60 * DAY + 1000);
  const { calendar } = await ok(`/guilds/${GUILD}/stats?period=month`);
  assert.ok(calendar.length >= 30 && calendar.length <= 31);
  const busy = calendar.filter((d: { ms: number }) => d.ms > 0);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].ms, 4 * HOUR);
  assert.equal(busy[0].day, new Date(midnight - 2 * DAY).toISOString().slice(0, 10));
  assert.equal(busy[0].end - busy[0].start, DAY);
  assert.equal((await ok(`/guilds/${GUILD}/stats?period=month&user=u1`)).calendar.find((d: { ms: number }) => d.ms).ms, 2 * HOUR);
  // The first day counts from its midnight, though the range starts partway through it
  db.exec('DELETE FROM session_members; DELETE FROM sessions');
  const start = now - 30 * DAY;
  const firstMidnight = start - (start % DAY);
  db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)").run(GUILD, now - 60 * DAY, now - 60 * DAY + 1000);
  const early = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)").run(GUILD, firstMidnight + 60_000, firstMidnight + HOUR + 60_000).lastInsertRowid;
  db.prepare("INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, 'u1', 3600)").run(early);
  const month = (await ok(`/guilds/${GUILD}/stats?period=month`)).calendar;
  assert.equal(month[0].start, firstMidnight);
  // Unless the range starts in its first minute, which it can't be sure of here
  if (start - firstMidnight > 2 * 60_000) assert.equal(month[0].ms, HOUR);
  for (const query of ['period=today', 'period=week', 'period=month&game=Valheim']) assert.equal((await ok(`/guilds/${GUILD}/stats?${query}`)).calendar, null, query);
});
