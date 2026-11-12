import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
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
import { feeds } from '../changes.ts';
import { db, getKv, setKv, transaction } from '../db.ts';
import { durationOf, hasAudio } from '../discordSounds.ts';
import { idSetting, setSetting, setting } from '../settings.ts';
import { coverFor, isShortLink, MOST_FROM_LINK, myPlaylists, parseLink, playlistsReady, RateLimited, search, searchReady, SpotifyError, tracksFor, type Track } from '../spotify.ts';
import type { Feature } from '../types.ts';
import { humansIn } from '../util.ts';
import { botChannelId, onMusicCheck, onPlaybackStop, playLong } from './voiceAudio.ts';
import { EXTENSIONS } from './soundLibrary.ts';

// Jumping within a song stops this far short of its end, which would only end it
const END_SLACK_MS = 6_000;
// Finding a song and downloading it takes seconds; this is for when YouTube is struggling
const FETCH_TIMEOUT_MS = 3 * 60_000;
export const MOST_QUEUED = 500;
/** Album covers looked up at once, for songs added without one */
const COVER_LOOKUPS = 4;
/** Songs waiting shown on each page of the music card */
const CARD_PAGE = 10;
/** How long the card waits for the music to settle before it's redrawn, so a burst of changes is one edit */
const CARD_DELAY_MS = 1_500;
// A file played once from the web page, which can be a whole song or a mix
export const MOST_FILE_BYTES = 60 * 1024 * 1024;
// A jump within a file stops this far short of its end, which would only stop it
const FILE_END_SLACK_MS = 500;
const LONGEST_FILE_MS = 20 * 60_000;
const SAFE_FILE = /^[\w.-]+$/;
const OTHER_LINK = /^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be|soundcloud\.com)\//i;
// Where the music was, kept so a restart or redeploy carries on from there
const SAVED_KEY = 'musicSessions';
/** Where each server's live music card is, so it keeps being redrawn after a restart */
const CARDS_KEY = 'musicCards';
const SAVE_EVERY_MS = 5_000;
// After longer than this, carrying on would surprise whoever's still around
const RESUME_WITHIN_MS = 10 * 60_000;
// The music container restarts alongside the bot, and the music waits this long for it
const READY_WAIT_MS = 3 * 60_000;
const READY_CHECK_MS = 1_000;
/** Who added the songs Autoplay picks, which the queue shows as Autoplay */
export const AUTOPLAY = 'autoplay';
/** Songs Autoplay adds each time the song playing is the last */
const AUTOPLAY_ADDS = 2;
/** Autoplay passes over anything shorter or longer, such as intros, mixes and whole albums */
const AUTOPLAY_SHORTEST_MS = 60_000;
const AUTOPLAY_LONGEST_MS = 10 * 60_000;
/** YouTube's mixes kept for each session, as Autoplay goes on from a different song each time */
const MIXES_KEPT = 20;
/** A mix that couldn't be read isn't asked for again for this long, so seeking within a song doesn't keep asking */
const MIX_RETRY_MS = 60_000;
/** How long the last song, once it's ended, waits for Autoplay before the music stops */
const AUTOPLAY_WAIT_MS = 30_000;
/** Songs remembered as played, so a long evening doesn't repeat them, kept across a restart */
const PLAYED_KEPT = 500;
const AUTOPLAY_NOTE = 'Autoplay found nothing new like the songs played, so the music stops after this one.';
const YOUTUBE_VIDEO = /^https:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)(?<video>[\w-]{11})/;
/** The YouTube video a link is to, or undefined for anything else */
const videoOf = (url: string) => url.match(YOUTUBE_VIDEO)?.groups?.video;

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
  /** The YouTube videos played since the music started, newest last, for Autoplay to go on from */
  played: { video: string; url: string; byPerson: boolean }[];
  /** Videos Autoplay leaves out: those played, and those it added, so one taken out isn't added again */
  seen: Set<string>;
  /** YouTube's mix for each video Autoplay went on from, or when it last couldn't be read */
  mixes: Map<string, Track[] | { failedAt: number }>;
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

/** Where the songs Autoplay added at the end start, leaving out the song playing */
function afterPeople(rows: QueueRow[], first: number) {
  let end = rows.length;
  while (end > first && rows[end - 1]!.added_by === AUTOPLAY) end--;
  return end;
}

