import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { durationOf, hasAudio } from '../discordSounds.ts';
import { idSetting } from '../settings.ts';
import { isShortLink, MOST_FROM_LINK, myPlaylists, parseLink, playlistsReady, search, searchReady, SpotifyError, tracksFor, type Track } from '../spotify.ts';
import type { Feature } from '../types.ts';
import { botChannelId, EXTENSIONS, onPlaybackStop, playLong, playStream } from './soundboard.ts';

// Spotify moving on this close to a song's end is the song finishing, not someone choosing something else
const END_SLACK_MS = 6_000;
// A different song this soon after the bot asked Spotify for one is Spotify not playing it, rather than someone's choice
const CANT_PLAY_MS = 5_000;
// Finding a song and downloading it takes seconds; this is for when YouTube is struggling
const FETCH_TIMEOUT_MS = 3 * 60_000;
export const MOST_QUEUED = 500;
const SHOWN_IN_DISCORD = 10;
// A file played once from the web page, which can be a whole song or a mix
export const MOST_FILE_BYTES = 50 * 1024 * 1024;
const LONGEST_FILE_MS = 20 * 60_000;
// A second of Spotify's audio in hand. The mixer skips ahead past anything more, rather than fall behind
const AUDIO_BUFFER = 48_000 * 4;
const SAFE_FILE = /^[\w.-]+$/;
const OTHER_LINK = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be|soundcloud\.com)\//i;

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

/** What the music container reports: yt-dlp, and Spotify, whose playback is optional */
export interface PlayerStatus {
  state: 'starting' | 'downloading' | 'running' | 'failed' | 'no-key' | 'no-consent' | 'off';
  message: string;
  loggedIn: boolean;
  account: string | null;
  active: boolean;
  version: string | null;
  expiresAt: number | null;
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
  /** Where the song playing came from: youtube or soundcloud, or spotify for a song they didn't have */
  via: string | null;
  /** Counts each change of what's playing, so a download or an ending from before it is ignored */
  turn: number;
  position: Position;
  stopAudio?: () => void;
  /** Why it stopped or skipped by itself, for the web page */
  note: string | null;
  // Only for songs played through Spotify
  /** The song Spotify has loaded, which is the current one unless someone changed it from Spotify */
  loaded: string | null;
  /** When the bot last asked Spotify for a song */
  requestedAt: number;
  /** A pause the bot asked for, so it isn't mistaken for one from Spotify */
  pausing: boolean;
}

const sessions = new Map<string, Session>();
let status: PlayerStatus | null = null;
/** Why the music container can't be reached, while it can't */
let unreachable: string | null = null;
let listening: AbortController | undefined;

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
  adding.forEach((t, i) => insert.run(guildId, before + step * (i + 1), t.uri, t.title, t.artist, t.album, t.cover, t.durationMs, who, Date.now()));
  renumber(guildId);
  fetchNext(guildId);
  return adding.length;
}

/** Spreads positions out again, so there's always room between two rows */
function renumber(guildId: string) {
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  queueOf(guildId).forEach((row, i) => update.run(i, row.id));
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
  rows.forEach((r, i) => update.run(i, r.id));
  fetchNext(guildId);
  return true;
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

const asBridge = () => ({ authorization: `Bearer ${config.musicToken}`, 'content-type': 'application/json' });

async function command(body: Record<string, unknown>) {
  const res = await fetch(`${config.musicUrl}/command`, { method: 'POST', headers: asBridge(), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`music container refused ${String(body.command)}: HTTP ${res.status}`);
}

/** Commands that are tidying up, where failing changes nothing for anyone */
const quietly = (body: Record<string, unknown>) => command(body).catch((err: unknown) => console.error('Music:', (err as Error).message));

async function openAudio(): Promise<Readable> {
  const res = await fetch(`${config.musicUrl}/audio`, { headers: { authorization: `Bearer ${config.musicToken}` } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  return Readable.fromWeb(res.body as ReadableStream<Uint8Array>, { highWaterMark: AUDIO_BUFFER });
}

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

/** Starts downloading the song after the one playing, so it follows without a wait */
function fetchNext(guildId: string) {
  const s = sessions.get(guildId);
  const next = queueOf(guildId)[1];
  if (!s || s.phase === 'paused' || !next || unavailable()) return;
  void fetchAudio(next).catch((err: unknown) => console.error(`Music: couldn’t fetch ${next.title} ahead:`, (err as Error).message));
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
          else if (event === 'soloist') await onSpotify(JSON.parse(data) as SpotifyMessage);
        }
      }
      throw new Error('the connection closed');
    } catch (err) {
      if (signal.aborted) return;
      const reason = (err as Error).message;
      if (unreachable !== reason) console.error(`Music container unreachable: ${reason}`);
      unreachable = reason;
      status = null;
      const s = onSpotifyNow();
      if (s?.phase === 'playing') pauseHere(s, 'The music player stopped answering, so the music paused.');
      await sleep(5_000, undefined, { signal }).catch(() => {});
    }
  }
}

