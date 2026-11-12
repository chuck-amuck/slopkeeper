// Shared by the api-*.test.ts files: a fake Discord server and client, the API on a free port, and calls to it
import './helpers.ts';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { after, before, beforeEach, mock, test, type TestContext } from 'node:test';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.ts';
import { db } from '../src/db.ts';
import { activity } from '../src/features/gamestats.ts';
import { steam } from '../src/features/steam.ts';

export const TOKEN = 'secret';
export const GUILD = 'g1';
export const soundFolder = path.join(process.env.DATA_DIR!, 'sounds', GUILD);

export const wav = (seconds = 0.2) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-f', 'wav', 'pipe:1'], {
    maxBuffer: 16 * 1024 * 1024,
  });

export let discordSounds: Map<string, { name: string; volume?: number; emoji?: { id: string | null; name: string | null } | null; user?: { id: string } | null }>;
export let refuseDiscord: Error | null;
export let nextSoundId = 0;
export let panelEdits: unknown[][];
export let permitted: bigint[];
export let sent: { channelId: string; message: any }[];
export let deletedEvents: string[];
export let editedEvents: [string, any][];
export let createdEvents: any[];
export let failSend: boolean;

export const member = (id: string, displayName: string, bot = false) => [id, { id, displayName, user: { bot } }] as const;

export const channel = (id: string, name: string, type: ChannelType, rawPosition: number, people: ReturnType<typeof member>[] = []) => ({
  id,
  name,
  type,
  rawPosition,
  joinable: true,
  isVoiceBased: () => type === ChannelType.GuildVoice,
  members: new Map(people),
  get guild() {
    return guild;
  },
  parent: { name: 'Chat' },
  permissionsFor: () => ({ has: (flag: bigint) => permitted.includes(flag) }),
  send: async (message: unknown) => {
    if (failSend) throw new Error('Missing Access');
    sent.push({ channelId: id, message });
    return { id: `posted-${sent.length}` };
  },
  toString: () => `<#${id}>`,
});
export const role = (id: string, name: string, position: number, extra = {}) => ({ id, name, position, managed: false, mentionable: true, members: new Map(), guild: null as unknown, toString: () => `<@&${id}>`, ...extra });

export const roles = new Map([
  [GUILD, role(GUILD, '@everyone', 0)],
  ['r1', role('r1', 'Gamers', 1)],
  ['r2', role('r2', 'Bot role', 2, { managed: true })],
  ['333', role('333', 'Mods', 5)],
]);
export let manageRoles = true;
export const heldRoles = new Set<string>();
export let failRoles = false;
export let mentionEveryone = true;
export const me = {
  permissions: { has: (flag: bigint) => (flag === PermissionFlagsBits.ManageRoles ? manageRoles : flag === PermissionFlagsBits.MentionEveryone ? mentionEveryone : true) },
  roles: { highest: { name: 'Slopkeeper', position: 3 } },
};
for (const r of roles.values()) r.guild = { members: { me } };