/**
 * Adds songs to the end, or after the song playing with `next`. Songs people add go ahead of those Autoplay added at the end, which
 * only fill in after them. Returns how many fitted
 */
export function addTracks(guildId: string, tracks: Track[], who: string, next = false): number {
  const rows = queueOf(guildId);
  const room = Math.max(0, MOST_QUEUED - rows.length);
  const adding = tracks.slice(0, room);
  if (!adding.length) return 0;
  const first = holdsFirst(guildId) ? 1 : 0;
  const after = next ? first : who === AUTOPLAY ? rows.length : afterPeople(rows, first);
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
  cardChanged(guildId);
  if (adding.some((t) => !t.cover)) void fillCovers();
  // A last song that ended waiting on Autoplay goes on to this one
  if (who !== AUTOPLAY) stillLooking.get(guildId)?.();
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
  const update = db.prepare('UPDATE music_queue SET cover = ? WHERE uri = ? AND cover IS NULL RETURNING guild_id');
  let next = 0;
  let waitSeconds = 0;
  const worker = async () => {
    while (next < uris.length && !waitSeconds && !exiting) {
      const uri = uris[next++]!;
      try {
        const cover = await coverFor(uri);
        if (cover) {
          // The queue on the page and the card show it
          const guilds = new Set((update.all(cover, uri) as unknown as { guild_id: string }[]).map((r) => r.guild_id));
          for (const guildId of guilds) cardChanged(guildId);
        } else coverless.add(uri);
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
  cardChanged(guildId);
  return true;
}

/**
 * Puts the queue in a random order, leaving the song playing where it is, and the songs Autoplay added at the end after the rest.
 * Returns how many songs were shuffled
 */
export function shuffleQueue(guildId: string, who: string): number {
  const rows = queueOf(guildId);
  const first = holdsFirst(guildId) ? 1 : 0;
  const end = afterPeople(rows, first);
  const rest = rows.slice(first, end);
  if (rest.length < 2) return 0;
  for (let n = rest.length - 1; n > 0; n--) {
    const k = Math.floor(Math.random() * (n + 1));
    [rest[n], rest[k]] = [rest[k], rest[n]];
  }
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  transaction(() => [...rows.slice(0, first), ...rest, ...rows.slice(end)].forEach((r, i) => update.run(i, r.id)));
  fetchNext(guildId);
  cardChanged(guildId);
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
  cardChanged(guildId);
  if (s && sessions.get(guildId) === s) void topUp(s);
  return row;
}

/** Empties the queue, apart from the song playing */
export function clearQueue(guildId: string, who: string) {
  const s = sessions.get(guildId);
  db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND id != ?').run(guildId, s?.current.id ?? -1);
  cardChanged(guildId);
  logActivity(guildId, who, 'Cleared the music queue');
  if (s) void topUp(s);
}

// ---------- the music container ----------

// The song playing, or first to play, and the one after it
const FETCHED_AHEAD = 2;
const ASKED_AHEAD_MS = 10 * 60_000;
const askedAhead = new Set<string>();

const asBridge = () => ({ authorization: `Bearer ${config.musicToken}`, 'content-type': 'application/json' });

/** Asks the music container something about YouTube. A 404 is "not found", with the reason; anything else that isn't fine throws */
async function askYoutube(where: '/fetch' | '/lookup' | '/similar', body: Record<string, unknown>): Promise<Record<string, unknown> & { missing?: string }> {
  const res = await fetch(`${config.musicUrl}${where}`, { method: 'POST', headers: asBridge(), body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 404) return { missing: String(answer.error ?? 'Not found.') };
  if (!res.ok) throw new Error(String(answer.error ?? `HTTP ${res.status}`));
  return answer;
}

/** The audio for a song: a file the music container downloaded, with where it came from, or why there isn't one */
async function fetchAudio(row: QueueRow): Promise<{ file: string; source: string; url: string | null } | { missing: string }> {
  const answer = await askYoutube('/fetch', row.uri.startsWith('spotify:') ? { uri: row.uri, title: row.title, artist: row.artist, durationMs: row.duration_ms } : { url: row.uri });
  if (answer.missing) return { missing: answer.missing };
  if (typeof answer.file !== 'string' || !SAFE_FILE.test(answer.file)) throw new Error('the music container named the file oddly');
  return { file: path.join(config.musicAudioDir, answer.file), source: String(answer.source ?? 'youtube'), url: typeof answer.url === 'string' ? answer.url : null };
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
      playerMaybeChanged();
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
      playerMaybeChanged();
      await sleep(5_000, undefined, { signal }).catch(() => {});
    }
  }
}

/** The music container's status changed. Exported for tests, which have no container to follow */
export function onStatus(next: PlayerStatus) {
  status = next;
  playerMaybeChanged();
}

let lastProblem: string | null | undefined;
/** The music page says when the player can't be used, so every server's page hears when that changes */
function playerMaybeChanged() {
  const problem = unavailable();
  if (problem === lastProblem) return;
  lastProblem = problem;
  feeds.music.changedEverywhere();
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

function newSession(guild: Guild, channelId: string, current: QueueRow, phase: Session['phase'], positionMs: number): Session {
  return { guild, channelId, phase, current, via: null, turn: 0, position: { ms: positionMs, at: Date.now(), speed: 0 }, note: null, played: [], seen: new Set(), mixes: new Map() };
}

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
    s = newSession(guild, channel.id, first, 'starting', 0);
    sessions.set(guild.id, s);
  }
  return playCurrent(s, carryOn);
}

/** Plays the current song from `fromMs`, from YouTube or SoundCloud */
async function playCurrent(s: Session, fromMs = 0): Promise<string | null> {
  const turn = ++s.turn;
  const row = s.current;
  s.phase = 'starting';
  cardChanged(s.guild.id);
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
    cardChanged(s.guild.id);
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
    cardChanged(s.guild.id);
    return stop;
  }
  Object.assign(s, { stopAudio: stop, via: found.source, phase: 'playing', position: { ms: fromMs, at: Date.now(), speed: 1 } });
  const video = found.url && videoOf(found.url);
  if (video && s.played.at(-1)?.video !== video) {
    s.played.push({ video, url: `https://www.youtube.com/watch?v=${video}`, byPerson: row.added_by !== AUTOPLAY });
    if (s.played.length > PLAYED_KEPT) s.played.shift();
    remember(s, video);
  }
  cardChanged(s.guild.id);
  saveSessions();
  fetchNext(s.guild.id);
  void topUp(s);
  return null;
}