function onStatus(next: PlayerStatus) {
  status = next;
  const s = onSpotifyNow();
  if (s?.phase === 'playing' && !spotifyReady()) pauseHere(s, 'Spotify signed out, so the music paused.');
}

// ---------- playing ----------

/** Why music can't play right now, or null if it can */
export function unavailable(): string | null {
  if (!config.musicUrl || !config.musicToken) return 'Music isn’t set up on this bot. It needs MUSIC_URL and MUSIC_TOKEN.';
  if (unreachable || !status) return 'The music player isn’t answering. Check that the music container is running.';
  if (!status.youtube?.ready) return status.youtube?.message ? `The music player can’t reach YouTube: ${status.youtube.message}` : 'The music player is still starting. Try again in a moment.';
  return null;
}

/** Whether songs YouTube doesn't have can play through Spotify instead */
const spotifyReady = () => status?.state === 'running' && status.loggedIn;
/** The server whose song is playing through Spotify, which only plays one thing at a time */
const onSpotifyNow = () => [...sessions.values()].find((s) => s.via === 'spotify');

/** Where the song playing has got to, in milliseconds */
const positionOf = (s: Session) => s.position.ms + Math.max(0, Date.now() - s.position.at) * s.position.speed;
const nearEnd = (s: Session) => positionOf(s) >= s.current.duration_ms - END_SLACK_MS;
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
    s = { guild, channelId: channel.id, phase: 'starting', current: first, via: null, turn: 0, position: { ms: 0, at: Date.now(), speed: 0 }, note: null, loaded: null, requestedAt: 0, pausing: false };
    sessions.set(guild.id, s);
  }
  return playCurrent(s, carryOn);
}

/** Plays the current song from `fromMs`: from YouTube or SoundCloud, or through Spotify if they don't have it and that's on */
async function playCurrent(s: Session, fromMs = 0): Promise<string | null> {
  const turn = ++s.turn;
  const row = s.current;
  s.phase = 'starting';
  stopAudioOf(s);
  if (s.via === 'spotify' && s.loaded === row.uri && fromMs > 0) return playOnSpotify(s, turn, true);
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
    // Spotify plays one thing at a time, so it can't stand in while it's playing in another server
    const elsewhere = onSpotifyNow();
    if (row.uri.startsWith('spotify:') && spotifyReady() && (!elsewhere || elsewhere === s || elsewhere.phase === 'paused')) return playOnSpotify(s, turn, false, fromMs);
    const note = `Couldn’t find ${row.title} on YouTube or SoundCloud, so it was skipped.`;
    const next = await moveOn(s);
    if (sessions.get(s.guild.id) !== s) return note;
    // The next song's own problem says more than this one being skipped
    if (next) return next;
    s.note ??= note;
    return null;
  }
  leaveSpotify(s);
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

/** Plays the current song through Spotify, carrying on where Spotify paused or starting it from `fromMs` */
async function playOnSpotify(s: Session, turn: number, carryOn: boolean, fromMs = 0): Promise<string | null> {
  // Spotify plays one thing at a time, so another server paused on Spotify loses its place
  for (const other of sessions.values()) if (other !== s && other.via === 'spotify') Object.assign(other, { via: null, loaded: null });
  const channel = channelOf(s);
  let pcm: Readable;
  try {
    pcm = await openAudio();
  } catch (err) {
    console.error('Music: couldn’t open Spotify’s audio:', (err as Error).message);
    s.phase = 'paused';
    return 'The music player isn’t answering. Check that the music container is running.';
  }
  if (s.turn !== turn || !channel) {
    pcm.destroy();
    return channel ? null : 'That voice channel is gone.';
  }
  const stop = await playStream(channel, pcm, () => onSpotifyStreamEnd(s, turn));
  if (typeof stop === 'string') {
    s.phase = 'paused';
    return stop;
  }
  Object.assign(s, { stopAudio: stop, via: 'spotify' });
  try {
    // Spotify only plays here once this device is the account's active one
    await command({ command: 'activate' });
    if (carryOn) await command({ command: 'play' });
    else {
      s.loaded = s.current.uri;
      s.requestedAt = Date.now();
      s.position = { ms: 0, at: Date.now(), speed: 0 };
      await command({ command: 'play', uri: s.current.uri });
      if (fromMs > 0) await command({ command: 'seek', position_ms: Math.round(fromMs) });
    }
  } catch (err) {
    console.error('Music:', (err as Error).message);
    stopAudioOf(s);
    s.phase = 'paused';
    return 'The music player didn’t start. Try again in a moment.';
  }
  s.phase = 'playing';
  fetchNext(s.guild.id);
  return null;
}

