import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { db, getKv, setKv, transaction } from '../db.ts';
import { durationOf, hasAudio } from '../discordSounds.ts';
import { idSetting } from '../settings.ts';
import { coverFor, isShortLink, MOST_FROM_LINK, myPlaylists, parseLink, playlistsReady, RateLimited, search, searchReady, SpotifyError, tracksFor, type Track } from '../spotify.ts';
import type { Feature } from '../types.ts';
import { humansIn } from '../util.ts';
import { botChannelId, EXTENSIONS, onPlaybackStop, playLong } from './soundboard.ts';

// Jumping within a song stops this far short of its end, which would only end it
const END_SLACK_MS = 6_000;
// Finding a song and downloading it takes seconds; this is for when YouTube is struggling
const FETCH_TIMEOUT_MS = 3 * 60_000;
export const MOST_QUEUED = 500;
/** Album covers looked up at once, for songs added without one */
const COVER_LOOKUPS = 4;
const SHOWN_IN_DISCORD = 10;
// A file played once from the web page, which can be a whole song or a mix
export const MOST_FILE_BYTES = 60 * 1024 * 1024;
// A jump within a file stops this far short of its end, which would only stop it
const FILE_END_SLACK_MS = 500;
const LONGEST_FILE_MS = 20 * 60_000;
const SAFE_FILE = /^[\w.-]+$/;
const OTHER_LINK = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be|soundcloud\.com)\//i;
// Where the music was, kept so a restart or redeploy carries on from there
const SAVED_KEY = 'musicSessions';
const SAVE_EVERY_MS = 5_000;
// After longer than this, carrying on would surprise whoever's still around
const RESUME_WITHIN_MS = 10 * 60_000;
// The music container restarts alongside the bot, and the music waits this long for it
const READY_WAIT_MS = 3 * 60_000;
const READY_CHECK_MS = 1_000;

export interface QueueRow {
  id: number;
  guild_id: string;
  pos: number;
  /** A Spotify song's URI, or the YouTube or SoundCloud link it was added by */
  uri: string;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  duration_ms: number;
  added_by: string;
  added_at: number;
}

/** What the music container reports: whether yt-dlp is ready */
export interface PlayerStatus {
  youtube?: { ready: boolean; version: string | null; message: string } | null;
}

interface Position {
  ms: number;
  at: number;
  speed: number;
}

/** Music playing, or paused, in one server */
interface Session {
  guild: Guild;
  channelId: string;
  phase: 'starting' | 'playing' | 'paused';
  /** The queue row being played */
  current: QueueRow;
  /** Where the song playing came from: youtube or soundcloud */
  via: string | null;
  /** Counts each change of what's playing, so a download or an ending from before it is ignored */
  turn: number;
  position: Position;
  stopAudio?: () => void;
  /** Why it stopped or skipped by itself, for the web page */
  note: string | null;
}

const sessions = new Map<string, Session>();
let status: PlayerStatus | null = null;
/** Why the music container can't be reached, while it can't */
let unreachable: string | null = null;
let listening: AbortController | undefined;
let saver: NodeJS.Timeout | undefined;

// ---------- the queue ----------

export function queueOf(guildId: string): QueueRow[] {
  return db.prepare('SELECT * FROM music_queue WHERE guild_id = ? ORDER BY pos, id').all(guildId) as unknown as QueueRow[];
}

/** Whether the first row is the song playing (or paused), which stays put while the rest move around it */
const holdsFirst = (guildId: string) => sessions.has(guildId);

/** Adds songs to the end, or after the song playing with `next`. Returns how many fitted */
export function addTracks(guildId: string, tracks: Track[], who: string, next = false): number {
  const rows = queueOf(guildId);
  const room = Math.max(0, MOST_QUEUED - rows.length);
  const adding = tracks.slice(0, room);
  if (!adding.length) return 0;
  const after = next ? (holdsFirst(guildId) ? 1 : 0) : rows.length;
  const before = rows[after - 1]?.pos ?? (rows[0]?.pos ?? 1) - 1;
  const following = rows[after]?.pos ?? before + adding.length + 1;
  const step = (following - before) / (adding.length + 1);
  const insert = db.prepare(
    'INSERT INTO music_queue (guild_id, pos, uri, title, artist, album, cover, duration_ms, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  transaction(() => {
    adding.forEach((t, i) => insert.run(guildId, before + step * (i + 1), t.uri, t.title, t.artist, t.album, t.cover, t.durationMs, who, Date.now()));
    renumber(guildId);
  });
  fetchNext(guildId);
  if (adding.some((t) => !t.cover)) void fillCovers();
  return adding.length;
}

// ---------- album covers ----------

/** Songs Spotify says have no cover, which aren't asked about again until a restart */
const coverless = new Set<string>();
let filling: Promise<void> | undefined;
let lookAgain = false;

/**
 * Fills in covers for queued Spotify songs without one, such as those from a playlist link, the front of each queue first. One run at a
 * time across all servers; a call during a run makes it look again afterwards. Resolves when nothing is left to fill
 */