/** A song from a file is over: it ended, so the next one plays, or it was cut off, so the music pauses */
function onSongEnd(s: Session, turn: number, byItself: boolean) {
  if (s.turn !== turn || sessions.get(s.guild.id) !== s) return;
  s.stopAudio = undefined;
  if (byItself && s.phase === 'playing') void moveOn(s).catch((err) => console.error(`Moving on to the next song in ${s.guild.name} failed:`, err));
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
  cardChanged(s.guild.id);
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
    cardChanged(guildId);
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
  // With nothing playing, only the queue changed
  cardChanged(guildId);
  logActivity(guildId, who, 'Stopped the music and cleared the queue');
}

/**
 * Goes on to the next song in the queue, or stops once there isn't one. With Autoplay on, the last song waits for it to find more.
 * Returns why the next song couldn't play, if it couldn't
 */
async function moveOn(s: Session): Promise<string | null> {
  if (autoplayDue(s)) {
    const { turn, current } = s;
    await untilToppedUp(s);
    // Someone skipped, stopped, paused or jumped within the song meanwhile
    if (sessions.get(s.guild.id) !== s || s.current !== current || s.turn !== turn) return null;
  }
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
    cardChanged(s.guild.id);
    return null;
  }
  return playCurrent(s);
}

function endSession(s: Session) {
  s.turn++;
  stillLooking.get(s.guild.id)?.();
  stopAudioOf(s);
  if (sessions.get(s.guild.id) === s) sessions.delete(s.guild.id);
  cardChanged(s.guild.id);
  saveSessions();
}

// ---------- Autoplay ----------

const waitingAfter = db.prepare('SELECT 1 FROM music_queue WHERE guild_id = ? AND id != ? LIMIT 1');

/** Whether Autoplay adds songs now: it's on and nothing waits after the song playing */
const autoplayDue = (s: Session) => setting(s.guild.id, 'musicAutoplay') && !waitingAfter.get(s.guild.id, s.current.id);

/** Autoplay looking for songs in each server, which a second look waits on rather than repeating */
const toppingUp = new Map<string, Promise<void>>();
/** The last song in each server that ended while Autoplay looked, which a song being added or the music stopping lets go on */
const stillLooking = new Map<string, () => void>();

