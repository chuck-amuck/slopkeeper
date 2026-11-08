import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { getKv, setKv } from './db.ts';
import { requestTimeout } from './util.ts';

const API = 'https://api.spotify.com/v1';
// Spotify caps search at 10 results for apps like this one
const SEARCH_LIMIT = 10;
/** The most songs one album or playlist link adds */
export const MOST_FROM_LINK = 100;
// Shuffling picks from this far into a long playlist
const MOST_SHUFFLED_FROM = 1_000;
const PLAYLISTS_KEPT_MS = 5 * 60_000;

export interface Track {
  uri: string;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  durationMs: number;
}

/** A message for whoever searched, rather than a fault in the bot */
export class SpotifyError extends Error {}

export const searchReady = () => Boolean(config.spotifyClientId && config.spotifyClientSecret);
/** Whether the bot can read the account owner's own playlists */
export const playlistsReady = () => searchReady() && Boolean(config.spotifyRefreshToken);

/** The app's own access, which reads the catalogue, or the account owner's, which also reads their playlists */
type As = 'app' | 'owner';
const tokens = new Map<As, { value: string; expiresAt: number }>();

async function signIn(body: Record<string, string>) {
  return fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
    signal: requestTimeout(),
  });
}

/**
 * The owner's refresh token. Spotify can hand out a new one when it's used, which is kept in the database,
 * but only for as long as SPOTIFY_REFRESH_TOKEN is the one it came from, so signing in again takes over
 */
const fromEnv = () => createHash('sha256').update(config.spotifyRefreshToken ?? '').digest('hex');
function refreshToken(): string {
  const kept = getKv('spotifyRefreshToken');
  const saved = kept ? (JSON.parse(kept) as { from: string; token: string }) : undefined;
  return saved?.from === fromEnv() ? saved.token : config.spotifyRefreshToken!;
}

async function accessToken(as: As): Promise<string> {
  const held = tokens.get(as);
  if (held && held.expiresAt > Date.now() + 60_000) return held.value;
  if (!searchReady()) throw new SpotifyError('Spotify search isn’t set up on this bot. It needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  if (as === 'owner' && !playlistsReady()) throw new SpotifyError('Playlists aren’t set up on this bot. It needs SPOTIFY_REFRESH_TOKEN, from signing in to Spotify once.');
  const res = await signIn(as === 'app' ? { grant_type: 'client_credentials' } : { grant_type: 'refresh_token', refresh_token: refreshToken() });
  if (as === 'owner' && (res.status === 400 || res.status === 401)) throw new SpotifyError('Spotify turned down the saved sign-in, so playlists can’t be read. Sign in to Spotify again and update SPOTIFY_REFRESH_TOKEN.');
  if (res.status === 400 || res.status === 401) throw new SpotifyError('Spotify turned down the search app’s Client ID or Secret.');
  if (!res.ok) throw new SpotifyError(`Spotify’s sign-in didn’t answer (HTTP ${res.status}). Try again in a moment.`);
  const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  if (as === 'owner' && body.refresh_token) setKv('spotifyRefreshToken', JSON.stringify({ from: fromEnv(), token: body.refresh_token }));
  tokens.set(as, { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

async function get<T>(pathAndQuery: string, as: As = 'app', retried = false): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { authorization: `Bearer ${await accessToken(as)}` }, signal: requestTimeout() });
  if (res.status === 401 && !retried) {
    tokens.delete(as);
    return get(pathAndQuery, as, true);
  }
  if (res.status === 429) throw new SpotifyError(`Spotify is limiting searches right now. Try again in ${Number(res.headers.get('retry-after')) || 30} seconds.`);
  if (res.status === 404) throw new SpotifyError('Spotify couldn’t find that. Spotify’s own playlists, like Daily Mixes, can’t be read by apps.');
  if (!res.ok) throw new SpotifyError(`Spotify didn’t answer (HTTP ${res.status}). Try again in a moment.`);
  return (await res.json()) as T;
}

interface ApiImage {
  url: string;
  width: number | null;
}
interface ApiAlbum {
  name: string;
  images?: ApiImage[];
}
interface ApiTrack {
  uri: string;
  name: string;
  type?: string;
  is_local?: boolean;
  is_playable?: boolean;
  duration_ms: number;
  artists: { name: string }[];
  album?: ApiAlbum;
}
interface Page<T> {
  items: T[];
  next: string | null;
}

/** The smallest cover that still looks sharp in a list */
function cover(images: ApiImage[] | undefined): string | null {
  if (!images?.length) return null;
  const sized = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sized.find((i) => (i.width ?? 0) >= 120) ?? sized.at(-1)!).url;
}

function toTrack(t: ApiTrack, album?: ApiAlbum): Track {
  const from = t.album ?? album;
  return { uri: t.uri, title: t.name, artist: t.artists.map((a) => a.name).join(', '), album: from?.name ?? '', cover: cover(from?.images), durationMs: t.duration_ms };
}

/** Songs only: local files and podcast episodes in a playlist can't be played from here */
const playable = (t: ApiTrack | null | undefined): t is ApiTrack => !!t && t.uri?.startsWith('spotify:track:') && !t.is_local && t.is_playable !== false;

