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
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { idSetting } from '../settings.ts';
import { isShortLink, MOST_FROM_LINK, myPlaylists, parseLink, playlistsReady, search, searchReady, SpotifyError, tracksFor, type Track } from '../spotify.ts';
import type { Feature } from '../types.ts';
import { botChannelId, onPlaybackStop, playStream } from './soundboard.ts';

// The next song is handed to Spotify this long before the current one ends, so it follows without a gap
const HAND_OVER_MS = 15_000;
// Spotify moving on this close to a song's end is the song finishing, not someone choosing something else
const END_SLACK_MS = 6_000;
// A different song this soon after the bot asked for one is Spotify not playing it, rather than someone's choice
const CANT_PLAY_MS = 5_000;
export const MOST_QUEUED = 500;
const SHOWN_IN_DISCORD = 10;
// A second of audio in hand. The mixer skips ahead past anything more, rather than fall behind
const AUDIO_BUFFER = 48_000 * 4;

export interface QueueRow {
  id: number;
  guild_id: string;
  pos: number;
  uri: string;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  duration_ms: number;
  added_by: string;
  added_at: number;
}

/** What the music container reports about itself and Spotify */
export interface PlayerStatus {
  state: 'starting' | 'downloading' | 'running' | 'failed' | 'no-key' | 'no-consent';
  message: string;
  loggedIn: boolean;
  account: string | null;
  active: boolean;
  version: string | null;
  expiresAt: number | null;
}

interface Position {
  ms: number;
  at: number;
  speed: number;
}

/** Music playing, or paused, in one server. Spotify plays one thing at a time, so there's at most one */
interface Session {
  guildId: string;
  channelId: string;
  phase: 'starting' | 'playing' | 'paused';
  /** The queue row being played */
  current: QueueRow;
  /** The song Spotify has loaded, which is the current one unless someone changed it from Spotify */
  loaded: string | null;
  /** The song handed to Spotify to follow the current one */
  handedNext: string | null;
  /** When the bot last asked Spotify for a song */
  requestedAt: number;
  position: Position;
  /** A pause the bot asked for, so it isn't mistaken for one from Spotify */
  pausing: boolean;
  stopStream?: () => void;
  handOverTimer?: NodeJS.Timeout;
  /** Why it stopped by itself, for the web page */
  note: string | null;
}

let session: Session | undefined;
let status: PlayerStatus | null = null;
/** Why the music container can't be reached, while it can't */
let unreachable: string | null = null;
let listening: AbortController | undefined;

// ---------- the queue ----------

export function queueOf(guildId: string): QueueRow[] {
  return db.prepare('SELECT * FROM music_queue WHERE guild_id = ? ORDER BY pos, id').all(guildId) as unknown as QueueRow[];
}

/** Whether the first row is the song playing (or paused), which stays put while the rest move around it */
const holdsFirst = (guildId: string) => session?.guildId === guildId;

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
  scheduleHandOver();
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
  scheduleHandOver();
  return true;
}

/** Takes a song out of the queue. Taking out the one playing skips it */
export async function removeTrack(guildId: string, id: number, who: string): Promise<QueueRow | null> {
  const row = queueOf(guildId).find((r) => r.id === id);
  if (!row) return null;
  if (session?.guildId === guildId && session.current.id === id) await moveOn(session);
  else db.prepare('DELETE FROM music_queue WHERE id = ?').run(id);
  logActivity(guildId, who, `Removed **${row.title}** from the music queue`);
  scheduleHandOver();
  return row;
}

/** Empties the queue, apart from the song playing */
export function clearQueue(guildId: string, who: string) {
  const keep = session?.guildId === guildId ? session.current.id : -1;
  db.prepare('DELETE FROM music_queue WHERE guild_id = ? AND id != ?').run(guildId, keep);
  logActivity(guildId, who, 'Cleared the music queue');
  scheduleHandOver();
}

// ---------- the music container ----------

