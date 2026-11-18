/**
 * Looking for music by name, on whichever service a server picked: Spotify, or YouTube Music through the music
 * container. With the fallback on, the other is asked when the first fails or finds nothing. A service that isn't set up
 * is passed over, so a bot without a Spotify app searches YouTube Music whatever's picked
 */
import { config } from './config.ts';
import { setting } from './settings.ts';
import { RateLimited, search as searchSpotify, searchReady as spotifyReady, SpotifyError, spotifyWaiting, type Track } from './spotify.ts';

export type Source = 'spotify' | 'youtube-music';
export const SOURCES: Record<Source, string> = { spotify: 'Spotify', 'youtube-music': 'YouTube Music' };

/** Where a song's picture can come from: Spotify, YouTube, SoundCloud and YouTube Music. The web UI allows the same */
export const COVER_HOSTS = /^https:\/\/(i\.scdn\.co|i\.ytimg\.com|i1\.sndcdn\.com|(lh3|yt3)\.googleusercontent\.com)\//;
/** A song found on YouTube Music, queued by its link, which the music container plays as it is */
export const YTM_SONG = /^https:\/\/music\.youtube\.com\/watch\?v=[\w-]{11}$/;

// The music container gives up after 15 seconds itself
const YTM_TIMEOUT_MS = 20_000;
const HOUR = 3_600_000;
// Songs a search found lately, so picking one of /music play's suggestions doesn't look it up again
const KNOWN_MS = 30 * 60_000;
const MOST_KNOWN = 500;

const NOT_SET_UP = 'Searching for music isn’t set up on this bot. It needs a Spotify app’s Client ID and Secret, or the music container.';

const ready = (source: Source) => (source === 'spotify' ? spotifyReady() : Boolean(config.musicUrl && config.musicToken));

/** Whether this bot can search for music at all */
export const searchReady = () => ready('spotify') || ready('youtube-music');

/** The services to ask, in turn */
function order(guildId: string, quick: boolean): Source[] {
  const main: Source = setting(guildId, 'musicSearch') === 'youtube-music' ? 'youtube-music' : 'spotify';
  const other: Source = main === 'spotify' ? 'youtube-music' : 'spotify';
  if (!ready(main)) return ready(other) ? [other] : [];
  const sources = setting(guildId, 'musicSearchFallback') && ready(other) ? [main, other] : [main];
  // Suggestions have 3 seconds, so they ask one: the other only while Spotify is waiting
  if (quick) return sources[0] === 'spotify' && spotifyWaiting() && sources[1] ? [sources[1]] : [sources[0]];
  return sources;
}

/** The service a server's searches go to first, or null when there's none */
export function searchSource(guildId: string): string | null {
  const [first] = order(guildId, false);
  return first ? SOURCES[first] : null;
}

/** "Spotify", or "Spotify or YouTube Music", for saying where nothing was found */
export const sourceNames = (sources: Source[]) => sources.map((s) => SOURCES[s]).join(' or ') || 'Spotify';

/** YouTube Music didn't answer, with why, for the log */
class YtmFailed extends SpotifyError {
  readonly detail: string;
  constructor(detail: string) {
    super('YouTube Music didn’t answer the search. Try again in a moment.');
    this.detail = detail;
  }
}

/** Asks the music container to search YouTube Music, or read an album or artist */
async function askYtm<T>(body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.musicUrl}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.musicToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(YTM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new YtmFailed((err as Error).message);
  }
  const answer = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) throw new YtmFailed(String(answer.error ?? `HTTP ${res.status}`));
  return answer as T;
}

interface YtmSong {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  seconds: number | null;
  cover: string | null;
}

