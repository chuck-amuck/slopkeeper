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

const NOT_FOUND = 'Spotify couldn’t find that.';

async function get<T>(pathAndQuery: string, as: As = 'app', retried = false): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { authorization: `Bearer ${await accessToken(as)}` }, signal: requestTimeout() });
  if (res.status === 401 && !retried) {
    tokens.delete(as);
    return get(pathAndQuery, as, true);
  }
  if (res.status === 429) throw new SpotifyError(`Spotify is limiting searches right now. Try again in ${Number(res.headers.get('retry-after')) || 30} seconds.`);
  if (res.status === 404) throw new SpotifyError(NOT_FOUND);
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

/**
 * Everything a link points to, up to MOST_FROM_LINK songs, with a name for it. `shuffle` picks them at random from the whole album or playlist.
 * `capped` means Spotify showed only the first MOST_FROM_LINK songs of a playlist, so shuffling can't reach further either
 */
export async function tracksFor(link: { kind: LinkKind; id: string }, shuffle = false): Promise<{ name: string; tracks: Track[]; capped?: boolean }> {
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
  // Spotify's Web API only shows what's in a playlist to an app signed in as the playlist's owner. Other playlists are read from Spotify's
  // public embed player, which shows any public playlist's first 100 songs
  if (!playlistsReady()) return fromEmbed(link.id, shuffle);
  // Spotify's own playlists aren't found, and other people's are refused
  const refused = (err: unknown) => {
    if (err instanceof SpotifyError && (/HTTP 40[13]/.test(err.message) || err.message === NOT_FOUND)) return null;
    throw err;
  };
  const list = await get<{ name: string }>(`/playlists/${link.id}?${market}&fields=name`, 'owner').catch(refused);
  const first = list && (await get<Page<{ track?: ApiTrack | null; item?: ApiTrack | null }>>(`/playlists/${link.id}/items?${market}&limit=100`, 'owner').catch(refused));
  if (!list || !first) return fromEmbed(link.id, shuffle);
  const entries = await rest(first, 'owner', shuffle);
  return { name: list.name, tracks: pick(entries.map((e) => e.item ?? e.track).filter(playable).map((t) => toTrack(t)), shuffle) };
}

interface EmbedTrack {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  isPlayable?: boolean;
}

const NOT_SHOWN = 'Spotify won’t show what’s in that playlist. It may be private, or no longer exist.';

/** A public playlist's first songs, as Spotify's embed player lists them, with no album or cover as the player doesn't give them */
async function fromEmbed(id: string, shuffle: boolean): Promise<{ name: string; tracks: Track[]; capped: boolean }> {
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, signal: requestTimeout() });
  } catch (err) {
    console.error('Spotify: couldn’t open a playlist’s embed page:', (err as Error).message);
    throw new SpotifyError('Spotify didn’t answer. Try again in a moment.');
  }
  if (res.status === 404) throw new SpotifyError(NOT_SHOWN);
  if (res.status === 429) throw new SpotifyError('Spotify is limiting the bot right now. Try again in a minute.');
  if (!res.ok) throw new SpotifyError(`Spotify didn’t answer (HTTP ${res.status}). Try again in a moment.`);
  const json = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(await res.text())?.[1];
  let entity: { name?: string; trackList?: EmbedTrack[] } | undefined;
  try {
    entity = json ? JSON.parse(json)?.props?.pageProps?.state?.data?.entity : undefined;
  } catch {
    entity = undefined;
  }
  if (!entity || !Array.isArray(entity.trackList)) {
    // A missing or private playlist has a page with no entity, so this is also how a change to Spotify's page would show
    if (!json || !/"status":\s*404/.test(json)) console.error(`Spotify: playlist ${id}'s embed page didn’t have the expected song list`);
    throw new SpotifyError(NOT_SHOWN);
  }
  const songs = entity.trackList
    .filter((t) => typeof t?.uri === 'string' && t.uri.startsWith('spotify:track:') && t.isPlayable !== false)
    .map((t): Track => ({ uri: t.uri!, title: String(t.title ?? 'Untitled').slice(0, 300), artist: String(t.subtitle ?? '').slice(0, 300), album: '', cover: null, durationMs: Number(t.duration) || 0 }));
  return { name: String(entity.name ?? 'Spotify playlist').slice(0, 300), tracks: pick(songs, shuffle), capped: entity.trackList.length >= MOST_FROM_LINK };
}

/**
 * A song's album cover, from Spotify's public oEmbed, which needs no sign-in. The image is served from i.scdn.co too, which is where the
 * web page takes images from, so only its id is kept. Null when Spotify has none; throws when Spotify is limiting or down
 */
export async function coverFor(uri: string): Promise<string | null> {
  const id = /^spotify:track:([A-Za-z0-9]{22})$/.exec(uri)?.[1];
  if (!id) return null;
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`, { signal: requestTimeout() });
  if (res.status === 429) throw new RateLimited(Number(res.headers.get('retry-after')) || 60);
  if (res.status >= 500) throw new SpotifyError('Spotify’s covers are down right now.');
  if (!res.ok) return null;
  const thumbnail = ((await res.json().catch(() => ({}))) as { thumbnail_url?: unknown }).thumbnail_url;
  const image = typeof thumbnail === 'string' ? /^https:\/\/[a-z0-9.-]+\.(?:spotifycdn\.com|scdn\.co)\/image\/([0-9a-f]{16,64})$/.exec(thumbnail)?.[1] : undefined;
  return image ? `https://i.scdn.co/image/${image}` : null;
}

/** Spotify asking the bot to wait, with how many seconds */
export class RateLimited extends SpotifyError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Spotify is limiting the bot right now. Try again in ${retryAfterSeconds} seconds.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
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
