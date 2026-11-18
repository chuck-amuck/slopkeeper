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

// Spotify asks the bot to wait sometimes, for seconds or for hours, and not always for everything at once. Until then
// that part of the API (search, albums, artists, ...) isn't asked, so the wait doesn't grow and a fallback answers at once
const waits = new Map<string, number>();
const partOf = (pathAndQuery: string) => pathAndQuery.split(/[/?]/)[1] ?? '';

/** Seconds until Spotify's search, or another part of its API, can be asked again, or 0 */
export const spotifyWaiting = (part = 'search') => Math.max(0, Math.ceil(((waits.get(part) ?? 0) - Date.now()) / 1000));

async function get<T>(pathAndQuery: string, as: As = 'app', retried = false): Promise<T> {
  const part = partOf(pathAndQuery);
  const wait = spotifyWaiting(part);
  if (wait) throw new RateLimited(wait);
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { authorization: `Bearer ${await accessToken(as)}` }, signal: requestTimeout() });
  if (res.status === 401 && !retried) {
    tokens.delete(as);
    return get(pathAndQuery, as, true);
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after')) || 30;
    waits.set(part, Math.max(waits.get(part) ?? 0, Date.now() + seconds * 1000));
    throw new RateLimited(seconds);
  }
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
  artists: { id?: string; name: string }[];
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

/** What a search for music by name found: a song or album to add by its URI, or an artist by name */
export interface Found {
  kind: 'song' | 'album' | 'artist';
  name: string;
  artist: string | null;
  /** What to add it by: the song's or album's URI, or "artist:", the artist's id and their name */
  ref: string;
  /** An album's year, and whether it's a single or EP rather than an album, so "their latest album" can be told */
  year?: string;
  single?: boolean;
}

interface ApiNamed {
  id: string;
  uri: string;
  name: string;
  artists?: { name: string }[];
  album_type?: string;
  release_date?: string;
}

const albumFound = (x: ApiNamed): Found => ({
  kind: 'album',
  name: x.name,
  artist: x.artists?.map((a) => a.name).join(', ') ?? null,
  ref: x.uri,
  year: x.release_date?.slice(0, 4),
  single: x.album_type === 'single',
});

/** The songs, albums or artists a name matches, best first, for whoever's asking to pick one */
export async function searchFor(query: string, kind: Found['kind'], most = 5): Promise<Found[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  if (kind === 'song') return (await search(q)).slice(0, most).map((t) => ({ kind, name: t.title, artist: t.artist, ref: t.uri }));
  const type = kind === 'album' ? 'album' : 'artist';
  const body = await get<Record<string, Page<ApiNamed | null>>>(`/search?type=${type}&limit=${Math.min(most, SEARCH_LIMIT)}&market=${config.spotifyMarket}&q=${encodeURIComponent(q)}`);
  return (body[`${type}s`]?.items ?? [])
    .filter((x): x is ApiNamed => !!x?.name)
    .map((x) =>
      // The artist's id too, so a namesake's songs aren't taken for theirs
      kind === 'album' ? albumFound(x) : { kind, name: x.name, artist: null, ref: `artist:${x.id}:${x.name}` },
    );
}

/** An artist's albums, newest first, singles and EPs left out, for "their latest album" */
export async function artistAlbums(artistId: string, most = SEARCH_LIMIT): Promise<Found[]> {
  const body = await get<Page<ApiNamed | null>>(`/artists/${encodeURIComponent(artistId)}/albums?include_groups=album&limit=${SEARCH_LIMIT}&market=${config.spotifyMarket}`);
  return body.items
    .filter((x): x is ApiNamed => !!x?.name)
    .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
    .slice(0, most)
    .map(albumFound);
}

/**
 * An artist's best-known songs, up to SEARCH_LIMIT: Spotify doesn't let apps like this one read an artist's top songs,
 * but searching lists them most-played first. A search by their name finds the most, and one by artist (which stops at
 * five) fills in for a name that's also a common phrase. Only songs that are theirs: by their id when it's known, so a
 * namesake's aren't added, or else by their name. A song found twice, or under the same title, is added once
 */