/** Notes a video as played or added, so Autoplay doesn't pick it again */
function remember(s: Session, video: string) {
  s.seen.delete(video);
  s.seen.add(video);
  if (s.seen.size > PLAYED_KEPT) s.seen.delete(s.seen.values().next().value!);
}

/** Waits for Autoplay to add songs after the last one ended, unless someone adds one first or it takes too long */
async function untilToppedUp(s: Session) {
  const guildId = s.guild.id;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    topUp(s),
    new Promise<void>((resolve) => {
      stillLooking.set(guildId, resolve);
      timer = setTimeout(resolve, AUTOPLAY_WAIT_MS).unref();
    }),
  ]);
  clearTimeout(timer);
  stillLooking.delete(guildId);
}

/** Adds songs like those played once the song playing is the last, while Autoplay is on */
function topUp(s: Session): Promise<void> {
  const guildId = s.guild.id;
  const looking = toppingUp.get(guildId);
  if (looking) return looking;
  if (!autoplayDue(s) || unavailable()) return Promise.resolve();
  const from = s.current;
  let again = false;
  const job = similarSongs(s)
    .then((songs) => {
      // Stopped, turned off, or someone added songs meanwhile
      if (sessions.get(guildId) !== s || !autoplayDue(s)) return;
      // The music moved on to a song someone added while it looked, so it looks again from that one
      if (s.current !== from) return void (again = true);
      if (!songs.length) {
        s.note = AUTOPLAY_NOTE;
        cardChanged(guildId);
        return;
      }
      if (s.note === AUTOPLAY_NOTE) s.note = null;
      for (const song of songs) remember(s, videoOf(song.uri)!);
      addTracks(guildId, songs, AUTOPLAY);
    })
    .catch((err: unknown) => console.error(`Music: Autoplay couldn’t find songs in ${s.guild.name}:`, (err as Error).message))
    .finally(() => {
      toppingUp.delete(guildId);
      if (again) void topUp(s);
    });
  toppingUp.set(guildId, job);
  return job;
}

/**
 * Songs not played yet from YouTube's mix of the latest song someone added, which keeps Autoplay close to what people chose. Once
 * that runs out, or can't be read, from the mix of the latest song played. Throws when no mix could be read
 */
async function similarSongs(s: Session): Promise<Track[]> {
  const seeds = [s.played.findLast((p) => p.byPerson), s.played.at(-1)].filter((p, n, all): p is Session['played'][number] => !!p && all.findIndex((q) => q?.video === p.video) === n);
  const queued = new Set(queueOf(s.guild.id).map((r) => videoOf(r.uri)));
  const picked: Track[] = [];
  let failed: Error | undefined;
  for (const seed of seeds) {
    const mix = await mixOf(s, seed, (err) => (failed = err));
    for (const song of mix) {
      const video = videoOf(song.uri)!;
      if (s.seen.has(video) || queued.has(video) || picked.some((p) => p.uri === song.uri)) continue;
      if (song.durationMs < AUTOPLAY_SHORTEST_MS || song.durationMs > AUTOPLAY_LONGEST_MS) continue;
      picked.push(song);
      if (picked.length === AUTOPLAY_ADDS) return picked;
    }
  }
  if (!picked.length && failed) throw failed;
  return picked;
}

/** A seed's mix, kept for the session. One that couldn't be read is empty for a while, with `failed` hearing why */
async function mixOf(s: Session, seed: Session['played'][number], failed: (err: Error) => void): Promise<Track[]> {
  let mix = s.mixes.get(seed.video);
  if (mix && 'failedAt' in mix && Date.now() - mix.failedAt > MIX_RETRY_MS) mix = undefined;
  if (!mix) {
    try {
      mix = await mixFor(seed.url);
    } catch (err) {
      failed(err as Error);
      mix = { failedAt: Date.now() };
    }
  }
  // Most recently used last, so the oldest goes first
  s.mixes.delete(seed.video);
  s.mixes.set(seed.video, mix);
  if (s.mixes.size > MIXES_KEPT) s.mixes.delete(s.mixes.keys().next().value!);
  return Array.isArray(mix) ? mix : [];
}