async function command(body: Record<string, unknown>) {
  const res = await fetch(`${config.musicUrl}/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.musicToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`music container refused ${String(body.command)}: HTTP ${res.status}`);
}

/** Commands that are tidying up, where failing changes nothing for anyone */
const quietly = (body: Record<string, unknown>) => command(body).catch((err: unknown) => console.error('Music:', (err as Error).message));

async function openAudio(): Promise<Readable> {
  const res = await fetch(`${config.musicUrl}/audio`, { headers: { authorization: `Bearer ${config.musicToken}` } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  return Readable.fromWeb(res.body as ReadableStream<Uint8Array>, { highWaterMark: AUDIO_BUFFER });
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
      if (session?.phase === 'playing') pauseHere(session, 'The music player stopped answering, so the music paused.');
      await sleep(5_000, undefined, { signal }).catch(() => {});
    }
  }
}

function onStatus(next: PlayerStatus) {
  status = next;
  if (session?.phase === 'playing' && !(next.state === 'running' && next.loggedIn)) pauseHere(session, 'Spotify signed out, so the music paused.');
}

// ---------- playing ----------

/** Why music can't play right now, or null if it can */
export function unavailable(): string | null {
  if (!config.musicUrl || !config.musicToken) return 'Music isn’t set up on this bot. It needs MUSIC_URL and MUSIC_TOKEN.';
  if (unreachable || !status) return 'The music player isn’t answering. Check that the music container is running.';
  if (status.state === 'no-key') return 'The music player needs a Spotify Soloist key (SOLOIST_API_KEY).';
  if (status.state === 'no-consent') return 'The music player won’t download Spotify Soloist until SOLOIST_ACCEPT_TERMS is true.';
  if (status.state === 'failed') return `The music player failed: ${status.message}`;
  if (status.state !== 'running') return 'The music player is still starting. Try again in a moment.';
  if (!status.loggedIn) return 'The music player isn’t paired with a Spotify account yet. See the README’s music section.';
  return null;
}

/** Where Spotify has got to in the song playing, in milliseconds */
const positionOf = (s: Session) => s.position.ms + Math.max(0, Date.now() - s.position.at) * s.position.speed;
const nearEnd = (s: Session) => positionOf(s) >= s.current.duration_ms - END_SLACK_MS;

/** Starts the queue in a channel, or carries on where it paused. Returns null on success or the reason it couldn't, for the user */
export async function startMusic(guild: Guild, channel: VoiceBasedChannel): Promise<string | null> {
  const problem = unavailable();
  if (problem) return problem;
  if (session && session.guildId !== guild.id && session.phase !== 'paused') return 'Music is already playing in another server, and Spotify only plays one thing at a time.';
  const first = queueOf(guild.id)[0];
  if (!first) return 'The queue is empty. Add a song first.';
  if (session?.guildId === guild.id && session.phase !== 'paused' && session.channelId === channel.id) return null;
  if (session && session.guildId !== guild.id) endSession(session);

  const carryOn = session?.guildId === guild.id && session.current.id === first.id && session.loaded === first.uri;
  const s: Session =
    session?.guildId === guild.id
      ? Object.assign(session, { channelId: channel.id, phase: 'starting' as const, note: null })
      : { guildId: guild.id, channelId: channel.id, phase: 'starting', current: first, loaded: null, handedNext: null, requestedAt: 0, position: { ms: 0, at: Date.now(), speed: 0 }, pausing: false, note: null };
  session = s;
  s.current = first;
  s.stopStream?.();
  s.stopStream = undefined;

  let pcm: Readable;
  try {
    pcm = await openAudio();
  } catch (err) {
    console.error('Music: couldn’t open the audio:', (err as Error).message);
    s.phase = 'paused';
    return 'The music player isn’t answering. Check that the music container is running.';
  }
  const stop = await playStream(channel, pcm, () => onStreamEnd(s));
  if (typeof stop === 'string') {
    s.phase = 'paused';
    return stop;
  }
  s.stopStream = stop;
  try {
    // Spotify only plays here once this device is the account's active one
    await command({ command: 'activate' });
    if (carryOn) await command({ command: 'play' });
    else await playUri(s, first.uri);
  } catch (err) {
    console.error('Music:', (err as Error).message);
    stopStreamOf(s);
    s.phase = 'paused';
    return 'The music player didn’t start. Try again in a moment.';
  }
  s.phase = 'playing';
  scheduleHandOver();
  return null;
}

async function playUri(s: Session, uri: string) {
  s.loaded = uri;
  s.handedNext = null;
  s.requestedAt = Date.now();
  s.position = { ms: 0, at: Date.now(), speed: 0 };
  await command({ command: 'play', uri });
}

function stopStreamOf(s: Session) {
  const stop = s.stopStream;
  s.stopStream = undefined;
  stop?.();
}

/** The music's audio stopped: Stop was pressed, everyone left, or the bot left voice */
function onStreamEnd(s: Session) {
  if (session !== s || !s.stopStream) return;
  s.stopStream = undefined;
  if (s.phase !== 'paused') pauseHere(s, null);
}

/** Pauses, keeping the queue. `note` says why, when it wasn't someone asking */
function pauseHere(s: Session, note: string | null, tellSpotify = true) {
  s.phase = 'paused';
  s.note = note;
  s.position = { ms: positionOf(s), at: Date.now(), speed: 0 };
  clearTimeout(s.handOverTimer);
  stopStreamOf(s);
  if (tellSpotify && status?.loggedIn) {
    s.pausing = true;
    void quietly({ command: 'pause' });
  }
}

export function pauseMusic(guildId: string): string | null {
  if (session?.guildId !== guildId || session.phase === 'paused') return 'Nothing is playing.';
  pauseHere(session, null);
  return null;
}

/** Ends the current song early. Returns null on success, or why it couldn't */
export async function skipMusic(guildId: string, who: string): Promise<string | null> {
  if (session?.guildId !== guildId) return 'Nothing is playing.';
  logActivity(guildId, who, `Skipped **${session.current.title}**`);
  await moveOn(session);
  return null;
}

/** Stops the music and empties the queue */
export function stopMusic(guildId: string, who: string) {
  if (session?.guildId === guildId) endSession(session);
  db.prepare('DELETE FROM music_queue WHERE guild_id = ?').run(guildId);
  logActivity(guildId, who, 'Stopped the music and cleared the queue');
}

/** Goes on to the next song in the queue, or stops once there isn't one */
async function moveOn(s: Session) {
  db.prepare('DELETE FROM music_queue WHERE id = ?').run(s.current.id);
  const next = queueOf(s.guildId)[0];
  if (!next) return endSession(s);
  s.current = next;
  s.note = null;
  if (s.phase === 'paused') {
    // It starts from the top of the new song once someone presses play
    s.loaded = null;
    s.handedNext = null;
    return;
  }
  try {
    await playUri(s, next.uri);
  } catch (err) {
    console.error('Music:', (err as Error).message);
    pauseHere(s, 'The music player didn’t start the next song, so the music paused.', false);
  }
  scheduleHandOver();
}

function endSession(s: Session) {
  clearTimeout(s.handOverTimer);
  stopStreamOf(s);
  if (s.phase !== 'paused') {
    s.pausing = true;
    void quietly({ command: 'pause' });
  }
  if (session === s) session = undefined;
}

/** Hands Spotify the next song shortly before the current one ends. Later than that, the queue can still change */
function scheduleHandOver() {
  const s = session;
  if (!s) return;
  clearTimeout(s.handOverTimer);
  if (s.phase !== 'playing' || s.handedNext || s.position.speed === 0) return;
  const wait = s.current.duration_ms - positionOf(s) - HAND_OVER_MS;
  const song = s.current.id;
  s.handOverTimer = setTimeout(
    () => {
      // Timed for one song, so it's no good once another is playing
      if (session !== s || s.phase !== 'playing' || s.handedNext || s.current.id !== song) return;
      const following = queueOf(s.guildId)[1];
      if (!following) return;
      s.handedNext = following.uri;
      void quietly({ command: 'add_to_queue', uri: following.uri });
    },
    Math.max(0, wait),
  );
}

interface SpotifyMessage {
  type: string;
  status?: string;
  is_active?: boolean;
  logged_in?: boolean;
  item?: { uri?: string; decorations?: { identity?: { name?: string } } } | null;
  position?: { position_ms: number; timestamp_ms: number; speed: number };
}

/** Follows what Spotify does, which is how a song ending is known */
export async function onSpotify(msg: SpotifyMessage) {
  const s = session;
  if (!s) return;
  if (msg.position && (msg.type === 'position_sync' || msg.type === 'playback_state')) {
    // Read before a change of song arrives, as that resets it
    s.position = { ms: msg.position.position_ms, at: msg.position.timestamp_ms, speed: msg.position.speed };
    scheduleHandOver();
    return;
  }
  if (msg.type === 'track_changed') {
    const uri = msg.item?.uri;
    if (!uri || uri === s.loaded) return;
    if (uri === s.handedNext || nearEnd(s)) {
      // The song finished. Spotify went on to the one it was handed, or to suggestions of its own once there was none
      db.prepare('DELETE FROM music_queue WHERE id = ?').run(s.current.id);
      clearTimeout(s.handOverTimer);
      s.handedNext = null;
      const next = queueOf(s.guildId)[0];
      if (!next) return endSession(s);
      s.current = next;
      s.position = { ms: 0, at: Date.now(), speed: 0 };
      if (next.uri === uri) s.loaded = uri;
      else if (s.phase === 'playing') await playUri(s, next.uri).catch((err: unknown) => console.error('Music:', (err as Error).message));
      else s.loaded = null;
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
      if (session === s) s.note = `Spotify wouldn’t play ${title}, so it was skipped.`;
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
  if (msg.type === 'playback_changed' && msg.status === 'playing' && s.phase === 'paused' && !s.stopStream) {
    // Played from the Spotify app while the bot isn't in voice, where nobody would hear it
    s.pausing = true;
    void quietly({ command: 'pause' });
    return;
  }
  if (msg.type === 'device_changed' && msg.is_active === false && s.phase === 'playing') {
    pauseHere(s, 'Spotify moved to another speaker, so the music paused.', false);
  }
}

// ---------- adding by search or link ----------

/** Songs for whatever was typed: a link to a song, album or playlist, or words to search for. The name says what was found */
export async function resolve(input: string, shuffle = false): Promise<{ name: string; tracks: Track[] }> {
  if (isShortLink(input)) throw new SpotifyError('Short spotify.link links can’t be read. Open it and copy the open.spotify.com link instead.');
  const link = parseLink(input);
  if (link) return tracksFor(link, shuffle);
  if (/^https?:\/\//i.test(input.trim())) throw new SpotifyError('That isn’t a Spotify song, album or playlist link.');
  const [top] = await search(input);
  if (!top) throw new SpotifyError(`Nothing on Spotify matches “${input.trim()}”.`);
  return { name: `${top.title} by ${top.artist}`, tracks: [top] };
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
  const s = session?.guildId === guildId ? session : undefined;
  return {
    problem: unavailable(),
    searchReady: searchReady(),
    account: status?.account ?? null,
    phase: s?.phase ?? 'stopped',
    // Playing a sound elsewhere from the soundboard takes the bot, and the music, with it
    channelId: s ? ((s.stopStream && botChannelId(guildId)) || s.channelId) : null,
    positionMs: s ? Math.round(positionOf(s)) : 0,
    note: s?.note ?? null,
    elsewhere: !!session && session.guildId !== guildId && session.phase !== 'paused',
  };
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
    const playing = session?.guildId === i.guildId && session.phase !== 'paused';
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
    const title = session?.guildId === i.guildId ? session.current.title : null;
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
        .setDescription('Spotify in voice, with a queue everyone shares')
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
    if (!config.musicUrl || !config.musicToken) return;
    // Stop, and everyone leaving, pause the music rather than lose the queue
    onPlaybackStop((guildId) => {
      if (session?.guildId === guildId && session.phase !== 'paused') pauseHere(session, null);
    });
    listening = new AbortController();
    void listen(listening.signal);
  },
  shutdown() {
    listening?.abort();
    if (session) endSession(session);
  },
};

/** The bot's own voice channel, for the web page to default to */
export const musicChannelFor = (guildId: string) => (session?.guildId === guildId ? session.channelId : botChannelId(guildId));

/** For tests: starts from nothing and follows a fake music container's status */
export function resetMusic(next: PlayerStatus | null = null) {
  if (session) clearTimeout(session.handOverTimer);
  session = undefined;
  status = next;
  unreachable = null;
}