export function fillCovers(): Promise<void> {
  if (!config.musicUrl || !config.musicToken) return Promise.resolve();
  if (filling) {
    lookAgain = true;
    return filling;
  }
  filling = (async () => {
    do {
      lookAgain = false;
      const waitSeconds = await fillSome();
      if (waitSeconds) {
        await sleep(Math.min(waitSeconds, 600) * 1000, undefined, { ref: false });
        lookAgain = true;
      }
    } while (lookAgain && !exiting);
  })()
    .catch((err: unknown) => console.error('Music: couldn’t fill in album covers:', err))
    .finally(() => (filling = undefined));
  return filling;
}

/** Waits for covers being filled in, without asking for another look */
export const coversFilled = () => filling ?? Promise.resolve();

/** One pass over the songs missing a cover. Returns how long Spotify asked to wait, or 0 */
async function fillSome(): Promise<number> {
  const rows = db
    .prepare("SELECT uri FROM music_queue WHERE cover IS NULL AND uri LIKE 'spotify:track:%' GROUP BY uri ORDER BY MIN(pos), MIN(id)")
    .all() as unknown as { uri: string }[];
  const uris = rows.map((r) => r.uri).filter((uri) => !coverless.has(uri));
  const update = db.prepare('UPDATE music_queue SET cover = ? WHERE uri = ? AND cover IS NULL');
  let next = 0;
  let waitSeconds = 0;
  const worker = async () => {
    while (next < uris.length && !waitSeconds && !exiting) {
      const uri = uris[next++]!;
      try {
        const cover = await coverFor(uri);
        if (cover) update.run(cover, uri);
        else coverless.add(uri);
      } catch (err) {
        // Anything else (a timeout, Spotify down) is tried again the next time songs are added
        if (err instanceof RateLimited) waitSeconds = Math.max(waitSeconds, err.retryAfterSeconds);
      }
    }
  };
  await Promise.all(Array.from({ length: COVER_LOOKUPS }, worker));
  return waitSeconds;
}

/** Spreads positions out again, so there's always room between two rows */
function renumber(guildId: string) {
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  transaction(() => queueOf(guildId).forEach((row, i) => update.run(i, row.id)));
}

/** Moves a song to a place in the queue. The song playing stays first */
export function moveTrack(guildId: string, id: number, to: number): boolean {
  const rows = queueOf(guildId);
  const from = rows.findIndex((r) => r.id === id);
  const first = holdsFirst(guildId) ? 1 : 0;
  if (from < first) return false;
  const [row] = rows.splice(from, 1);
  rows.splice(Math.max(first, Math.min(rows.length, Math.trunc(to))), 0, row);
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  transaction(() => rows.forEach((r, i) => update.run(i, r.id)));
  fetchNext(guildId);
  return true;
}

/** Puts the queue in a random order, leaving the song playing where it is. Returns how many songs were shuffled */
export function shuffleQueue(guildId: string, who: string): number {
  const rows = queueOf(guildId);
  const first = holdsFirst(guildId) ? 1 : 0;
  const rest = rows.slice(first);
  if (rest.length < 2) return 0;
  for (let n = rest.length - 1; n > 0; n--) {
    const k = Math.floor(Math.random() * (n + 1));
    [rest[n], rest[k]] = [rest[k], rest[n]];
  }
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  transaction(() => [...rows.slice(0, first), ...rest].forEach((r, i) => update.run(i, r.id)));
  fetchNext(guildId);
  logActivity(guildId, who, 'Shuffled the music queue');
  return rest.length;
}

/** Takes a song out of the queue. Taking out the one playing skips it */
export async function removeTrack(guildId: string, id: number, who: string): Promise<QueueRow | null> {
  const row = queueOf(guildId).find((r) => r.id === id);
  if (!row) return null;
  const s = sessions.get(guildId);
  if (s?.current.id === id) await moveOn(s);
  else db.prepare('DELETE FROM music_queue WHERE id = ?').run(id);
  logActivity(guildId, who, `Removed **${row.title}** from the music queue`);
  fetchNext(guildId);
  return row;
}

/** Empties the queue, apart from the song playing */
export function clearQueue(guildId: string, who: string) {
  const keep = sessions.get(guildId)?.current.id ?? -1;
  db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND id != ?').run(guildId, keep);
  logActivity(guildId, who, 'Cleared the music queue');
}

// ---------- the music container ----------

// The song playing, or first to play, and the one after it
const FETCHED_AHEAD = 2;
const ASKED_AHEAD_MS = 10 * 60_000;
const askedAhead = new Set<string>();

const asBridge = () => ({ authorization: `Bearer ${config.musicToken}`, 'content-type': 'application/json' });