/** Spotify's audio stopped: Stop was pressed, everyone left, or the bot left voice */
function onSpotifyStreamEnd(s: Session, turn: number) {
  if (s.turn !== turn || !s.stopAudio) return;
  s.stopAudio = undefined;
  if (s.phase !== 'paused') pauseHere(s, null);
}

/** Pauses Spotify and lets it go, when the next song comes from somewhere else */
function leaveSpotify(s: Session) {
  if (s.via === 'spotify') {
    s.pausing = true;
    void quietly({ command: 'pause' });
  }
  Object.assign(s, { via: null, loaded: null });
}

function stopAudioOf(s: Session) {
  const stop = s.stopAudio;
  s.stopAudio = undefined;
  stop?.();
}

/** Pauses, keeping the queue. `note` says why, when it wasn't someone asking */
function pauseHere(s: Session, note: string | null, tellSpotify = true) {
  s.turn++;
  s.phase = 'paused';
  s.note = note;
  s.position = { ms: positionOf(s), at: Date.now(), speed: 0 };
  stopAudioOf(s);
  if (s.via === 'spotify' && tellSpotify && status?.loggedIn) {
    s.pausing = true;
    void quietly({ command: 'pause' });
  }
}

export function pauseMusic(guildId: string): string | null {
  const s = sessions.get(guildId);
  if (!s || s.phase === 'paused') return 'Nothing is playing.';
  pauseHere(s, null);
  return null;
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
    s.loaded = null;
    return null;
  }
  return playCurrent(s);
}

function endSession(s: Session) {
  s.turn++;
  stopAudioOf(s);
  if (s.via === 'spotify' && s.phase !== 'paused') {
    s.pausing = true;
    void quietly({ command: 'pause' });
  }
  if (sessions.get(s.guild.id) === s) sessions.delete(s.guild.id);
}

interface SpotifyMessage {
  type: string;
  status?: string;
  is_active?: boolean;
  logged_in?: boolean;
  item?: { uri?: string; decorations?: { identity?: { name?: string } } } | null;
  position?: { position_ms: number; timestamp_ms: number; speed: number };
}

/** Follows what Spotify does while it plays a song, which is how that song ending is known */
export async function onSpotify(msg: SpotifyMessage) {
  const s = onSpotifyNow();
  if (!s) return;
  if (msg.position && (msg.type === 'position_sync' || msg.type === 'playback_state')) {
    s.position = { ms: msg.position.position_ms, at: msg.position.timestamp_ms, speed: msg.position.speed };
    return;
  }
  if (msg.type === 'track_changed') {
    const uri = msg.item?.uri;
    if (!uri || uri === s.loaded) return;
    if (nearEnd(s)) {
      // The song finished, and Spotify went on to suggestions of its own
      s.loaded = uri;
      if (s.phase === 'playing') await moveOn(s);
      return;
    }
    if (s.phase !== 'paused' && Date.now() - s.requestedAt < CANT_PLAY_MS) {
      // The same song under another address, as Spotify can swap in another copy of it
      if (msg.item?.decorations?.identity?.name === s.current.title) {
        s.loaded = uri;
        return;
      }
      const title = s.current.title;
      await moveOn(s);
      if (sessions.get(s.guild.id) === s) s.note = `Spotify wouldn’t play ${title}, so it was skipped.`;
      return;
    }
    // Someone chose something else for this device in Spotify
    s.loaded = uri;
    if (s.phase === 'playing') pauseHere(s, 'Something else was started on this speaker from Spotify, so the music paused.');
    return;
  }
  if (msg.type === 'playback_changed' && msg.status === 'paused') {
    if (s.pausing) {
      s.pausing = false;
      return;
    }
    if (s.phase === 'playing' && nearEnd(s)) await moveOn(s);
    else if (s.phase === 'playing') pauseHere(s, 'The music was paused from Spotify.', false);
    return;
  }
  if (msg.type === 'playback_changed' && msg.status === 'playing' && s.phase === 'paused' && !s.stopAudio) {
    // Played from the Spotify app while the bot isn't in voice, where nobody would hear it
    s.pausing = true;
    void quietly({ command: 'pause' });
    return;
  }
  if (msg.type === 'device_changed' && msg.is_active === false && s.phase === 'playing') {
    pauseHere(s, 'Spotify moved to another speaker, so the music paused.', false);
  }
}

