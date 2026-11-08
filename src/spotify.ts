import { config } from './config.ts';
import { requestTimeout } from './util.ts';

const API = 'https://api.spotify.com/v1';
// Spotify caps search at 10 results for apps like this one
const SEARCH_LIMIT = 10;
/** The most songs one album or playlist link adds */
export const MOST_FROM_LINK = 100;

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

let token: { value: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  if (!searchReady()) throw new SpotifyError('Spotify search isn’t set up on this bot. It needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: requestTimeout(),
  });
  if (res.status === 400 || res.status === 401) throw new SpotifyError('Spotify turned down the search app’s Client ID or Secret.');
  if (!res.ok) throw new SpotifyError(`Spotify’s sign-in didn’t answer (HTTP ${res.status}). Try again in a moment.`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function get<T>(pathAndQuery: string, retried = false): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: requestTimeout() });
  if (res.status === 401 && !retried) {
    token = undefined;
    return get(pathAndQuery, true);
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

/** Everything a link points to, up to MOST_FROM_LINK songs, with a name for it */
export async function tracksFor(link: { kind: LinkKind; id: string }): Promise<{ name: string; tracks: Track[] }> {
  const market = `market=${config.spotifyMarket}`;
  if (link.kind === 'track') {
    const t = await get<ApiTrack>(`/tracks/${link.id}?${market}`);
    if (!playable(t)) throw new SpotifyError('That song can’t be played here.');
    return { name: t.name, tracks: [toTrack(t)] };
  }
  if (link.kind === 'album') {
    const album = await get<ApiAlbum & { tracks: Page<ApiTrack> }>(`/albums/${link.id}?${market}`);
    const items = await rest(album.tracks);
    return { name: album.name, tracks: items.filter(playable).map((t) => toTrack(t, album)) };
  }
  const list = await get<{ name: string }>(`/playlists/${link.id}?${market}&fields=name`);
  // Since 2026 Spotify only shows what's in a playlist to apps acting for a signed-in person, which this one isn't
  const first = await get<Page<{ track?: ApiTrack | null; item?: ApiTrack | null }>>(`/playlists/${link.id}/items?${market}&limit=100`).catch((err: unknown) => {
    if (err instanceof SpotifyError && /HTTP 40[13]/.test(err.message)) throw new SpotifyError(`Spotify doesn’t let the bot see what’s in **${list.name}**, as it only shows playlists to apps someone has signed in to. Add its songs or albums instead.`);
    throw err;
  });
  const entries = await rest(first);
  return { name: list.name, tracks: entries.map((e) => e.item ?? e.track).filter(playable).map((t) => toTrack(t)) };
}

/** Follows a list's later pages until there are enough */
async function rest<T>(page: Page<T>): Promise<T[]> {
  const items = [...page.items];
  let next = page.next;
  while (next && items.length < MOST_FROM_LINK) {
    const more = await get<Page<T>>(next.slice(API.length));
    items.push(...more.items);
    next = more.next;
  }
  return items.slice(0, MOST_FROM_LINK);
}

/** Forgets the access token, for tests */
export function resetSpotify() {
  token = undefined;
}