/** Asks the music container something about YouTube. A 404 is "not found", with the reason; anything else that isn't fine throws */
async function askYoutube(where: '/fetch' | '/lookup', body: Record<string, unknown>): Promise<Record<string, unknown> & { missing?: string }> {
  const res = await fetch(`${config.musicUrl}${where}`, { method: 'POST', headers: asBridge(), body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 404) return { missing: String(answer.error ?? 'Not found.') };
  if (!res.ok) throw new Error(String(answer.error ?? `HTTP ${res.status}`));
  return answer;
}

/** The audio for a song: a file the music container downloaded, or why there isn't one */
async function fetchAudio(row: QueueRow): Promise<{ file: string; source: string } | { missing: string }> {
  const answer = await askYoutube('/fetch', row.uri.startsWith('spotify:') ? { uri: row.uri, title: row.title, artist: row.artist, durationMs: row.duration_ms } : { url: row.uri });
  if (answer.missing) return { missing: answer.missing };
  if (typeof answer.file !== 'string' || !SAFE_FILE.test(answer.file)) throw new Error('the music container named the file oddly');
  return { file: path.join(config.musicAudioDir, answer.file), source: String(answer.source ?? 'youtube') };
}

/** Starts downloading the first two songs in the queue, so pressing play, and the song after, start without a wait */
function fetchNext(guildId: string) {
  if (unavailable()) return;
  for (const row of queueOf(guildId).slice(0, FETCHED_AHEAD)) {
    // The music container keeps what it downloads, but not what it couldn't find, so each is only asked about once in a while
    if (askedAhead.has(row.uri)) continue;
    askedAhead.add(row.uri);
    setTimeout(() => askedAhead.delete(row.uri), ASKED_AHEAD_MS).unref();
    void fetchAudio(row).catch((err: unknown) => console.error(`Music: couldn’t fetch ${row.title} ahead:`, (err as Error).message));
  }
}

/** Follows the music container's events for as long as the bot runs, reconnecting when it drops */
async function listen(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${config.musicUrl}/events`, { headers: { authorization: `Bearer ${config.musicToken}` }, signal });
      if (res.status === 401) throw new Error('the music container turned down MUSIC_TOKEN');
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      unreachable = null;
      let buffer = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || !data) continue;
          if (event === 'status') onStatus(JSON.parse(data) as PlayerStatus);
        }
      }
      throw new Error('the connection closed');
    } catch (err) {
      if (signal.aborted) return;
      const reason = (err as Error).message;
      if (unreachable !== reason) console.error(`Music container unreachable: ${reason}`);
      unreachable = reason;
      status = null;
      await sleep(5_000, undefined, { signal }).catch(() => {});
    }
  }
}

/** The music container's status changed. Exported for tests, which have no container to follow */
export function onStatus(next: PlayerStatus) {
  status = next;
}

// ---------- playing ----------

/** Why music can't play right now, or null if it can */
export function unavailable(): string | null {
  if (!config.musicUrl || !config.musicToken) return 'Music isn’t set up on this bot. It needs MUSIC_URL and MUSIC_TOKEN.';
  if (unreachable || !status) return 'The music player isn’t answering. Check that the music container is running.';
  if (!status.youtube?.ready) return status.youtube?.message ? `The music player can’t reach YouTube: ${status.youtube.message}` : 'The music player is still starting. Try again in a moment.';
  return null;
}


/** Where the song playing has got to, in milliseconds */
const positionOf = (s: Session) => s.position.ms + Math.max(0, Date.now() - s.position.at) * s.position.speed;
const channelOf = (s: Session) => {
  const channel = s.guild.channels.cache.get(s.channelId);
  return channel?.isVoiceBased() ? channel : undefined;
};

/** Starts the queue in a channel, or carries on where it paused. Returns null on success or the reason it couldn't, for the user */
export async function startMusic(guild: Guild, channel: VoiceBasedChannel): Promise<string | null> {
  const problem = unavailable();
  if (problem) return problem;
  const first = queueOf(guild.id)[0];
  if (!first) return 'The queue is empty. Add a song first.';
  // The music takes over from a file, rather than playing on top of it
  stopFile(guild.id);
  let s = sessions.get(guild.id);
  if (s && s.phase !== 'paused' && s.channelId === channel.id) return null;
  const carryOn = s?.current.id === first.id ? positionOf(s) : 0;
  if (s) Object.assign(s, { channelId: channel.id, note: null, current: first });
  else {
    s = { guild, channelId: channel.id, phase: 'starting', current: first, via: null, turn: 0, position: { ms: 0, at: Date.now(), speed: 0 }, note: null };
    sessions.set(guild.id, s);
  }
  return playCurrent(s, carryOn);
}

/** Plays the current song from `fromMs`, from YouTube or SoundCloud */
async function playCurrent(s: Session, fromMs = 0): Promise<string | null> {
  const turn = ++s.turn;
  const row = s.current;
  s.phase = 'starting';
  stopAudioOf(s);
  let found: Awaited<ReturnType<typeof fetchAudio>>;
  try {
    found = await fetchAudio(row);
  } catch (err) {
    if (s.turn !== turn) return null;
    console.error(`Music: couldn’t get ${row.title}:`, (err as Error).message);
    pauseHere(s, `The music player couldn’t get ${row.title}, so the music paused. Try again in a moment.`);
    return `The music player couldn’t get ${row.title}. Try again in a moment.`;
  }
  if (s.turn !== turn || sessions.get(s.guild.id) !== s) return null;
  if ('missing' in found) {
    const note = `Couldn’t find ${row.title} on YouTube or SoundCloud, so it was skipped.`;
    const next = await moveOn(s);
    if (sessions.get(s.guild.id) !== s) return note;
    // The next song's own problem says more than this one being skipped
    if (next) return next;
    s.note ??= note;
    return null;
  }
  const channel = channelOf(s);
  const stop = channel ? await playLong(channel, found.file, (byItself) => onSongEnd(s, turn, byItself), fromMs) : 'That voice channel is gone.';
  if (s.turn !== turn) {
    if (typeof stop !== 'string') stop();
    return null;
  }
  if (typeof stop === 'string') {
    s.phase = 'paused';
    s.position = { ms: fromMs, at: Date.now(), speed: 0 };
    return stop;
  }
  Object.assign(s, { stopAudio: stop, via: found.source, phase: 'playing', position: { ms: fromMs, at: Date.now(), speed: 1 } });
  saveSessions();
  fetchNext(s.guild.id);
  return null;
}

/** A song from a file is over: it ended, so the next one plays, or it was cut off, so the music pauses */
function onSongEnd(s: Session, turn: number, byItself: boolean) {
  if (s.turn !== turn || sessions.get(s.guild.id) !== s) return;
  s.stopAudio = undefined;
  if (byItself && s.phase === 'playing') void moveOn(s);
  else if (s.phase !== 'paused') pauseHere(s, null);
}

function stopAudioOf(s: Session) {
  const stop = s.stopAudio;
  s.stopAudio = undefined;
  stop?.();
}

/** Pauses, keeping the queue. `note` says why, when it wasn't someone asking */
function pauseHere(s: Session, note: string | null) {
  s.turn++;
  s.phase = 'paused';
  s.note = note;
  s.position = { ms: positionOf(s), at: Date.now(), speed: 0 };
  stopAudioOf(s);
  saveSessions();
}

export function pauseMusic(guildId: string): string | null {
  const s = sessions.get(guildId);
  if (!s || s.phase === 'paused') return 'Nothing is playing.';
  pauseHere(s, null);
  return null;
}

/** Jumps to `ms` into the song playing, or to there for when it's resumed. Returns null on success, or why it couldn't */
export async function seekMusic(guildId: string, ms: number): Promise<string | null> {
  const s = sessions.get(guildId);
  if (!s) return 'Nothing is playing.';
  // Not right up to the end, which would only skip it
  const to = Math.round(Math.max(0, Math.min(ms, s.current.duration_ms - END_SLACK_MS)));
  if (s.phase === 'paused') {
    s.position = { ms: to, at: Date.now(), speed: 0 };
    return null;
  }
  // Playing, or still starting, maybe from an earlier seek: it starts again from here
  return playCurrent(s, to);
}

/** Ends the current song early. Returns null on success, or why it couldn't */
export async function skipMusic(guildId: string, who: string): Promise<string | null> {
  const s = sessions.get(guildId);
  if (!s) return 'Nothing is playing.';
  logActivity(guildId, who, `Skipped **${s.current.title}**`);
  await moveOn(s);
  return null;
}

/** Stops the music and empties the queue */
export function stopMusic(guildId: string, who: string) {
  const s = sessions.get(guildId);
  if (s) endSession(s);
  db.prepare('DELETE FROM music_queue WHERE guild_id = ?').run(guildId);
  logActivity(guildId, who, 'Stopped the music and cleared the queue');
}

/** Goes on to the next song in the queue, or stops once there isn't one. Returns why the next song couldn't play, if it couldn't */
async function moveOn(s: Session): Promise<string | null> {
  db.prepare('DELETE FROM music_queue WHERE id = ?').run(s.current.id);
  const next = queueOf(s.guild.id)[0];
  if (!next) {
    endSession(s);
    return null;
  }
  s.current = next;
  s.note = null;
  if (s.phase === 'paused') {
    // It starts from the top of the new song once someone presses play
    s.turn++;
    s.position = { ms: 0, at: Date.now(), speed: 0 };
    return null;
  }
  return playCurrent(s);
}

function endSession(s: Session) {
  s.turn++;
  stopAudioOf(s);
  if (sessions.get(s.guild.id) === s) sessions.delete(s.guild.id);
  saveSessions();
}

// ---------- carrying on after a restart ----------

interface SavedSession {
  guildId: string;
  channelId: string;
  /** The queue row playing, which has to still be first for the music to carry on */
  songId: number;
  positionMs: number;
  playing: boolean;
  at: number;
}

/** Once the bot is exiting, the place it saved last is the one to keep, rather than the pauses that leaving voice causes */
let exiting = false;
let wroteNone = false;

/** Keeps where the music is in each server, so a restart carries on from there. Skips writing while nothing has been playing */
function saveSessions() {
  if (exiting) return;
  const saved: SavedSession[] = [...sessions.values()].map((s) => ({
    guildId: s.guild.id,
    channelId: s.channelId,
    songId: s.current.id,
    positionMs: Math.round(Math.max(0, Math.min(positionOf(s), s.current.duration_ms))),
    playing: s.phase !== 'paused',
    at: Date.now(),
  }));
  if (!saved.length && wroteNone) return;
  wroteNone = !saved.length;
  setKv(SAVED_KEY, JSON.stringify(saved));
}

/** Carries the music on where it was before the bot restarted: playing again if it was playing and someone's still listening, or paused at the same place */
export async function resumeAfterRestart(client: Client): Promise<void> {
  const raw = getKv(SAVED_KEY);
  if (!raw) return;
  setKv(SAVED_KEY, '[]');
  let saved: SavedSession[];
  try {
    saved = JSON.parse(raw) as SavedSession[];
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  await Promise.all(saved.map((entry) => resumeOne(client, entry)));
}

async function resumeOne(client: Client, saved: SavedSession) {
  const guild = client.guilds?.cache.get(saved.guildId);
  const didnt = (why: string) => console.log(`Music: didn’t carry on in ${guild?.name ?? saved.guildId} after the restart: ${why}`);
  if (!guild) return didnt('the bot isn’t in that server');
  if (Date.now() - saved.at > RESUME_WITHIN_MS) return didnt('the music stopped too long ago');
  if (sessions.has(guild.id)) return;
  const first = queueOf(guild.id)[0];
  if (!first || first.id !== saved.songId) return didnt('its song isn’t first in the queue any more');
  const channel = guild.channels.cache.get(saved.channelId);
  if (!channel?.isVoiceBased()) return didnt('its voice channel is gone');
  const positionMs = Math.min(Math.max(0, Number(saved.positionMs) || 0), first.duration_ms);
  // Paused at the same place, so pressing play carries on from there
  const s: Session = { guild, channelId: channel.id, phase: 'paused', current: first, via: null, turn: 0, position: { ms: positionMs, at: Date.now(), speed: 0 }, note: null };
  sessions.set(guild.id, s);
  saveSessions();
  if (!saved.playing) return;
  const until = Date.now() + READY_WAIT_MS;
  while (unavailable() && Date.now() < until) await sleep(READY_CHECK_MS);
  // Someone pressed play, skipped or stopped meanwhile
  if (sessions.get(guild.id) !== s || s.turn !== 0 || s.phase !== 'paused') return;
  const problem = unavailable();
  if (problem) {
    s.note = 'The bot restarted and the music player didn’t come back in time, so the music paused.';
    return didnt(problem);
  }
  if (!humansIn(channel).length) {
    s.note = `The bot restarted while nobody was in ${channel.name}, so the music paused.`;
    return didnt(`nobody is in #${channel.name}`);
  }
  const failed = await startMusic(guild, channel);
  if (failed) return didnt(failed);
  console.log(`Music: carried on ${first.title} in #${channel.name} from ${time(positionMs)} after the restart`);
}