/** YouTube Music's mix for a video, from the music container */
async function mixFor(url: string): Promise<Track[]> {
  const answer = await askYoutube('/similar', { url });
  if (answer.missing) return [];
  const songs = Array.isArray(answer.songs) ? (answer.songs as Record<string, unknown>[]) : [];
  return songs.flatMap((song) => {
    const video = typeof song.url === 'string' ? videoOf(song.url) : undefined;
    if (!video) return [];
    const cover = typeof song.cover === 'string' && song.cover.startsWith('https://i.ytimg.com/') ? song.cover : null;
    return [{ uri: `https://www.youtube.com/watch?v=${video}`, title: String(song.title ?? 'Untitled').slice(0, 300), artist: String(song.artist ?? '').slice(0, 300), album: '', cover, durationMs: Number(song.durationMs) || 0 }];
  });
}

/** Turns Autoplay on or off. Off takes out the songs it added that haven't played */
export function setAutoplay(guildId: string, on: boolean, who: string) {
  setSetting(guildId, 'musicAutoplay', on);
  logActivity(guildId, who, `Turned Autoplay ${on ? 'on' : 'off'}`);
  autoplayChanged(guildId);
}

/** Puts a change to the Autoplay setting into effect, from anywhere it's changed */
export function autoplayChanged(guildId: string) {
  const s = sessions.get(guildId);
  if (setting(guildId, 'musicAutoplay')) {
    if (s) void topUp(s);
  } else {
    db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND added_by = ? AND id != ?').run(guildId, AUTOPLAY, s?.current.id ?? -1);
    if (s?.note === AUTOPLAY_NOTE) s.note = null;
    // A last song waiting for it stops the music now
    stillLooking.get(guildId)?.();
  }
  // The switch on the page and the card show it
  cardChanged(guildId);
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
  /** What Autoplay knows of what played, so it neither repeats songs nor loses its place */
  played?: Session['played'];
  seen?: string[];
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
    played: s.played.slice(-MIXES_KEPT),
    seen: [...s.seen],
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
  const s = newSession(guild, channel.id, first, 'paused', positionMs);
  if (Array.isArray(saved.played)) s.played = saved.played.filter((p) => typeof p?.video === 'string' && typeof p.url === 'string' && videoOf(p.url) === p.video);
  if (Array.isArray(saved.seen)) s.seen = new Set(saved.seen.filter((v) => typeof v === 'string').slice(-PLAYED_KEPT));
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
    cardChanged(guild.id);
    return didnt(problem);
  }
  if (!humansIn(channel).length) {
    s.note = `The bot restarted while nobody was in ${channel.name}, so the music paused.`;
    cardChanged(guild.id);
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
  feeds.music.changed(guild.id);
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
      feeds.music.changed(guildId);
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
  // A jump within the file
  feeds.music.changed(guildId);
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

/** A song's page, for its title on the card */
function songLink(uri: string): string | null {
  const track = uri.match(/^spotify:track:(\w+)$/);
  if (track) return `https://open.spotify.com/track/${track[1]}`;
  return /^https:\/\//.test(uri) ? uri : null;
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** The music card: what's playing and how far in, a page of what's next, and buttons to control it */
export function musicCard(guildId: string, page = 0) {
  const rows = queueOf(guildId);
  const s = sessions.get(guildId);
  const state = musicState(guildId);
  const embed = new EmbedBuilder().setColor(0x1db954);
  const waiting = s ? rows.filter((r) => r.id !== s.current.id) : rows;
  const pages = Math.max(1, Math.ceil(waiting.length / CARD_PAGE));
  const shown = Math.max(0, Math.min(Math.trunc(page) || 0, pages - 1));

  if (s) {
    const song = s.current;
    const at = Math.min(state.positionMs, song.duration_ms);
    const where = state.channelId ? ` in <#${state.channelId}>` : '';
    const progress =
      s.phase === 'playing'
        ? `Ends <t:${Math.round((Date.now() + song.duration_ms - at) / 1000)}:R>${where}`
        : s.phase === 'paused'
          ? `Paused at ${time(at)} of ${time(song.duration_ms)}${where}`
          : `Starting${where}…`;
    embed
      .setAuthor({ name: s.phase === 'paused' ? '⏸ Paused' : s.phase === 'starting' ? '⏳ Starting' : '▶ Now playing' })
      .setTitle(cut(song.title, 256))
      .setURL(songLink(song.uri))
      .setDescription([`${cut(song.artist, 200)} · ${time(song.duration_ms)}`, progress, state.note && `-# ${state.note}`].filter(Boolean).join('\n'));
    if (song.cover) embed.setThumbnail(song.cover);
  } else {
    embed.setTitle('🎵 Music').setDescription(rows.length ? 'Not playing. ▶ starts the queue in your voice channel.' : 'The queue is empty. Add songs with /music play.');
  }
  if (waiting.length) {
    const first = shown * CARD_PAGE;
    const lines = waiting
      .slice(first, first + CARD_PAGE)
      .map((r, n) => `${first + n + 1}. **${cut(r.title, 60)}** – ${cut(r.artist, 40)} · ${time(r.duration_ms)}${r.added_by === AUTOPLAY ? ' · *Autoplay*' : ''}`);
    const left = waiting.reduce((sum, r) => sum + r.duration_ms, 0);
    embed.addFields({ name: `Up next: ${waiting.length} song${waiting.length === 1 ? '' : 's'}, ${Math.round(left / 60_000)} min`, value: lines.join('\n').slice(0, 1024) });
  }

  const playing = s?.phase === 'playing' || s?.phase === 'starting';
  const button = (id: string, label: string, emoji: string, disabled = false, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`music:${id}:${shown}`).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    playing ? button('toggle', 'Pause', '⏸') : button('toggle', 'Play', '▶', !rows.length, ButtonStyle.Success),
    button('skip', 'Skip', '⏭', !s),
    button('shuffle', 'Shuffle', '🔀', waiting.length < 2),
    button('stop', 'Stop', '⏹', !s && !rows.length, ButtonStyle.Danger),
    button('show', 'Refresh', '🔄'),
  );
  // Autoplay shares the second row with the pages, when there's more than one
  const autoplay = setting(guildId, 'musicAutoplay');
  const more = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) {
    const turn = (to: number, label: string, emoji: string) =>
      new ButtonBuilder().setCustomId(`music:show:${to}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary).setDisabled(to < 0 || to >= pages);
    more.addComponents(
      turn(shown - 1, 'Earlier', '◀'),
      new ButtonBuilder().setCustomId('music:page').setLabel(`Page ${shown + 1} of ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      turn(shown + 1, 'Later', '▶'),
    );
  }
  more.addComponents(button('autoplay', autoplay ? 'Autoplay: on' : 'Autoplay: off', '♾️', false, autoplay ? ButtonStyle.Primary : ButtonStyle.Secondary));
  return { embeds: [embed], components: [controls, more] };
}

