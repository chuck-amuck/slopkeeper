import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type VoiceBasedChannel,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { feeds } from '../changes.ts';
import { db, getKv, setKv, transaction } from '../db.ts';
import { durationOf, hasAudio, tagsOf } from '../discordSounds.ts';
import * as perf from '../perf.ts';
import { idSetting, setSetting, setting } from '../settings.ts';
import { coverFor, isShortLink, MOST_FROM_LINK, myPlaylists, parseLink, pick, playlistsReady, RateLimited, SpotifyError, tracksFor, type Track } from '../spotify.ts';
import { artistSongsFor, knownTrack, searchReady, searchSongs, searchSource, sourceNames, YTM_ALBUM_REF, ytmAlbumTracks } from '../musicSearch.ts';
import type { Feature } from '../types.ts';
import { humansIn } from '../util.ts';
import { applyMusicVolume, botChannelId, onMusicCheck, onPlaybackStop, playLong } from './voiceAudio.ts';
import { EXTENSIONS } from './soundLibrary.ts';
import { songLevel, songMultiplier } from '../songLevels.ts';

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
// A file uploaded from the web page, which can be a whole song or a mix
export const MOST_FILE_BYTES = 60 * 1024 * 1024;
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
/** Songs Autoplay keeps waiting at the end of the queue while the music is on, so what comes after people's songs shows */
const AUTOPLAY_SHOWN = 3;
/** Spotify songs matched to YouTube videos kept for each session, for Autoplay to go on from */
const MATCHES_KEPT = 100;
// Shuffle picks from this many of a YouTube playlist's songs, the most the music container reads
const PLAYLIST_READ = 500;
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
/** Its video and its name for each */
const SEEN_KEPT = 2 * PLAYED_KEPT;
const AUTOPLAY_NOTE = 'Autoplay found nothing new like the songs played, so the music stops after this one.';
const YOUTUBE_VIDEO = /^https:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)(?<video>[\w-]{11})/;
// A SoundCloud track's own page, which is what a set lists, and not a set or a profile
const SOUNDCLOUD_TRACK = /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/(?<path>[\w-]+\/(?!sets(?:[/?#]|$))[\w-]+)\/?(?:[?#].*)?$/;
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
  /** Songs in a row whose file wouldn't play: two is something wider than one file, like the music folder */
  failedInRow?: number;
  channelId: string;
  phase: 'starting' | 'playing' | 'paused';
  /** When the music started, which pauses, skips and restarts keep until it stops: the web UI's music player stays hidden till then */
  since: number;
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
  /**
   * Videos Autoplay leaves out, and songs by name (see `byName`), so another upload of one isn't picked either: those
   * played, and those it added, so one taken out isn't added again
   */
  seen: Set<string>;
  /** YouTube's mix for each video Autoplay went on from, or when it last couldn't be read */
  mixes: Map<string, Track[] | { failedAt: number }>;
  /** The song Autoplay's waiting songs are like, once it's added some */
  autoplayFrom: AutoplaySeed | null;
  /** The YouTube video each Spotify song was matched to, by its URI */
  matched: Map<string, string>;
  /** The song's row in music_plays, for Stats, once it's been heard from the top */
  history?: { queueId: number; id: number };
}

/** What Autoplay goes on from: the last song in the queue someone added, or failing that, the latest played */
interface AutoplaySeed {
  /** Changes when Autoplay should start again from another song */
  key: string;
  /** The queue row, while it's a song someone queued */
  id: number | null;
  title: string | null;
  /** The queued song, to find its YouTube video */
  uri: string | null;
  /** Its YouTube video once looked for, or null if it has none */
  video?: string | null;
  /** Taken out of the queue before it played, so the song queued before it leads again */
  gone?: boolean;
}

const FROM_PLAYED: AutoplaySeed = { key: 'played', id: null, title: null, uri: null };

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

/** Queues kept from before Autoplay's songs always stayed at the end, which a shuffle or a move could put them in the middle of */
export function autoplayToEnd() {
  const guilds = db.prepare('SELECT DISTINCT guild_id AS id FROM music_queue WHERE added_by = ?').all(AUTOPLAY) as { id: string }[];
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  transaction(() => {
    for (const { id } of guilds) {
      // The first may be playing, so it stays put
      const [first, ...rest] = queueOf(id);
      [first, ...rest.filter((r) => r.added_by !== AUTOPLAY), ...rest.filter((r) => r.added_by === AUTOPLAY)].forEach((r, i) => update.run(i, r!.id));
    }
  });
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
  if (who !== AUTOPLAY) {
    // A last song that ended waiting on Autoplay goes on to this one
    stillLooking.get(guildId)?.();
    // Autoplay's songs follow this one now
    const s = sessions.get(guildId);
    if (s) void topUp(s);
  }
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

/**
 * Moves a song to a place in the queue. The song playing stays first, and people's songs stay ahead of Autoplay's, which don't move:
 * one is kept with keepTrack instead
 */
export function moveTrack(guildId: string, id: number, to: number): boolean {
  const rows = queueOf(guildId);
  const from = rows.findIndex((r) => r.id === id);
  const first = holdsFirst(guildId) ? 1 : 0;
  if (from < first || rows[from]!.added_by === AUTOPLAY) return false;
  const [row] = rows.splice(from, 1);
  rows.splice(Math.max(first, Math.min(afterPeople(rows, first), Math.trunc(to))), 0, row);
  const update = db.prepare('UPDATE music_queue SET pos = ? WHERE id = ?');
  transaction(() => rows.forEach((r, i) => update.run(i, r.id)));
  fetchNext(guildId);
  cardChanged(guildId);
  // Another song may be last now, which Autoplay follows
  const s = sessions.get(guildId);
  if (s) void topUp(s);
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
  // Another song may be last now, which Autoplay follows
  const s = sessions.get(guildId);
  if (s) void topUp(s);
  return rest.length;
}

/**
 * Keeps a song Autoplay added as if `who` had queued it: it goes to the end of people's songs, and Autoplay's other songs make way for
 * ones like it, as for any song someone adds. Returns it, or null if it isn't one of Autoplay's
 */
export function keepTrack(guildId: string, id: number, who: string): QueueRow | null {
  const rows = queueOf(guildId);
  const row = rows.find((r) => r.id === id && r.added_by === AUTOPLAY);
  if (!row) return null;
  Object.assign(row, { added_by: who, added_at: Date.now() });
  const s = sessions.get(guildId);
  if (s?.current.id === id) Object.assign(s.current, { added_by: who, added_at: row.added_at });
  const first = holdsFirst(guildId) ? 1 : 0;
  const others = rows.filter((r) => r !== row);
  if (s?.current.id !== id) others.splice(afterPeople(others, first), 0, row);
  const update = db.prepare('UPDATE music_queue SET pos = ?, added_by = ?, added_at = ? WHERE id = ?');
  transaction(() => (s?.current.id === id ? rows : others).forEach((r, i) => update.run(i, r.added_by, r.added_at, r.id)));
  logActivity(guildId, who, `Added **${row.title}** to the music queue from Autoplay`);
  fetchNext(guildId);
  cardChanged(guildId);
  if (s) void topUp(s);
  return row;
}

/** Takes a song out of the queue. Taking out the one playing skips it */
export async function removeTrack(guildId: string, id: number, who: string): Promise<QueueRow | null> {
  return (await removeTracks(guildId, [id], who))[0] ?? null;
}

/**
 * Takes several songs out of the queue at once, as one change in Activity. Taking out the one playing skips it. Returns
 * the ones that were still there
 */
export async function removeTracks(guildId: string, ids: number[], who: string): Promise<QueueRow[]> {
  const rows = queueOf(guildId).filter((r) => ids.includes(r.id));
  if (!rows.length) return [];
  const s = sessions.get(guildId);
  // An upload isn't deleted straight away, in case it was taken out by mistake
  for (const row of rows) waitAgain(guildId, row);
  if (s) seedTakenOut(s, rows.map((r) => r.id));
  const playing = rows.find((r) => r.id === s?.current.id);
  for (const row of rows) if (row !== playing) db.prepare('DELETE FROM music_queue WHERE id = ?').run(row.id);
  if (s && playing) await moveOn(s);
  tidyFiles();
  logActivity(guildId, who, rows.length === 1 ? `Removed **${rows[0]!.title}** from the music queue` : `Removed ${rows.length} songs from the music queue`);
  fetchNext(guildId);
  cardChanged(guildId);
  if (s && sessions.get(guildId) === s) void topUp(s);
  return rows;
}

/** Empties the queue, apart from the song playing */
export function clearQueue(guildId: string, who: string) {
  const s = sessions.get(guildId);
  if (s) seedTakenOut(s, queueOf(guildId).map((r) => r.id));
  db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND id != ?').run(guildId, s?.current.id ?? -1);
  tidyFiles();
  cardChanged(guildId);
  logActivity(guildId, who, 'Cleared the music queue');
  if (s) void topUp(s);
}

// ---------- the music container ----------

// The song playing, or first to play, and the one after it
const FETCHED_AHEAD = 2;
const ASKED_AHEAD_MS = 10 * 60_000;
const askedAhead = new Set<string>();
/** A song that takes this long from being due to being heard is kept for a look */
const SLOW_SONG_S = 8;

const asBridge = () => ({ authorization: `Bearer ${config.musicToken}`, 'content-type': 'application/json' });

/** Asks the music container something about YouTube. A 404 is "not found", with the reason; anything else that isn't fine throws */
export async function askYoutube(where: '/fetch' | '/lookup' | '/similar' | '/clip', body: Record<string, unknown>, trace?: perf.Trace): Promise<Record<string, unknown> & { missing?: string }> {
  const res = await fetch(`${config.musicUrl}${where}`, { method: 'POST', headers: asBridge(), body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const ytdlp = perf.serverTiming(res.headers.get('server-timing')).get('ytdlp');
  if (ytdlp !== undefined) trace?.part('yt-dlp', ytdlp, 'download');
  if (res.status === 404) return { missing: String(answer.error ?? 'Not found.') };
  // 502 is YouTube or SoundCloud turning it down; anything else is the music container itself
  if (res.status === 502) throw new TurnedDown(String(answer.error ?? 'HTTP 502'));
  if (!res.ok) throw new Error(String(answer.error ?? `HTTP ${res.status}`));
  return answer;
}

/** The music container answered, but couldn't get the song: YouTube turning one down, say, rather than the container being down */
class TurnedDown extends Error {}

/** The audio for a song: a file the music container downloaded, with where it came from, or why there isn't one */
async function fetchAudio(row: QueueRow, trace?: perf.Trace, retried = false): Promise<{ file: string; source: string; url: string | null } | { missing: string }> {
  // An upload is here already
  const uploaded = uploadedName(row.uri);
  if (uploaded) return existsSync(fileOf(uploaded)) ? { file: fileOf(uploaded), source: 'file', url: null } : { missing: 'The uploaded file is gone.' };
  const asked = performance.now();
  const answer = await askYoutube('/fetch', row.uri.startsWith('spotify:') ? { uri: row.uri, title: row.title, artist: row.artist, durationMs: row.duration_ms } : { url: row.uri }, trace);
  // The music container says when it had the song already
  if (answer.missing) return { missing: answer.missing };
  const kept = answer.kept === true;
  perf.time('music_download_seconds', (performance.now() - asked) / 1000, { kept: kept ? 'yes' : 'no' });
  if (trace) trace.detail.kept = kept;
  if (typeof answer.file !== 'string' || !SAFE_FILE.test(answer.file)) throw new Error('the music container named the file oddly');
  // Without the music container's folder, every song would fail the same way, so this pauses rather than skipping them all.
  // A file the container let go of just after answering is fetched again first
  if (!existsSync(path.join(config.musicAudioDir, answer.file)) && !retried) return fetchAudio(row, trace, true);
  if (!existsSync(path.join(config.musicAudioDir, answer.file))) throw new Unreadable(`The music player downloaded ${row.title}, but the bot can’t see its files (MUSIC_AUDIO_DIR), so the music paused.`);
  return { file: path.join(config.musicAudioDir, answer.file), source: String(answer.source ?? 'youtube'), url: typeof answer.url === 'string' ? answer.url : null };
}

/** A song the music container has, in a folder the bot can't read */
class Unreadable extends Error {}

/** Downloads still going, by song, so Autoplay looking for a song's video and fetching it ahead share one */
const fetching = new Map<string, ReturnType<typeof fetchAudio>>();

function fetchShared(row: QueueRow): ReturnType<typeof fetchAudio> {
  // By name too, like the music container, so a song queued under another name gets its own download
  const key = [row.uri, row.title.trim().toLowerCase(), row.artist.trim().toLowerCase()].join('\n');
  let job = fetching.get(key);
  if (!job) {
    job = fetchAudio(row).finally(() => fetching.delete(key));
    fetching.set(key, job);
  }
  return job;
}

/** Starts downloading the first two songs in the queue, so pressing play, and the song after, start without a wait */
function fetchNext(guildId: string) {
  if (unavailable()) return;
  for (const row of queueOf(guildId).slice(0, FETCHED_AHEAD)) {
    // The music container keeps what it downloads, but not what it couldn't find, so each is only asked about once in a while.
    // An upload needs nothing fetched
    if (askedAhead.has(row.uri) || uploadedName(row.uri)) continue;
    askedAhead.add(row.uri);
    setTimeout(() => askedAhead.delete(row.uri), ASKED_AHEAD_MS).unref();
    void fetchShared(row)
      .then((found) => {
        // Read for levelling now, so it starts without that wait when its turn comes
        if ('file' in found && setting(guildId, 'evenMusic')) void songLevel(found.file);
        // Autoplay knows the video a Spotify song was matched to before it plays
        const s = sessions.get(guildId);
        const video = 'url' in found && found.url && videoOf(found.url);
        if (s && video) matchedTo(s, row.uri, video);
      })
      .catch((err: unknown) => console.error(`Music: couldn’t fetch ${row.title} ahead:`, (err as Error).message));
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
  return {
    guild,
    channelId,
    phase,
    since: Date.now(),
    current,
    via: null,
    turn: 0,
    position: { ms: positionMs, at: Date.now(), speed: 0 },
    note: null,
    played: [],
    seen: new Set(),
    mixes: new Map(),
    autoplayFrom: null,
    matched: new Map(),
  };
}

/** Starts the queue in a channel, or carries on where it paused. Returns null on success or the reason it couldn't, for the user */
export async function startMusic(guild: Guild, channel: VoiceBasedChannel): Promise<string | null> {
  const first = queueOf(guild.id)[0];
  // An upload plays from the bot's own folder, without the music container
  const problem = first && uploadedName(first.uri) ? null : unavailable();
  if (problem) return problem;
  if (!first) return 'The queue is empty. Add a song first.';
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
  const trace = new perf.Trace('music_start_seconds', 'Music', s.guild.id, SLOW_SONG_S);
  let found: Awaited<ReturnType<typeof fetchAudio>>;
  try {
    // YouTube turns down a download now and then, and a second go often gets it
    found = await fetchAudio(row, trace).catch((err: unknown) => {
      if (!(err instanceof TurnedDown) || s.turn !== turn) throw err;
      console.error(`Music: couldn’t get ${row.title}, trying again:`, err.message);
      return fetchAudio(row, trace);
    });
    trace.step('download');
  } catch (err) {
    if (s.turn !== turn) return null;
    console.error(`Music: couldn’t get ${row.title}:`, (err as Error).message);
    if (err instanceof Unreadable) {
      pauseHere(s, err.message);
      return err.message;
    }
    // A song turned down twice is skipped, so it doesn't hold up the queue. A second in a row is something wider, like
    // YouTube turning the bot away, so the music pauses there rather than going through the whole queue
    if (err instanceof TurnedDown && !s.failedInRow) {
      s.failedInRow = 1;
      const note = `Couldn’t get ${row.title}, so it was skipped.`;
      const next = await moveOn(s);
      if (sessions.get(s.guild.id) !== s) return note;
      if (next) return next;
      s.note ??= note;
      cardChanged(s.guild.id);
      return null;
    }
    const either = err instanceof TurnedDown ? ' either' : '';
    pauseHere(s, `The music player couldn’t get ${row.title}${either}, so the music paused. Try again in a moment.`);
    return `The music player couldn’t get ${row.title}${either}. Try again in a moment.`;
  }
  if (s.turn !== turn || sessions.get(s.guild.id) !== s) return null;
  if ('missing' in found) {
    const note = uploadedName(row.uri) ? `The file for ${row.title} is gone, so it was skipped.` : `Couldn’t find ${row.title} on YouTube or SoundCloud, so it was skipped.`;
    const next = await moveOn(s);
    if (sessions.get(s.guild.id) !== s) return note;
    // The next song's own problem says more than this one being skipped
    if (next) return next;
    s.note ??= note;
    cardChanged(s.guild.id);
    return null;
  }
  // Levelled to the others once it's been read, which a song fetched ahead already has been, and which takes well under a
  // second for one that wasn't
  const gain = setting(s.guild.id, 'evenMusic') ? await songMultiplier(found.file, setting(s.guild.id, 'musicVolume')) : 1;
  trace.step('levelling');
  if (s.turn !== turn || sessions.get(s.guild.id) !== s) return null;
  const channel = channelOf(s);
  const source = found.source;
  trace.detail.source = source;
  const heard = () => {
    // Any song heard, however the last one ended, starts the count of files that won't play again
    s.failedInRow = 0;
    trace.step('starting');
    trace.end();
    // From the top only: a seek, a resume or carrying on after a restart is the same play
    if (s.history?.queueId === row.id) return;
    try {
      if (fromMs === 0) {
        const { lastInsertRowid } = insertPlay.run(s.guild.id, Date.now(), row.uri, row.title, row.artist, source, row.duration_ms, row.added_by);
        s.history = { queueId: row.id, id: Number(lastInsertRowid) };
      } else {
        // After a restart the play was started by the bot before it, so carry on with its row
        const play = openPlay.get(s.guild.id, row.uri, Date.now() - fromMs - RESUME_SLACK_MS) as { id: number } | undefined;
        if (play) s.history = { queueId: row.id, id: play.id };
      }
    } catch (err) {
      console.error('Couldn’t note a song for Stats:', err);
    }
  };
  const stop = channel ? await playLong(channel, found.file, (byItself, failed) => onSongEnd(s, turn, byItself, failed), fromMs, heard, gain) : 'That voice channel is gone.';
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
  remember(s, byName(row.title, row.artist));
  const video = found.url && videoOf(found.url);
  if (video && s.played.at(-1)?.video !== video) {
    s.played.push({ video, url: `https://www.youtube.com/watch?v=${video}`, byPerson: row.added_by !== AUTOPLAY });
    matchedTo(s, row.uri, video);
    if (s.played.length > PLAYED_KEPT) s.played.shift();
    remember(s, video);
  }
  cardChanged(s.guild.id);
  saveSessions();
  fetchNext(s.guild.id);
  void topUp(s);
  return null;
}

const insertPlay = db.prepare('INSERT INTO music_plays (guild_id, at, uri, title, artist, source, duration_ms, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const openPlay = db.prepare('SELECT id FROM music_plays WHERE guild_id = ? AND uri = ? AND played_ms IS NULL AND at >= ? ORDER BY at DESC LIMIT 1');
const finishPlay = db.prepare('UPDATE music_plays SET played_ms = ?, skipped = ? WHERE id = ?');
/** A song resumed after a restart started no further back than where it is, plus the time paused and restarting */
const RESUME_SLACK_MS = 30 * 60_000;

/** Notes in music_plays how far the current song got, if it was heard from the top. That play is then over */
function playedTo(s: Session, ms: number, skipped: boolean) {
  if (s.history?.queueId !== s.current.id) return;
  try {
    finishPlay.run(Math.round(Math.min(ms, s.current.duration_ms)), skipped ? 1 : 0, s.history.id);
  } catch (err) {
    console.error('Couldn’t note how far a song got for Stats:', err);
  }
  s.history = undefined;
}

/** A song from a file is over: it ended, so the next one plays, or it was cut off, so the music pauses */
function onSongEnd(s: Session, turn: number, byItself: boolean, failed = false) {
  if (s.turn !== turn || sessions.get(s.guild.id) !== s) return;
  s.stopAudio = undefined;
  if (byItself && s.phase === 'playing') playedTo(s, s.current.duration_ms, false);
  const movingOn = (note: string | null) =>
    void moveOn(s)
      .then((next) => {
        if (note && !next && sessions.get(s.guild.id) === s) {
          s.note ??= note;
          cardChanged(s.guild.id);
        }
      })
      .catch((err) => console.error(`Moving on to the next song in ${s.guild.name} failed:`, err));
  if (byItself && s.phase === 'playing') movingOn(null);
  // A file that won't play is skipped, like a song that can't be found. A second in a row is something wider, like the
  // music folder, so the music pauses there rather than going through the whole queue
  else if (failed && s.phase === 'playing' && !s.failedInRow) {
    s.failedInRow = 1;
    movingOn(`Couldn’t play ${s.current.title}, so it was skipped.`);
  } else if (s.phase !== 'paused') pauseHere(s, failed ? `Couldn’t play ${s.current.title} either, so the music paused.` : null);
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
  playedTo(s, positionOf(s), true);
  await moveOn(s);
  return null;
}

/** Stops the music and empties the queue */
export function stopMusic(guildId: string, who: string) {
  const s = sessions.get(guildId);
  if (s) endSession(s);
  db.prepare('DELETE FROM music_queue WHERE guild_id = ?').run(guildId);
  tidyFiles();
  // With nothing playing, only the queue changed
  cardChanged(guildId);
  logActivity(guildId, who, 'Stopped the music and cleared the queue');
}

/**
 * Goes on to the next song in the queue, or stops once there isn't one. With Autoplay on, the last song waits for it to find more.
 * Returns why the next song couldn't play, if it couldn't
 */
async function moveOn(s: Session): Promise<string | null> {
  if (autoplayOn(s) && nothingAfter(s)) {
    const { turn, current } = s;
    await untilToppedUp(s);
    // Someone skipped, stopped, paused or jumped within the song meanwhile
    if (sessions.get(s.guild.id) !== s || s.current !== current || s.turn !== turn) return null;
  }
  db.prepare('DELETE FROM music_queue WHERE id = ?').run(s.current.id);
  if (uploadedName(s.current.uri)) tidyFiles();
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
const autoplayRows = db.prepare('SELECT COUNT(*) AS n FROM music_queue WHERE guild_id = ? AND added_by = ? AND id != ?');
const dropAutoplay = db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND added_by = ? AND id != ?');

const autoplayOn = (s: Session) => setting(s.guild.id, 'musicAutoplay');
/** Whether the music runs out after the song playing */
const nothingAfter = (s: Session) => !waitingAfter.get(s.guild.id, s.current.id);
/** Autoplay's songs waiting, leaving out the one playing */
const autoplayWaiting = (s: Session) => (autoplayRows.get(s.guild.id, AUTOPLAY, s.current.id) as { n: number }).n;

/**
 * The song Autoplay goes on from: the last song in the queue that someone added, the one playing included, so the music carries on
 * in the style of whatever plays last. Once those have all played, it keeps the last of them, so its songs don't change under people
 * as the music runs on
 */
function seedOf(s: Session): AutoplaySeed {
  const last = queueOf(s.guild.id).findLast((r) => r.added_by !== AUTOPLAY);
  const from = s.autoplayFrom?.gone ? null : s.autoplayFrom;
  if (!last) return from ?? FROM_PLAYED;
  return from?.id === last.id ? from : { key: `song:${last.id}`, id: last.id, title: last.title, uri: last.uri };
}

/** Notes that the song Autoplay follows was taken out before it played, when it's among `ids` */
function seedTakenOut(s: Session, ids: number[]) {
  const id = s.autoplayFrom?.id;
  if (id != null && id !== s.current.id && ids.includes(id)) s.autoplayFrom = { ...s.autoplayFrom!, gone: true };
}

/** Autoplay's songs follow the last song in the queue someone added: once that changes, the ones waiting go, to make way for songs like it */
function followSeed(s: Session) {
  const seed = seedOf(s);
  const before = s.autoplayFrom;
  s.autoplayFrom = seed;
  if (before === seed) return;
  if (before && before.key !== seed.key && dropAutoplay.run(s.guild.id, AUTOPLAY, s.current.id).changes) cardChanged(s.guild.id);
  // So a restart carries on from the same song
  saveSessions();
}

function matchedTo(s: Session, uri: string, video: string) {
  if (videoOf(uri)) return;
  s.matched.delete(uri);
  s.matched.set(uri, video);
  if (s.matched.size > MATCHES_KEPT) s.matched.delete(s.matched.keys().next().value!);
}

/**
 * The YouTube video a queued song is, or was matched to. A Spotify song not matched yet is fetched now, which it would be before
 * playing anyway. Null for an upload, a SoundCloud song, or one that couldn't be found
 */
async function videoFor(s: Session, seed: AutoplaySeed): Promise<string | null> {
  if (!seed.uri) return null;
  const own = videoOf(seed.uri);
  if (own) return own;
  if (seed.video !== undefined) return seed.video;
  const known = s.matched.get(seed.uri);
  if (known || !seed.uri.startsWith('spotify:')) return (seed.video = known ?? null);
  const row = queueOf(s.guild.id).find((r) => r.uri === seed.uri);
  if (!row) return null;
  const found = await fetchShared(row).catch(() => null);
  // Couldn't ask: it's asked again next time. A song with no match isn't
  if (!found) return null;
  const video = 'url' in found && found.url ? (videoOf(found.url) ?? null) : null;
  if (video) matchedTo(s, seed.uri, video);
  seed.video = video;
  if (s.autoplayFrom === seed) saveSessions();
  return video;
}

/** Autoplay looking for songs in each server, which a second look waits on rather than repeating */
const toppingUp = new Map<string, Promise<void>>();
/** Servers whose queue changed while Autoplay looked, so it looks again once it's done */
const lookAgainFor = new Set<string>();
/** The last song in each server that ended while Autoplay looked, which a song being added or the music stopping lets go on */
const stillLooking = new Map<string, () => void>();

/** Notes a video or song name as played or added, so Autoplay doesn't pick it again */
function remember(s: Session, seen: string | null) {
  if (!seen) return;
  s.seen.delete(seen);
  s.seen.add(seen);
  if (s.seen.size > SEEN_KEPT) s.seen.delete(s.seen.values().next().value!);
}

/** What follows a dash in a song's name that says which version it is: “- 2009 Remaster”, “- Live at Leeds”, “- Radio Edit” */
const VERSION_NOTE = /^(\d{4}\s+)?(remaster(ed)?\b|live(\s+(at|in|from|on)\b|$)|mono\b|stereo\b|demo\b|acoustic\b|instrumental\b|.*\b(version|edit|remix|remaster(ed)?)$)/i;
/** Letters and digits alone, accents and case aside */
const plainText = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
/** An artist or channel by name, as the music container compares them: LinkinParkVEVO and Linkin Park are one */
const plainArtist = (name: string) => plainText(name).replace(/official|vevo|topic|music/g, '');

/** A song's name without what's in brackets: (Official Video), [Lyrics], (feat. Someone) */
const unbracketed = (title: string) => title.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();

/**
 * A song as Autoplay knows it by name, since YouTube has many uploads of a song and its mix offers any of them: “The
 * Fruits of Conquest” matched from Spotify and “The Strokes - The Fruits of Conquest (Official Video)” are one. Brackets
 * go, and a dash's other side when one side is the artist or the other says which version it is, so remasters, live
 * versions and features count as the song too. A title like “Artist - Song” from a label's channel is kept whole, as
 * the artist can't be told from the song (see `namesOf`). Another artist's song of the same name counts too, which
 * Autoplay can do without. Null when nothing's left to go by
 */
export function byName(title: string, artist: string): string | null {
  let name = unbracketed(title);
  const parts = name.split(/\s+[-–—]\s+/);
  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    const artists = [artist, ...artist.split(/\s*(?:,|&|\band\b)\s*/)].map(plainArtist).filter(Boolean);
    if (artists.includes(plainArtist(first))) name = second;
    else if (artists.includes(plainArtist(second)) || VERSION_NOTE.test(second)) name = first;
  }
  const plain = plainText(name.replace(/\s(feat|ft)\.?\s.*$/i, ''));
  return plain ? `name:${plain}` : null;
}

/** A song from YouTube's mix by each name an upload of it might have been known by: its own, and its artist and name together, as a title from a label's channel is */
function namesOf(song: { title: string; artist: string }): string[] {
  const title = unbracketed(song.title);
  const together = [`${song.artist} ${title}`, `${title} ${song.artist}`].map(plainText);
  return [byName(song.title, song.artist), ...together.map((plain) => `name:${plain}`)].filter((name): name is string => !!name);
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

/**
 * Keeps Autoplay's songs waiting at the end while it's on, like the last song in the queue someone added. A look already going is waited on, and
 * looks again afterwards if that song changed meanwhile
 */
function topUp(s: Session): Promise<void> {
  const guildId = s.guild.id;
  if (!autoplayOn(s)) return Promise.resolve();
  followSeed(s);
  const looking = toppingUp.get(guildId);
  if (looking) {
    lookAgainFor.add(guildId);
    return looking;
  }
  if (unavailable() || autoplayWaiting(s) >= AUTOPLAY_SHOWN) return Promise.resolve();
  const from = s.autoplayFrom!.key;
  let again = false;
  const job = similarSongs(s, AUTOPLAY_SHOWN - autoplayWaiting(s))
    .then((songs) => {
      // Stopped or turned off meanwhile
      if (sessions.get(guildId) !== s || !autoplayOn(s)) return;
      // Someone queued another song while it looked, so it looks again from that one
      if (seedOf(s).key !== from) return void (again = true);
      if (!songs.length) {
        // Only worth saying when the music would stop
        if (nothingAfter(s)) {
          s.note = AUTOPLAY_NOTE;
          cardChanged(guildId);
        }
        return;
      }
      if (s.note === AUTOPLAY_NOTE) s.note = null;
      const room = AUTOPLAY_SHOWN - autoplayWaiting(s);
      if (room <= 0) return;
      for (const song of songs.slice(0, room)) {
        remember(s, videoOf(song.uri)!);
        remember(s, byName(song.title, song.artist));
      }
      addTracks(guildId, songs.slice(0, room), AUTOPLAY);
    })
    .catch((err: unknown) => console.error(`Music: Autoplay couldn’t find songs in ${s.guild.name}:`, (err as Error).message))
    .finally(() => {
      toppingUp.delete(guildId);
      if (lookAgainFor.delete(guildId)) again = true;
      // Music started since this look began looks for itself now
      const now = sessions.get(guildId);
      if (now && (again || now !== s)) void topUp(now);
    });
  toppingUp.set(guildId, job);
  return job;
}

/**
 * Up to `wanted` songs not played yet from YouTube's mix of the last song in the queue someone added, which keeps Autoplay close to what people
 * chose. Once that runs out, or can't be read, from the mix of the latest song someone played, then the latest played. Throws when no
 * mix could be read
 */
async function similarSongs(s: Session, wanted: number): Promise<Track[]> {
  const queuedVideo = await videoFor(s, s.autoplayFrom!);
  const fromQueue = queuedVideo ? { video: queuedVideo, url: `https://www.youtube.com/watch?v=${queuedVideo}` } : undefined;
  const seeds = [fromQueue, s.played.findLast((p) => p.byPerson), s.played.at(-1)].filter((p, n, all): p is { video: string; url: string } => !!p && all.findIndex((q) => q?.video === p.video) === n);
  // A Spotify song is known by the video it was matched to, so the song Autoplay follows isn't offered back, and any song by its name
  const queued = new Set(queueOf(s.guild.id).flatMap((r) => [videoOf(r.uri) ?? s.matched.get(r.uri), byName(r.title, r.artist)]));
  if (queuedVideo) queued.add(queuedVideo);
  const picked: Track[] = [];
  let failed: Error | undefined;
  for (const seed of seeds) {
    const mix = await mixOf(s, seed, (err) => (failed = err));
    for (const song of mix) {
      const video = videoOf(song.uri)!;
      if (s.seen.has(video) || queued.has(video) || picked.some((p) => p.uri === song.uri)) continue;
      // Another upload of a song played, queued or picked already
      const names = namesOf(song);
      if (names.some((name) => s.seen.has(name) || queued.has(name) || picked.some((p) => byName(p.title, p.artist) === name))) continue;
      if (song.durationMs < AUTOPLAY_SHORTEST_MS || song.durationMs > AUTOPLAY_LONGEST_MS) continue;
      picked.push(song);
      if (picked.length === wanted) return picked;
    }
  }
  if (!picked.length && failed) throw failed;
  return picked;
}

/** A seed's mix, kept for the session. One that couldn't be read is empty for a while, with `failed` hearing why */
async function mixOf(s: Session, seed: { video: string; url: string }, failed: (err: Error) => void): Promise<Track[]> {
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
  return answer.missing ? [] : listedSongs(answer.songs);
}

/** YouTube videos or SoundCloud tracks the music container listed, as songs for the queue. Any other link is left out */
function listedSongs(listed: unknown): Track[] {
  const songs = Array.isArray(listed) ? (listed as Record<string, unknown>[]) : [];
  return songs.flatMap((song) => {
    const link = typeof song.url === 'string' ? song.url : '';
    const video = videoOf(link);
    const track = link.match(SOUNDCLOUD_TRACK)?.groups?.path;
    const uri = video ? `https://www.youtube.com/watch?v=${video}` : track ? `https://soundcloud.com/${track}` : null;
    if (!uri) return [];
    const cover = typeof song.cover === 'string' && /^https:\/\/(i\.ytimg\.com|i1\.sndcdn\.com)\//.test(song.cover) ? song.cover : null;
    return [{ uri, title: String(song.title ?? 'Untitled').slice(0, 300), artist: String(song.artist ?? '').slice(0, 300), album: '', cover, durationMs: Number(song.durationMs) || 0 }];
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
    dropAutoplay.run(guildId, AUTOPLAY, s?.current.id ?? -1);
    if (s) s.autoplayFrom = null;
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
  since?: number;
  autoplayFrom?: AutoplaySeed | null;
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
    since: s.since,
    autoplayFrom: s.autoplayFrom,
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
  if (Array.isArray(saved.seen)) s.seen = new Set(saved.seen.filter((v) => typeof v === 'string').slice(-SEEN_KEPT));
  if (Number.isFinite(saved.since)) s.since = saved.since!;
  const seed = saved.autoplayFrom;
  if (seed && typeof seed.key === 'string') {
    s.autoplayFrom = {
      key: seed.key,
      id: Number.isInteger(seed.id) ? seed.id : null,
      title: typeof seed.title === 'string' ? seed.title : null,
      uri: typeof seed.uri === 'string' ? seed.uri : null,
      ...(seed.video === null || (typeof seed.video === 'string' && /^[\w-]{11}$/.test(seed.video)) ? { video: seed.video } : {}),
      ...(seed.gone === true ? { gone: true } : {}),
    };
  }
  sessions.set(guild.id, s);
  saveSessions();
  if (!saved.playing) return;
  // An uploaded file plays without the music container, so it doesn't wait for it
  const needsPlayer = !uploadedName(first.uri);
  const until = Date.now() + READY_WAIT_MS;
  while (needsPlayer && unavailable() && Date.now() < until) await sleep(READY_CHECK_MS);
  // Someone pressed play, skipped or stopped meanwhile
  if (sessions.get(guild.id) !== s || s.turn !== 0 || s.phase !== 'paused') return;
  const problem = needsPlayer && unavailable();
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

// ---------- uploaded files ----------

/** How an uploaded file's queue row names it: `file:` and its name in the files folder */
const FILE_URI = /^file:([0-9a-f]{16}\.[a-z0-9]+)$/;
/** An upload waits this long for Play next or Add to end, then it's deleted */
const UPLOAD_WAIT_MS = 60 * 60_000;
/** The room each server's uploads take at most, those waiting and those in the queue */
export const MOST_FILES_BYTES = 500 * 1024 * 1024;
const FULL = `Uploaded files take up to ${MOST_FILES_BYTES / 1024 / 1024} MB for each server, and that’s used up. Remove one from the queue, or wait for one to play.`;

/** An upload waiting for Play next or Add to end, as the song it'll be */
interface Upload {
  guildId: string;
  track: Track;
  bytes: number;
  timer: NodeJS.Timeout;
}

/** What the page is told of an upload, to add it with */
export interface UploadedFile {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
}

/** Uploads waiting, by their name in the folder */
const uploads = new Map<string, Upload>();
/** Uploads still arriving or being checked, which a tidy-up leaves alone */
const arriving = new Set<string>();
const filesDir = () => path.join(config.dataDir, 'music-files');
const fileOf = (name: string) => path.join(filesDir(), name);
const uploadedName = (uri: string) => FILE_URI.exec(uri)?.[1];
const sizeOf = (file: string) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** The room a server's uploads take, waiting and queued */
function filesBytes(guildId: string): number {
  let bytes = 0;
  for (const upload of uploads.values()) if (upload.guildId === guildId) bytes += upload.bytes;
  for (const { uri } of db.prepare("SELECT uri FROM music_queue WHERE guild_id = ? AND uri LIKE 'file:%'").all(guildId) as unknown as { uri: string }[]) {
    const name = uploadedName(uri);
    if (name) bytes += sizeOf(fileOf(name));
  }
  return bytes;
}

/** Why a file can't be uploaded, from its name and size alone, or null if it might */
export function fileProblem(guildId: string, ext: string, size: number): string | null {
  if (!EXTENSIONS.includes(ext)) return `That isn’t a file the bot can play. Use one of: ${EXTENSIONS.join(', ')}`;
  if (size > MOST_FILE_BYTES) return `That file is over ${MOST_FILE_BYTES / 1024 / 1024} MB.`;
  return size && filesBytes(guildId) + size > MOST_FILES_BYTES ? FULL : null;
}

/**
 * Takes an upload: `save` writes it to the file it's given, then it's checked, and waits for Play next or Add to end. Named by its
 * own tags, or its file name. Returns what it is, or why it can't be played, for the user
 */
export async function uploadFile(guildId: string, fileName: string, save: (file: string) => Promise<void>): Promise<UploadedFile | string> {
  const ext = path.extname(fileName).toLowerCase();
  const problem = fileProblem(guildId, ext, 0);
  if (problem) return problem;
  mkdirSync(filesDir(), { recursive: true });
  const name = `${randomBytes(8).toString('hex')}${ext}`;
  const file = fileOf(name);
  arriving.add(name);
  try {
    await save(file);
    const seconds = (await hasAudio(file)) ? await durationOf(file).catch(() => NaN) : null;
    const tags: Awaited<ReturnType<typeof tagsOf>> = seconds === null ? {} : await tagsOf(file);
    // From here to taking its place among the uploads has no waiting, so two at once can't both fit in the room left for one
    const bytes = sizeOf(file);
    const problem =
      seconds === null
        ? 'That file doesn’t have any audio the bot can read.'
        : !Number.isFinite(seconds)
          ? 'The bot can’t tell how long that file is, so it won’t play it.'
          : seconds * 1000 > LONGEST_FILE_MS
            ? `That file is over ${LONGEST_FILE_MS / 60_000} minutes long.`
            : filesBytes(guildId) + bytes > MOST_FILES_BYTES
              ? FULL
              : null;
    if (problem) {
      rmSync(file, { force: true });
      return problem;
    }
    const track: Track = {
      uri: `file:${name}`,
      title: tags.title ?? (path.basename(fileName, path.extname(fileName)).trim().slice(0, 300) || 'An uploaded file'),
      artist: tags.artist ?? 'Uploaded file',
      album: tags.album ?? '',
      cover: null,
      durationMs: Math.round(seconds! * 1000),
    };
    const timer = setTimeout(() => discardUpload(guildId, name), UPLOAD_WAIT_MS).unref();
    uploads.set(name, { guildId, track, bytes, timer });
    return { id: name, title: track.title, artist: track.artist, durationMs: track.durationMs };
  } finally {
    arriving.delete(name);
  }
}

/** Adds an upload waiting to the queue, to the end or to play next. Returns the song it is, or why it couldn't */
export function queueUpload(guildId: string, id: string, who: string, next: boolean): Track | 'gone' | 'full' {
  const upload = uploads.get(id);
  if (upload?.guildId !== guildId) return 'gone';
  if (!addTracks(guildId, [upload.track], who, next)) return 'full';
  clearTimeout(upload.timer);
  uploads.delete(id);
  logActivity(guildId, who, `Added the file **${upload.track.title}** to the music queue${next ? ' to play next' : ''}`);
  return upload.track;
}

/** An upload taken out of the queue waits again for an hour, so Undo can put it back */
function waitAgain(guildId: string, row: QueueRow) {
  const name = uploadedName(row.uri);
  if (!name || !existsSync(fileOf(name))) return;
  const track: Track = { uri: row.uri, title: row.title, artist: row.artist, album: row.album, cover: row.cover, durationMs: row.duration_ms };
  const timer = setTimeout(() => discardUpload(guildId, name), UPLOAD_WAIT_MS).unref();
  uploads.set(name, { guildId, track, bytes: sizeOf(fileOf(name)), timer });
}

/** Deletes an upload that's still waiting. Returns whether there was one */
export function discardUpload(guildId: string, id: string): boolean {
  const upload = uploads.get(id);
  if (upload?.guildId !== guildId) return false;
  clearTimeout(upload.timer);
  uploads.delete(id);
  rmSync(fileOf(id), { force: true });
  return true;
}

/** Deletes the uploaded files nothing needs: not arriving, waiting, or in a queue. Exported for tests, as a restart does it */
export function tidyFiles() {
  let names: string[];
  try {
    names = readdirSync(filesDir());
  } catch {
    return;
  }
  const queued = new Set((db.prepare("SELECT uri FROM music_queue WHERE uri LIKE 'file:%'").all() as unknown as { uri: string }[]).map((r) => uploadedName(r.uri)));
  for (const name of names) {
    if (arriving.has(name) || uploads.has(name) || queued.has(name)) continue;
    // Tidying never gets in the way of the music
    try {
      rmSync(fileOf(name), { force: true, recursive: true });
    } catch (err) {
      console.error(`Music: couldn’t delete the upload ${name}:`, (err as Error).message);
    }
  }
}

// ---------- adding by search or link ----------

/** Songs for whatever was typed: a Spotify link to a song, album or playlist, a YouTube or SoundCloud link, or words to search for. The name says what was found */
export async function resolve(guildId: string, input: string, shuffle = false): Promise<{ name: string; tracks: Track[]; capped?: boolean; note?: string }> {
  // One of /music play's suggestions, as it was found
  const known = knownTrack(input);
  if (known) return { name: songName(known), tracks: [known] };
  // An album chat found on YouTube Music
  const album = YTM_ALBUM_REF.exec(input.trim());
  if (album) return ytmAlbumTracks(album[1], shuffle);
  if (isShortLink(input)) throw new SpotifyError('Short spotify.link links can’t be read. Open it and copy the open.spotify.com link instead.');
  const link = parseLink(input);
  if (link) return tracksFor(link, shuffle);
  if (OTHER_LINK.test(input.trim())) return lookUp(input.trim(), shuffle);
  if (/^https?:\/\//i.test(input.trim())) throw new SpotifyError('That isn’t a Spotify, YouTube or SoundCloud link.');
  const {
    found: [top],
    answered,
    failed,
  } = await searchSongs(guildId, input);
  if (!top) throw new SpotifyError(`Nothing on ${sourceNames(answered)} matches “${input.trim()}”.${failed ? ` ${failed}` : ''}`);
  return { name: songName(top), tracks: [top] };
}

/** “Title by Artist”, or the title alone for a song with no artist */
function songName(track: Track) {
  return track.artist ? `${track.title} by ${track.artist}` : track.title;
}

/**
 * What a YouTube or SoundCloud link is, from the music container: one song, or a playlist's first MOST_FROM_LINK
 * songs, or that many at random. A YouTube playlist shuffles from its first PLAYLIST_READ, and a SoundCloud set from
 * all of it, as the music container picks before reading each track. `note` says what was left out
 */
async function lookUp(url: string, shuffle = false): Promise<{ name: string; tracks: Track[]; note?: string }> {
  const problem = unavailable();
  if (problem) throw new SpotifyError(problem);
  const soundcloud = /^https?:\/\/([\w-]+\.)?soundcloud\.com\//i.test(url);
  let answer: Awaited<ReturnType<typeof askYoutube>>;
  try {
    answer = await askYoutube('/lookup', { url, count: shuffle && !soundcloud ? PLAYLIST_READ : MOST_FROM_LINK, shuffle });
  } catch (err) {
    console.error('Music: couldn’t look up a link:', (err as Error).message);
    throw new SpotifyError('The music player couldn’t read that link. Try again in a moment.');
  }
  if (answer.missing) throw new SpotifyError(answer.missing);
  if (answer.playlist) {
    const all = listedSongs(answer.songs);
    const skipped = Math.max(0, Math.floor(Number(answer.skipped)) || 0);
    const notes = [
      answer.more === true &&
        (soundcloud
          ? !shuffle && `the first ${MOST_FROM_LINK}; shuffle picks from all of it`
          : shuffle
            ? `picked from its first ${PLAYLIST_READ}`
            : `the first ${MOST_FROM_LINK}; shuffle picks from its first ${PLAYLIST_READ}`),
      skipped &&
        (soundcloud
          ? `${skipped} locked or over-long ${skipped === 1 ? 'track' : 'tracks'} left out`
          : `${skipped} private, deleted, live or over-long ${skipped === 1 ? 'video' : 'videos'} left out`),
    ].filter(Boolean);
    return { name: String(answer.title ?? 'A playlist').slice(0, 300), tracks: pick(all, shuffle), note: notes.join(', ') };
  }
  const title = String(answer.title ?? 'Untitled').slice(0, 300);
  const cover = typeof answer.cover === 'string' && /^https:\/\/(i\.ytimg\.com|i1\.sndcdn\.com)\//.test(answer.cover) ? answer.cover : null;
  const track: Track = { uri: String(answer.url ?? url), title, artist: String(answer.artist ?? '').slice(0, 300), album: '', cover, durationMs: Number(answer.durationMs) || 0 };
  return { name: track.artist ? `${title} by ${track.artist}` : title, tracks: [track] };
}

/** Adds what was typed and says what happened. `shuffle` picks an album's or playlist's songs at random. Throws SpotifyError with a message for the user */
export async function queueFrom(guildId: string, input: string, who: string, next: boolean, shuffle = false): Promise<string> {
  const found = await resolve(guildId, input, shuffle);
  if (!found.tracks.length) throw new SpotifyError(`**${found.name}** has no songs that can be played here.`);
  const added = addTracks(guildId, found.tracks, who, next);
  if (!added) throw new SpotifyError(`The queue is full (${MOST_QUEUED} songs).`);
  const songs = `${added}${shuffle && found.tracks.length > 1 ? ' random' : ''} song${added === 1 ? '' : 's'}`;
  const what = found.tracks.length === 1 ? `**${found.name}**` : `${songs} from **${found.name}**`;
  logActivity(guildId, who, `Added ${what} to the music queue${next ? ' to play next' : ''}`);
  const cut =
    found.tracks.length > added
      ? ` (only ${added} fitted)`
      : found.note !== undefined
        ? found.note && ` (${found.note})`
        : found.capped
        ? ` (the first ${MOST_FROM_LINK} Spotify shows)`
        : !shuffle && found.tracks.length >= MOST_FROM_LINK
          ? ` (the first ${MOST_FROM_LINK}; shuffle picks from all of it)`
          : '';
  return `Added ${what}${cut}.`;
}

/** Adds an artist's best-known songs, by their ref from chat's find_music. Returns what was added, or throws a SpotifyError saying why not */
export async function queueArtist(guildId: string, ref: string, who: string, next: boolean, shuffle = false): Promise<string> {
  const { found, answered, failed, name: artist } = await artistSongsFor(guildId, ref);
  const tracks = pick(found, shuffle);
  if (!tracks.length) throw new SpotifyError(`No songs by **${artist}** on ${sourceNames(answered)}.${failed ? ` ${failed}` : ''}`);
  const added = addTracks(guildId, tracks, who, next);
  if (!added) throw new SpotifyError(`The queue is full (${MOST_QUEUED} songs).`);
  // As the service spells it, rather than every artist on the first song
  const named = tracks[0].artist.split(', ').find((a) => a.toLowerCase() === artist.trim().toLowerCase()) ?? artist.trim();
  const what = `${added} song${added === 1 ? '' : 's'} by **${named}**`;
  logActivity(guildId, who, `Added ${what} to the music queue${next ? ' to play next' : ''}`);
  return `Added ${what}${added < tracks.length ? ` (only ${added} fitted)` : ''}.`;
}

/** Whether music is playing, or starting, rather than paused or stopped */
export const musicPlaying = (guildId: string) => {
  const s = sessions.get(guildId);
  return !!s && s.phase !== 'paused';
};

// ---------- what the web page and /music queue show ----------

export function musicState(guildId: string) {
  const s = sessions.get(guildId);
  return {
    problem: unavailable(),
    searchReady: searchReady(),
    // Where searching on the Music tab looks first
    searchFrom: searchSource(guildId),
    // Only with the account's sign-in; without it the page doesn't offer them
    playlistsReady: playlistsReady(),
    phase: s?.phase ?? 'stopped',
    since: s?.since ?? null,
    // Playing a sound elsewhere from the soundboard takes the bot, and the music, with it
    channelId: s ? ((s.stopAudio && botChannelId(guildId)) || s.channelId) : null,
    positionMs: s ? Math.round(Math.min(positionOf(s), s.current.duration_ms)) : 0,
    note: s?.note ?? null,
    via: s?.via ?? null,
    /** The song Autoplay's songs are like, for their heading */
    autoplayLike: s?.autoplayFrom?.title ?? null,
  };
}

export const time = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

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
    // Autoplay's songs come after people's, under a heading of their own
    const lines = waiting.slice(first, first + CARD_PAGE).flatMap((r, n) => {
      const line = `${first + n + 1}. **${cut(r.title, 60)}** – ${cut(r.artist, 40)} · ${time(r.duration_ms)}`;
      const startsAutoplay = r.added_by === AUTOPLAY && waiting[first + n - 1]?.added_by !== AUTOPLAY;
      return startsAutoplay ? [`-# ♾️ Autoplay${state.autoplayLike ? `, like ${cut(state.autoplayLike, 60)}` : ''}`, line] : [line];
    });
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
  const volume = setting(guildId, 'musicVolume');
  const loudness = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('quieter', 'Quieter', '🔉', volume <= 0),
    new ButtonBuilder().setCustomId('music:volume').setLabel(`Volume ${volume}%`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    button('louder', 'Louder', '🔊', volume >= MOST_VOLUME),
  );
  return { embeds: [embed], components: [controls, more, loudness] };
}

// The card's volume buttons step by this, up to /setup's limit
const VOLUME_STEP = 5;
const MOST_VOLUME = 200;

interface Card {
  client: Client;
  channelId: string;
  messageId: string;
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

const stuckCards = new Map<string, string>();

/**
 * Edits a card or panel. 'gone' when its message or channel was deleted, so it can be let go; 'failed' for anything
 * else, like Discord not answering, which the next change tries again
 */
async function editCard(card: Card, edit: ReturnType<typeof musicCard> | { embeds: EmbedBuilder[]; components: [] }): Promise<'ok' | 'gone' | 'failed'> {
  try {
    const channel = await card.client.channels.fetch(card.channelId);
    if (!channel?.isTextBased()) return 'gone';
    await channel.messages.edit(card.messageId, edit);
    stuckCards.delete(card.messageId);
    return 'ok';
  } catch (err) {
    const code = err instanceof DiscordAPIError ? err.code : null;
    if (code === RESTJSONErrorCodes.UnknownMessage || code === RESTJSONErrorCodes.UnknownChannel) return 'gone';
    const reason = err instanceof Error ? err.message : String(err);
    if (stuckCards.get(card.messageId) !== reason) console.error(`Music card ${card.messageId} in channel ${card.channelId} can’t be updated:`, reason);
    stuckCards.set(card.messageId, reason);
    return 'failed';
  }
}

/** The client panels are redrawn through, which is the bot's: known once music is set up, or a panel is posted */
let panelClient: Client | null = null;
const panelsOf = (guildId: string) =>
  db.prepare('SELECT message_id, channel_id, page FROM music_panels WHERE guild_id = ? ORDER BY rowid').all(guildId) as { message_id: string; channel_id: string; page: number }[];

export function trackMusicPanel(messageId: string, guildId: string, channelId: string, page = 0) {
  db.prepare('INSERT INTO music_panels (message_id, guild_id, channel_id, page) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET page = excluded.page').run(
    messageId,
    guildId,
    channelId,
    page,
  );
}

/** Posts a music panel from outside Discord, which stays where it is and follows the music */
export async function postMusicPanel(client: Client, channel: GuildTextBasedChannel) {
  panelClient ??= client;
  const message = await channel.send({ ...musicCard(channel.guild.id), allowedMentions: { parse: [] } });
  trackMusicPanel(message.id, channel.guild.id, channel.id);
}

/** Keeps a newly posted card up to date. The card it takes over from loses its buttons, so only one is live */
function adoptCard(guildId: string, card: Card) {
  const old = cards.get(guildId);
  cards.set(guildId, card);
  saveCards();
  if (!old || old.messageId === card.messageId) return;
  void editCard(old, { embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription('🎵 The music card moved further down.')], components: [] });
}

const redraws = new Map<string, NodeJS.Timeout>();

/** Redraws the server's live card and its panels soon, once whatever changed has settled, and tells the web UI at once */
function cardChanged(guildId: string) {
  feeds.music.changed(guildId);
  if (redraws.has(guildId)) return;
  const timer = setTimeout(() => {
    redraws.delete(guildId);
    void redrawCards(guildId);
  }, CARD_DELAY_MS);
  timer.unref();
  redraws.set(guildId, timer);
}

/** Redraws the cards when something they show changed outside the music, like its volume */
export const musicCardsChanged = (guildId: string) => cardChanged(guildId);

async function redrawCards(guildId: string) {
  const card = cards.get(guildId);
  // A deleted card is let go
  if (card && (await editCard(card, musicCard(guildId))) === 'gone' && cards.get(guildId) === card) {
    cards.delete(guildId);
    saveCards();
  }
  if (!panelClient) return;
  for (const p of panelsOf(guildId)) {
    const panel = { client: panelClient, channelId: p.channel_id, messageId: p.message_id };
    if ((await editCard(panel, musicCard(guildId, p.page))) === 'gone') db.prepare('DELETE FROM music_panels WHERE message_id = ?').run(p.message_id);
  }
}

export const OUTSIDE_DJ = (guildId: string) => `Only <@&${idSetting(guildId, 'musicDjRole')}> and people with **Manage Server** can control the music.`;

/** The card's buttons, which act like the /music commands */
async function onCardButton(i: ButtonInteraction<'cached'>) {
  const [, action, pageText] = i.customId.split(':');
  const page = Number(pageText) || 0;
  if (action === 'show') {
    // A panel stays on the page it was turned to
    db.prepare('UPDATE music_panels SET page = ? WHERE message_id = ?').run(page, i.message.id);
    return i.update(musicCard(i.guildId, page));
  }
  if (!canControl(i.member)) return i.reply({ content: OUTSIDE_DJ(i.guildId), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (action === 'shuffle') {
    shuffleQueue(i.guildId, i.user.id);
    return i.update(musicCard(i.guildId, page));
  }
  if (action === 'autoplay') {
    setAutoplay(i.guildId, !setting(i.guildId, 'musicAutoplay'), i.user.id);
    return i.update(musicCard(i.guildId, page));
  }
  if (action === 'quieter' || action === 'louder') {
    // To the next multiple of the step, so 18% goes to 20% or 15%
    const now = setting(i.guildId, 'musicVolume');
    const next = action === 'louder' ? Math.min(MOST_VOLUME, Math.floor(now / VOLUME_STEP) * VOLUME_STEP + VOLUME_STEP) : Math.max(0, Math.ceil(now / VOLUME_STEP) * VOLUME_STEP - VOLUME_STEP);
    setSetting(i.guildId, 'musicVolume', next);
    applyMusicVolume(i.guildId);
    logActivity(i.guildId, i.user.id, `Set Music volume to ${next}%`);
    cardChanged(i.guildId);
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

export function canControl(member: GuildMember): boolean {
  const role = idSetting(member.guild.id, 'musicDjRole');
  return !role || member.roles.cache.has(role) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

const searches = new Map<string, { at: number; tracks: Track[] }>();

/** Songs to suggest for what's being typed, from the server's own search service */
async function searched(guildId: string, typed: string): Promise<Track[]> {
  const key = `${guildId} ${typed.toLowerCase()}`;
  let found = searches.get(key);
  if (!found || Date.now() - found.at > 60_000) {
    found = { at: Date.now(), tracks: (await searchSongs(guildId, typed, true).catch(() => null))?.found ?? [] };
    searches.set(key, found);
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
  if (!typed || !i.guildId || /^(https?:\/\/|spotify:)/i.test(typed) || !searchReady()) return i.respond([]);
  // The account's own playlists that match come first, as searching can't find them. Discord waits 3 seconds, so both are asked at once
  const [lists, tracks] = await Promise.all([
    playlistsReady() ? myPlaylists().then((all) => all.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())).slice(0, 5), () => []) : [],
    typed.length < 3 ? [] : searched(i.guildId, typed),
  ]);
  return i.respond([
    ...lists.map((p) => ({ name: `Playlist: ${p.name} (${p.songs} song${p.songs === 1 ? '' : 's'})`.slice(0, 100), value: `spotify:playlist:${p.id}` })),
    ...tracks.slice(0, 25 - lists.length).map((t) => ({ name: `${t.title}${t.artist ? ` – ${t.artist}` : ''}`.slice(0, 100), value: t.uri })),
  ]);
}

async function run(i: ChatInputCommandInteraction<'cached'>) {
  const sub = i.options.getSubcommand();
  const reply = (content: string) => i.reply({ content, flags: MessageFlags.Ephemeral });
  // What changes the music for everyone is said in the channel, so people can see who did it
  const announce = (content: string) => i.reply({ content, allowedMentions: { parse: [] } });
  if (sub === 'queue') return i.reply({ ...musicCard(i.guildId), flags: MessageFlags.Ephemeral });
  if (sub === 'panel') {
    panelClient ??= i.client;
    const response = await i.reply({ ...musicCard(i.guildId), withResponse: true, allowedMentions: { parse: [] } });
    const message = response.resource?.message;
    if (!message) return;
    trackMusicPanel(message.id, i.guildId, message.channelId);
    // Slash commands work in channels the bot can't see, but it can't keep a panel up to date there
    if ((await editCard({ client: i.client, channelId: message.channelId, messageId: message.id }, musicCard(i.guildId))) !== 'ok') {
      await i.followUp({ content: 'This panel works, but it can’t follow the music, because I can’t see this channel. If it’s private, add me to it under **Edit Channel → Permissions**.', flags: MessageFlags.Ephemeral });
    }
    return;
  }
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
            .addStringOption((o) => o.setName('song').setDescription('A song to search for, or a Spotify, YouTube or SoundCloud link').setAutocomplete(true).setMaxLength(300))
            .addBooleanOption((o) => o.setName('next').setDescription('Play it after the current song, instead of at the end'))
            .addBooleanOption((o) => o.setName('shuffle').setDescription('For an album or playlist: 100 of its songs at random, instead of the first 100')),
        )
        .addSubcommand((s) => s.setName('pause').setDescription('Pause the music, keeping the queue'))
        .addSubcommand((s) => s.setName('skip').setDescription('Skip to the next song'))
        .addSubcommand((s) => s.setName('queue').setDescription('Show what’s playing and what’s next'))
        .addSubcommand((s) => s.setName('panel').setDescription('Post what’s playing here, with buttons, kept up to date as the music changes'))
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
    // Uploads left from before a restart that nothing in a queue will play
    tidyFiles();
    autoplayToEnd();
    if (!config.musicUrl || !config.musicToken) return;
    exiting = false;
    panelClient = client;
    restoreCards(client);
    // The music may have moved on while the bot was away
    for (const { guild_id } of db.prepare('SELECT DISTINCT guild_id FROM music_panels').all() as { guild_id: string }[]) cardChanged(guild_id);
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
    for (const upload of uploads.values()) clearTimeout(upload.timer);
    for (const timer of redraws.values()) clearTimeout(timer);
    redraws.clear();
    listening?.abort();
    for (const s of [...sessions.values()]) endSession(s);
  },
};

/** The bot's own voice channel, for the web page to default to */
export const musicChannelFor = (guildId: string) => sessions.get(guildId)?.channelId ?? botChannelId(guildId);

/** For tests: starts from nothing and follows a fake music container's status */
export function resetMusic(next: PlayerStatus | null = null) {
  askedAhead.clear();
  fetching.clear();
  toppingUp.clear();
  stillLooking.clear();
  for (const timer of redraws.values()) clearTimeout(timer);
  redraws.clear();
  cards.clear();
  stuckCards.clear();
  panelClient = null;
  for (const s of sessions.values()) s.turn++;
  sessions.clear();
  status = next;
  unreachable = null;
  exiting = false;
  coverless.clear();
  for (const upload of uploads.values()) clearTimeout(upload.timer);
  uploads.clear();
}

