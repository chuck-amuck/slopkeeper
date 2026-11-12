import { type Guild } from 'discord.js';
import { type IncomingMessage } from 'node:http';
import path from 'node:path';
import { logActivity } from '../activity.ts';
import { addTracks, AUTOPLAY, clearQueue, fileProblem, fileUploadPath, MOST_FILE_BYTES, moveTrack, musicChannelFor, musicState, pauseMusic, playFile, queueFrom, queueOf, removeTrack, seekFile, seekMusic, shuffleQueue, skipMusic, startMusic, stopFile, stopMusic } from '../features/music.ts';
import { setting } from '../settings.ts';
import { myPlaylists, playlistsReady, search, SpotifyError, type Track } from '../spotify.ts';
import { type Ask, Refused, by, plain, readJson, refuse, saveBody, voiceChannelFor, whoDid } from './common.ts';

// The management API for the music queue and player

export function musicList(guild: Guild) {
  const state = musicState(guild.id);
  const channel = state.channelId ? guild.channels.cache.get(state.channelId) : undefined;
  return {
    ...state,
    channelName: channel?.name ?? null,
    defaultChannelId: musicChannelFor(guild.id),
    volume: setting(guild.id, 'musicVolume'),
    autoplay: setting(guild.id, 'musicAutoplay'),
    queue: queueOf(guild.id).map((r) => ({
      id: r.id,
      uri: r.uri,
      title: r.title,
      artist: r.artist,
      album: r.album,
      cover: r.cover,
      durationMs: r.duration_ms,
      addedBy: r.added_by === AUTOPLAY ? 'Autoplay' : whoDid(guild, r.added_by),
      autoplay: r.added_by === AUTOPLAY,
    })),
  };
}

/** Spotify's messages are for whoever searched; anything else is the bot's fault */
const spotifyRefused = (err: unknown): never => {
  if (err instanceof SpotifyError) throw new Refused(502, err.message.replaceAll('**', ''));
  throw err;
};

export async function handleMusic(guild: Guild, req: IncomingMessage, url: URL, rest: string[]) {
  const key = `${req.method} ${rest.join('/')}`;
  if (key === 'GET ') return musicList(guild);
  if (key === 'GET search') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const tracks: Track[] = await search(q).catch(spotifyRefused);
    return { tracks };
  }
  if (key === 'GET playlists') {
    if (!playlistsReady()) return { playlists: [], problem: 'Playlists need the bot signed in to Spotify once, with SPOTIFY_REFRESH_TOKEN. See the README’s music container section.' };
    return { playlists: await myPlaylists().catch(spotifyRefused), problem: null };
  }
  if (key === 'POST queue') {
    const { query, track, next, shuffle } = await readJson(req);
    if (track && typeof track === 'object') {
      // A search result picked on the page, sent back as it came
      const t = track as Record<string, unknown>;
      if (typeof t.uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) || typeof t.title !== 'string' || typeof t.durationMs !== 'number') throw new Refused(400, 'That isn’t a song.');
      const picked: Track = { uri: t.uri, title: t.title.slice(0, 300), artist: String(t.artist ?? '').slice(0, 300), album: String(t.album ?? '').slice(0, 300), cover: typeof t.cover === 'string' && t.cover.startsWith('https://i.scdn.co/') ? t.cover : null, durationMs: t.durationMs };
      if (!addTracks(guild.id, [picked], by(), next === true)) throw new Refused(409, 'The queue is full.');
      logActivity(guild.id, by(), `Added **${picked.title}** to the music queue${next === true ? ' to play next' : ''}`);
      return musicList(guild);
    }
    if (typeof query !== 'string' || !query.trim()) throw new Refused(400, 'Search for a song, or paste a Spotify link.');
    const message = await queueFrom(guild.id, query, by(), next === true, shuffle === true).catch(spotifyRefused);
    return { ...musicList(guild), message: plain(guild, message) };
  }
  if (key === 'DELETE queue') {
    clearQueue(guild.id, by());
    return musicList(guild);
  }
  if (key === 'POST queue/shuffle') {
    if (!shuffleQueue(guild.id, by())) throw new Refused(409, 'There’s nothing to shuffle. It takes two songs waiting.');
    return musicList(guild);
  }
  if (rest[0] === 'queue' && rest.length >= 2) {
    const id = Number(rest[1]);
    if (key === `DELETE queue/${rest[1]}`) {
      if (!(await removeTrack(guild.id, id, by()))) throw new Refused(404, 'That song isn’t in the queue any more.');
      return musicList(guild);
    }
    if (key === `POST queue/${rest[1]}/move`) {
      const { to } = await readJson(req);
      if (!Number.isInteger(to)) throw new Refused(400, 'Say where to move it.');
      if (!moveTrack(guild.id, id, to as number)) throw new Refused(409, 'That song can’t move: it’s playing, or gone.');
      return musicList(guild);
    }
  }
  if (key === 'POST file') {
    // Sent as the file itself, so what it is and where to play it come in the address
    const name = (url.searchParams.get('name') ?? '').trim().slice(0, 200);
    const ext = path.extname(name).toLowerCase();
    refuse(guild, fileProblem(ext, Number(req.headers['content-length'] ?? 0)));
    const channel = voiceChannelFor(guild, url.searchParams.get('channelId'));
    const file = fileUploadPath(ext);
    await saveBody(req, file, MOST_FILE_BYTES);
    refuse(guild, await playFile(guild, channel, file, path.basename(name, path.extname(name)) || 'a file', by()));
    return musicList(guild);
  }
  if (key === 'POST file/seek') {
    const { positionMs } = await readJson(req);
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) throw new Refused(400, 'positionMs must be a number.');
    const problem = await seekFile(guild.id, positionMs);
    if (problem === 'No file is playing.') throw new Refused(409, problem);
    refuse(guild, problem);
    return musicList(guild);
  }
  if (key === 'POST file/stop') {
    if (!stopFile(guild.id)) throw new Refused(409, 'No file is playing.');
    return musicList(guild);
  }
  if (key === 'POST play') {
    const { channelId } = await readJson(req);
    refuse(guild, await startMusic(guild, voiceChannelFor(guild, channelId)));
    return musicList(guild);
  }
  if (key === 'POST pause') {
    refuse(guild, pauseMusic(guild.id));
    return musicList(guild);
  }
  if (key === 'POST seek') {
    const { positionMs } = await readJson(req);
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) throw new Refused(400, 'positionMs must be a number.');
    refuse(guild, await seekMusic(guild.id, positionMs));
    return musicList(guild);
  }
  if (key === 'POST skip') {
    refuse(guild, await skipMusic(guild.id, by()));
    return musicList(guild);
  }
  if (key === 'POST stop') {
    stopMusic(guild.id, by());
    return musicList(guild);
  }
  throw new Refused(404, 'Not found.');
}

export async function musicRoutes({ client, guild, req, res, url, section, rest }: Ask) {
  if (section === 'music') return handleMusic(guild, req, url, rest);
  throw new Refused(404, 'Not found.');
}