// ---------- a file, played once ----------

interface PlayingFile {
  name: string;
  file: string;
  channel: VoiceBasedChannel;
  durationMs: number;
  startedAt: number;
  /** Bumped each time it starts again from somewhere else, so the copy stopped for that doesn't delete the file */
  turn: number;
  stop?: () => void;
}

/** The file playing in each server, which is deleted once it's over */
const files = new Map<string, PlayingFile>();
const filesDir = () => path.join(config.dataDir, 'music-files');

/** Why a file can't be played, from its name and size alone, or null if it might */
export function fileProblem(ext: string, size: number): string | null {
  if (!EXTENSIONS.includes(ext)) return `That isn’t a file the bot can play. Use one of: ${EXTENSIONS.join(', ')}`;
  return size > MOST_FILE_BYTES ? `That file is over ${MOST_FILE_BYTES / 1024 / 1024} MB.` : null;
}

/** Where to keep an upload while it plays */
export function fileUploadPath(ext: string): string {
  mkdirSync(filesDir(), { recursive: true });
  return path.join(filesDir(), `${randomBytes(8).toString('hex')}${ext}`);
}

/**
 * Plays an uploaded file once in a channel, pausing the music here and stopping any file already playing. The file is deleted once it's over.
 * Returns null on success or the reason it couldn't play, for the user
 */