export async function search(query: string): Promise<Track[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const body = await get<{ tracks: Page<ApiTrack> }>(`/search?type=track&limit=${SEARCH_LIMIT}&market=${config.spotifyMarket}&q=${encodeURIComponent(q)}`);
  return body.tracks.items.filter(playable).map((t) => toTrack(t));
}

export type LinkKind = 'track' | 'album' | 'playlist';

/** A Spotify song, album or playlist link or URI, or null if it isn't one */
export function parseLink(input: string): { kind: LinkKind; id: string } | null {
  const text = input.trim();
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(text);
  if (uri) return { kind: uri[1] as LinkKind, id: uri[2] };
  const link = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})(?:[/?#].*)?$/i.exec(text);
  return link ? { kind: link[1].toLowerCase() as LinkKind, id: link[2] } : null;
}

/** Short links that only Spotify's app hands out, and which need following to know what they are */
export const isShortLink = (input: string) => /^https?:\/\/spotify\.link\//i.test(input.trim());

/** Everything a link points to, up to MOST_FROM_LINK songs, with a name for it. `shuffle` picks them at random from the whole album or playlist */
export async function tracksFor(link: { kind: LinkKind; id: string }, shuffle = false): Promise<{ name: string; tracks: Track[] }> {
  const market = `market=${config.spotifyMarket}`;
  if (link.kind === 'track') {
    const t = await get<ApiTrack>(`/tracks/${link.id}?${market}`);
    if (!playable(t)) throw new SpotifyError('That song can’t be played here.');
    return { name: t.name, tracks: [toTrack(t)] };
  }
  if (link.kind === 'album') {
    const album = await get<ApiAlbum & { tracks: Page<ApiTrack> }>(`/albums/${link.id}?${market}`);
    const items = await rest(album.tracks, 'app', shuffle);
    return { name: album.name, tracks: pick(items.filter(playable).map((t) => toTrack(t, album)), shuffle) };
  }
  // Spotify only shows what's in a playlist to an app acting for someone who's signed in, and then only their own
  const as: As = playlistsReady() ? 'owner' : 'app';
  const list = await get<{ name: string }>(`/playlists/${link.id}?${market}&fields=name`, as);
  const first = await get<Page<{ track?: ApiTrack | null; item?: ApiTrack | null }>>(`/playlists/${link.id}/items?${market}&limit=100`, as).catch((err: unknown) => {
    if (!(err instanceof SpotifyError && /HTTP 40[13]/.test(err.message))) throw err;
    throw new SpotifyError(
      as === 'owner'
        ? `Spotify only lets the bot see what’s in playlists made by the Spotify account it’s signed in as, and **${list.name}** isn’t one. Add its songs or albums instead.`
        : `Spotify doesn’t let the bot see what’s in **${list.name}**, as it only shows playlists to apps someone has signed in to. Add its songs or albums instead.`,
    );
  });
  const entries = await rest(first, as, shuffle);
  return { name: list.name, tracks: pick(entries.map((e) => e.item ?? e.track).filter(playable).map((t) => toTrack(t)), shuffle) };
}

/** The first MOST_FROM_LINK, or that many at random */
function pick<T>(items: T[], shuffle: boolean): T[] {
  if (!shuffle) return items.slice(0, MOST_FROM_LINK);
  const mixed = [...items];
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  return mixed.slice(0, MOST_FROM_LINK);
}

/** Follows a list's later pages until there are enough, or, to shuffle, until there's plenty to pick from */
async function rest<T>(page: Page<T>, as: As, shuffle = false): Promise<T[]> {
  const enough = shuffle ? MOST_SHUFFLED_FROM : MOST_FROM_LINK;
  const items = [...page.items];
  let next = page.next;
  while (next && items.length < enough) {
    const more = await get<Page<T>>(next.slice(API.length), as);
    items.push(...more.items);
    next = more.next;
  }
  return items.slice(0, enough);
}

export interface Playlist {
  id: string;
  name: string;
  cover: string | null;
  songs: number;
}

let owned: { at: number; lists: Playlist[] } | undefined;

/** The signed-in account's own playlists and the ones it collaborates on, which are the only ones Spotify lets the bot read */
export async function myPlaylists(): Promise<Playlist[]> {
  if (owned && Date.now() - owned.at < PLAYLISTS_KEPT_MS) return owned.lists;
  const me = await get<{ id: string }>('/me', 'owner');
  type ApiPlaylist = { id: string; name: string; collaborative?: boolean; owner?: { id: string }; images?: ApiImage[] | null; items?: { total: number }; tracks?: { total: number } };
  let page = await get<Page<ApiPlaylist | null>>('/me/playlists?limit=50', 'owner');
  const all = [...page.items];
  for (let pages = 1; page.next && pages < 20; pages++) {
    page = await get<Page<ApiPlaylist | null>>(page.next.slice(API.length), 'owner');
    all.push(...page.items);
  }
  const lists = all
    .filter((p): p is ApiPlaylist => !!p && (p.owner?.id === me.id || !!p.collaborative))
    .map((p) => ({ id: p.id, name: p.name, cover: cover(p.images ?? undefined), songs: p.items?.total ?? p.tracks?.total ?? 0 }));
  owned = { at: Date.now(), lists };
  return lists;
}

/** Forgets access tokens and playlists, for tests */
export function resetSpotify() {
  tokens.clear();
  owned = undefined;
}