interface Card {
  client: Client;
  channelId: string;
  messageId: string;
  timer?: NodeJS.Timeout;
}

/** The card from the latest /music play in each server, which is redrawn as the music changes */
const cards = new Map<string, Card>();

function saveCards() {
  setKv(CARDS_KEY, JSON.stringify([...cards].map(([guildId, { channelId, messageId }]) => ({ guildId, channelId, messageId }))));
}

/** Picks up the cards from before a restart and redraws them, as the music may have moved on meanwhile */
export function restoreCards(client: Client) {
  let saved: unknown;
  try {
    saved = JSON.parse(getKv(CARDS_KEY) ?? '[]');
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  for (const entry of saved as Partial<Record<'guildId' | 'channelId' | 'messageId', unknown>>[]) {
    const { guildId, channelId, messageId } = entry ?? {};
    if (typeof guildId !== 'string' || typeof channelId !== 'string' || typeof messageId !== 'string' || cards.has(guildId)) continue;
    cards.set(guildId, { client, channelId, messageId });
    cardChanged(guildId);
  }
}

async function editCard(card: Card, edit: ReturnType<typeof musicCard> | { embeds: EmbedBuilder[]; components: [] }) {
  const channel = await Promise.resolve()
    .then(() => card.client.channels.fetch(card.channelId))
    .catch(() => null);
  if (!channel?.isTextBased()) return false;
  return channel.messages.edit(card.messageId, edit).then(
    () => true,
    () => false,
  );
}

/** Keeps a newly posted card up to date. The card it takes over from loses its buttons, so only one is live */
function adoptCard(guildId: string, card: Card) {
  const old = cards.get(guildId);
  cards.set(guildId, card);
  saveCards();
  if (!old || old.messageId === card.messageId) return;
  clearTimeout(old.timer);
  void editCard(old, { embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription('🎵 The music card moved further down.')], components: [] });
}