export async function playFile(guild: Guild, channel: VoiceBasedChannel, file: string, name: string, who: string): Promise<string | null> {
  const seconds = (await hasAudio(file)) ? await durationOf(file).catch(() => NaN) : null;
  const problem =
    seconds === null
      ? 'That file doesn’t have any audio the bot can read.'
      : !Number.isFinite(seconds)
        ? 'The bot can’t tell how long that file is, so it won’t play it.'
        : seconds * 1000 > LONGEST_FILE_MS
          ? `That file is over ${LONGEST_FILE_MS / 60_000} minutes long.`
          : null;
  if (problem) {
    rmSync(file, { force: true });
    return problem;
  }
  stopFile(guild.id);
  const playing: PlayingFile = { name, file, channel, durationMs: Math.round(seconds! * 1000), startedAt: Date.now(), turn: 0 };
  const failed = await playFileFrom(guild.id, playing, 0);
  if (failed) return failed;
  files.set(guild.id, playing);
  const s = sessions.get(guild.id);
  if (s && s.phase !== 'paused') pauseHere(s, 'Paused for a file. Press Resume to carry on.');
  logActivity(guild.id, who, `Played the file **${name}**`);
  return null;
}

/** Plays a file from `ms` in, stopping where it was playing. If it can't, the file is deleted and the reason returned */
async function playFileFrom(guildId: string, playing: PlayingFile, ms: number): Promise<string | null> {
  const turn = ++playing.turn;
  playing.stop?.();
  const stop = await playLong(
    playing.channel,
    playing.file,
    () => {
      if (playing.turn !== turn) return;
      if (files.get(guildId) === playing) files.delete(guildId);
      rmSync(playing.file, { force: true });
    },
    ms,
  );
  if (typeof stop === 'string') {
    if (files.get(guildId) === playing) files.delete(guildId);
    rmSync(playing.file, { force: true });
    return stop;
  }
  playing.stop = stop;
  playing.startedAt = Date.now() - ms;
  return null;
}

