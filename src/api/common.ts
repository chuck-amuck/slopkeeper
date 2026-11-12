import { ChannelType, type Client, type Guild, type GuildBasedChannel, type GuildTextBasedChannel, type NewsChannel, type TextChannel } from 'discord.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { FROM_WEB, fromWebUser, webUser } from '../activity.ts';
import * as discordBoard from '../discordSounds.ts';
import { checkSetting } from '../features/setup.ts';
import { idSetting, setting } from '../settings.ts';
import { canSee, humansIn } from '../util.ts';

// What every part of the management API shares: refusals, reading requests, who is asking, and lookups that refuse what isn’t there

/** A request to one area of the API, with the server it's for and the rest of its path */
export interface Ask {
  client: Client<true>;
  guild: Guild;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  section: string;
  rest: string[];
}

// A little over the largest sound, which is the largest thing anything sends
const MAX_BODY = 5 * 1024 * 1024 + 1024;

/** How long a request waiting for a change (/playing?after, /updates) holds before answering anyway, well inside a proxy’s timeout */
const CHANGE_WAIT_MS = 25_000;

export class Refused extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The bot's messages are written for Discord; the web UI shows plain text */
export function plain(guild: Guild, text: string): string {
  return text
    .replace(discordBoard.PICK_A_PART, 'turn on its Discord switch to pick a part')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replace(/<#(\d+)>/g, (_, id: string) => `#${guild.channels.cache.get(id)?.name ?? 'unknown channel'}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${guild.roles.cache.get(id)?.name ?? 'unknown role'}`)
    .replace(/<@!?(\d+)>/g, (_, id: string) => nameOf(guild, id))
    .replace(/<t:(\d+)(:\w)?>/g, (_, secs: string) => new Date(Number(secs) * 1000).toLocaleDateString('en-US', { timeZone: setting(guild.id, 'timezone'), dateStyle: 'medium' }));
}

const hash = (text: string) => createHash('sha256').update(text).digest();

interface SignedIn {
  email: string;
  name: string;
}

/** Who the web UI says is asking: someone Pangolin signed in, or nobody for the home network */
export const asking = new AsyncLocalStorage<SignedIn | undefined>();

/** Who to credit a change from the web UI to */
export const by = () => {
  const who = asking.getStore();
  return who ? fromWebUser(who.email) : FROM_WEB;
};

/** The web UI sends these URL-encoded, and only with the token */
export function signedIn(req: IncomingMessage): SignedIn | undefined {
  const read = (name: string, max: number) => {
    const value = req.headers[name];
    if (typeof value !== 'string') return undefined;
    try {
      return decodeURIComponent(value).trim().slice(0, max) || undefined;
    } catch {
      return undefined;
    }
  };
  const email = read('x-slopkeeper-email', 254);
  return email ? { email, name: read('x-slopkeeper-name', 100) ?? email } : undefined;
}

export function authorized(req: IncomingMessage, token: string): boolean {
  return timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${token}`));
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Refused(413, 'File is over 5 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Writes a large upload straight to a file, refusing it once it's over `max` bytes */
export async function saveBody(req: IncomingMessage, file: string, max: number) {
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > max) throw new Refused(413, `That file is over ${max / 1024 / 1024} MB.`);
          yield chunk;
        }
      },
      createWriteStream(file),
    );
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const body = JSON.parse((await readBody(req)).toString() || '{}') as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Refused) throw err;
  }
  throw new Refused(400, 'That isn’t valid JSON.');
}

const CHANNEL_SETTINGS = ['announceChannel', 'freeGamesChannel', 'saleChannel', 'patchNotesChannel', 'ttsChannel', 'loopRoom'] as const;

/**
 * Channels the pickers offer: the ones the bot can see, plus any a setting still points at, so the setting shows as
 * it is, marked as a problem, rather than as none
 */
export function listed(guild: Guild) {
  const inUse = new Set(CHANNEL_SETTINGS.map((key) => idSetting(guild.id, key)));
  return (c: GuildBasedChannel) => canSee(guild, c) || inUse.has(c.id);
}

export const channelName = (guild: Guild, c: GuildBasedChannel) => (canSee(guild, c) ? c.name : 'a channel I can’t see');

export const textChannels = (guild: Guild) =>
  [...guild.channels.cache.values()]
    .filter((c): c is TextChannel | NewsChannel => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && listed(guild)(c))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: channelName(guild, c), category: c.parent?.name ?? null }));

/** Aborts once whoever asked has gone, or after the longest a request waits for a change */
export function untilGone(req: IncomingMessage, res: ServerResponse) {
  const gone = new AbortController();
  res.once('close', () => gone.abort());
  // Gone already, before this could listen for it
  if (res.closed || req.destroyed) gone.abort();
  return { gone: gone.signal, signal: AbortSignal.any([gone.signal, AbortSignal.timeout(CHANGE_WAIT_MS)]) };
}

export const nameOf = (guild: Guild, id: string) => guild.members.cache.get(id)?.displayName ?? 'Someone who left';

export const memberList = (guild: Guild) =>
  [...guild.members.cache.values()]
    .filter((m) => !m.user.bot)
    .map((m) => ({ id: m.id, name: m.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Someone signed in through Pangolin shows as the Discord member they said they are, or their sign-in name if they haven't */
export function whoDid(guild: Guild, actor: string) {
  if (actor === FROM_WEB) return 'Web UI';
  if (!actor.startsWith(fromWebUser(''))) return nameOf(guild, actor);
  const user = webUser(actor.slice(fromWebUser('').length));
  if (user?.userId && guild.members.cache.has(user.userId)) return nameOf(guild, user.userId);
  return user?.name ?? 'Someone on the web UI';
}

export const refuse = (guild: Guild, problem: string | null) => {
  if (problem) throw new Refused(400, plain(guild, problem));
};

/** Turns a failed Discord step into a message for the page */
export const cantDo = (err: Error): never => {
  throw new Refused(400, err.message);
};

export function voiceChannelFor(guild: Guild, id: unknown) {
  const channel = guild.channels.cache.get(String(id));
  if (!channel?.isVoiceBased()) throw new Refused(400, 'Pick a voice channel.');
  // With nobody there, the bot would leave as soon as it joined
  if (!humansIn(channel).length) throw new Refused(400, `Nobody’s in ${channel.name} any more.`);
  return channel;
}

/** A text channel the bot can post in, from what the page sent */
export function postingChannel(guild: Guild, id: unknown) {
  const checked = checkSetting(guild, 'announceChannel', id);
  if ('error' in checked) throw new Refused(400, plain(guild, checked.error));
  return guild.channels.cache.get(String(checked.value)) as GuildTextBasedChannel;
}

export const cantPost = (err: unknown) => {
  console.error(err);
  throw new Refused(502, 'Discord wouldn’t take the message. Try again in a bit.');
};

export function memberIn(guild: Guild, id: string) {
  const member = guild.members.cache.get(id);
  if (!member || member.user.bot) throw new Refused(404, 'They aren’t in this server.');
  return member;
}
