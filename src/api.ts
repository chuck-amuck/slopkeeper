import { ChannelType, type Client, type Guild } from 'discord.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { config } from './config.ts';
import * as discordBoard from './discordSounds.ts';
import { checkSetting, LABELS, LIMITS, source } from './features/setup.ts';
import {
  addSound,
  addToDiscord,
  changeEmoji,
  findSound,
  listSounds,
  parseEmoji,
  refreshPanels,
  removeSound,
  renameSound,
  syncToDiscord,
  uploadProblem,
  type Sound,
} from './features/soundboard.ts';
import { DEFAULTS, isAllowed, setSetting, setting, type SettingKey } from './settings.ts';
import type { Feature } from './types.ts';
import { servedGuilds } from './util.ts';

// A little over the largest sound, which is the largest thing anything sends
const MAX_BODY = 5 * 1024 * 1024 + 1024;
const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

class Refused extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The bot's messages are written for Discord; the web UI shows plain text */
function plain(guild: Guild, text: string): string {
  return text
    .replace(discordBoard.PICK_A_PART, 'turn on its Discord switch to pick a part')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replace(/<#(\d+)>/g, (_, id: string) => `#${guild.channels.cache.get(id)?.name ?? 'unknown channel'}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${guild.roles.cache.get(id)?.name ?? 'unknown role'}`);
}

const hash = (text: string) => createHash('sha256').update(text).digest();

function authorized(req: IncomingMessage, token: string): boolean {
  return timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${token}`));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Refused(413, 'File is over 5 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const body = JSON.parse((await readBody(req)).toString() || '{}') as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Refused) throw err;
  }
  throw new Refused(400, 'That isn’t valid JSON.');
}

// ffprobe per sound is slow, and a sound only changes by being replaced
const durations = new Map<string, { mtimeMs: number; seconds: number | null }>();

async function durationOf(file: string, mtimeMs: number): Promise<number | null> {
  const known = durations.get(file);
  if (known?.mtimeMs === mtimeMs) return known.seconds;
  const seconds = await discordBoard.durationOf(file).catch(() => null);
  durations.set(file, { mtimeMs, seconds });
  return seconds;
}

async function soundList(guild: Guild) {
  const sounds = [];
  for (const sound of listSounds(guild.id)) {
    const { size, mtimeMs } = statSync(sound.file);
    const seconds = await durationOf(sound.file, mtimeMs);
    sounds.push({ name: sound.name, emoji: sound.emoji ?? null, onDiscord: sound.onDiscord, bytes: size, seconds, fitsDiscord: seconds !== null && discordBoard.fits(seconds) });
  }
  return {
    sounds,
    slots: await discordBoard.slots(guild).catch(() => null),
    emojis: guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: e.animated, code: e.toString() })),
    clipSeconds: discordBoard.CLIP_SECONDS,
  };
}

function settingList(guild: Guild) {
  const keys = Object.keys(DEFAULTS) as SettingKey[];
  return {
    settings: keys.map((key) => ({
      key,
      label: LABELS[key],
      value: setting(guild.id, key),
      default: DEFAULTS[key],
      source: source(guild.id, key),
      limits: LIMITS[key as keyof typeof LIMITS] ?? null,
    })),
    channels: [...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null })),
    roles: [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name })),
    timeZones: TIME_ZONES,
  };
}

const soundOf = (guild: Guild, name: string): Sound => {
  const sound = findSound(guild.id, name);
  if (!sound) throw new Refused(404, 'No sound by that name.');
  return sound;
};

const refuse = (guild: Guild, problem: string | null) => {
  if (problem) throw new Refused(400, plain(guild, problem));
};

async function handleSounds(client: Client<true>, guild: Guild, req: IncomingMessage, res: ServerResponse, url: URL, name?: string, part?: string) {
  const method = req.method!;
  // Everything but reading changes what the posted panels show
  const refresh = () => refreshPanels(client, guild.id);

  if (name === undefined) {
    if (method === 'GET') return soundList(guild);
    throw new Refused(405, 'Not here.');
  }

  if (part === 'audio' && method === 'GET') {
    const { file } = soundOf(guild, name);
    res.writeHead(200, {
      'content-type': AUDIO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
    return null;
  }

  if (part === 'discord') {
    const sound = soundOf(guild, name);
    if (method === 'PUT') {
      const { start } = await readJson(req);
      if (start !== undefined && (typeof start !== 'number' || !(start >= 0))) throw new Refused(400, 'Start has to be a number of seconds.');
      refuse(guild, await addToDiscord(guild, sound, start));
    } else if (method === 'DELETE') await discordBoard.remove(guild, sound.name);
    else throw new Refused(405, 'Not here.');
    await refresh();
    return {};
  }
  if (part !== undefined) throw new Refused(404, 'Not found.');

  if (method === 'PUT') {
    const ext = path.extname(url.searchParams.get('file') ?? '').toLowerCase();
    refuse(guild, uploadProblem(name, ext, Number(req.headers['content-length'] ?? 0)));
    const data = await readBody(req);
    const added = await addSound(guild, name, ext, data);
    if (!added) throw new Refused(400, 'That file doesn’t have any audio the bot can read, so it wasn’t saved.');
    await refresh();
    return { replaced: added.replaced, discordProblem: added.problem && plain(guild, added.problem) };
  }

  if (method === 'PATCH') {
    const sound = soundOf(guild, name);
    const body = await readJson(req);
    if ('emoji' in body) {
      if (body.emoji !== null && typeof body.emoji !== 'string') throw new Refused(400, 'Emoji has to be text.');
      const emoji = body.emoji ? await parseEmoji(guild, body.emoji) : null;
      if (emoji && 'error' in emoji) throw new Refused(400, emoji.error);
      await changeEmoji(guild, sound.name, emoji?.emoji ?? null);
    }
    if ('name' in body) refuse(guild, await renameSound(guild, sound, String(body.name)));
    await refresh();
    return {};
  }

  if (method === 'DELETE') {
    const problem = await removeSound(guild, soundOf(guild, name));
    await refresh();
    return { discordProblem: problem };
  }
  throw new Refused(405, 'Not here.');
}

async function handleSettings(guild: Guild, req: IncomingMessage, key?: string) {
  if (key === undefined) {
    if (req.method === 'GET') return settingList(guild);
    throw new Refused(405, 'Not here.');
  }
  if (!Object.hasOwn(DEFAULTS, key)) throw new Refused(404, 'No such setting.');
  const settingKey = key as SettingKey;
  if (req.method === 'DELETE') {
    setSetting(guild.id, settingKey, undefined);
    return {};
  }
  if (req.method !== 'PUT') throw new Refused(405, 'Not here.');
  const checked = checkSetting(guild, settingKey, (await readJson(req)).value);
  if ('error' in checked) throw new Refused(400, plain(guild, checked.error));
  setSetting(guild.id, settingKey, checked.value);
  return { warning: checked.warning && plain(guild, checked.warning) };
}

async function handle(client: Client<true>, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://api');
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Refused(400, 'Bad path.');
  }
  const [root, guildId, section, ...rest] = segments;
  if (root !== 'guilds') throw new Refused(404, 'Not found.');
  if (guildId === undefined) {
    if (req.method !== 'GET') throw new Refused(405, 'Not here.');
    return { guilds: servedGuilds(client).map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) })) };
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild || !isAllowed(guild.id)) throw new Refused(404, 'The bot isn’t in that server.');

  if (section === 'sounds' && rest.length <= 2) return handleSounds(client, guild, req, res, url, rest[0], rest[1]);
  if (section === 'settings' && rest.length <= 1) return handleSettings(guild, req, rest[0]);
  if (section === 'discord-sync' && !rest.length && req.method === 'POST') {
    const result = await syncToDiscord(guild);
    await refreshPanels(client, guild.id);
    return { ...result, failed: result.failed.map((f) => plain(guild, f)), blocker: result.blocker && plain(guild, result.blocker) };
  }
  throw new Refused(404, 'Not found.');
}

/** The management API behind the web UI. Every sound and setting rule lives in the bot, so it's the only thing that applies them */
export function createApi(client: Client<true>, token: string): Server {
  return createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      // A refused upload may not have been read to the end, so the connection can't be reused
      res.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 && { connection: 'close' }) }).end(JSON.stringify(body));
    };
    if (!authorized(req, token)) return reply(401, { error: 'Unauthorized.' });
    if (req.method !== 'GET') console.log(`Web UI: ${req.method} ${req.url}`);
    handle(client, req, res).then(
      (body) => body && reply(200, body),
      (err: unknown) => {
        if (err instanceof Refused) return reply(err.status, { error: err.message });
        console.error(`Web UI: ${req.method} ${req.url} failed:`, err);
        if (res.headersSent) res.destroy();
        else reply(500, { error: 'Something broke. Check the bot logs.' });
      },
    );
  });
}

let server: Server | undefined;

export const webApi: Feature = {
  setup(client) {
    if (!config.apiToken) return;
    server = createApi(client, config.apiToken).listen(config.apiPort, () => console.log(`Management API listening on port ${config.apiPort}`));
    server.on('error', (err) => console.error('Management API failed:', err.message));
  },
  shutdown() {
    server?.close();
    server?.closeAllConnections();
  },
};