/** Jumps to `ms` into the file playing. Returns null on success, or why it couldn't */
export async function seekFile(guildId: string, ms: number): Promise<string | null> {
  const playing = files.get(guildId);
  if (!playing) return 'No file is playing.';
  // Not right up to the end, which would only stop it
  return playFileFrom(guildId, playing, Math.round(Math.max(0, Math.min(ms, playing.durationMs - FILE_END_SLACK_MS))));
}

/** Stops the file playing in a server, if there is one. Returns whether there was */
export function stopFile(guildId: string): boolean {
  const playing = files.get(guildId);
  playing?.stop?.();
  return !!playing;
}

// ---------- adding by search or link ----------

/** Songs for whatever was typed: a Spotify link to a song, album or playlist, a YouTube or SoundCloud link, or words to search for. The name says what was found */
export async function resolve(input: string, shuffle = false): Promise<{ name: string; tracks: Track[]; capped?: boolean }> {
  if (isShortLink(input)) throw new SpotifyError('Short spotify.link links can’t be read. Open it and copy the open.spotify.com link instead.');
  const link = parseLink(input);
  if (link) return tracksFor(link, shuffle);
  if (OTHER_LINK.test(input.trim())) return lookUp(input.trim());
  if (/^https?:\/\//i.test(input.trim())) throw new SpotifyError('That isn’t a Spotify, YouTube or SoundCloud link.');
  const [top] = await search(input);
  if (!top) throw new SpotifyError(`Nothing on Spotify matches “${input.trim()}”.`);
  return { name: `${top.title} by ${top.artist}`, tracks: [top] };
}

/** What a YouTube or SoundCloud link is, from the music container */
async function lookUp(url: string): Promise<{ name: string; tracks: Track[] }> {
  const problem = unavailable();
  if (problem) throw new SpotifyError(problem);
  let answer: Awaited<ReturnType<typeof askYoutube>>;
  try {
    answer = await askYoutube('/lookup', { url });
  } catch (err) {
    console.error('Music: couldn’t look up a link:', (err as Error).message);
    throw new SpotifyError('The music player couldn’t read that link. Try again in a moment.');
  }
  if (answer.missing) throw new SpotifyError(answer.missing);
  const title = String(answer.title ?? 'Untitled').slice(0, 300);
  const cover = typeof answer.cover === 'string' && /^https:\/\/(i\.ytimg\.com|i1\.sndcdn\.com)\//.test(answer.cover) ? answer.cover : null;
  const track: Track = { uri: String(answer.url ?? url), title, artist: String(answer.artist ?? '').slice(0, 300), album: '', cover, durationMs: Number(answer.durationMs) || 0 };
  return { name: track.artist ? `${title} by ${track.artist}` : title, tracks: [track] };
}

/** Adds what was typed and says what happened. `shuffle` picks an album's or playlist's songs at random. Throws SpotifyError with a message for the user */
export async function queueFrom(guildId: string, input: string, who: string, next: boolean, shuffle = false): Promise<string> {
  const found = await resolve(input, shuffle);
  if (!found.tracks.length) throw new SpotifyError(`**${found.name}** has no songs that can be played here.`);
  const added = addTracks(guildId, found.tracks, who, next);
  if (!added) throw new SpotifyError(`The queue is full (${MOST_QUEUED} songs).`);
  const songs = `${added}${shuffle && found.tracks.length > 1 ? ' random' : ''} song${added === 1 ? '' : 's'}`;
  const what = found.tracks.length === 1 ? `**${found.name}**` : `${songs} from **${found.name}**`;
  logActivity(guildId, who, `Added ${what} to the music queue${next ? ' to play next' : ''}`);
  const cut =
    found.tracks.length > added
      ? ` (only ${added} fitted)`
      : found.capped
        ? ` (the first ${MOST_FROM_LINK} Spotify shows)`
        : !shuffle && found.tracks.length >= MOST_FROM_LINK
          ? ` (the first ${MOST_FROM_LINK}; shuffle picks from all of it)`
          : '';
  return `Added ${what}${cut}.`;
}

// ---------- what the web page and /music queue show ----------

export function musicState(guildId: string) {
  const s = sessions.get(guildId);
  return {
    problem: unavailable(),
    searchReady: searchReady(),
    // Only with the account's sign-in; without it the page doesn't offer them
    playlistsReady: playlistsReady(),
    phase: s?.phase ?? 'stopped',
    // Playing a sound elsewhere from the soundboard takes the bot, and the music, with it
    channelId: s ? ((s.stopAudio && botChannelId(guildId)) || s.channelId) : null,
    positionMs: s ? Math.round(Math.min(positionOf(s), s.current.duration_ms)) : 0,
    note: s?.note ?? null,
    via: s?.via ?? null,
    file: playingFile(guildId),
  };
}

function playingFile(guildId: string) {
  const playing = files.get(guildId);
  return playing ? { name: playing.name, durationMs: playing.durationMs, positionMs: Math.min(playing.durationMs, Date.now() - playing.startedAt) } : null;
}

const time = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

// ---------- Discord ----------

function canControl(member: GuildMember): boolean {
  const role = idSetting(member.guild.id, 'musicDjRole');
  return !role || member.roles.cache.has(role) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

const searches = new Map<string, { at: number; tracks: Track[] }>();

async function searched(typed: string): Promise<Track[]> {
  let found = searches.get(typed.toLowerCase());
  if (!found || Date.now() - found.at > 60_000) {
    found = { at: Date.now(), tracks: await search(typed).catch(() => []) };
    searches.set(typed.toLowerCase(), found);
    if (searches.size > 200) searches.delete(searches.keys().next().value!);
  }
  return found.tracks;
}

async function suggest(i: AutocompleteInteraction) {
  const typed = String(i.options.getFocused()).trim();
  if (!typed || parseLink(typed) || !searchReady()) return i.respond([]);
  // The account's own playlists that match come first, as searching can't find them. Discord waits 3 seconds, so both are asked at once
  const [lists, tracks] = await Promise.all([
    playlistsReady() ? myPlaylists().then((all) => all.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())).slice(0, 5), () => []) : [],
    typed.length < 3 ? [] : searched(typed),
  ]);
  return i.respond([
    ...lists.map((p) => ({ name: `Playlist: ${p.name} (${p.songs} song${p.songs === 1 ? '' : 's'})`.slice(0, 100), value: `spotify:playlist:${p.id}` })),
    ...tracks.slice(0, 25 - lists.length).map((t) => ({ name: `${t.title} – ${t.artist}`.slice(0, 100), value: t.uri })),
  ]);
}