export const guild = {
  id: GUILD,
  name: 'Test server',
  client: { user: { id: 'the-bot' } },
  afkChannelId: '704',
  voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  iconURL: () => null,
  premiumTier: 0,
  members: {
    me,
    cache: new Map([member('u1', 'Ana'), member('u2', 'Ben'), member('u3', 'Cy')]),
    fetch: async ({ user }: { user: string }) => ({
      ...guild.members.cache.get(user),
      roles: {
        cache: new Map([...heldRoles].filter((key) => key.startsWith(`${user}:`)).map((key) => [key.split(':')[1], {}])),
        add: async (id: string) => {
          if (failRoles) throw new Error('Missing Permissions');
          heldRoles.add(`${user}:${id}`);
        },
        remove: async (id: string) => void heldRoles.delete(`${user}:${id}`),
      },
    }),
  },
  scheduledEvents: {
    create: async (event: unknown) => {
      createdEvents.push(event);
      return { id: `new-event-${createdEvents.length}` };
    },
    delete: async (id: string) => void deletedEvents.push(id),
    edit: async (id: string, changes: unknown) => void editedEvents.push([id, changes]),
  },
  channels: {
    cache: new Map([
      ['c2', channel('c2', 'second', ChannelType.GuildText, 2)],
      ['111', channel('111', 'first', ChannelType.GuildAnnouncement, 1)],
      ['v1', channel('v1', 'voice', ChannelType.GuildVoice, 3)],
      ['701', channel('701', 'General', ChannelType.GuildVoice, 4, [member('u1', 'Ana')])],
      ['702', channel('702', 'Gaming', ChannelType.GuildVoice, 5, [member('u1', 'Ana'), member('u2', 'Ben'), member('b1', 'Some Bot', true)])],
      ['703', channel('703', 'Bots', ChannelType.GuildVoice, 6, [member('b1', 'Some Bot', true)])],
      ['704', channel('704', 'AFK', ChannelType.GuildVoice, 7, [member('u3', 'Cy')])],
    ]),
  },
  roles: {
    cache: roles,
    create: async ({ name, mentionable }: { name: string; mentionable: boolean }) => {
      if (refuseDiscord) throw refuseDiscord;
      const made = role(`made-${roles.size}`, name, 1, { mentionable, guild: { members: { me } } });
      roles.set(made.id, made);
      return made;
    },
    delete: async (id: string) => {
      if (!roles.delete(id)) throw new Error('Unknown Role');
    },
  },
  emojis: {
    cache: new Collection([['123456789012345678', { id: '123456789012345678', name: 'slop', animated: false, toString: () => '<:slop:123456789012345678>' }]]),
    fetch: async (id: string) => {
      if (id !== '123456789012345678') throw new Error('Unknown Emoji');
      return { id };
    },
  },
  soundboardSounds: {
    fetch: async () => guild.soundboardSounds.cache,
    // What the gateway keeps current between fetches
    get cache() {
      return new Map([...discordSounds].map(([id, sound]) => [id, { ...sound, url: `https://cdn.test/${id}` }]));
    },
    create: async ({ name, volume }: { name: string; volume: number }) => {
      if (refuseDiscord) throw refuseDiscord;
      const soundId = `s${++nextSoundId}`;
      discordSounds.set(soundId, { name, volume });
      return { soundId };
    },
    edit: async (id: string, data: { name?: string; volume?: number }) => {
      if (refuseDiscord) throw refuseDiscord;
      const sound = discordSounds.get(id)!;
      if (data.name) sound.name = data.name;
      if (data.volume !== undefined) sound.volume = data.volume;
    },
    delete: async (id: string) => {
      if (refuseDiscord) throw refuseDiscord;
      discordSounds.delete(id);
    },
  },
};

export const client = {
  guilds: { cache: new Map([[GUILD, guild]]) },
  // Discord's events, which the web UI's updates follow: none come here
  on: () => client,
  channels: {
    fetch: async (channelId: string) => ({
      isTextBased: () => true,
      isSendable: () => true,
      send: async (message: unknown) => {
        if (failSend) throw new Error('Missing Access');
        sent.push({ channelId, message });
        return { id: `posted-${sent.length}` };
      },
      messages: { edit: async (...args: unknown[]) => void panelEdits.push(args) },
    }),
  },
} as never;

export const server = createApi(client, TOKEN);
export let base: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.method(console, 'log', () => {});
});
after(() => {
  server.close();
  server.closeAllConnections();
  mock.restoreAll();
});

beforeEach(() => {
  discordSounds = new Map();
  refuseDiscord = null;
  manageRoles = true;
  mentionEveryone = true;
  heldRoles.clear();
  failRoles = false;
  for (const id of roles.keys()) if (id.startsWith('made-')) roles.delete(id);
  panelEdits = [];
  sent = [];
  deletedEvents = [];
  editedEvents = [];
  createdEvents = [];
  failSend = false;
  permitted = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  db.exec(`DELETE FROM sound_emoji; DELETE FROM discord_sounds; DELETE FROM sound_plays; DELETE FROM guild_settings; DELETE FROM sound_panels;
    DELETE FROM sound_favourites; DELETE FROM game_nights; DELETE FROM game_night_series; DELETE FROM game_plays; DELETE FROM session_members; DELETE FROM sessions;
    DELETE FROM sound_levels; DELETE FROM join_sounds; DELETE FROM activity; DELETE FROM game_aliases; DELETE FROM deleted_sounds; DELETE FROM games;
    DELETE FROM steam_links; DELETE FROM steam_owned; DELETE FROM steam_family; DELETE FROM sale_prices; DELETE FROM game_roles; DELETE FROM hidden_apps; DELETE FROM game_votes; DELETE FROM web_users`);
  db.prepare("INSERT INTO sound_panels (message_id, guild_id, channel_id, page) VALUES ('m', ?, '111', 0)").run(GUILD);
  if (existsSync(soundFolder)) for (const f of readdirSync(soundFolder)) execFileSync('rm', ['-r', path.join(soundFolder, f)]);
});