export async function artistSongs(artist: string, id?: string): Promise<Track[]> {
  const name = artist.trim().replaceAll('"', '').slice(0, 100);
  if (!name) return [];
  const found = await Promise.all(
    [name, `artist:"${name}"`].map((q) => get<{ tracks: Page<ApiTrack> }>(`/search?type=track&limit=${SEARCH_LIMIT}&market=${config.spotifyMarket}&q=${encodeURIComponent(q)}`)),
  );
  const theirs = (t: ApiTrack) => t.artists.some((a) => (id ? a.id === id : a.name.toLowerCase() === name.toLowerCase()));
  const titles = new Set<string>();
  const songs: Track[] = [];
  for (const t of found.flatMap((b) => b.tracks.items)) {
    const title = t.name.toLowerCase();
    if (!playable(t) || !theirs(t) || titles.has(title)) continue;
    titles.add(title);
    songs.push(toTrack(t));
  }
  return songs.slice(0, SEARCH_LIMIT);
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

const UNPLAYABLE = 'That song can’t be played here.';

/**
 * Everything a link points to, up to MOST_FROM_LINK songs, with a name for it. `shuffle` picks them at random from the whole album or playlist.
 * `capped` means Spotify showed only the first MOST_FROM_LINK songs, so shuffling can't reach further either
 */
export async function tracksFor(link: { kind: LinkKind; id: string }, shuffle = false): Promise<{ name: string; tracks: Track[]; capped?: boolean }> {
  if (link.kind === 'playlist') return playlistTracks(link.id, shuffle);
  // A song or album is read with the bot's Spotify app. Without one, or while the app is being made to wait or failing,
  // it comes from Spotify's public player instead, which needs no app
  if (!searchReady()) return fromEmbed(link.kind, link.id, shuffle);
  try {
    return await fromApi({ kind: link.kind, id: link.id }, shuffle);
  } catch (err) {
    // A link that's wrong, or a song that can't play, is the same either way
    if (err instanceof SpotifyError && !(err instanceof RateLimited) && (err.message === NOT_FOUND || err.message === UNPLAYABLE)) throw err;
    noteOnce(`Spotify: couldn’t read a link with the app (${(err as Error).message.replace(/\d+/g, 'N')}), so it was read from the public player`);
    return fromEmbed(link.kind, link.id, shuffle).catch((embedErr: unknown) => {
      throw err instanceof SpotifyError ? err : embedErr;
    });
  }
}

/** A song or album, from Spotify's Web API */
async function fromApi(link: { kind: 'track' | 'album'; id: string }, shuffle: boolean): Promise<{ name: string; tracks: Track[] }> {
  const market = `market=${config.spotifyMarket}`;
  if (link.kind === 'track') {
    const t = await get<ApiTrack>(`/tracks/${link.id}?${market}`);
    if (!playable(t)) throw new SpotifyError(UNPLAYABLE);
    return { name: t.name, tracks: [toTrack(t)] };
  }
  const album = await get<ApiAlbum & { tracks: Page<ApiTrack> }>(`/albums/${link.id}?${market}`);
  const items = await rest(album.tracks, 'app', shuffle);
  return { name: album.name, tracks: pick(items.filter(playable).map((t) => toTrack(t, album)), shuffle) };
}

async function playlistTracks(id: string, shuffle: boolean): Promise<{ name: string; tracks: Track[]; capped?: boolean }> {
  const market = `market=${config.spotifyMarket}`;
  // Spotify's Web API only shows what's in a playlist to an app signed in as the playlist's owner. Other playlists are read from Spotify's
  // public embed player, which shows any public playlist's first 100 songs
  if (!playlistsReady()) return fromEmbed('playlist', id, shuffle);
  // Spotify's own playlists aren't found, and other people's are refused
  const refused = (err: unknown) => {
    if (err instanceof SpotifyError && (/HTTP 40[13]/.test(err.message) || err.message === NOT_FOUND)) return null;
    throw err;
  };
  const list = await get<{ name: string }>(`/playlists/${id}?${market}&fields=name`, 'owner').catch(refused);
  const first = list && (await get<Page<{ track?: ApiTrack | null; item?: ApiTrack | null }>>(`/playlists/${id}/items?${market}&limit=100`, 'owner').catch(refused));
  if (!list || !first) return fromEmbed('playlist', id, shuffle);
  const entries = await rest(first, 'owner', shuffle);
  return { name: list.name, tracks: pick(entries.map((e) => e.item ?? e.track).filter(playable).map((t) => toTrack(t)), shuffle) };
}

const said = new Map<string, number>();
/** A line for the log, once an hour */
function noteOnce(line: string) {
  if (Date.now() - (said.get(line) ?? 0) < 3_600_000) return;
  said.set(line, Date.now());
  console.warn(line);
}

interface EmbedTrack {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  isPlayable?: boolean;
}

/** What Spotify's embed player shows: a song, or an album or playlist with its songs */
interface EmbedEntity extends EmbedTrack {
  name?: string;
  artists?: { name?: string }[];
  trackList?: EmbedTrack[];
  visualIdentity?: { image?: { url?: string; maxWidth?: number }[] };
}

const NOT_SHOWN: Record<LinkKind, string> = {
  playlist: 'Spotify won’t show what’s in that playlist. It may be private, or no longer exist.',
  album: 'Spotify won’t show that album. It may no longer exist.',
  track: 'Spotify won’t show that song. It may no longer exist.',
};

/** What Spotify's public embed player shows for a song, album or playlist, which needs no sign-in or Spotify app */
async function embedOf(kind: LinkKind, id: string): Promise<EmbedEntity> {
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, signal: requestTimeout() });
  } catch (err) {
    console.error(`Spotify: couldn’t open a ${kind}’s embed page:`, (err as Error).message);
    throw new SpotifyError('Spotify didn’t answer. Try again in a moment.');
  }
  if (res.status === 404) throw new SpotifyError(NOT_SHOWN[kind]);
  if (res.status === 429) throw new SpotifyError('Spotify is limiting the bot right now. Try again in a minute.');
  if (!res.ok) throw new SpotifyError(`Spotify didn’t answer (HTTP ${res.status}). Try again in a moment.`);
  const json = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(await res.text())?.[1];
  let entity: EmbedEntity | undefined;
  try {
    entity = json ? JSON.parse(json)?.props?.pageProps?.state?.data?.entity : undefined;
  } catch {
    entity = undefined;
  }
  const expected = kind === 'track' ? typeof entity?.uri === 'string' && entity.uri.startsWith('spotify:track:') : Array.isArray(entity?.trackList);
  if (!entity || !expected) {
    // A missing or private one has a page with no entity, so this is also how a change to Spotify's page would show
    if (!json || !/"status":\s*404/.test(json)) console.error(`Spotify: ${kind} ${id}'s embed page didn’t have what was expected`);
    throw new SpotifyError(NOT_SHOWN[kind]);
  }
  return entity;
}