// ---------- a file, played once ----------

interface PlayingFile {
  name: string;
  durationMs: number;
  startedAt: number;
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
  const playing: PlayingFile = { name, durationMs: Math.round(seconds! * 1000), startedAt: Date.now() };
  const stop = await playLong(channel, file, () => {
    if (files.get(guild.id) === playing) files.delete(guild.id);
    rmSync(file, { force: true });
  });
  if (typeof stop === 'string') {
    rmSync(file, { force: true });
    return stop;
  }
  playing.stop = stop;
  files.set(guild.id, playing);
  const s = sessions.get(guild.id);
  if (s && s.phase !== 'paused') pauseHere(s, 'Paused for a file. Press Resume to carry on.');
  logActivity(guild.id, who, `Played the file **${name}**`);
  return null;
}

/** Stops the file playing in a server, if there is one. Returns whether there was */
export function stopFile(guildId: string): boolean {
  const playing = files.get(guildId);
  playing?.stop?.();
  return !!playing;
}

// ---------- adding by search or link ----------

/** Songs for whatever was typed: a Spotify link to a song, album or playlist, a YouTube or SoundCloud link, or words to search for. The name says what was found */
export async function resolve(input: string, shuffle = false): Promise<{ name: string; tracks: Track[] }> {
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
  const cut = found.tracks.length > added ? ` (only ${added} fitted)` : !shuffle && found.tracks.length >= MOST_FROM_LINK ? ` (the first ${MOST_FROM_LINK}; shuffle picks from all of it)` : '';
  return `Added ${what}${cut}.`;
}

// ---------- what the web page and /music queue show ----------

export function musicState(guildId: string) {
  const s = sessions.get(guildId);
  return {
    problem: unavailable(),
    searchReady: searchReady(),
    // Only while Spotify can play, which is when the account matters
    account: status && status.state !== 'off' ? status.account : null,
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
    const problem = await startMusic(i.guild, channel);
    if (problem) return say(`${added ? `${added} ` : ''}${problem}`);
    const now = queueOf(i.guildId)[0];
    return say(`${added ? `${added} ` : ''}Playing **${now.title}** in ${channel}.`.trim());
  }
  if (sub === 'pause') {
    const problem = pauseMusic(i.guildId);
    return problem ? reply(problem) : announce('Paused the music. Use /music play to carry on.');
  }
  if (sub === 'skip') {
    const title = sessions.get(i.guildId)?.current.title ?? null;
    const problem = await skipMusic(i.guildId, i.user.id);
    return problem ? reply(problem) : announce(`Skipped **${title}**.`);
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
        .addSubcommand((s) => s.setName('stop').setDescription('Stop the music and clear the queue')),
      run: (i) => (i.inCachedGuild() ? run(i) : i.reply({ content: 'Music only works in a server.', flags: MessageFlags.Ephemeral })),
      autocomplete: suggest,
    },
  ],
  setup() {
    // Files left from before a restart, which nothing will play now
    rmSync(filesDir(), { recursive: true, force: true });
    if (!config.musicUrl || !config.musicToken) return;
    // Stop, and everyone leaving, pause the music rather than lose the queue
    onPlaybackStop((guildId) => {
      const s = sessions.get(guildId);
      if (s && s.phase !== 'paused') pauseHere(s, null);
    });
    listening = new AbortController();
    void listen(listening.signal);
  },
  shutdown() {
    for (const guildId of files.keys()) stopFile(guildId);
    listening?.abort();
    for (const s of [...sessions.values()]) endSession(s);
  },
};

/** The bot's own voice channel, for the web page to default to */
export const musicChannelFor = (guildId: string) => sessions.get(guildId)?.channelId ?? botChannelId(guildId);

/** For tests: starts from nothing and follows a fake music container's status */
export function resetMusic(next: PlayerStatus | null = null) {
  for (const s of sessions.values()) s.turn++;
  sessions.clear();
  status = next;
  unreachable = null;
}