async function run(i: ChatInputCommandInteraction<'cached'>) {
  const sub = i.options.getSubcommand();
  const reply = (content: string) => i.reply({ content, flags: MessageFlags.Ephemeral });
  // What changes the music for everyone is said in the channel, so people can see who did it
  const announce = (content: string) => i.reply({ content, allowedMentions: { parse: [] } });
  if (sub === 'queue') {
    const rows = queueOf(i.guildId);
    if (!rows.length) return reply('The queue is empty.');
    const state = musicState(i.guildId);
    const lines = rows.slice(0, SHOWN_IN_DISCORD).map((r, n) => {
      const playing = n === 0 && state.phase !== 'stopped';
      return `${playing ? (state.phase === 'paused' ? '⏸' : '▶') : `${n}.`} **${r.title}** – ${r.artist} (${time(r.duration_ms)})`;
    });
    if (rows.length > SHOWN_IN_DISCORD) lines.push(`…and ${rows.length - SHOWN_IN_DISCORD} more`);
    return reply(lines.join('\n'));
  }
  const role = idSetting(i.guildId, 'musicDjRole');
  if (!canControl(i.member)) return reply(`Only <@&${role}> and people with **Manage Server** can control the music.`);

  if (sub === 'play') {
    const input = i.options.getString('song');
    const next = i.options.getBoolean('next') ?? false;
    let added = '';
    if (input) {
      await i.deferReply();
      try {
        added = await queueFrom(i.guildId, input, i.user.id, next, i.options.getBoolean('shuffle') ?? false);
      } catch (err) {
        if (!(err instanceof SpotifyError)) throw err;
        return i.editReply(err.message);
      }
    }
    const s = sessions.get(i.guildId);
    const playing = !!s && s.phase !== 'paused';
    const say = (content: string) => (i.deferred ? i.editReply(content) : reply(content));
    if (playing) return say(added || 'The music is already playing.');
    const channel = i.member.voice.channel;
    if (!channel) return say(`${added ? `${added} ` : ''}Join a voice channel and use /music play to start it.`.trim());
    // Getting the song can take longer than the 3 s Discord waits for an answer
    if (!i.deferred) await i.deferReply();
    const problem = await startMusic(i.guild, channel);
    if (problem && !added) {
      // Only the person who asked needs to see why it didn't start
      await i.deleteReply();
      return i.followUp({ content: problem, flags: MessageFlags.Ephemeral });
    }
    if (problem) return say(`${added} ${problem}`);
    const now = queueOf(i.guildId)[0];
    return say(`${added ? `${added} ` : ''}Playing **${now.title}** in ${channel}.`.trim());
  }
  if (sub === 'pause') {
    const problem = pauseMusic(i.guildId);
    return problem ? reply(problem) : announce('Paused the music. Use /music play to carry on.');
  }
  if (sub === 'skip') {
    const title = sessions.get(i.guildId)?.current.title;
    if (!title) return reply('Nothing is playing.');
    // Starting the next song can take longer than the 3 s Discord waits for an answer
    await i.deferReply();
    const problem = await skipMusic(i.guildId, i.user.id);
    if (problem) {
      await i.deleteReply();
      return i.followUp({ content: problem, flags: MessageFlags.Ephemeral });
    }
    return i.editReply({ content: `Skipped **${title}**.`, allowedMentions: { parse: [] } });
  }
  if (sub === 'shuffle') {
    const shuffled = shuffleQueue(i.guildId, i.user.id);
    return shuffled ? announce(`Shuffled the ${shuffled} songs in the queue.`) : reply('There’s nothing to shuffle. It takes two songs waiting.');
  }
  if (sub === 'stop') {
    stopMusic(i.guildId, i.user.id);
    return announce('Stopped the music and cleared the queue.');
  }
}