/** A song from the music container, as the queue keeps it, or null if it isn't one */
function ytmTrack(song: YtmSong): Track | null {
  // Only a song with a length: the queue's times, seeking and carrying on after a restart all go by it
  if (typeof song?.id !== 'string' || !/^[\w-]{11}$/.test(song.id) || typeof song.title !== 'string' || !Number.isFinite(song.seconds) || song.seconds! <= 0) return null;
  return {
    uri: `https://music.youtube.com/watch?v=${song.id}`,
    title: song.title.slice(0, 300),
    artist: (Array.isArray(song.artists) ? song.artists.filter((a) => typeof a === 'string') : []).join(', ').slice(0, 300),
    album: typeof song.album === 'string' ? song.album.slice(0, 300) : '',
    cover: typeof song.cover === 'string' && COVER_HOSTS.test(song.cover) ? song.cover : null,
    durationMs: song.seconds! * 1000,
  };
}

const said = new Map<string, number>();
/** Says in the log why a service didn't answer, once an hour for each reason */
function noteFailure(source: Source, err: unknown, next: Source | undefined) {
  const why = err instanceof RateLimited ? `is making the bot wait ${err.retryAfterSeconds} s` : err instanceof YtmFailed ? `failed: ${err.detail}` : `failed: ${(err as Error).message}`;
  const key = `${source} ${why.replace(/\d+/g, 'N')}`;
  if (Date.now() - (said.get(key) ?? 0) < HOUR) return;
  said.set(key, Date.now());
  console.warn(`Music search: ${SOURCES[source]} ${why}${next ? `, so ${SOURCES[next]} was asked` : ''}`);
}

/**
 * What a search found, which service found it, and the services that answered, for saying where nothing was found. When
 * one failed and the other found nothing, `failed` says why the first failed, as it might have found it
 */
export interface Searched<T> {
  found: T[];
  from: Source | null;
  answered: Source[];
  failed?: string;
}

/**
 * Asks each service in turn until one finds something. Nothing found anywhere is an empty list; every service failing
 * throws the first one's reason, as a SpotifyError for whoever asked
 */
async function firstFound<T>(guildId: string, ask: Record<Source, () => Promise<T[]>>, quick = false): Promise<Searched<T>> {
  const sources = order(guildId, quick);
  if (!sources.length) throw new SpotifyError(NOT_SET_UP);
  const answered: Source[] = [];
  let failure: SpotifyError | undefined;
  for (const [n, source] of sources.entries()) {
    try {
      const found = await ask[source]();
      answered.push(source);
      if (found.length) return { found, from: source, answered };
    } catch (err) {
      noteFailure(source, err, sources[n + 1]);
      failure ??= err instanceof SpotifyError ? err : new SpotifyError(`${SOURCES[source]} didn’t answer the search. Try again in a moment.`);
    }
  }
  if (!answered.length) throw failure!;
  return { found: [], from: null, answered, ...(failure && { failed: failure.message }) };
}

const known = new Map<string, { at: number; track: Track }>();

/** A song a search found in the last half hour, by its URI or link, so it's added as found without looking it up again */
export function knownTrack(uri: string): Track | undefined {
  const kept = known.get(uri.trim());
  return kept && Date.now() - kept.at < KNOWN_MS ? kept.track : undefined;
}

function remember(tracks: Track[]) {
  for (const track of tracks) {
    known.delete(track.uri);
    known.set(track.uri, { at: Date.now(), track });
  }
  for (const uri of known.keys()) {
    if (known.size <= MOST_KNOWN) break;
    known.delete(uri);
  }
}

/** Songs matching some words, best first. `quick` asks only one service, for suggestions as someone types */
export async function searchSongs(guildId: string, query: string, quick = false): Promise<Searched<Track>> {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!q) return { found: [], from: null, answered: [] };
  const searched = await firstFound<Track>(
    guildId,
    {
      spotify: () => searchSpotify(q),
      'youtube-music': async () => {
        const { results } = await askYtm<{ results?: YtmSong[] }>({ search: q, kind: 'song', limit: 10 });
        return (Array.isArray(results) ? results : []).map(ytmTrack).filter((t): t is Track => !!t);
      },
    },
    quick,
  );
  remember(searched.found);
  return searched;
}

/** Forgets what was searched for, for tests */
export function resetMusicSearch() {
  known.clear();
  said.clear();
}
