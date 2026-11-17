// Stats → Sounds & music: the soundboard, the music and speech over a range, from sound_plays, music_plays and
// speech_lines. Speech is counted by who, which voice and how, never by what was said, as the words aren't kept.
// People are only listed while they're members

import type { Guild } from 'discord.js';
import { db } from '../db.ts';
import { AUTOPLAY } from './music.ts';
import { countIn, stepsOf } from './overview.ts';
import { voiceName } from './say.ts';

const TOP = 10;

interface Window {
  since: number;
  until: number;
  /** where the stretch before starts, for ranges that aren't simply as long again */
  before?: number;
}

const soundRows = (guildId: string, since: number, until: number) =>
  db.prepare('SELECT user_id AS userId, name, played_at AS at FROM sound_plays WHERE guild_id = ? AND played_at >= ? AND played_at < ?').all(guildId, since, until) as {
    userId: string;
    name: string;
    at: number;
  }[];

const songRows = (guildId: string, since: number, until: number) =>
  db.prepare('SELECT at, title, artist, source, added_by AS addedBy, played_ms AS playedMs, skipped FROM music_plays WHERE guild_id = ? AND at >= ? AND at < ?').all(guildId, since, until) as {
    at: number;
    title: string;
    artist: string;
    source: string | null;
    addedBy: string;
    playedMs: number | null;
    skipped: number;
  }[];

const lineRows = (guildId: string, since: number, until: number) =>
  db.prepare('SELECT at, user_id AS userId, voice, kind FROM speech_lines WHERE guild_id = ? AND at >= ? AND at < ?').all(guildId, since, until) as {
    at: number;
    userId: string | null;
    voice: string;
    kind: 'say' | 'message' | 'announcement';
  }[];

/** When each kind of record starts, or null with none yet */
function firstOf(guildId: string) {
  const first = (sql: string) => (db.prepare(sql).get(guildId) as { at: number | null }).at;
  return {
    sounds: first('SELECT MIN(played_at) AS at FROM sound_plays WHERE guild_id = ?'),
    music: first('SELECT MIN(at) AS at FROM music_plays WHERE guild_id = ?'),
    speech: first('SELECT MIN(at) AS at FROM speech_lines WHERE guild_id = ?'),
  };
}

/** How many of each key, most first, the first `TOP` */
function tally<T>(rows: T[], keyOf: (row: T) => string | null) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP);
}

function totalsIn(guildId: string, since: number, until: number) {
  const sounds = soundRows(guildId, since, until);
  const songs = songRows(guildId, since, until);
  const lines = lineRows(guildId, since, until);
  return {
    sounds,
    songs,
    lines,
    totals: {
      sounds: sounds.length,
      songs: songs.length,
      listenedMs: songs.reduce((sum, s) => sum + (s.playedMs ?? 0), 0),
      skipped: songs.filter((s) => s.skipped).length,
      lines: lines.length,
    },
  };
}

export function soundStats(guild: Guild, { since, until, before: startBefore }: Window, timeZone: string, nameOf: (id: string) => string) {
  const isMember = (id: string | null) => id !== null && guild.members.cache.has(id);
  const from = firstOf(guild.id);
  const known = [from.sounds, from.music, from.speech].filter((at): at is number => at !== null);
  const recordsFrom = known.length ? Math.min(...known) : null;
  const here = totalsIn(guild.id, since, until);

  // The stretch just before, as long as this one. Each kind compares only once its records cover all of it
  const start = startBefore ?? since - (until - since);
  const end = Math.min(since, start + (until - since));
  const before = since > 0 && recordsFrom !== null && recordsFrom <= start ? totalsIn(guild.id, start, end).totals : null;
  const covered = (at: number | null) => at !== null && at <= start;
  const previous = before && {
    sounds: covered(from.sounds) ? before.sounds : null,
    songs: covered(from.music) ? before.songs : null,
    listenedMs: covered(from.music) ? before.listenedMs : null,
    lines: covered(from.speech) ? before.lines : null,
  };

  // Charts start at the first record, so the weeks before show as nothing rather than as quiet
  const first = recordsFrom === null ? since || until : Math.max(since, Math.min(recordsFrom, until));
  const steps = stepsOf(first, until, timeZone);
  const songKey = (s: { title: string; artist: string }) => `${s.title}\u0000${s.artist}`;
  const listened = new Map<string, number>();
  for (const s of here.songs) listened.set(songKey(s), (listened.get(songKey(s)) ?? 0) + (s.playedMs ?? 0));

  return {
    timeZone,
    since,
    until,
    from,
    totals: here.totals,
    previous,
    activity: {
      step: steps.step,
      times: steps.starts,
      until: steps.ends.at(-1) ?? until,
      sounds: countIn(here.sounds.map((s) => s.at), steps),
      songs: countIn(here.songs.map((s) => s.at), steps),
      lines: countIn(here.lines.map((l) => l.at), steps),
    },
    sounds: tally(here.sounds, (s) => s.name).map(([name, plays]) => ({ name, plays })),
    soundPeople: tally(here.sounds, (s) => (isMember(s.userId) ? s.userId : null)).map(([id, plays]) => ({ id, name: nameOf(id), plays })),
    songs: tally(here.songs, songKey).map(([key, plays]) => {
      const [title, artist] = key.split('\u0000');
      return { title, artist, plays, listenedMs: listened.get(key) ?? 0 };
    }),
    artists: tally(here.songs, (s) => s.artist || null).map(([name, plays]) => ({ name, plays })),
    // Who put the songs on: people, and Autoplay when the queue ran out
    djs: tally(here.songs, (s) => (s.addedBy === AUTOPLAY || isMember(s.addedBy) ? s.addedBy : null)).map(([id, songs]) => ({ id, name: id === AUTOPLAY ? 'Autoplay' : nameOf(id), songs })),
    sources: tally(here.songs, (s) => s.source ?? 'unknown').map(([source, songs]) => ({ source, songs })),
    voices: tally(here.lines, (l) => l.voice).map(([voice, lines]) => ({ voice, name: voiceName(voice) ?? voice, lines })),
    speakers: tally(here.lines, (l) => (isMember(l.userId) ? l.userId : null)).map(([id, lines]) => ({ id, name: nameOf(id), lines })),
    kinds: {
      say: here.lines.filter((l) => l.kind === 'say').length,
      message: here.lines.filter((l) => l.kind === 'message').length,
      announcement: here.lines.filter((l) => l.kind === 'announcement').length,
    },
  };
}