export function call(url: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(base + url, {
    ...rest,
    headers: { authorization: `Bearer ${TOKEN}`, ...rest.headers },
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
}

export async function ok(url: string, init?: RequestInit & { json?: unknown }) {
  const res = await call(url, init);
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

export async function refused(status: number, url: string, init?: RequestInit & { json?: unknown }): Promise<string> {
  const res = await call(url, init);
  const body = (await res.json()) as any;
  assert.equal(res.status, status, JSON.stringify(body));
  return body.error;
}

export const upload = (name: string, file = 'clip.wav', body: BodyInit = wav() as BodyInit, replace = false) =>
  call(`/guilds/${GUILD}/sounds/${name}?file=${file}${replace ? '&replace=1' : ''}`, { method: 'PUT', body });
export const sounds = async () => (await ok(`/guilds/${GUILD}/sounds`)).sounds as any[];

/** Changes the fakes' state for one test. Imported bindings can't be assigned, so tests go through this */
export function setFake(changes: Partial<{ panelEdits: unknown[][]; permitted: bigint[]; failSend: boolean; refuseDiscord: Error | null; manageRoles: boolean; failRoles: boolean; mentionEveryone: boolean }>) {
  if (changes.panelEdits !== undefined) panelEdits = changes.panelEdits;
  if (changes.permitted !== undefined) permitted = changes.permitted;
  if (changes.failSend !== undefined) failSend = changes.failSend;
  if (changes.refuseDiscord !== undefined) refuseDiscord = changes.refuseDiscord;
  if (changes.manageRoles !== undefined) manageRoles = changes.manageRoles;
  if (changes.failRoles !== undefined) failRoles = changes.failRoles;
  if (changes.mentionEveryone !== undefined) mentionEveryone = changes.mentionEveryone;
}

export const plays = () => (db.prepare('SELECT user_id, name FROM sound_plays').all() as { user_id: string; name: string }[]).map((r) => `${r.user_id}:${r.name}`);

export const play = (name: string, channelId: unknown) => ({ url: `/guilds/${GUILD}/sounds/${name}/play`, init: { method: 'POST', json: { channelId } } });

export const HOUR = 3_600_000;

export const quietWav = () =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-af', 'volume=-20dB', '-f', 'wav', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });

export const onlyOnDiscord = () => [...discordSounds.values()][0];

export const planned = (fields = {}) => ({ game: 'Valheim', when: 'tomorrow 8pm', channelId: '111', hostId: 'u2', voiceChannelId: 'v1', details: 'Bring food', ...fields });

export const postNight = (json: unknown) => ok(`/guilds/${GUILD}/game-nights`, { method: 'POST', json });

export const as = (email: string, name?: string) => ({ 'x-slopkeeper-email': encodeURIComponent(email), ...(name && { 'x-slopkeeper-name': encodeURIComponent(name) }) });

export const listed = async (name: string) => (await ok(`/guilds/${GUILD}/sounds`)).sounds.find((s: { name: string }) => s.name === name);

export const realFetch = fetch;

export function discordCdn(t: TestContext, answer: () => Response = () => new Response(new Uint8Array(wav()), { headers: { 'content-type': 'audio/mpeg' } })) {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://cdn.test/')) return realFetch(url, init);
    asked.push(String(url));
    return answer();
  });
  return asked;
}

export const save = (id: string) => ok(`/guilds/${GUILD}/discord-sounds/${id}/save`, { method: 'POST' });

export const restore = (id: number) => ok(`/guilds/${GUILD}/deleted-sounds/${id}/restore`, { method: 'POST' });

export const activityText = () => (db.prepare('SELECT action FROM activity ORDER BY id').all() as { action: string }[]).map((r) => r.action);

export const library = () => ok(`/guilds/${GUILD}/games`);

export const accounts = async () => (await ok(`/guilds/${GUILD}/steam-links`)) as { configured: boolean; members: { id: string; name: string; steam: { url: string; private: boolean; games: number } | null }[] };

export const account = async (id: string) => (await accounts()).members.find((m) => m.id === id)!.steam;

export const pick = (query: string) => ok(`/guilds/${GUILD}/pick?${query}`);

export const hours = (n: number) => n * 3_600_000;