export const music: Feature = {
  title: 'Music',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Music in voice, with a queue everyone shares')
        .setDMPermission(false)
        .addSubcommand((s) =>
          s
            .setName('play')
            .setDescription('Add a song or album, and start the music in your voice channel')
            .addStringOption((o) => o.setName('song').setDescription('A song to search for, or a Spotify link').setAutocomplete(true).setMaxLength(300))
            .addBooleanOption((o) => o.setName('next').setDescription('Play it after the current song, instead of at the end'))
            .addBooleanOption((o) => o.setName('shuffle').setDescription('For an album or playlist: 100 of its songs at random, instead of the first 100')),
        )
        .addSubcommand((s) => s.setName('pause').setDescription('Pause the music, keeping the queue'))
        .addSubcommand((s) => s.setName('skip').setDescription('Skip to the next song'))
        .addSubcommand((s) => s.setName('queue').setDescription('Show what’s playing and what’s next'))
        .addSubcommand((s) => s.setName('shuffle').setDescription('Put the songs waiting in a random order'))
        .addSubcommand((s) => s.setName('stop').setDescription('Stop the music and clear the queue')),
      run: (i) => (i.inCachedGuild() ? run(i) : i.reply({ content: 'Music only works in a server.', flags: MessageFlags.Ephemeral })),
      autocomplete: suggest,
    },
  ],
  setup(client) {
    // Files left from before a restart, which nothing will play now
    rmSync(filesDir(), { recursive: true, force: true });
    if (!config.musicUrl || !config.musicToken) return;
    exiting = false;
    saver = setInterval(() => {
      if (sessions.size || !wroteNone) saveSessions();
    }, SAVE_EVERY_MS).unref();
    void resumeAfterRestart(client).catch((err: unknown) => console.error('Music: couldn’t carry on after the restart:', err));
    // Songs left in the queue from before without a cover
    void fillCovers();
    // Stop, and everyone leaving, pause the music rather than lose the queue
    onPlaybackStop((guildId) => {
      const s = sessions.get(guildId);
      if (s && s.phase !== 'paused') pauseHere(s, null);
    });
    listening = new AbortController();
    void listen(listening.signal);
  },
  saveForRestart() {
    if (!config.musicUrl || !config.musicToken) return;
    saveSessions();
    exiting = true;
  },
  shutdown() {
    clearInterval(saver);
    for (const guildId of files.keys()) stopFile(guildId);
    listening?.abort();
    for (const s of [...sessions.values()]) endSession(s);
  },
};

/** The bot's own voice channel, for the web page to default to */
export const musicChannelFor = (guildId: string) => sessions.get(guildId)?.channelId ?? botChannelId(guildId);

/** For tests: starts from nothing and follows a fake music container's status */
export function resetMusic(next: PlayerStatus | null = null) {
  askedAhead.clear();
  for (const s of sessions.values()) s.turn++;
  sessions.clear();
  status = next;
  unreachable = null;
  exiting = false;
  coverless.clear();
}