/** The cover on an embed page: the smallest that still looks sharp, as an i.scdn.co image */
function embedCover(entity: EmbedEntity): string | null {
  const images = (entity.visualIdentity?.image ?? []).filter((i) => scdnImage(i?.url)).sort((a, b) => (a.maxWidth ?? 0) - (b.maxWidth ?? 0));
  const best = images.find((i) => (i.maxWidth ?? 0) >= 120) ?? images.at(-1);
  return best ? scdnImage(best.url) : null;
}

/**
 * A song, an album's songs, or a public playlist's first songs, as Spotify's embed player shows them. A playlist's
 * songs come without their album or cover, as the player doesn't give them
 */
async function fromEmbed(kind: LinkKind, id: string, shuffle: boolean): Promise<{ name: string; tracks: Track[]; capped: boolean }> {
  const entity = await embedOf(kind, id);
  const cover = kind === 'playlist' ? null : embedCover(entity);
  if (kind === 'track') {
    if (entity.isPlayable === false) throw new SpotifyError(UNPLAYABLE);
    const title = String(entity.name ?? entity.title ?? 'Untitled').slice(0, 300);
    const artist = (entity.artists ?? []).map((a) => a?.name).filter((a): a is string => typeof a === 'string').join(', ').slice(0, 300);
    return { name: title, tracks: [{ uri: entity.uri!, title, artist, album: '', cover, durationMs: Number(entity.duration) || 0 }], capped: false };
  }
  const album = kind === 'album' ? String(entity.name ?? '').slice(0, 300) : '';
  const list = entity.trackList!;
  const songs = list
    .filter((t) => typeof t?.uri === 'string' && t.uri.startsWith('spotify:track:') && t.isPlayable !== false)
    .map((t): Track => ({ uri: t.uri!, title: String(t.title ?? 'Untitled').slice(0, 300), artist: String(t.subtitle ?? '').slice(0, 300), album, cover, durationMs: Number(t.duration) || 0 }));
  return { name: String(entity.name ?? (kind === 'album' ? 'Spotify album' : 'Spotify playlist')).slice(0, 300), tracks: pick(songs, shuffle), capped: list.length >= MOST_FROM_LINK };
}

const IMAGE = /^https:\/\/[a-z0-9.-]+\.(?:spotifycdn\.com|scdn\.co)\/image\/([0-9a-f]{16,64})$/;
/** One of Spotify's images, from wherever it was served, as i.scdn.co serves it, which the web page takes images from. Null if it isn't one */
function scdnImage(url: unknown): string | null {
  const id = typeof url === 'string' ? IMAGE.exec(url)?.[1] : undefined;
  return id ? `https://i.scdn.co/image/${id}` : null;
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
  return scdnImage(((await res.json().catch(() => ({}))) as { thumbnail_url?: unknown }).thumbnail_url);
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
export function pick<T>(items: T[], shuffle: boolean): T[] {
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

/** Forgets access tokens, playlists and waits, for tests */
export function resetSpotify() {
  tokens.clear();
  waits.clear();
  said.clear();
  owned = undefined;
}