/** Redraws the server's live card soon, once whatever changed has settled, and tells the web UI at once */
function cardChanged(guildId: string) {
  feeds.music.changed(guildId);
  const card = cards.get(guildId);
  if (!card || card.timer) return;
  card.timer = setTimeout(() => {
    card.timer = undefined;
    void editCard(card, musicCard(guildId)).then((ok) => {
      // A deleted card, or one in a channel the bot lost, is let go
      if (!ok && cards.get(guildId) === card) {
        cards.delete(guildId);
        saveCards();
      }
    });
  }, CARD_DELAY_MS);
  card.timer.unref();
}

const OUTSIDE_DJ = (guildId: string) => `Only <@&${idSetting(guildId, 'musicDjRole')}> and people with **Manage Server** can control the music.`;

/** The card's buttons, which act like the /music commands */
async function onCardButton(i: ButtonInteraction<'cached'>) {
  const [, action, pageText] = i.customId.split(':');
  const page = Number(pageText) || 0;
  if (action === 'show') return i.update(musicCard(i.guildId, page));
  if (!canControl(i.member)) return i.reply({ content: OUTSIDE_DJ(i.guildId), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (action === 'shuffle') {
    shuffleQueue(i.guildId, i.user.id);
    return i.update(musicCard(i.guildId, page));
  }
  if (action === 'autoplay') {
    setAutoplay(i.guildId, !setting(i.guildId, 'musicAutoplay'), i.user.id);
    return i.update(musicCard(i.guildId, page));
  }
  if (action === 'stop') {
    // Asked first, privately, since the queue can't be brought back
    const songs = queueOf(i.guildId).length;
    const yes = new ButtonBuilder().setCustomId('music:stop-yes:0').setLabel('Stop and clear').setStyle(ButtonStyle.Danger);
    return i.reply({
      content: `Stop the music and clear the queue${songs ? ` of ${songs} song${songs === 1 ? '' : 's'}` : ''}?`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(yes)],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (action === 'stop-yes') {
    stopMusic(i.guildId, i.user.id);
    await i.update({ content: '⏹ Stopped the music and cleared the queue.', components: [] });
    // Said in the channel too, as /music stop is, so people can see who did it
    return i.followUp({ content: `${i.user} stopped the music and cleared the queue.`, allowedMentions: { parse: [] } });
  }
  if (action !== 'toggle' && action !== 'skip') return;
  // Starting a song can take longer than the 3 s Discord waits for an answer
  await i.deferUpdate();
  let problem: string | null;
  const s = sessions.get(i.guildId);
  if (action === 'skip') problem = await skipMusic(i.guildId, i.user.id);
  else if (s && s.phase !== 'paused') problem = pauseMusic(i.guildId);
  else {
    const channel = i.member.voice.channel ?? (s && channelOf(s));
    problem = channel ? await startMusic(i.guild, channel) : 'Join a voice channel first, and the music plays there.';
  }
  await i.editReply(musicCard(i.guildId, page));
  if (problem) await i.followUp({ content: problem, flags: MessageFlags.Ephemeral });
}

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
  if (i.options.getSubcommand() === 'remove') {
    // The queue, searched by title or artist, numbered as the card shows it
    const typed = String(i.options.getFocused()).trim().toLowerCase();
    const rows = i.guildId ? queueOf(i.guildId) : [];
    const playing = i.guildId ? sessions.get(i.guildId)?.current.id : undefined;
    return i.respond(
      rows
        .map((r, n) => ({ r, label: `${r.id === playing ? '▶' : `${playing === undefined ? n + 1 : n}.`} ${r.title} – ${r.artist}` }))
        .filter(({ r }) => !typed || `${r.title} ${r.artist}`.toLowerCase().includes(typed))
        .slice(0, 25)
        .map(({ r, label }) => ({ name: label.slice(0, 100), value: String(r.id) })),
    );
  }
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
  if (sub === 'queue') return i.reply({ ...musicCard(i.guildId), flags: MessageFlags.Ephemeral });
  if (!canControl(i.member)) return reply(OUTSIDE_DJ(i.guildId));

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
    // A public answer carries the card, which then follows the music
    // Only once deferred: a song was given, or the music is being started
    const withCard = async (content: string) => {
      const message = await i.editReply({ content, ...musicCard(i.guildId), allowedMentions: { parse: [] } });
      adoptCard(i.guildId, { client: i.client, channelId: message.channelId, messageId: message.id });
    };
    if (playing) {
      if (i.deferred) return withCard(added || 'The music is already playing.');
      return i.reply({ content: 'The music is already playing.', ...musicCard(i.guildId), flags: MessageFlags.Ephemeral });
    }
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
    return withCard(`${added ? `${added} ` : ''}Playing **${now.title}** in ${channel}.`.trim());
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
  if (sub === 'remove') {
    const id = Number(i.options.getString('song', true));
    const row = Number.isInteger(id) ? await removeTrack(i.guildId, id, i.user.id) : null;
    if (!row) return reply('That song isn’t in the queue any more. Pick one from the list.');
    return announce(`Took **${row.title}** out of the queue.`);
  }
  if (sub === 'shuffle') {
    const shuffled = shuffleQueue(i.guildId, i.user.id);
    return shuffled ? announce(`Shuffled the ${shuffled} songs in the queue.`) : reply('There’s nothing to shuffle. It takes two songs waiting.');
  }
  if (sub === 'stop') {
    stopMusic(i.guildId, i.user.id);
    return announce('Stopped the music and cleared the queue.');
  }
  if (sub === 'autoplay') {
    const on = i.options.getBoolean('on') ?? !setting(i.guildId, 'musicAutoplay');
    setAutoplay(i.guildId, on, i.user.id);
    return announce(on ? 'Turned Autoplay on: when the queue runs out, similar songs from YouTube keep playing.' : 'Turned Autoplay off: the music stops when the queue runs out.');
  }
}

export const music: Feature = {
  title: 'Music',
  componentPrefix: 'music',
  onButton: (i) => (i.inCachedGuild() ? onCardButton(i) : Promise.resolve()),
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Music in voice, with a queue everyone shares')
        .setContexts(InteractionContextType.Guild)
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
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Take a song out of the queue. Taking out the one playing skips it')
            .addStringOption((o) => o.setName('song').setDescription('A song in the queue').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('stop').setDescription('Stop the music and clear the queue'))
        .addSubcommand((s) =>
          s
            .setName('autoplay')
            .setDescription('Keep playing similar songs from YouTube when the queue runs out')
            .addBooleanOption((o) => o.setName('on').setDescription('On or off. Leave it out to switch it')),
        ),
      run: (i) => (i.inCachedGuild() ? run(i) : i.reply({ content: 'Music only works in a server.', flags: MessageFlags.Ephemeral })),
      autocomplete: suggest,
    },
  ],
  setup(client) {
    // Files left from before a restart, which nothing will play now
    rmSync(filesDir(), { recursive: true, force: true });
    if (!config.musicUrl || !config.musicToken) return;
    exiting = false;
    restoreCards(client);
    saver = setInterval(() => {
      if (sessions.size || !wroteNone) saveSessions();
    }, SAVE_EVERY_MS).unref();
    void resumeAfterRestart(client).catch((err: unknown) => console.error('Music: couldn’t carry on after the restart:', err));
    // Songs left in the queue from before without a cover
    void fillCovers();
    // Stop, and everyone leaving, pause the music rather than lose the queue. The web UI's Stop leaves it playing
    onPlaybackStop((guildId, keepMusic) => {
      if (keepMusic) return;
      const s = sessions.get(guildId);
      if (s && s.phase !== 'paused') pauseHere(s, null);
    });
    onMusicCheck((guildId) => {
      const phase = sessions.get(guildId)?.phase;
      return phase === 'playing' || phase === 'starting';
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
    for (const card of cards.values()) clearTimeout(card.timer);
    listening?.abort();
    for (const s of [...sessions.values()]) endSession(s);
  },
};

/** The bot's own voice channel, for the web page to default to */
export const musicChannelFor = (guildId: string) => sessions.get(guildId)?.channelId ?? botChannelId(guildId);

/** For tests: starts from nothing and follows a fake music container's status */
export function resetMusic(next: PlayerStatus | null = null) {
  askedAhead.clear();
  toppingUp.clear();
  stillLooking.clear();
  for (const card of cards.values()) clearTimeout(card.timer);
  cards.clear();
  for (const s of sessions.values()) s.turn++;
  sessions.clear();
  status = next;
  unreachable = null;
  exiting = false;
  coverless.clear();
}

