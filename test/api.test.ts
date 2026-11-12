import './helpers.ts';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { ChannelType, Collection, DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { after, before, beforeEach, mock, test, type TestContext } from 'node:test';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi, webApi } from '../src/api.ts';
import { candidatesFor } from '../src/features/games.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { logActivity, recentActivity } from '../src/activity.ts';
import { Mixer } from '../src/mixer.ts';
import { noteGame } from '../src/gameNames.ts';
import { activity, stats } from '../src/features/gamestats.ts';
import { steam, unlinkSteam } from '../src/features/steam.ts';
import { BIN_DAYS, clearBin, levelLibrary, setJoinSound, soundboard, soundGain } from '../src/features/soundboard.ts';
import { lengthFor } from '../src/features/say.ts';
import { setting, setSetting } from '../src/settings.ts';
import { resetSpotify } from '../src/spotify.ts';

const TOKEN = 'secret';
const GUILD = 'g1';
const soundFolder = path.join(process.env.DATA_DIR!, 'sounds', GUILD);

const wav = (seconds = 0.2) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-f', 'wav', 'pipe:1'], {
    maxBuffer: 16 * 1024 * 1024,
  });

let discordSounds: Map<string, { name: string; volume?: number; emoji?: { id: string | null; name: string | null } | null; user?: { id: string } | null }>;
let refuseDiscord: Error | null;
let nextSoundId = 0;
let panelEdits: unknown[][];
let permitted: bigint[];
let sent: { channelId: string; message: any }[];
let deletedEvents: string[];
let editedEvents: [string, any][];
let createdEvents: any[];
let failSend: boolean;

const member = (id: string, displayName: string, bot = false) => [id, { id, displayName, user: { bot } }] as const;

const channel = (id: string, name: string, type: ChannelType, rawPosition: number, people: ReturnType<typeof member>[] = []) => ({
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
const role = (id: string, name: string, position: number, extra = {}) => ({ id, name, position, managed: false, mentionable: true, members: new Map(), guild: null as unknown, toString: () => `<@&${id}>`, ...extra });

const roles = new Map([
  [GUILD, role(GUILD, '@everyone', 0)],
  ['r1', role('r1', 'Gamers', 1)],
  ['r2', role('r2', 'Bot role', 2, { managed: true })],
  ['333', role('333', 'Mods', 5)],
]);
let manageRoles = true;
const heldRoles = new Set<string>();
let failRoles = false;
let mentionEveryone = true;
const me = {
  permissions: { has: (flag: bigint) => (flag === PermissionFlagsBits.ManageRoles ? manageRoles : flag === PermissionFlagsBits.MentionEveryone ? mentionEveryone : true) },
  roles: { highest: { name: 'Slopkeeper', position: 3 } },
};
for (const r of roles.values()) r.guild = { members: { me } };

const guild = {
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

const client = {
  guilds: { cache: new Map([[GUILD, guild]]) },
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

const server = createApi(client, TOKEN);
let base: string;

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

function call(url: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(base + url, {
    ...rest,
    headers: { authorization: `Bearer ${TOKEN}`, ...rest.headers },
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
}

async function ok(url: string, init?: RequestInit & { json?: unknown }) {
  const res = await call(url, init);
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

async function refused(status: number, url: string, init?: RequestInit & { json?: unknown }): Promise<string> {
  const res = await call(url, init);
  const body = (await res.json()) as any;
  assert.equal(res.status, status, JSON.stringify(body));
  return body.error;
}

const upload = (name: string, file = 'clip.wav', body: BodyInit = wav() as BodyInit, replace = false) =>
  call(`/guilds/${GUILD}/sounds/${name}?file=${file}${replace ? '&replace=1' : ''}`, { method: 'PUT', body });
const sounds = async () => (await ok(`/guilds/${GUILD}/sounds`)).sounds as any[];

test('says when the free game list can’t be read', async (t) => {
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response('', { status: 500 })));
  const res = await call(`/guilds/${GUILD}/free-games`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'The free game list couldn’t be read just now.');
});

test('lists the current free games with why each is or isn’t posted', async (t) => {
  const real = fetch;
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    asked.push(String(url));
    if (String(url).includes('gamerpower')) {
      return new Response(JSON.stringify([{ id: 1, title: 'Great Game (Steam) Giveaway', worth: '$9.99', image: '', description: '', open_giveaway_url: 'https://example.com/g', platforms: 'PC, Steam', end_date: 'N/A', status: 'Active' }]));
    }
    return new Response(JSON.stringify({ items: [] }));
  });
  const { games } = await ok(`/guilds/${GUILD}/free-games`);
  assert.deepEqual(games, [{ title: 'Great Game', url: 'https://example.com/g', worth: '$9.99', platforms: 'Steam', show: false, reason: 'Not on Steam, so it can’t be rated' }]);
});

test('lists what’s on sale with the reasons in plain names', async (t) => {
  db.prepare(`INSERT INTO games (id, guild_id, name, steam_appid, added_by) VALUES (9001, ?, 'Discounted', 9001, 'x')`).run(GUILD);
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (9001, 'u1')`).run();
  db.prepare(`INSERT INTO sale_prices (country, appid, discount, was, price, final) VALUES ('us', 9001, 50, '$20.00', '$10.00', 1000)`).run();
  t.after(() => db.exec('DELETE FROM games WHERE id = 9001; DELETE FROM sale_prices'));
  const { games } = await ok(`/guilds/${GUILD}/sales`);
  assert.deepEqual(games, [
    { name: 'Discounted', url: 'https://store.steampowered.com/app/9001', discount: 50, was: '$20.00', price: '$10.00', why: 'Wanted by Ana' },
  ]);
});

test('every route needs the token', async () => {
  for (const authorization of [undefined, 'Bearer wrong', TOKEN]) {
    const res = await fetch(`${base}/guilds`, { headers: authorization ? { authorization } : {} });
    assert.equal(res.status, 401);
  }
  const res = await fetch(`${base}/guilds/${GUILD}/settings/timezone`, { method: 'PUT', body: '{"value":"UTC"}' });
  assert.equal(res.status, 401);
  assert.notEqual(setting(GUILD, 'timezone'), 'UTC');
});

test('lists servers, and refuses one the bot isn’t in', async () => {
  assert.deepEqual((await ok('/guilds')).guilds, [{ id: GUILD, name: 'Test server', icon: null }]);
  assert.match(await refused(404, '/guilds/other/sounds'), /isn’t in that server/);
});

test('uploads a sound, copies it to Discord and updates the posted panels', async () => {
  const res = await upload('horn');
  assert.deepEqual(await res.json(), { name: 'horn', replaced: false, discordProblem: null });
  assert.equal(res.status, 200);
  const [sound] = await sounds();
  assert.equal(sound.name, 'horn');
  assert.equal(sound.onDiscord, true);
  assert.equal(sound.fitsDiscord, true);
  assert.ok(Math.abs(sound.seconds - 0.2) < 0.05);
  assert.equal(discordSounds.size, 1);
  assert.equal(panelEdits.length, 1);
});

test('replacing has to be asked for, and puts the old sound in Recently deleted', async () => {
  await upload('horn', 'a.wav', wav() as BodyInit);
  const refusal = await upload('horn', 'b.wav', wav(1) as BodyInit);
  assert.equal(refusal.status, 409);
  assert.equal(((await refusal.json()) as any).error, 'There’s already a sound called horn.');
  assert.ok(Math.abs((await sounds())[0].seconds - 0.2) < 0.05, 'the first sound is untouched');

  const res = await call(`/guilds/${GUILD}/sounds/horn?file=b.wav&replace=1`, { method: 'PUT', body: wav(1) as BodyInit });
  assert.equal(((await res.json()) as any).replaced, true);
  const [sound] = await sounds();
  assert.equal((await sounds()).length, 1);
  assert.ok(Math.abs(sound.seconds - 1) < 0.05);
  const { sounds: binned } = await ok(`/guilds/${GUILD}/deleted-sounds`);
  assert.deepEqual(binned.map((s: any) => s.name), ['horn']);
  await ok(`/guilds/${GUILD}/deleted-sounds/${binned[0].id}/restore`, { method: 'POST' });
  assert.deepEqual((await sounds()).map((s: any) => s.name), ['horn', 'horn-2']);
});

test('keep=1 adds an upload under the next free name instead of replacing', async () => {
  await upload('horn');
  const kept = await ok(`/guilds/${GUILD}/sounds/horn?file=b.wav&keep=1`, { method: 'PUT', body: wav() as never });
  assert.deepEqual([kept.name, kept.replaced], ['horn-2', false]);
  assert.equal((await ok(`/guilds/${GUILD}/sounds/bell?file=c.wav&keep=1`, { method: 'PUT', body: wav() as never })).name, 'bell');
  assert.deepEqual((await sounds()).map((s: any) => s.name), ['bell', 'horn', 'horn-2']);
  assert.deepEqual((await ok(`/guilds/${GUILD}/deleted-sounds`)).sounds, []);
});

test('a sound too long for Discord stays on the bot, with a reason in plain text', async () => {
  const res = await upload('long', 'long.wav', wav(7) as BodyInit);
  const { discordProblem } = (await res.json()) as any;
  assert.equal(discordProblem, 'it’s 7.0 s long and Discord allows 5 s; turn on its Discord switch to pick a part');
  const [sound] = await sounds();
  assert.equal(sound.onDiscord, false);
  assert.equal(sound.fitsDiscord, false);
});

test('turns down uploads the /sound command would', async () => {
  assert.match(await (await upload('Bad%20Name')).json().then((b: any) => b.error), /lowercase/);
  assert.match(await (await upload('ok', 'notes.txt')).json().then((b: any) => b.error), /Unsupported/);
  const fake = await upload('fake', 'fake.mp3', Buffer.from('not audio') as BodyInit);
  assert.equal(fake.status, 400);
  assert.equal((await sounds()).length, 0);
});

test('a name can’t reach outside the server’s sound folder', async () => {
  assert.equal((await upload('..%2F..%2Fescape')).status, 400);
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, 'escape.wav')), false);
  await refused(404, `/guilds/${GUILD}/sounds/..%2F..%2Fbot.db/audio`);
  await upload('horn');
  const res = await call(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: '../escape' } });
  assert.equal(res.status, 400);
  assert.equal((await sounds())[0].name, 'horn');
});

test('an oversized upload is refused without being stored', async () => {
  const res = await upload('big', 'big.wav', Buffer.alloc(6 * 1024 * 1024) as BodyInit);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /over 5 MB/);
  assert.equal((await sounds()).length, 0);
});

test('an upload that doesn’t declare its size is cut off at the limit', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/guilds/${GUILD}/sounds/big?file=big.wav`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    // Written separately, or Node would declare the size
    req.write(Buffer.alloc(6 * 1024 * 1024));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal((await sounds()).length, 0);
});

test('refuses a server that isn’t on the allowed list, even if the bot is still in it', async () => {
  Object.assign(config, { allowedGuildIds: ['someone-else'] });
  await refused(404, `/guilds/${GUILD}/sounds`);
  assert.deepEqual((await ok('/guilds')).guilds, []);
  Object.assign(config, { allowedGuildIds: null });
});

test('serves a sound’s audio', async () => {
  const data = wav();
  await upload('horn', 'horn.wav', data as BodyInit);
  const res = await call(`/guilds/${GUILD}/sounds/horn/audio`);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(data));
});

test('renames a sound everywhere and keeps its play counts', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { emoji: '🎺' } });
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)').run(GUILD, 'u', 'horn', 1);
  panelEdits = [];

  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'trumpet' } });

  const [sound] = await sounds();
  assert.equal(sound.name, 'trumpet');
  assert.equal(sound.emoji, '🎺');
  assert.equal(sound.onDiscord, true);
  assert.equal([...discordSounds.values()][0].name, 'trumpet');
  assert.deepEqual(readdirSync(soundFolder), ['trumpet.wav']);
  assert.equal((db.prepare('SELECT name FROM sound_plays').get() as any).name, 'trumpet');
  assert.equal(panelEdits.length, 1);
});

test('a rename Discord refuses changes nothing', async () => {
  await upload('horn');
  const error = await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'x' } });
  assert.match(error, /at least 2/);
  assert.deepEqual(readdirSync(soundFolder), ['horn.wav']);
  assert.equal([...discordSounds.values()][0].name, 'horn');
});

test('won’t rename onto another sound', async () => {
  await upload('horn', 'horn.wav');
  await upload('bell', 'bell.wav');
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'bell' } }), /already a sound called bell/);
  assert.equal((await sounds()).length, 2);
});

test('sets and clears emoji, with the same rules as /sound emoji', async () => {
  await upload('horn');
  const patch = (emoji: unknown) => ({ method: 'PATCH', json: { emoji } });
  await ok(`/guilds/${GUILD}/sounds/horn`, patch('<:slop:123456789012345678>'));
  assert.equal((await sounds())[0].emoji, '<:slop:123456789012345678>');
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, patch('<:other:999999999999999999>')), /from this server/);
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, patch('words')), /single emoji/);
  await ok(`/guilds/${GUILD}/sounds/horn`, patch(null));
  assert.equal((await sounds())[0].emoji, null);
});

test('deletes a sound from the bot and from Discord, saying where it is in the bin', async () => {
  await upload('horn');
  const { binId } = await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
  assert.equal((await sounds()).length, 0);
  assert.equal(discordSounds.size, 0);
  assert.deepEqual((await ok(`/guilds/${GUILD}/deleted-sounds`)).sounds.map((s: any) => s.id), [binId]);
  await refused(404, `/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
});

test('takes a sound off Discord and puts part of a long one on', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn/discord`, { method: 'DELETE' });
  assert.equal((await sounds())[0].onDiscord, false);
  assert.equal(discordSounds.size, 0);

  await upload('long', 'long.wav', wav(7) as BodyInit);
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/long/discord`, { method: 'PUT', json: {} }), /7\.0 s long/);
  await ok(`/guilds/${GUILD}/sounds/long/discord`, { method: 'PUT', json: { start: 1 } });
  assert.equal(discordSounds.size, 1);
  await refused(400, `/guilds/${GUILD}/sounds/long/discord`, { method: 'PUT', json: { start: 'soon' } });
});

test('syncs what fits and reports the rest', async () => {
  await upload('horn', 'horn.wav');
  await upload('long', 'long.wav', wav(7) as BodyInit);
  discordSounds.clear();
  const result = await ok(`/guilds/${GUILD}/discord-sync`, { method: 'POST' });
  assert.deepEqual(result.added, ['horn']);
  assert.deepEqual(result.tooLong, ['long']);
  assert.equal(result.blocker, null);
});

test('reports each setting with where it comes from', async () => {
  setSetting(GUILD, 'hopOnMinPeople', 4);
  const { settings, channels, roles: listed, timeZones } = await ok(`/guilds/${GUILD}/settings`);
  const min = settings.find((s: any) => s.key === 'hopOnMinPeople');
  assert.deepEqual([min.value, min.default, min.source, min.limits], [4, 2, 'set here', [2, 25]]);
  assert.equal(settings.find((s: any) => s.key === 'recapMinMinutes').source, 'default');
  assert.deepEqual(channels.map((c: any) => c.name), ['first', 'second']);
  assert.deepEqual(listed.map((r: any) => r.name), ['Mods', 'Gamers']);
  assert.ok(timeZones.includes('America/Chicago'));
});

test('changes and resets a setting', async () => {
  await ok(`/guilds/${GUILD}/settings/hopOnMinPeople`, { method: 'PUT', json: { value: 5 } });
  assert.equal(setting(GUILD, 'hopOnMinPeople'), 5);
  await ok(`/guilds/${GUILD}/settings/hopOnMinPeople`, { method: 'DELETE' });
  assert.equal(setting(GUILD, 'hopOnMinPeople'), 2);
});

test('holds settings to the limits /setup has', async () => {
  const put = (key: string, value: unknown) => ({ url: `/guilds/${GUILD}/settings/${key}`, init: { method: 'PUT', json: { value } } });
  for (const [key, value] of [
    ['hopOnMinPeople', 1],
    ['hopOnMinPeople', 26],
    ['hopOnMinPeople', 2.5],
    ['hopOnMinPeople', '3'],
    ['weeklyPostDay', 7],
    ['weeklyPostHour', 24],
    ['sessionGraceMin', 0],
    ['recapMinMinutes', 601],
    ['gameNightReminderMin', -1],
    ['timezone', 'Mars/Olympus'],
    ['steamCountry', 'usa'],
    ['freeGames', 'yes'],
    ['announceChannel', 'v1'],
    ['announceChannel', 'nope'],
    ['hopOnRole', GUILD],
    ['hopOnRole', 'r2'],
    ['hopOnRole', 'nope'],
  ] as const) {
    const { url, init } = put(key, value);
    await refused(400, url, init);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM guild_settings').get() as any).n, 0, `${key} ${value}`);
  }
  await refused(404, `/guilds/${GUILD}/settings/constructor`, { method: 'PUT', json: { value: 1 } });
  await refused(400, `/guilds/${GUILD}/settings/hopOnMinPeople`, { method: 'PUT', body: 'not json' });
});

test('refuses a channel the bot can’t post in, naming it in plain text', async () => {
  permitted = [PermissionFlagsBits.ViewChannel];
  const error = await refused(400, `/guilds/${GUILD}/settings/announceChannel`, { method: 'PUT', json: { value: '111' } });
  assert.equal(error, 'I can’t post in #first yet. Give my role Send Messages, Embed Links there, then run this again.');
});

test('warns about a role the bot can’t hand out yet', async () => {
  const { warning } = await ok(`/guilds/${GUILD}/settings/hopOnRole`, { method: 'PUT', json: { value: '333' } });
  assert.match(warning, /above @Mods/);
  assert.equal(setting(GUILD, 'hopOnRole'), '333');
  assert.equal((await ok(`/guilds/${GUILD}/settings/hopOnRole`, { method: 'PUT', json: { value: 'r1' } })).warning, undefined);
});

test('stores values in the form /setup does', async () => {
  await ok(`/guilds/${GUILD}/settings/steamCountry`, { method: 'PUT', json: { value: 'GB' } });
  assert.equal(setting(GUILD, 'steamCountry'), 'gb');
  await ok(`/guilds/${GUILD}/settings/freeGames`, { method: 'PUT', json: { value: true } });
  assert.equal(setting(GUILD, 'freeGames'), true);
  await ok(`/guilds/${GUILD}/settings/monthlyRecap`, { method: 'PUT', json: { value: false } });
  assert.equal(setting(GUILD, 'monthlyRecap'), false);
  await ok(`/guilds/${GUILD}/settings/timezone`, { method: 'PUT', json: { value: ' Europe/London ' } });
  assert.equal(setting(GUILD, 'timezone'), 'Europe/London');
});

test('lists voice channels with people in them, busiest first, without bots or the AFK channel', async () => {
  assert.deepEqual((await ok(`/guilds/${GUILD}/voice`)).channels, [
    { id: '702', name: 'Gaming', people: ['Ana', 'Ben'] },
    { id: '701', name: 'General', people: ['Ana'] },
  ]);
});

const plays = () => (db.prepare('SELECT user_id, name FROM sound_plays').all() as { user_id: string; name: string }[]).map((r) => `${r.user_id}:${r.name}`);
const play = (name: string, channelId: unknown) => ({ url: `/guilds/${GUILD}/sounds/${name}/play`, init: { method: 'POST', json: { channelId } } });

test('plays a sound in a voice channel and counts it, with nobody credited', async (t) => {
  // The audio loop and the leave-when-idle timer would otherwise keep the test process going
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await upload('horn');
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  // After the test, pass or fail, so a failure doesn't leave audio running and hang the run
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });

  const { url, init } = play('horn', '702');
  await ok(url, init);
  assert.deepEqual(plays(), ['web:horn']);
});

test('says what’s playing as it changes, and stops one sound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await upload('horn');
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });

  const quiet = await ok(`/guilds/${GUILD}/playing`);
  assert.deepEqual(quiet.playing, []);
  // Waits at the bot until something starts
  const waiting = ok(`/guilds/${GUILD}/playing?after=${encodeURIComponent(quiet.version)}`);
  const { url, init } = play('horn', '702');
  await ok(url, init);
  const now = await waiting;
  assert.notEqual(now.version, quiet.version);
  assert.deepEqual(
    now.playing.map((p: { name: string; kind: string; loop: boolean }) => [p.name, p.kind, p.loop]),
    [['horn', 'sound', false]],
  );
  // A version from before answers straight away
  const again = await ok(`/guilds/${GUILD}/playing?after=${encodeURIComponent(quiet.version)}`);
  assert.deepEqual(
    again.playing.map((p: { id: number }) => p.id),
    now.playing.map((p: { id: number }) => p.id),
  );

  const id = now.playing[0].id;
  assert.deepEqual(await ok(`/guilds/${GUILD}/playing/${id}/stop`, { method: 'POST' }), { playing: [] });
  assert.match(await refused(404, `/guilds/${GUILD}/playing/${id}/stop`, { method: 'POST' }), /already finished/);
});

test('won’t play somewhere it can’t', async () => {
  await upload('horn');
  const attempts = [
    [400, 'Pick a voice channel', play('horn', '111')],
    [400, 'Pick a voice channel', play('horn', 'nope')],
    [400, 'Pick a voice channel', play('horn', undefined)],
    [400, 'Nobody’s in voice', play('horn', 'v1')],
    [400, 'Nobody’s in Bots', play('horn', '703')],
    [404, 'No sound', play('missing', '702')],
  ] as const;
  for (const [status, message, { url, init }] of attempts) assert.ok((await refused(status, url, init)).includes(message), message);
  assert.deepEqual(plays(), []);
});

test('says why it can’t join, in plain text, without counting the play', async () => {
  await upload('horn');
  const { url, init } = play('horn', '701');
  const error = await refused(400, url, init);
  assert.match(error, /Connect/);
  assert.doesNotMatch(error, /\*\*/);
  assert.deepEqual(plays(), []);
});

test('stop works with nothing playing', async () => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/stop`, { method: 'POST' }), { musicPlaying: false });
});

test('stars a sound and reports how often it’s been played', async () => {
  await upload('horn');
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)').run(GUILD, 'u1', 'horn', 1, GUILD, 'web', 'horn', 2, 'elsewhere', 'u1', 'horn', 3);
  const star = (favourite: boolean) => ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { favourite } });
  assert.deepEqual((await sounds()).map((s) => [s.favourite, s.plays]), [[false, 2]]);
  await star(true);
  await star(true);
  assert.equal((await sounds())[0].favourite, true);
  await star(false);
  assert.equal((await sounds())[0].favourite, false);
});

test('a favourite follows a rename, and doesn’t outlive its sound', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { favourite: true } });
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'trumpet' } });
  assert.equal((await sounds())[0].favourite, true);
  await ok(`/guilds/${GUILD}/sounds/trumpet`, { method: 'DELETE' });
  await upload('trumpet');
  assert.equal((await sounds())[0].favourite, false);
});

function addNight(fields: { guild?: string; startsIn?: number; cancelled?: number; series?: number | null; messageId?: string | null; eventId?: string | null } = {}): number {
  const { guild: guildId = GUILD, startsIn = 86_400_000, cancelled = 0, series = null, messageId = 'card', eventId = 'event' } = fields;
  const id = Number(
    db
      .prepare(
        `INSERT INTO game_nights (guild_id, channel_id, message_id, event_id, game, details, voice_channel_id, starts_at, created_by, cancelled, series_id)
         VALUES (?, '111', ?, ?, 'Halo', 'Bring snacks', '701', ?, 'u1', ?, ?)`,
      )
      .run(guildId, messageId, eventId, Date.now() + startsIn, cancelled, series).lastInsertRowid,
  );
  const rsvp = db.prepare('INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, ?)');
  rsvp.run(id, 'u1', 'in');
  rsvp.run(id, 'u2', 'maybe');
  rsvp.run(id, 'gone', 'out');
  return id;
}

function addSeries(guildId = GUILD): number {
  return Number(
    db
      .prepare(
        `INSERT INTO game_night_series (guild_id, channel_id, game, created_by, every_days, next_at, post_at)
         VALUES (?, '111', 'Halo', 'u1', 7, ?, ?)`,
      )
      .run(guildId, Date.now() + 8 * 86_400_000, Date.now() + 2 * 86_400_000).lastInsertRowid,
  );
}

const isCancelled = (id: number) => (db.prepare('SELECT cancelled FROM game_nights WHERE id = ?').get(id) as { cancelled: number }).cancelled === 1;

test('lists this server’s upcoming nights, with names', async () => {
  const series = addSeries();
  const id = addNight({ series });
  addNight({ cancelled: 1 });
  addNight({ startsIn: -4 * 3_600_000 });
  addNight({ guild: 'other' });
  addSeries('other');
  const { nights, series: repeating, timeZone } = await ok(`/guilds/${GUILD}/game-nights`);
  assert.equal(timeZone, setting(GUILD, 'timezone'));
  assert.equal(nights.length, 1);
  const { startsAt, when, ...rest } = nights[0];
  assert.ok(startsAt > Date.now());
  assert.match(when, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual(rest, { id, game: 'Halo', details: 'Bring snacks', voiceChannel: 'General', voiceChannelId: '701', hostId: 'u1', host: 'Ana', in: ['Ana'], maybe: ['Ben'], out: ['Someone who left'], repeats: 'Every week' });
  assert.deepEqual(repeating.map((s: any) => [s.id, s.repeats, s.host]), [[series, 'Every week', 'Ana']]);
});

test('still shows a night that started in the last few hours', async () => {
  addNight({ startsIn: -3_600_000 });
  assert.equal((await ok(`/guilds/${GUILD}/game-nights`)).nights.length, 1);
});

test('cancelling removes the event, redraws the card and tells only the people who are in', async () => {
  const id = addNight();
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  assert.equal(isCancelled(id), true);
  assert.deepEqual(deletedEvents, ['event']);
  const [channelEdit] = panelEdits as [[string, any]];
  assert.equal(channelEdit[0], 'card');
  assert.match(channelEdit[1].embeds[0].toJSON().title, /Cancelled/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111');
  assert.match(sent[0].message.content, /Halo night\*\* is off/);
  assert.deepEqual(sent[0].message.allowedMentions, { users: ['u1'] });
});

test('editing a night moves its event and card, and tells whoever’s in or maybe', async () => {
  const id = addNight();
  const edit = (json: unknown) => ok(`/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json });
  const { night: before } = await edit({});
  assert.match(before.when, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual([before.voiceChannelId, before.hostId], ['701', 'u1']);
  assert.equal(sent.length + editedEvents.length + panelEdits.length, 0, 'nothing changed, so nothing happens');

  const { changed, night } = await edit({ game: 'Halo 3', when: 'tomorrow 9pm', details: '', voiceChannelId: '702' });
  assert.deepEqual(changed, ['game', 'time', 'details', 'voice channel']);
  assert.deepEqual([night.game, night.details, night.voiceChannel], ['Halo 3', null, 'Gaming']);
  const [[eventId, event]] = editedEvents;
  assert.equal(eventId, 'event');
  assert.deepEqual([event.name, event.description, event.channel, +event.scheduledStartTime], ['Halo 3 night', '', '702', night.startsAt]);
  assert.equal((panelEdits[0] as [string, any])[0], 'card');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /Halo 3 night\*\* now starts <t:\d+:F> .* and meets in <#702>/);
  assert.deepEqual(sent[0].message.allowedMentions, { users: ['u1', 'u2'] });
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Changed the game, time, details, voice channel of **Halo 3** night');

  await edit({ voiceChannelId: null });
  assert.deepEqual(editedEvents[1][1].entityMetadata, { location: 'Voice chat' }, 'no voice channel makes it an outside event, which needs an end');
  assert.ok(editedEvents[1][1].scheduledEndTime);

  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json: { when: 'whenever' } }), 'I couldn’t tell when whenever is. Try something like fri 8pm, tomorrow 20:30 or nov 3 7pm.');
  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json: { game: ' ' } }), 'Say what you’re playing, in 90 characters or fewer.');
  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json: { voiceChannelId: '111' } }), 'Pick a voice channel.');
  await refused(404, `/guilds/${GUILD}/game-nights/99999`, { method: 'PATCH', json: {} });
  const started = addNight({ startsIn: -60_000 });
  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${started}`, { method: 'PATCH', json: { when: 'tomorrow 9pm' } }), 'It’s already started, so its time can’t change.');
});

test('cancelling twice doesn’t ping twice', async () => {
  const id = addNight();
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  assert.equal(sent.length, 1);
  assert.equal(deletedEvents.length, 1);
});

test('doesn’t announce a night that has already started', async () => {
  const id = addNight({ startsIn: -3_600_000 });
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  assert.equal(isCancelled(id), true);
  assert.equal(sent.length, 0);
});

test('can’t touch another server’s night or series', async () => {
  const night = addNight({ guild: 'other' });
  const series = addSeries('other');
  await refused(404, `/guilds/${GUILD}/game-nights/${night}/cancel`, { method: 'POST' });
  await refused(404, `/guilds/${GUILD}/game-night-series/${series}`, { method: 'DELETE' });
  assert.equal(isCancelled(night), false);
  assert.ok(db.prepare('SELECT 1 FROM game_night_series WHERE id = ?').get(series));
  assert.equal(deletedEvents.length, 0);
});

test('refuses nights that don’t exist', async () => {
  for (const id of ['99999', 'abc', '1.5']) await refused(404, `/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  await refused(404, `/guilds/${GUILD}/game-night-series/99999`, { method: 'DELETE' });
});

test('stopping a series leaves posted nights on, without their Stop repeating button', async () => {
  const series = addSeries();
  const id = addNight({ series });
  await ok(`/guilds/${GUILD}/game-night-series/${series}`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT 1 FROM game_night_series WHERE id = ?').get(series), undefined);
  assert.equal(isCancelled(id), false);
  assert.equal(sent.length, 0);
  const [[, card]] = panelEdits as [[string, any]];
  assert.doesNotMatch(JSON.stringify(card.components), /gn:stop/);
  assert.doesNotMatch(JSON.stringify(card.embeds), /Repeats/);
});

const HOUR = 3_600_000;

function addPlay(user: string, game: string, hoursAgo: number, hours: number, guildId = GUILD) {
  const start = Date.now() - hoursAgo * HOUR;
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(guildId, user, game, start, start + hours * HOUR);
}

function addSession(members: [string, number][], hoursAgo: number) {
  const start = Date.now() - hoursAgo * HOUR;
  const id = db.prepare("INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '701', ?, ?)").run(GUILD, start, start + HOUR).lastInsertRowid;
  for (const [user, seconds] of members) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(id, user, seconds);
}

function seedStats() {
  addPlay('u1', 'Halo', 10, 3);
  addPlay('u2', 'Halo', 9, 1);
  addPlay('u1', 'Doom', 5, 2);
  addPlay('gone', 'Doom', 5, 4);
  addPlay('u1', 'Halo', 24 * 20, 1);
  addPlay('u1', 'Other server', 3, 1, 'other');
  addSession([['u1', 3600], ['u2', 1800], ['gone', 7200]], 12);
}

test('stats match what /gamestats works from, leaving out people who’ve left', async () => {
  seedStats();
  const data = await ok(`/guilds/${GUILD}/stats?period=week`);
  const direct = stats(GUILD, Date.now() - 7 * 24 * HOUR, 'none', 'user_id');
  assert.equal(data.players[0].ms, direct.find((r) => r.key === 'u1')!.ms);
  assert.deepEqual(data.players.map((p: any) => [p.id, p.name, Math.round(p.ms / HOUR), p.games]), [['u1', 'Ana', 5, 2], ['u2', 'Ben', 1, 1]]);
  assert.deepEqual(data.games.map((g: any) => [g.name, g.people]), [['Doom', 2], ['Halo', 2]]);
  assert.deepEqual(data.voice.map((p: any) => [p.name, p.ms, p.nights]), [['Ana', 3_600_000, 1], ['Ben', 1_800_000, 1]]);
  // Halo was on for 3h and Doom for 4h, some of that by someone who's since left
  assert.equal(Math.round(data.totals.gameMs / HOUR), 7);
  assert.equal(Math.round(data.totals.playerMs / HOUR), 6);
  assert.equal(data.totals.voiceMs, 5_400_000);
  assert.equal(data.totals.people, 2);
});

test('the period decides what counts', async () => {
  seedStats();
  const hoursFor = async (period: string) => Math.round((await ok(`/guilds/${GUILD}/stats?period=${period}`)).players[0].ms / HOUR);
  assert.equal(await hoursFor('week'), 5);
  assert.equal(await hoursFor('month'), 6);
  assert.equal(await hoursFor('all'), 6);
  for (const period of ['decade', 'constructor']) await refused(400, `/guilds/${GUILD}/stats?period=${period}`);
});

test('filters by person, by game and by both', async () => {
  seedStats();
  const byUser = await ok(`/guilds/${GUILD}/stats?period=week&user=u1`);
  assert.deepEqual(byUser.user, { id: 'u1', name: 'Ana' });
  assert.deepEqual(byUser.games.map((g: any) => g.name), ['Halo', 'Doom']);
  assert.deepEqual(byUser.voice.map((p: any) => p.id), ['u1']);

  const byGame = await ok(`/guilds/${GUILD}/stats?period=week&game=${encodeURIComponent('halo')}`);
  assert.deepEqual(byGame.players.map((p: any) => p.id), ['u1', 'u2']);
  assert.deepEqual(byGame.voice, []);

  const both = await ok(`/guilds/${GUILD}/stats?period=week&user=u2&game=Halo`);
  assert.equal(Math.round(both.totals.gameMs / HOUR), 1);
});

test('a picked game shows how long it was played, a picked person their own time', async () => {
  seedStats();
  const halo = await ok(`/guilds/${GUILD}/stats?period=week&game=Halo`);
  assert.equal(Math.round(halo.totals.gameMs / HOUR), 3);
  assert.equal(Math.round(halo.totals.playerMs / HOUR), 4);
  assert.deepEqual(halo.players.map((p: any) => [p.name, Math.round(p.ms / HOUR)]), [['Ana', 3], ['Ben', 1]]);
  const ben = await ok(`/guilds/${GUILD}/stats?period=week&user=u2`);
  assert.equal(Math.round(ben.totals.gameMs / HOUR), 1);
  assert.equal(Math.round(ben.activity.buckets.reduce((sum: number, b: any) => sum + b.ms, 0) / HOUR), 1);
});

test('game time over time adds up to the total, by day for a short period', async () => {
  seedStats();
  const data = await ok(`/guilds/${GUILD}/stats?period=week`);
  assert.equal(data.activity.step, 'day');
  assert.ok(data.activity.buckets.length >= 7);
  const total = data.activity.buckets.reduce((sum: number, b: any) => sum + b.ms, 0);
  assert.ok(Math.abs(total - data.totals.gameMs) < 2000, `${total} vs ${data.totals.gameMs}`);
});

test('stats are empty for a quiet server', async () => {
  const data = await ok(`/guilds/${GUILD}/stats`);
  assert.deepEqual(data.activity, { step: 'day', buckets: [] });
  assert.equal(data.totals.gameMs, 0);
});

test('a play across midnight is split between the days', () => {
  const midnight = Date.parse('2026-03-10T05:00:00Z'); // In Chicago, on CDT
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(GUILD, 'u1', 'Halo', midnight - HOUR / 2, midnight + HOUR);
  const { step, buckets } = activity(GUILD, midnight - 2 * 24 * HOUR, midnight + 24 * HOUR, 'America/Chicago');
  assert.equal(step, 'day');
  assert.deepEqual(buckets.filter((b) => b.ms).map((b) => b.ms), [HOUR / 2, HOUR]);
  assert.equal(buckets.filter((b) => b.ms)[1].start, midnight);
});

test('longer periods are grouped by week, then by month from the 1st', () => {
  const now = Date.parse('2026-06-15T17:00:00Z');
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(GUILD, 'u1', 'Halo', now - 500 * 24 * HOUR, now - 500 * 24 * HOUR + HOUR);
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(GUILD, 'u1', 'Halo', now - 50 * 24 * HOUR, now - 50 * 24 * HOUR + HOUR);
  assert.equal(activity(GUILD, now - 100 * 24 * HOUR, now, 'UTC').step, 'week');
  const months = activity(GUILD, 0, now, 'UTC');
  assert.equal(months.step, 'month');
  assert.equal(new Date(months.buckets[1].start).getUTCDate(), 1);
  assert.equal(months.buckets.reduce((sum, b) => sum + b.ms, 0), 2 * HOUR);
});

test('stays off without a token', async () => {
  const listening = mock.fn();
  await webApi.setup?.({ ...(client as object), on: listening } as never);
  await assert.rejects(fetch(`http://127.0.0.1:${config.apiPort}/guilds`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  webApi.shutdown?.();
});

test('listens on the configured port with a token, and stops on shutdown', async () => {
  const url = 'http://127.0.0.1:18787/guilds';
  Object.assign(config, { apiToken: TOKEN, apiPort: 18787 });
  await webApi.setup?.(client);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  webApi.shutdown?.();
  Object.assign(config, { apiToken: null });
  await assert.rejects(fetch(url));
});

test('a read never changes anything', async () => {
  await upload('horn');
  panelEdits = [];
  await sounds();
  await ok(`/guilds/${GUILD}/settings`);
  assert.equal(panelEdits.length, 0);
  assert.ok(readFileSync(path.join(soundFolder, 'horn.wav')).length > 0);
});

const quietWav = () =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-af', 'volume=-20dB', '-f', 'wav', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
const onlyOnDiscord = () => [...discordSounds.values()][0];

test('uploading measures a sound and plays a quiet one louder, here and on Discord', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  const [sound] = await sounds();
  assert.ok(sound.gainDb > 3, String(sound.gainDb));
  assert.equal(sound.percent, 100);
  assert.ok(soundGain(GUILD, 'quiet') > 1.4);
  assert.ok(sound.volume > 0.5 && sound.volume <= 1);
  assert.equal(onlyOnDiscord().volume, sound.volume);
});

test('Discord’s volume stops at its limit of 1', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  await ok(`/guilds/${GUILD}/sounds/quiet`, { method: 'PATCH', json: { volume: 200 } });
  assert.equal(onlyOnDiscord().volume, 1);
  assert.ok(soundGain(GUILD, 'quiet') > 2.8);
});

test('a sound’s loudness is what plays in voice, even past Discord’s limit', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  await ok(`/guilds/${GUILD}/sounds/quiet`, { method: 'PATCH', json: { volume: 200 } });
  const [sound] = await sounds();
  assert.equal(sound.volume, 1);
  assert.equal(sound.loudness, soundGain(GUILD, 'quiet') / 2);
  assert.ok(sound.loudness > 1);
});

test('the picked volume multiplies the measured one and reaches Discord without re-uploading', async () => {
  await upload('horn');
  const before = soundGain(GUILD, 'horn');
  const id = [...discordSounds.keys()][0];
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  assert.ok(Math.abs(soundGain(GUILD, 'horn') / before - 0.5) < 0.001);
  assert.equal((await sounds())[0].percent, 50);
  assert.deepEqual([...discordSounds.keys()], [id]);
  assert.equal(onlyOnDiscord().volume, (await sounds())[0].volume);
});

test('refuses a volume outside the slider', async () => {
  await upload('horn');
  for (const volume of [24, 201, 50.5, '50', null]) assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume } }), /whole number from 25 to 200/);
  assert.equal((await sounds())[0].percent, 100);
});

test('new audio under an old name starts from a new measurement and normal volume', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  const loud = (await sounds())[0].gainDb;
  await upload('horn', 'q.wav', quietWav() as BodyInit, true);
  const [sound] = await sounds();
  assert.equal(sound.percent, 100);
  assert.ok(sound.gainDb > loud);
});

test('renaming keeps its level and whoever’s join sound it is', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  setJoinSound(GUILD, 'u1', 'horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'honk' } });
  assert.equal((await sounds())[0].percent, 50);
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, [{ id: 'u1', who: 'Ana', name: 'honk' }]);
});

test('deleting clears its level and any join sound using it', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  setJoinSound(GUILD, 'u1', 'horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT 1 FROM sound_levels WHERE guild_id = ?').get(GUILD), undefined);
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, []);
});

test('turning even volume off and on applies to playback and Discord’s copies', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  const levelled = onlyOnDiscord().volume;
  await ok(`/guilds/${GUILD}/settings/evenVolume`, { method: 'PUT', json: { value: false } });
  assert.equal(soundGain(GUILD, 'quiet'), 1);
  assert.equal(onlyOnDiscord().volume, 0.5);
  await ok(`/guilds/${GUILD}/settings/evenVolume`, { method: 'DELETE' });
  assert.equal(onlyOnDiscord().volume, levelled);
});

test('turned off, the picked volume still counts', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  await ok(`/guilds/${GUILD}/settings/evenVolume`, { method: 'PUT', json: { value: false } });
  assert.equal(soundGain(GUILD, 'horn'), 0.5);
});

test('measures sounds from before levelling, once, keeping a volume already picked', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  db.exec('UPDATE sound_levels SET gain_db = NULL, percent = 70');
  onlyOnDiscord().volume = 0.5;
  const logged = mock.method(console, 'log', () => {});
  logged.mock.resetCalls();
  await levelLibrary(client);
  const [sound] = await sounds();
  assert.ok(sound.gainDb > 3);
  assert.equal(sound.percent, 70);
  assert.notEqual(onlyOnDiscord().volume, 0.5);
  const lines = logged.mock.callCount();
  assert.equal(lines, 1);
  await levelLibrary(client);
  assert.equal(logged.mock.callCount(), lines);
});

test('an upload can stay off Discord', async () => {
  const res = await call(`/guilds/${GUILD}/sounds/horn?file=a.wav&discord=0`, { method: 'PUT', body: wav() as BodyInit });
  assert.deepEqual(await res.json(), { name: 'horn', replaced: false, discordProblem: null });
  assert.equal(discordSounds.size, 0);
  assert.equal((await sounds())[0].onDiscord, false);
});

test('replacing a sound that’s on Discord updates its copy even when told to stay off', async () => {
  await upload('horn');
  const old = [...discordSounds.keys()][0];
  await call(`/guilds/${GUILD}/sounds/horn?file=a.wav&discord=0&replace=1`, { method: 'PUT', body: wav() as BodyInit });
  assert.equal(discordSounds.size, 1);
  assert.notEqual([...discordSounds.keys()][0], old);
});

test('lists and removes join sounds, only for this server', async () => {
  setJoinSound(GUILD, 'u1', 'horn');
  setJoinSound('other', 'u2', 'bell');
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, [{ id: 'u1', who: 'Ana', name: 'horn' }]);
  await refused(404, `/guilds/${GUILD}/join-sounds/u2`, { method: 'DELETE' });
  await ok(`/guilds/${GUILD}/join-sounds/u1`, { method: 'DELETE' });
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM join_sounds WHERE guild_id = 'other'").get() as { n: number }).n, 1);
});

const planned = (fields = {}) => ({ game: 'Valheim', when: 'tomorrow 8pm', channelId: '111', hostId: 'u2', voiceChannelId: 'v1', details: 'Bring food', ...fields });
const postNight = (json: unknown) => ok(`/guilds/${GUILD}/game-nights`, { method: 'POST', json });
const nightRows = () => db.prepare('SELECT * FROM game_nights WHERE guild_id = ?').all(GUILD) as any[];

test('offers what the planning form needs', async () => {
  setSetting(GUILD, 'announceChannel', '111');
  db.prepare("INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'u1', 'Halo', 'voice', 0, 1)").run(GUILD);
  const data = await ok(`/guilds/${GUILD}/game-nights`);
  assert.deepEqual(data.games, ['Halo']);
  assert.equal(data.defaultChannel, '111');
  assert.deepEqual(data.channels.map((c: any) => c.name), ['first', 'second']);
  assert.deepEqual(data.voiceChannels.slice(0, 2).map((c: any) => c.name), ['voice', 'General']);
  assert.deepEqual(data.members.map((m: any) => m.name), ['Ana', 'Ben', 'Cy']);
});

test('reads a typed time back before anything is posted', async () => {
  const { time } = await ok(`/guilds/${GUILD}/game-nights/when?text=${encodeURIComponent('tomorrow 8pm')}`);
  assert.match(time.label, /8:00 PM/);
  assert.equal(time.passed, false);
  assert.equal((await ok(`/guilds/${GUILD}/game-nights/when?text=whenever`)).time, null);
  assert.equal(nightRows().length, 0);
});

test('planning posts the card and event, with the picked host in', async () => {
  await postNight(planned());
  const [night] = nightRows();
  assert.equal(night.game, 'Valheim');
  assert.equal(night.created_by, 'u2');
  assert.equal(night.channel_id, '111');
  assert.equal(night.voice_channel_id, 'v1');
  assert.equal(night.message_id, 'posted-1');
  assert.equal(night.event_id, 'new-event-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111');
  assert.match(sent[0].message.embeds[0].toJSON().title, /Valheim night/);
  assert.equal(createdEvents[0].name, 'Valheim night');
  const { nights } = await ok(`/guilds/${GUILD}/game-nights`);
  assert.deepEqual(nights[0].in, ['Ben']);
});

test('planning a repeating night starts the series', async () => {
  await postNight(planned({ repeat: 14 }));
  const series = db.prepare('SELECT * FROM game_night_series WHERE guild_id = ?').get(GUILD) as any;
  assert.equal(series.every_days, 14);
  assert.equal(nightRows()[0].series_id, series.id);
});

test('a card that can’t be posted leaves no night, event or series behind', async () => {
  failSend = true;
  const errors = mock.method(console, 'error', () => {});
  await refused(500, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned({ repeat: 7 }) });
  errors.mock.restore();
  assert.equal(nightRows().length, 0);
  assert.deepEqual(deletedEvents, ['new-event-1']);
  assert.equal(db.prepare('SELECT 1 FROM game_night_series WHERE guild_id = ?').get(GUILD), undefined);
  assert.deepEqual((await ok(`/guilds/${GUILD}/activity`)).entries, []);
});

test('refuses a night it can’t plan, before posting anything', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ game: '' }, /what you’re playing/],
    [{ game: 'x'.repeat(91) }, /what you’re playing/],
    [{ game: 5 }, /what you’re playing/],
    [{ when: 'whenever' }, /couldn’t tell when whenever/],
    [{ when: '2020-01-01 8pm' }, /already passed/],
    [{ details: 'x'.repeat(1001) }, /1000 characters/],
    [{ hostId: 'nobody' }, /Pick a host/],
    [{ channelId: 'v1' }, /Pick a text channel/],
    [{ voiceChannelId: '111' }, /Pick a voice channel/],
    [{ repeat: 3 }, /every 1 or 2 weeks/],
  ];
  for (const [fields, message] of cases) assert.match(await refused(400, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned(fields) }), message);
  assert.equal(nightRows().length, 0);
  assert.equal(sent.length, 0);
  assert.equal(createdEvents.length, 0);
});

test('details that aren’t text are left out', async () => {
  await postNight(planned({ details: 42 }));
  assert.equal(nightRows()[0].details, null);
});

test('a bot can’t host', async () => {
  guild.members.cache.set('b1', member('b1', 'Some Bot', true)[1] as never);
  assert.match(await refused(400, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned({ hostId: 'b1' }) }), /Pick a host/);
  guild.members.cache.delete('b1');
});

test('won’t post where the bot can’t', async () => {
  permitted = [PermissionFlagsBits.ViewChannel];
  assert.match(await refused(400, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned() }), /can’t post in #first/);
  assert.equal(sent.length, 0);
});

test('records what the page changes, newest first, in plain text', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'honk' } });
  await ok(`/guilds/${GUILD}/settings/announceChannel`, { method: 'PUT', json: { value: '111' } });
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 0 } });
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'DELETE' });
  await postNight(planned());
  await ok(`/guilds/${GUILD}/sounds/honk`, { method: 'DELETE' });
  const { entries } = await ok(`/guilds/${GUILD}/activity`);
  assert.deepEqual(entries.map((e: any) => [e.who, e.action.replace(/ for .*/, '')]), [
    ['Web UI', 'Removed sound honk'],
    ['Web UI', 'Planned Valheim night'],
    ['Web UI', 'Put Hop-on cooldown back to the default'],
    ['Web UI', 'Set Hop-on cooldown to 0 min'],
    ['Web UI', 'Set Announce channel to #first'],
    ['Web UI', 'Renamed horn to honk'],
    ['Web UI', 'Set the volume of horn to 50%'],
    ['Web UI', 'Added sound horn'],
  ]);
});

test('a refused change isn’t recorded', async () => {
  await upload('horn');
  await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 5 } });
  await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'BAD NAME' } });
  await refused(400, `/guilds/${GUILD}/settings/hopOnMinPeople`, { method: 'PUT', json: { value: 999 } });
  assert.equal((await ok(`/guilds/${GUILD}/activity`)).entries.length, 1);
});

test('records cancelling and stopping, with the game', async () => {
  const series = addSeries();
  const id = addNight();
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  await ok(`/guilds/${GUILD}/game-night-series/${series}`, { method: 'DELETE' });
  assert.deepEqual((await ok(`/guilds/${GUILD}/activity`)).entries.map((e: any) => e.action), ['Stopped Halo night repeating', 'Cancelled Halo night']);
});

test('names who did it in Discord, and pages back through the history', async () => {
  for (let n = 0; n < 60; n++) logActivity(GUILD, n === 0 ? 'u1' : 'gone', `Change ${n}`);
  const first = await ok(`/guilds/${GUILD}/activity`);
  assert.equal(first.entries.length, 50);
  assert.equal(first.more, true);
  assert.equal(first.entries[0].action, 'Change 59');
  assert.equal(first.entries[0].who, 'Someone who left');
  const rest = await ok(`/guilds/${GUILD}/activity?before=${first.entries[49].id}`);
  assert.equal(rest.entries.length, 10);
  assert.equal(rest.more, false);
  assert.equal(rest.entries[9].action, 'Change 0');
  assert.equal(rest.entries[9].who, 'Ana');
});

/** Headers the web UI adds for someone Pangolin signed in */
const as = (email: string, name?: string) => ({ 'x-slopkeeper-email': encodeURIComponent(email), ...(name && { 'x-slopkeeper-name': encodeURIComponent(name) }) });
const whoDid = async () => (await ok(`/guilds/${GUILD}/activity`)).entries.map((e: any) => [e.who, e.action]);

test('credits changes to whoever Pangolin signed in, and Web UI to anyone else', async () => {
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 5 }, headers: as('chuck@example.com', 'Chuck Z') });
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 6 }, headers: as('pat@example.com') });
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 7 } });
  assert.deepEqual(await whoDid(), [
    ['Web UI', 'Set Hop-on cooldown to 7 min'],
    ['pat@example.com', 'Set Hop-on cooldown to 6 min'],
    ['Chuck Z', 'Set Hop-on cooldown to 5 min'],
  ]);
});

test('a sign-in name keeps up with Pangolin, and isn’t mangled', async () => {
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 5 }, headers: as('jose@example.com', 'Jose') });
  await ok(`/guilds/${GUILD}/sounds`, { headers: as('jose@example.com', 'José Ñandú') });
  assert.deepEqual(await whoDid(), [['José Ñandú', 'Set Hop-on cooldown to 5 min']]);
});

test('a header that isn’t encoded properly names nobody', async () => {
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 5 }, headers: { 'x-slopkeeper-email': '%E0%A4%A' } });
  assert.deepEqual(await whoDid(), [['Web UI', 'Set Hop-on cooldown to 5 min']]);
});

test('says who’s signed in, and nobody for the home network', async () => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/me`), { me: null });
  assert.deepEqual(await ok(`/guilds/${GUILD}/me`, { headers: as('chuck@example.com', 'Chuck') }), { me: { name: 'Chuck', userId: null } });
});

test('someone signed in can say which Discord member they are, and their changes show that name', async () => {
  const chuck = as('chuck@example.com', 'Chuck');
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 5 }, headers: chuck });
  assert.deepEqual(await ok(`/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u1' }, headers: chuck }), { me: { name: 'Chuck', userId: 'u1' } });
  // Saying it again changes nothing, so it isn't recorded twice
  await ok(`/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u1' }, headers: chuck });
  assert.deepEqual(await ok(`/guilds/${GUILD}/me`, { headers: chuck }), { me: { name: 'Chuck', userId: 'u1' } });
  assert.deepEqual(await whoDid(), [
    ['Ana', 'Linked the web sign-in for Chuck to Ana'],
    ['Ana', 'Set Hop-on cooldown to 5 min'],
  ]);

  await ok(`/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u2' }, headers: chuck });
  await ok(`/guilds/${GUILD}/me`, { method: 'DELETE', headers: chuck });
  assert.deepEqual(await ok(`/guilds/${GUILD}/me`, { headers: chuck }), { me: { name: 'Chuck', userId: null } });
  assert.deepEqual((await whoDid()).slice(0, 2), [
    ['Chuck', 'Unlinked the web sign-in for Chuck from Ben'],
    ['Chuck', 'Linked the web sign-in for Chuck to Ben'],
  ]);
});

test('two sign-ins can’t be the same Discord member', async () => {
  await ok(`/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u1' }, headers: as('chuck@example.com', 'Chuck') });
  assert.match(await refused(409, `/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u1' }, headers: as('pat@example.com') }), /already said they’re Ana/);
  assert.equal((await ok(`/guilds/${GUILD}/me`, { headers: as('pat@example.com') })).me.userId, null);
});

test('only someone signed in can say who they are, and only as someone in the server', async () => {
  assert.match(await refused(403, `/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u1' } }), /signed in through Pangolin/);
  await refused(403, `/guilds/${GUILD}/me`, { method: 'DELETE' });
  const pat = as('pat@example.com');
  await refused(404, `/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'nobody' }, headers: pat });
  await refused(404, `/guilds/${GUILD}/me`, { method: 'PUT', json: {}, headers: pat });
  await refused(405, `/guilds/${GUILD}/me`, { method: 'POST', headers: pat });
  assert.deepEqual(await whoDid(), []);
});

test('a link to someone who left the server isn’t used', async () => {
  const chuck = as('chuck@example.com', 'Chuck');
  await ok(`/guilds/${GUILD}/me`, { method: 'PUT', json: { userId: 'u3' }, headers: chuck });
  const cy = guild.members.cache.get('u3')!;
  guild.members.cache.delete('u3');
  try {
    assert.deepEqual(await ok(`/guilds/${GUILD}/me`, { headers: chuck }), { me: { name: 'Chuck', userId: null } });
    assert.equal((await whoDid())[0][0], 'Chuck');
  } finally {
    guild.members.cache.set('u3', cy);
  }
});

test('games added and hidden from the web are put down to whoever did it', async () => {
  await ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'Valheim' }, headers: as('chuck@example.com', 'Chuck') });
  assert.equal((db.prepare('SELECT added_by FROM games WHERE guild_id = ?').get(GUILD) as any).added_by, 'web:chuck@example.com');
});

test('activity stays with its server and goes after a year', async () => {
  logActivity('other', 'u1', 'Elsewhere');
  db.prepare("INSERT INTO activity (guild_id, at, actor, action) VALUES (?, ?, 'u1', 'Ancient')").run(GUILD, Date.now() - 366 * 86_400_000);
  logActivity(GUILD, 'u1', 'Recent');
  assert.deepEqual((await ok(`/guilds/${GUILD}/activity`)).entries.map((e: any) => e.action), ['Recent']);
});

/** A sound of the given format, quiet for the first half and loud for the second, so what's kept can be told apart by its loudness */
function steps(ext: string, seconds = 4) {
  const half = seconds / 2;
  const filter = `sine=frequency=440:duration=${half},volume=-30dB[a];sine=frequency=440:duration=${half},volume=-3dB[b];[a][b]concat=n=2:v=0:a=1`;
  const out = path.join(process.env.DATA_DIR!, `steps${ext}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex', filter, out]);
  return readFileSync(out);
}

const lengthOf = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
const addFile = (name: string, ext: string, data: Buffer) => ok(`/guilds/${GUILD}/sounds/${name}?file=${name}${ext}`, { method: 'PUT', body: data as never });
const trim = (name: string, json: unknown) => call(`/guilds/${GUILD}/sounds/${name}/trim`, { method: 'POST', json });
const listed = async (name: string) => (await ok(`/guilds/${GUILD}/sounds`)).sounds.find((s: { name: string }) => s.name === name);

for (const ext of ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac']) {
  test(`trims ${ext} to the right length and keeps the format`, async () => {
    await addFile('cutme', ext, steps(ext));
    assert.equal((await trim('cutme', { start: 1, end: 2.5 })).status, 200);
    assert.ok(Math.abs(lengthOf(path.join(soundFolder, `cutme${ext}`)) - 1.5) < 0.1, String(lengthOf(path.join(soundFolder, `cutme${ext}`))));
    assert.equal((await listed('cutme')).trimmed, true);
  });
}

test('trimming keeps the part asked for, and the sound is measured again', async () => {
  await addFile('quietloud', '.wav', steps('.wav'));
  const whole = (await listed('quietloud')).gainDb;
  await ok(`/guilds/${GUILD}/sounds/quietloud/trim`, { method: 'POST', json: { start: 2.2, end: 3.8 } });
  const loud = (await listed('quietloud')).gainDb;
  assert.ok(loud < whole, `${loud} should be under ${whole}`);

  await addFile('loudquiet', '.wav', steps('.wav'));
  await ok(`/guilds/${GUILD}/sounds/loudquiet/trim`, { method: 'POST', json: { start: 0.2, end: 1.8 } });
  assert.ok((await listed('loudquiet')).gainDb > whole);
});

test('a second trim keeps the first original, and restoring brings it back exactly', async () => {
  const data = wav(3);
  await addFile('twice', '.wav', data);
  await ok(`/guilds/${GUILD}/sounds/twice/trim`, { method: 'POST', json: { start: 0, end: 2 } });
  await ok(`/guilds/${GUILD}/sounds/twice/trim`, { method: 'POST', json: { start: 0.5, end: 1.5 } });
  assert.ok(Math.abs(lengthOf(path.join(soundFolder, 'twice.wav')) - 1) < 0.1);
  await ok(`/guilds/${GUILD}/sounds/twice/restore`, { method: 'POST' });
  assert.ok(readFileSync(path.join(soundFolder, 'twice.wav')).equals(data));
  assert.equal((await listed('twice')).trimmed, false);
  assert.equal((await listed('twice')).seconds, 3);
});

test('restoring measures the sound again and needs something to restore', async () => {
  await addFile('backagain', '.wav', steps('.wav'));
  const whole = (await listed('backagain')).gainDb;
  await ok(`/guilds/${GUILD}/sounds/backagain/trim`, { method: 'POST', json: { start: 2.2, end: 3.8 } });
  await ok(`/guilds/${GUILD}/sounds/backagain/restore`, { method: 'POST' });
  assert.equal((await listed('backagain')).gainDb, whole);
  const res = await call(`/guilds/${GUILD}/sounds/backagain/restore`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('an original follows a renamed sound, and goes with a deleted or replaced one', async () => {
  const data = wav(3);
  await addFile('first', '.wav', data);
  await ok(`/guilds/${GUILD}/sounds/first/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  await ok(`/guilds/${GUILD}/sounds/first`, { method: 'PATCH', json: { name: 'second' } });
  assert.equal((await listed('second')).trimmed, true);
  await ok(`/guilds/${GUILD}/sounds/second/restore`, { method: 'POST' });
  assert.ok(readFileSync(path.join(soundFolder, 'second.wav')).equals(data));

  await ok(`/guilds/${GUILD}/sounds/second/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  await ok(`/guilds/${GUILD}/sounds/second?file=second.mp3&replace=1`, { method: 'PUT', body: steps('.mp3') as never });
  assert.equal((await listed('second')).trimmed, false);
  // The replaced sound took its original to the bin with it
  assert.deepEqual(readdirSync(path.join(soundFolder, 'originals')), []);

  await ok(`/guilds/${GUILD}/sounds/second/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  await ok(`/guilds/${GUILD}/sounds/second`, { method: 'DELETE' });
  assert.deepEqual(readdirSync(path.join(soundFolder, 'originals')), []);
});

test('originals aren’t listed as sounds', async () => {
  await addFile('shadow', '.wav', wav(3));
  await ok(`/guilds/${GUILD}/sounds/shadow/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  assert.deepEqual((await ok(`/guilds/${GUILD}/sounds`)).sounds.map((s: { name: string }) => s.name), ['shadow']);
});

test('refuses a range that doesn’t make sense and leaves the sound alone', async () => {
  const data = wav(3);
  await addFile('safe', '.wav', data);
  for (const [json, why] of [
    [{ start: 'a', end: 1 }, /numbers/],
    [{ start: 1 }, /numbers/],
    [{ start: 1, end: null }, /numbers/],
    [{ start: -1, end: 1 }, /inside/],
    [{ start: 1, end: 4 }, /inside/],
    [{ start: 2, end: 1 }, /at least/],
    [{ start: 1, end: 1.05 }, /at least/],
    [{ start: 0, end: 3 }, /whole/],
  ] as [unknown, RegExp][]) {
    const res = await trim('safe', json);
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.match(((await res.json()) as { error: string }).error, why);
  }
  assert.ok(readFileSync(path.join(soundFolder, 'safe.wav')).equals(data));
  assert.equal((await listed('safe')).trimmed, false);
  assert.equal((await trim('nothing-here', { start: 0, end: 1 })).status, 404);
});

/** Swaps a program for a small script until the test ends */
function fakeProgram(t: TestContext, name: string, script: string) {
  mock.method(console, 'error', () => {});
  const bin = mkdtempSync(path.join(process.env.DATA_DIR!, 'bin-'));
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath}`;
  t.after(() => {
    process.env.PATH = realPath;
    mock.restoreAll();
  });
}

test('a sound whose length can’t be read isn’t trimmed', async (t) => {
  const data = wav(3);
  await addFile('unknown', '.wav', data);
  fakeProgram(t, 'ffprobe', 'exit 1');
  const res = await trim('unknown', { start: 1, end: 2 });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /can’t tell how long/);
  assert.ok(readFileSync(path.join(soundFolder, 'unknown.wav')).equals(data));
});

for (const [what, script] of [
  ['fails', 'exit 1'],
  ['writes nothing', 'for last; do :; done; : > "$last"'],
]) {
  test(`when ffmpeg ${what}, the sound stays as it was with nothing left behind`, async (t) => {
    const data = wav(3);
    await addFile('stuck', '.wav', data);
    fakeProgram(t, 'ffmpeg', script);
    const res = await trim('stuck', { start: 1, end: 2 });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /couldn’t be cut/);
    assert.ok(readFileSync(path.join(soundFolder, 'stuck.wav')).equals(data));
    assert.equal((await listed('stuck')).trimmed, false);
    assert.deepEqual(readdirSync(path.join(soundFolder, 'originals')), []);
  });
}

test('a trimmed sound keeps its volume, emoji and star, and logs what happened', async () => {
  await addFile('kept', '.wav', wav(3));
  await ok(`/guilds/${GUILD}/sounds/kept`, { method: 'PATCH', json: { volume: 150, emoji: '📯', favourite: true } });
  await ok(`/guilds/${GUILD}/sounds/kept/trim`, { method: 'POST', json: { start: 0, end: 1.5 } });
  await ok(`/guilds/${GUILD}/sounds/kept/restore`, { method: 'POST' });
  const sound = await listed('kept');
  assert.deepEqual([sound.percent, sound.emoji, sound.favourite], [150, '📯', true]);
  const { entries } = await ok(`/guilds/${GUILD}/activity`);
  const actions = entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes('Trimmed kept to 1.5 s'), actions.join(', '));
  assert.ok(actions.includes('Restored the original kept'), actions.join(', '));
});

test('trimming leaves Discord’s copy alone', async () => {
  await addFile('mirrored', '.wav', wav(3));
  const before = new Map(discordSounds);
  await ok(`/guilds/${GUILD}/sounds/mirrored/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  assert.deepEqual(discordSounds, before);
  assert.equal((await listed('mirrored')).onDiscord, true);
  await ok(`/guilds/${GUILD}/sounds/mirrored/restore`, { method: 'POST' });
  assert.deepEqual(discordSounds, before);
});

test('games can be merged and separated, and it shows in the stats and activity', async () => {
  addPlay('u1', 'Halo Infinite', 10, 2);
  addPlay('u2', 'haloinfinite', 9, 2);
  addPlay('u1', 'Halo 6', 5, 1);
  noteGame(GUILD, 'Halo Infinite');
  noteGame(GUILD, 'haloinfinite');
  noteGame(GUILD, 'Halo 6');
  const before = (await ok(`/guilds/${GUILD}/game-names`)).games;
  assert.deepEqual(before.map((g: any) => [g.name, Math.round(g.ms / HOUR), g.spellings]), [['Halo Infinite', 3, ['haloinfinite']], ['Halo 6', 1, []]]);

  await ok(`/guilds/${GUILD}/game-names/merge`, { method: 'POST', json: { names: ['Halo Infinite', 'Halo 6'], into: 'Halo Infinite' } });
  const merged = await ok(`/guilds/${GUILD}/stats?period=week&game=Halo Infinite`);
  assert.equal(Math.round(merged.totals.gameMs / HOUR), 4);
  assert.deepEqual(merged.spellings, ['Halo 6', 'haloinfinite']);
  assert.deepEqual((await ok(`/guilds/${GUILD}/stats?period=week`)).spellings, []);

  await ok(`/guilds/${GUILD}/game-names/separate`, { method: 'POST', json: { name: 'Halo 6' } });
  assert.deepEqual((await ok(`/guilds/${GUILD}/game-names`)).games.map((g: any) => g.name), ['Halo Infinite', 'Halo 6']);
  const actions = (await ok(`/guilds/${GUILD}/activity`)).entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes('Merged Halo Infinite, Halo 6 into Halo Infinite'), actions.join(', '));
  assert.ok(actions.includes('Separated Halo 6'), actions.join(', '));
});

test('bad game name changes are refused', async () => {
  for (const [path, json, why] of [
    ['merge', { names: 'Halo', into: 'Halo' }, /Pick the games/],
    ['merge', { names: [1, 2], into: 'Halo' }, /Pick the games/],
    ['merge', { names: ['A', 'B'] }, /Pick the games/],
    ['merge', { names: ['A', 'B'], into: 'A' }, /no game called A/],
    ['separate', {}, /Pick a spelling/],
    ['separate', { name: 'Nothing' }, /no game called/],
  ] as [string, unknown, RegExp][]) {
    const res = await call(`/guilds/${GUILD}/game-names/${path}`, { method: 'POST', json });
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.match(((await res.json()) as { error: string }).error, why);
  }
  assert.equal((await call(`/guilds/${GUILD}/game-names/other`, { method: 'POST', json: {} })).status, 404);
});

const realFetch = fetch;
const missingPermissions = () => new DiscordAPIError({ code: RESTJSONErrorCodes.MissingPermissions, message: 'Missing Permissions' }, RESTJSONErrorCodes.MissingPermissions, 403, 'DELETE', '', {});

/** Serves Discord's copies of sounds, or whatever a test wants instead. Other addresses, like this API's, go through */
function discordCdn(t: TestContext, answer: () => Response = () => new Response(new Uint8Array(wav()), { headers: { 'content-type': 'audio/mpeg' } })) {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://cdn.test/')) return realFetch(url, init);
    asked.push(String(url));
    return answer();
  });
  return asked;
}

const discordList = async () => (await ok(`/guilds/${GUILD}/sounds`)).discordSounds as any[];
const save = (id: string) => ok(`/guilds/${GUILD}/discord-sounds/${id}/save`, { method: 'POST' });
const takeOff = (id: string) => `/guilds/${GUILD}/discord-sounds/${id}`;
const swapIn = (name: string, replacing: string, start?: number) => [`/guilds/${GUILD}/sounds/${name}/discord`, { method: 'PUT', json: { replacing, start } }] as const;
const libraryOnly = (name: string, body: Buffer = wav()) => call(`/guilds/${GUILD}/sounds/${name}?file=clip.wav&discord=0`, { method: 'PUT', body: body as BodyInit });

test('lists what’s on Discord’s soundboard, whoever added it', async () => {
  await upload('horn');
  discordSounds.set('theirs', { name: 'Their Sound', volume: 0.8, emoji: { id: null, name: '🔊' } });
  discordSounds.set('own', { name: 'custom', emoji: { id: '123456789012345678', name: null } });
  discordSounds.set('other', { name: 'foreign', emoji: { id: '999999999999999999', name: null } });
  const list = await discordList();
  assert.deepEqual(
    list.map((s) => [s.name, s.library, s.emoji]),
    [
      ['horn', 'horn', null],
      ['Their Sound', null, '🔊'],
      ['custom', null, '<:slop:123456789012345678>'],
      ['foreign', null, null],
    ],
  );
  assert.equal(list[1].volume, 0.8);
  assert.ok(list.every((s) => !('url' in s)));
  assert.deepEqual((await ok(`/guilds/${GUILD}/sounds`)).slots, { used: 4, total: 8 });
});

test('says which sounds the bot can’t remove', async (t) => {
  discordSounds.set('mine', { name: 'mine', user: { id: 'the-bot' } });
  discordSounds.set('theirs', { name: 'theirs', user: { id: 'u1' } });
  discordSounds.set('unknown', { name: 'unknown', user: null });
  assert.ok((await discordList()).every((s) => s.removable));
  t.mock.method(me.permissions, 'has', (flag: bigint) => flag !== PermissionFlagsBits.ManageGuildExpressions);
  assert.deepEqual(
    (await discordList()).map((s) => [s.name, s.removable]),
    [
      ['mine', true],
      ['theirs', false],
      ['unknown', true],
    ],
  );
});

test('a soundboard Discord won’t show leaves the library working', async (t) => {
  await upload('horn');
  t.mock.method(guild.soundboardSounds, 'fetch', async () => {
    throw new Error('Discord is down');
  });
  // Past when the gateway's copy is trusted, so it asks Discord
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 });
  const body = await ok(`/guilds/${GUILD}/sounds`);
  assert.equal(body.slots, null);
  assert.deepEqual(body.discordSounds, []);
  assert.equal(body.sounds.length, 1);
});

test('names saved from Discord fit the library', async (t) => {
  discordCdn(t);
  const names = [
    ['a', 'Air Horn!', 'air-horn'],
    ['b', 'Été fou', 'ete-fou'],
    ['c', '  --spaced--  ', 'spaced'],
    ['1234567890', '🔊🔊', 'sound-567890'],
    ['0000000001', 'x', 'sound-000001'],
    ['f', 'y'.repeat(32), 'y'.repeat(32)],
    ['g', 'y'.repeat(32), `${'y'.repeat(30)}-2`],
    ['h', 'AIR HORN', 'air-horn-2'],
    ['i', 'air horn', 'air-horn-3'],
  ];
  for (const [id, name, saved] of names) {
    discordSounds.set(id, { name });
    assert.equal((await save(id)).name, saved);
  }
});

test('saving keeps the sound’s emoji and links it, without touching Discord’s copy or the sound with that name', async (t) => {
  discordCdn(t);
  await libraryOnly('horn');
  const before = readFileSync(path.join(soundFolder, 'horn.wav'));
  discordSounds.set('theirs', { name: 'Horn', volume: 0.8, emoji: { id: null, name: '🔊' } });
  const { name } = await save('theirs');
  assert.equal(name, 'horn-2');
  assert.ok(readFileSync(path.join(soundFolder, 'horn.wav')).equals(before));
  const sound = (await sounds()).find((s) => s.name === 'horn-2');
  assert.equal(sound.emoji, '🔊');
  assert.equal(sound.onDiscord, true);
  assert.deepEqual(discordSounds.get('theirs'), { name: 'Horn', volume: 0.8, emoji: { id: null, name: '🔊' } });
  assert.equal((await discordList()).find((s) => s.id === 'theirs').library, 'horn-2');
});

test('saving twice keeps one copy and one line of history', async (t) => {
  const asked = discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  assert.equal((await save('theirs')).name, 'horn');
  assert.equal((await save('theirs')).name, 'horn');
  assert.equal(asked.length, 1);
  assert.equal((await sounds()).length, 1);
  const saves = (await ok(`/guilds/${GUILD}/activity`)).entries.filter((e: any) => e.action.includes('Saved'));
  assert.equal(saves.length, 1);
});

test('an ogg from Discord is stored as one', async (t) => {
  discordCdn(t, () => new Response(new Uint8Array(wav()), { headers: { 'content-type': 'audio/ogg' } }));
  discordSounds.set('theirs', { name: 'Horn' });
  await save('theirs');
  assert.ok(existsSync(path.join(soundFolder, 'horn.ogg')));
});

test('a download that fails or isn’t audio saves nothing', async (t) => {
  discordSounds.set('theirs', { name: 'Horn' });
  let answer = new Response('nope', { status: 500 });
  discordCdn(t, () => answer);
  const url = `/guilds/${GUILD}/discord-sounds/theirs/save`;
  assert.match(await refused(400, url, { method: 'POST' }), /wouldn’t hand over Horn/);
  answer = new Response('this is not audio', { headers: { 'content-type': 'audio/mpeg' } });
  assert.match(await refused(400, url, { method: 'POST' }), /couldn’t be read/);
  assert.equal((await sounds()).length, 0);
  assert.equal((await discordList())[0].library, null);
});

test('taking off a sound that isn’t saved saves it first', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  // The library name comes back, so the page can put it back on
  assert.deepEqual(await ok(takeOff('theirs'), { method: 'DELETE' }), { name: 'horn' });
  assert.equal(discordSounds.size, 0);
  const [sound] = await sounds();
  assert.equal(sound.name, 'horn');
  assert.equal(sound.onDiscord, false);
});

test('a sound that can’t be saved stays on Discord', async (t) => {
  discordCdn(t, () => new Response('nope', { status: 500 }));
  discordSounds.set('theirs', { name: 'Horn' });
  await refused(400, takeOff('theirs'), { method: 'DELETE' });
  assert.ok(discordSounds.has('theirs'));
});

test('taking off a saved sound only frees the slot', async (t) => {
  const asked = discordCdn(t);
  await upload('horn');
  const [{ id }] = await discordList();
  await ok(takeOff(id), { method: 'DELETE' });
  assert.equal(discordSounds.size, 0);
  assert.equal(asked.length, 0);
  assert.equal((await sounds())[0].onDiscord, false);
});

test('without permission a sound stays where it is, and the page says what’s needed', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  await libraryOnly('bell');
  refuseDiscord = missingPermissions();
  assert.match(await refused(400, takeOff('theirs'), { method: 'DELETE' }), /Manage Expressions/);
  assert.ok(discordSounds.has('theirs'));
  assert.equal((await sounds()).find((s) => s.name === 'horn').onDiscord, true);
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /Manage Expressions/);
});

test('renaming a saved sound that was someone else’s says what’s needed', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  await save('theirs');
  refuseDiscord = missingPermissions();
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'bell' } }), /Manage Expressions/);
});

test('deleting a saved sound Discord won’t let go of unlinks it', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  await save('theirs');
  refuseDiscord = missingPermissions();
  assert.match((await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' })).discordProblem, /Manage Expressions/);
  refuseDiscord = null;
  assert.equal((await discordList())[0].library, null);
  assert.equal((await save('theirs')).name, 'horn');
});

test('swapping puts a library sound in another’s slot, keeping the one that came off', async (t) => {
  discordCdn(t);
  await libraryOnly('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  await ok(...swapIn('bell', 'theirs'));
  assert.ok(!discordSounds.has('theirs'));
  assert.ok([...discordSounds.values()].some((s) => s.name === 'bell'));
  const list = await sounds();
  assert.equal(list.find((s) => s.name === 'theirs').onDiscord, false);
  assert.equal(list.find((s) => s.name === 'bell').onDiscord, true);
  const { entries } = await ok(`/guilds/${GUILD}/activity`);
  assert.ok(entries.some((e: any) => e.action === 'Swapped Theirs for bell on Discord’s soundboard'));
});

test('swapping in a long sound uses the part picked', async (t) => {
  discordCdn(t);
  await libraryOnly('long', wav(7));
  discordSounds.set('theirs', { name: 'Theirs' });
  await ok(...swapIn('long', 'theirs', 1.5));
  assert.ok([...discordSounds.values()].some((s) => s.name === 'long'));
});

test('a sound that can’t go on leaves the old one alone', async (t) => {
  const asked = discordCdn(t);
  await libraryOnly('long', wav(7));
  discordSounds.set('theirs', { name: 'Theirs' });
  assert.match(await refused(400, ...swapIn('long', 'theirs')), /7\.0 s long/);
  assert.match(await refused(400, ...swapIn('long', 'theirs', 50)), /only 7\.0 s/);
  assert.ok(discordSounds.has('theirs'));
  assert.equal(asked.length, 0);
  assert.equal((await sounds()).length, 1);
});

test('a sound already on Discord can’t be swapped in', async (t) => {
  discordCdn(t);
  await upload('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /already on Discord/);
  assert.ok(discordSounds.has('theirs'));
});

test('if Discord turns the new sound down, the old one goes back', async (t) => {
  discordCdn(t);
  await libraryOnly('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  const { create } = guild.soundboardSounds;
  t.mock.method(guild.soundboardSounds, 'create', async (sound: { name: string; volume: number }) => {
    if (sound.name === 'bell') throw new Error('Discord said no');
    return create(sound);
  });
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /Discord said no/);
  assert.deepEqual([...discordSounds.values()].map((s) => s.name), ['theirs']);
  const list = await sounds();
  assert.equal(list.find((s) => s.name === 'theirs').onDiscord, true);
  assert.equal(list.find((s) => s.name === 'bell').onDiscord, false);
});

test('if the old sound can’t go back, the page says it’s in the library', async (t) => {
  discordCdn(t);
  await libraryOnly('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  t.mock.method(guild.soundboardSounds, 'create', async () => {
    throw new Error('Discord said no');
  });
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /theirs couldn’t go back on, but it’s safe in the library/);
  assert.ok((await sounds()).some((s) => s.name === 'theirs'));
});

test('only sounds on this server’s soundboard can be asked for', async (t) => {
  const asked = discordCdn(t);
  await upload('bell');
  for (const part of ['/audio', '/save']) await refused(404, `/guilds/${GUILD}/discord-sounds/nope${part}`, { method: part === '/audio' ? 'GET' : 'POST' });
  await refused(404, takeOff('nope'), { method: 'DELETE' });
  await refused(404, ...swapIn('bell', 'nope'));
  assert.equal(asked.length, 0);
  discordSounds.set('theirs', { name: 'Theirs' });
  await refused(404, `/guilds/${GUILD}/discord-sounds/theirs/nope`);
  await refused(404, `/guilds/${GUILD}/discord-sounds/theirs/save`);
  await refused(404, '/guilds/other/discord-sounds/theirs/audio');
});

test('previews a Discord sound without saving it', async (t) => {
  const asked = discordCdn(t);
  discordSounds.set('theirs', { name: 'Theirs' });
  const res = await call(`/guilds/${GUILD}/discord-sounds/theirs/audio`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(wav()));
  assert.deepEqual(asked, ['https://cdn.test/theirs']);
  assert.equal((await sounds()).length, 0);
});

test('plays a Discord sound in voice as loud as it is there, or as the library has it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = discordCdn(t);
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });
  const added = t.mock.method(Mixer.prototype, 'add', () => {});
  const id = `played${Date.now()}`;
  discordSounds.set(id, { name: 'Theirs', volume: 0.8 });
  const url = `/guilds/${GUILD}/discord-sounds/${id}/play`;
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  const file = path.join(tmpdir(), `slopkeeper-discord-${id}`);
  t.after(() => rmSync(file));
  assert.ok(readFileSync(file).equals(wav()));
  assert.equal(asked.length, 1, 'the second play uses the same copy');
  assert.deepEqual(added.mock.calls[0].arguments.slice(0, 2), [file, 0.8 / 0.5]);
  assert.deepEqual(plays(), [], 'not a library sound, so nothing to count');

  await save(id);
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  assert.equal(added.mock.calls[2].arguments[0], path.join(soundFolder, 'theirs.mp3'));
  assert.deepEqual(plays(), ['web:theirs']);
  assert.match(await refused(400, url, { method: 'POST', json: { channelId: 'v1' } }), /Nobody’s in voice/);
});

test('a file from the page plays once at the music volume, and is deleted after', async (t) => {
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });
  const added = t.mock.method(Mixer.prototype, 'add', (_file: string, _gain: number, onEnd: () => void) => onEnd);
  const folder = path.join(process.env.DATA_DIR!, 'music-files');
  const leftovers = () => (existsSync(folder) ? readdirSync(folder) : []);
  const url = (name: string, channelId = '702') => `/guilds/${GUILD}/music/file?name=${encodeURIComponent(name)}&channelId=${channelId}`;

  let music = await ok(url('My Song.wav'), { method: 'POST', body: wav(2) as BodyInit });
  assert.equal(music.file.name, 'My Song');
  assert.ok(Math.abs(music.file.durationMs - 2000) < 100, String(music.file.durationMs));
  const [file, gain, , options] = added.mock.calls[0].arguments;
  assert.deepEqual([gain, options], [1, { group: 'music', lasting: true }], 'at the music volume, and sounds can’t push it out');
  assert.ok(existsSync(file));
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Played the file **My Song**');

  await ok(url('Another.wav'), { method: 'POST', body: wav(1) as BodyInit });
  assert.ok(!existsSync(file), 'a second file stops the first, which is deleted');
  music = await ok(`/guilds/${GUILD}/music/file/stop`, { method: 'POST' });
  assert.equal(music.file, null);
  assert.deepEqual(leftovers(), []);
  assert.match(await refused(409, `/guilds/${GUILD}/music/file/stop`, { method: 'POST' }), /No file is playing/);
  assert.match(await refused(400, `/guilds/${GUILD}/music/seek`, { method: 'POST', json: { positionMs: 'half' } }), /positionMs must be a number/);
  assert.match(await refused(400, `/guilds/${GUILD}/music/seek`, { method: 'POST', json: { positionMs: 1000 } }), /Nothing is playing/);

  assert.match(await refused(400, url('notes.txt'), { method: 'POST', body: 'hello' }), /isn’t a file the bot can play/);
  assert.match(await refused(400, url('fake.mp3'), { method: 'POST', body: 'hello' }), /doesn’t have any audio/);
  assert.match(await refused(400, url('song.mp3', 'v1'), { method: 'POST', body: 'hello' }), /Nobody’s in voice/);
  const huge = 61 * 1024 * 1024;
  assert.match(await refused(400, url('huge.mp3'), { method: 'POST', headers: { 'content-length': String(huge) }, body: Buffer.alloc(huge) as BodyInit }), /over 60 MB/);
  // Sent in pieces, with no length up front, it's counted as it arrives
  const pieces = new ReadableStream({
    start(c) {
      for (let i = 0; i < 62; i++) c.enqueue(new Uint8Array(1024 * 1024));
      c.close();
    },
  });
  assert.match(await refused(413, url('huge.mp3'), { method: 'POST', body: pieces, duplex: 'half' } as RequestInit), /over 60 MB/);
  assert.deepEqual(leftovers(), [], 'nothing refused is kept');
  assert.equal(added.mock.callCount(), 2);
});

const DAY = 86_400_000;
const bin = async () => (await ok(`/guilds/${GUILD}/deleted-sounds`)).sounds as any[];
const remove = (name: string) => ok(`/guilds/${GUILD}/sounds/${name}`, { method: 'DELETE' });
const restore = (id: number) => ok(`/guilds/${GUILD}/deleted-sounds/${id}/restore`, { method: 'POST' });
const activityText = () => (db.prepare('SELECT action FROM activity ORDER BY id').all() as { action: string }[]).map((r) => r.action);

test('a deleted sound comes back with everything it had, but not on Discord', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { emoji: '📯', volume: 150, favourite: true } });
  await ok(`/guilds/${GUILD}/sounds/horn/trim`, { method: 'POST', json: { start: 0, end: 0.1 } });
  const before = (await sounds())[0];
  const trimmed = readFileSync(path.join(soundFolder, 'horn.wav'));
  setJoinSound(GUILD, 'u1', 'horn');

  await remove('horn');
  assert.deepEqual(await sounds(), []);
  assert.equal(existsSync(path.join(soundFolder, 'horn.wav')), false);
  assert.equal(discordSounds.size, 0);
  const [deleted] = await bin();
  assert.equal(deleted.name, 'horn');
  assert.equal(deleted.emoji, '📯');
  assert.equal(deleted.expiresAt - deleted.deletedAt, BIN_DAYS * DAY);

  assert.deepEqual(await restore(deleted.id), { name: 'horn' });
  const after = (await sounds())[0];
  for (const key of ['name', 'emoji', 'favourite', 'volume', 'trimmed', 'loudness']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.trimmed, true);
  assert.equal(after.onDiscord, false);
  assert.deepEqual(readFileSync(path.join(soundFolder, 'horn.wav')), trimmed);
  assert.deepEqual(await bin(), []);
  assert.deepEqual(readdirSync(path.join(soundFolder, 'bin')), []);
  assert.equal((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds.length, 0);
  assert.equal(activityText().at(-1), 'Restored sound **horn**');
  await ok(`/guilds/${GUILD}/sounds/horn/restore`, { method: 'POST' });
  assert.notDeepEqual(readFileSync(path.join(soundFolder, 'horn.wav')), trimmed, 'its untrimmed version came back too');
});

test('a sound comes back under a new name if its own has been taken, original and all', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn/trim`, { method: 'POST', json: { start: 0, end: 0.1 } });
  await remove('horn');
  await upload('horn');
  const [deleted] = await bin();
  assert.deepEqual(await restore(deleted.id), { name: 'horn-2' });
  assert.deepEqual((await sounds()).map((s) => [s.name, s.trimmed]), [['horn', false], ['horn-2', true]]);

  await remove('horn-2');
  await upload('horn-2');
  assert.deepEqual(await restore((await bin())[0].id), { name: 'horn-2-2' });
});

test('a long name stays within the limit when it has to change', async () => {
  const name = 'x'.repeat(32);
  await upload(name);
  await remove(name);
  await upload(name);
  const { name: back } = await restore((await bin())[0].id);
  assert.equal(back, `${'x'.repeat(30)}-2`);
});

test('two deleted sounds of one name are kept apart, newest first', async () => {
  await upload('horn', 'a.wav', wav(0.2) as BodyInit);
  await remove('horn');
  await upload('horn', 'a.wav', wav(0.4) as BodyInit);
  await remove('horn');
  const [newest, oldest] = await bin();
  assert.ok(newest.id > oldest.id);
  await restore(oldest.id);
  assert.ok(readFileSync(path.join(soundFolder, 'horn.wav')).length < wav(0.3).length);
});

test('sounds in the bin aren’t listed, and go after 30 days', async () => {
  await upload('old');
  await upload('recent');
  await remove('old');
  await remove('recent');
  const [recent, old] = await bin();
  db.prepare('UPDATE deleted_sounds SET deleted_at = ? WHERE id = ?').run(Date.now() - (BIN_DAYS + 1) * DAY, old.id);
  db.prepare('UPDATE deleted_sounds SET deleted_at = ? WHERE id = ?').run(Date.now() - (BIN_DAYS - 1) * DAY, recent.id);
  clearBin();
  assert.deepEqual((await bin()).map((s) => s.name), ['recent']);
  assert.deepEqual(readdirSync(path.join(soundFolder, 'bin')), [String(recent.id)]);
  assert.deepEqual(await sounds(), []);
});

test('delete forever erases a sound, for this server only', async () => {
  await upload('horn');
  await remove('horn');
  const [deleted] = await bin();
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${deleted.id + 1}`, { method: 'DELETE' });
  await refused(404, `/guilds/${GUILD}/deleted-sounds/nope/restore`, { method: 'POST' });
  await refused(405, `/guilds/${GUILD}/deleted-sounds/${deleted.id}`, { method: 'POST' });
  await refused(405, `/guilds/${GUILD}/deleted-sounds/${deleted.id}/restore`, { method: 'DELETE' });
  const { lastInsertRowid } = db.prepare(`INSERT INTO deleted_sounds (guild_id, name, favourite, percent, deleted_at) VALUES ('elsewhere', 'theirs', 0, 100, 0)`).run();
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${lastInsertRowid}/restore`, { method: 'POST' });
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${lastInsertRowid}`, { method: 'DELETE' });

  await ok(`/guilds/${GUILD}/deleted-sounds/${deleted.id}`, { method: 'DELETE' });
  assert.deepEqual(await bin(), []);
  assert.equal(existsSync(path.join(soundFolder, 'bin', String(deleted.id))), false);
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${deleted.id}/restore`, { method: 'POST' });
  assert.equal(activityText().at(-1), 'Erased deleted sound **horn**');
});

test('a sound whose files have gone says so instead of breaking', async () => {
  await upload('horn');
  await remove('horn');
  const [deleted] = await bin();
  rmSync(path.join(soundFolder, 'bin', String(deleted.id)), { recursive: true });
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${deleted.id}/restore`, { method: 'POST' });
  assert.deepEqual(await bin(), []);
});

const library = () => ok(`/guilds/${GUILD}/games`);
const addGame = (name: string) => ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { name } });
const gameCalled = async (name: string) => ((await library()).games as any[]).find((g) => g.name === name);
const insertGame = (name: string, appid: number | null = null) => Number(db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, 'u1')`).run(GUILD, name, appid).lastInsertRowid);
const mark = (id: number, user: string, json: unknown) => ok(`/guilds/${GUILD}/games/${id}/members/${user}`, { method: 'PATCH', json });

function fakeSteam(t: TestContext, found: Record<string, number> = {}, down = false) {
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    if (down) return new Response('', { status: 503 });
    if (String(url).includes('GetItems')) return new Response(JSON.stringify({ response: {} }));
    const term = new URL(url).searchParams.get('term')!;
    const match = Object.keys(found).find((name) => name.toLowerCase() === term.toLowerCase());
    return new Response(JSON.stringify({ items: match ? [{ id: found[match], name: match }] : [] }));
  });
}

test('adds a game by name, using Steam’s name and app ID when it has one', async (t) => {
  fakeSteam(t, { 'Deep Rock Galactic': 548430 });
  assert.deepEqual(await addGame('  deep rock galactic '), { name: 'Deep Rock Galactic', added: true });
  const game = await gameCalled('Deep Rock Galactic');
  assert.equal(game.appid, 548430);
  assert.equal(game.url, 'https://store.steampowered.com/app/548430');
  assert.deepEqual(activityText(), ['Added **Deep Rock Galactic** to the game library']);
  assert.deepEqual(await addGame('Deep Rock Galactic'), { name: 'Deep Rock Galactic', added: false });
  assert.equal((await library()).games.length, 1);
  assert.equal(activityText().length, 1);
});

test('a game Steam doesn’t know is added as typed, once', async (t) => {
  fakeSteam(t);
  assert.deepEqual(await addGame('Tabletop Night'), { name: 'Tabletop Night', added: true });
  assert.deepEqual(await addGame('tabletop night'), { name: 'Tabletop Night', added: false });
  const game = await gameCalled('Tabletop Night');
  assert.equal(game.appid, null);
  assert.equal(game.url, null);
});

test('adds a game by its store link, and turns down a link that leads nowhere', async (t) => {
  fakeSteam(t);
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer) VALUES (620, 'Portal 2', 1)`).run();
  assert.equal((await addGame('https://store.steampowered.com/app/620/Portal_2/')).name, 'Portal 2');
  assert.equal((await gameCalled('Portal 2')).appid, 620);
  assert.match(await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'https://store.steampowered.com/app/99999999/' } }), /doesn’t know/);
  assert.match(await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'https://example.com/nope' } }), /doesn’t know/);
  assert.equal((await library()).games.length, 1);
});

test('turns down a bad name, and says when Steam can’t be asked rather than adding it wrongly', async (t) => {
  for (const name of ['', '   ', 5, 'x'.repeat(101), `https://store.steampowered.com/${'x'.repeat(200)}`]) await refused(400, `/guilds/${GUILD}/games`, { method: 'POST', json: { name } });
  fakeSteam(t, {}, true);
  mock.method(console, 'error', () => {});
  assert.match(await refused(502, `/guilds/${GUILD}/games`, { method: 'POST', json: { name: 'Valheim' } }), /couldn’t be reached/);
  assert.deepEqual((await library()).games, []);
});

test('lists who has a game, who needs it, who wants it and any sale', async () => {
  const id = insertGame('Valheim', 892970);
  insertGame('Other', 1);
  db.prepare(`INSERT INTO game_owners (game_id, user_id) VALUES (?, 'u1')`).run(id);
  db.prepare(`INSERT INTO game_owners (game_id, user_id) SELECT id, 'u2' FROM games WHERE name = 'Other'`).run();
  db.prepare(`INSERT INTO game_owners (game_id, user_id) VALUES (?, 'gone')`).run(id);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u3', 's3')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, playtime) VALUES ('s3', 892970, 5)`).run();
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (?, 'u2')`).run(id);
  db.prepare(`INSERT INTO sale_prices (country, appid, discount, was, price, final) VALUES ('us', 892970, 40, '$20.00', '$12.00', 1200), ('de', 1, 90, '20€', '2€', 200)`).run();
  const { games, members } = await library();
  const [other, valheim] = games;
  assert.deepEqual(valheim.owners, [{ id: 'u1', name: 'Ana', steam: false }, { id: 'u3', name: 'Cy', steam: true }]);
  assert.deepEqual(valheim.needs, [{ id: 'u2', name: 'Ben' }]);
  assert.deepEqual(valheim.wanted, [{ id: 'u2', name: 'Ben' }]);
  assert.deepEqual(valheim.sale, { discount: 40, price: '$12.00', was: '$20.00' });
  assert.equal(other.sale, null, 'another region’s sale');
  assert.deepEqual(members.map((m: { name: string }) => m.name), ['Ana', 'Ben', 'Cy']);
});

test('sets a game’s player limit and Steam link, leaving the other as it was', async () => {
  const id = insertGame('Valheim');
  insertGame('Taken', 7);
  const url = `/guilds/${GUILD}/games/${id}`;
  await ok(url, { method: 'PATCH', json: { maxPlayers: 10 } });
  assert.equal((await gameCalled('Valheim')).maxPlayers, 10);
  await ok(url, { method: 'PATCH', json: { steam: 'https://store.steampowered.com/app/892970/Valheim/' } });
  assert.equal((await gameCalled('Valheim')).appid, 892970);
  assert.equal((await gameCalled('Valheim')).maxPlayers, 10);
  await ok(url, { method: 'PATCH', json: { maxPlayers: null, steam: '' } });
  assert.equal((await gameCalled('Valheim')).maxPlayers, null);
  assert.equal((await gameCalled('Valheim')).appid, null);

  for (const maxPlayers of [0, 101, 2.5, '4']) await refused(400, url, { method: 'PATCH', json: { maxPlayers } });
  await ok(url, { method: 'PATCH', json: { maxPlayers: 1 } });
  await ok(url, { method: 'PATCH', json: { maxPlayers: 100 } });
  assert.match(await refused(400, url, { method: 'PATCH', json: { steam: 'not a link' } }), /Steam app ID/);
  assert.match(await refused(409, url, { method: 'PATCH', json: { steam: '7' } }), /Taken already has/);
  await refused(404, `/guilds/${GUILD}/games/9999`, { method: 'PATCH', json: {} });
  await refused(405, `/guilds/${GUILD}/games/${id}`, { method: 'PUT', json: {} });
  await refused(405, `/guilds/${GUILD}/games/${id}/members/u1`, { method: 'DELETE' });
});

test('marks who owns and wants a game, and owning ends wanting', async () => {
  const id = insertGame('Valheim', 892970);
  await mark(id, 'u1', { wants: true });
  assert.deepEqual((await gameCalled('Valheim')).wanted.map((w: { id: string }) => w.id), ['u1']);
  await mark(id, 'u1', { wants: false });
  assert.deepEqual((await gameCalled('Valheim')).wanted, []);
  await mark(id, 'u1', { wants: true });
  await mark(id, 'u1', { owns: true });
  await mark(id, 'u1', { owns: true });
  const owned = await gameCalled('Valheim');
  assert.deepEqual(owned.owners, [{ id: 'u1', name: 'Ana', steam: false }]);
  assert.deepEqual(owned.wanted, []);
  assert.match(await refused(409, `/guilds/${GUILD}/games/${id}/members/u1`, { method: 'PATCH', json: { wants: true } }), /Ana already owns Valheim/);
  await mark(id, 'u1', { owns: false });
  assert.deepEqual((await gameCalled('Valheim')).owners, []);
  assert.equal(activityText().at(-1), 'Marked Ana as not owning **Valheim**');
});

test('Steam ownership can’t be changed by hand, and only Steam games can be wanted', async () => {
  const id = insertGame('Valheim', 892970);
  const noSteam = insertGame('Tabletop');
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u3', 's3')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, playtime) VALUES ('s3', 892970, 5)`).run();
  const url = `/guilds/${GUILD}/games/${id}/members`;
  assert.match(await refused(409, `${url}/u3`, { method: 'PATCH', json: { owns: false } }), /owns it on Steam/);
  assert.match(await refused(409, `${url}/u3`, { method: 'PATCH', json: { owns: true } }), /owns it on Steam/);
  assert.equal((await gameCalled('Valheim')).owners[0].steam, true);
  assert.match(await refused(409, `/guilds/${GUILD}/games/${noSteam}/members/u1`, { method: 'PATCH', json: { wants: true } }), /needs a Steam link/);
  await refused(404, `${url}/nobody`, { method: 'PATCH', json: { owns: true } });
  await refused(400, `${url}/u1`, { method: 'PATCH', json: {} });
  await refused(400, `${url}/u1`, { method: 'PATCH', json: { owns: 'yes' } });
});

test('removing a game clears its marks, and a game in another server can’t be touched', async () => {
  const id = insertGame('Valheim', 892970);
  await mark(id, 'u1', { owns: true });
  await mark(id, 'u2', { wants: true });
  const { lastInsertRowid } = db.prepare(`INSERT INTO games (guild_id, name, added_by) VALUES ('elsewhere', 'Theirs', 'x')`).run();
  await refused(404, `/guilds/${GUILD}/games/${lastInsertRowid}`, { method: 'DELETE' });
  await refused(404, `/guilds/${GUILD}/games/${lastInsertRowid}`, { method: 'PATCH', json: { maxPlayers: 2 } });
  await refused(404, `/guilds/${GUILD}/games/${lastInsertRowid}/members/u1`, { method: 'PATCH', json: { owns: true } });

  await ok(`/guilds/${GUILD}/games/${id}`, { method: 'DELETE' });
  assert.deepEqual((await library()).games, []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM game_owners WHERE game_id = ?').get(id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM game_wants WHERE game_id = ?').get(id) as { n: number }).n, 0);
  assert.equal(activityText().at(-1), 'Removed **Valheim** from the game library');
  db.prepare(`DELETE FROM games WHERE guild_id = 'elsewhere'`).run();
});

test('the web UI sets and clears the sound managers role, but isn’t limited by it', async () => {
  const url = `/guilds/${GUILD}/settings/soundManagerRole`;
  assert.equal(await refused(400, url, { method: 'PUT', json: { value: 'nope' } }), 'Pick a role.');
  await ok(url, { method: 'PUT', json: { value: '333' } });
  assert.equal(setting(GUILD, 'soundManagerRole'), '333');
  await upload('horn');
  assert.equal((await sounds()).length, 1);
  await remove('horn');
  await ok(url, { method: 'DELETE' });
  assert.equal(setting(GUILD, 'soundManagerRole'), null);
});

function linkSteam(user: string, games: [number, string | null][]) {
  db.prepare('INSERT INTO steam_links (user_id, steam_id) VALUES (?, ?)').run(user, `steam-${user}`);
  for (const [appid, name] of games) db.prepare('INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES (?, ?, ?, 1)').run(`steam-${user}`, appid, name);
}
const owned = async () => (await ok(`/guilds/${GUILD}/games/owned`)).games as { appid: number; name: string; owners: string[] }[];

test('lists what members own, most shared first, without the library or people from other servers', async () => {
  insertGame('Already Listed', 1);
  linkSteam('u1', [[1, 'Already Listed'], [2, 'Zebra Game'], [3, 'Shared Game'], [4, 'Alpha Game']]);
  linkSteam('u2', [[3, 'Shared Game'], [5, null]]);
  linkSteam('stranger', [[6, 'Not From Here'], [3, 'Shared Game']]);
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer) VALUES (5, 'Named By Steam', 0), (3, 'Other Spelling', 0)`).run();
  assert.deepEqual(await owned(), [
    { appid: 3, name: 'Shared Game', owners: ['Ana', 'Ben'] },
    { appid: 4, name: 'Alpha Game', owners: ['Ana'] },
    { appid: 5, name: 'Named By Steam', owners: ['Ben'] },
    { appid: 2, name: 'Zebra Game', owners: ['Ana'] },
  ]);
  db.prepare('DELETE FROM app_info WHERE appid IN (3, 5)').run();
});

test('a game nobody has a name for is left off', async () => {
  linkSteam('u1', [[8, null]]);
  db.prepare('DELETE FROM app_info WHERE appid = 8').run();
  assert.deepEqual(await owned(), []);
});

test('adds a game from the owned list, once, with its app ID', async () => {
  linkSteam('u1', [[3, 'Shared Game']]);
  assert.deepEqual(await ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { appid: 3 } }), { name: 'Shared Game', added: true });
  const game = await gameCalled('Shared Game');
  assert.equal(game.appid, 3);
  assert.deepEqual(game.owners, [{ id: 'u1', name: 'Ana', steam: true }]);
  assert.deepEqual(await owned(), []);
  assert.deepEqual(activityText(), ['Added **Shared Game** to the game library']);
  assert.match(await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { appid: 3 } }), /isn’t on the list/);
});

test('picking a game already listed without Steam links it instead of adding it twice', async () => {
  insertGame('shared game');
  linkSteam('u1', [[3, 'Shared Game']]);
  assert.deepEqual(await ok(`/guilds/${GUILD}/games`, { method: 'POST', json: { appid: 3 } }), { name: 'shared game', added: false });
  const { games } = await library();
  assert.equal(games.length, 1);
  assert.equal(games[0].appid, 3);
});

test('only games on the list can be picked', async () => {
  linkSteam('stranger', [[6, 'Not From Here']]);
  for (const appid of [6, 999, 'abc', 1.5, null]) await refused(404, `/guilds/${GUILD}/games`, { method: 'POST', json: { appid } });
  assert.deepEqual((await library()).games, []);
});

test('the owned list only takes GET', async () => {
  await refused(404, `/guilds/${GUILD}/games/owned`, { method: 'DELETE' });
});

const VALVE = '76561197960287930';
const OTHER_STEAM = '76561197960287931';
const accounts = async () => (await ok(`/guilds/${GUILD}/steam-links`)) as { configured: boolean; members: { id: string; name: string; steam: { url: string; private: boolean; games: number } | null }[] };
const account = async (id: string) => (await accounts()).members.find((m) => m.id === id)!.steam;
const linkUrl = (user: string) => `/guilds/${GUILD}/steam-links/${user}`;
const linkTo = (user: string, profile: unknown) => ok(linkUrl(user), { method: 'PUT', json: { profile } });

/** Steam with a key set: `gaben` is a custom URL, one profile has two games, and any other is private */
function steamApi(t: TestContext, state = { down: false, ownedDown: false }) {
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (String(input).startsWith(base)) return real(input, init);
    if (state.down) throw new Error('offline');
    const url = new URL(input);
    if (url.pathname.includes('ResolveVanityURL')) {
      return new Response(JSON.stringify({ response: url.searchParams.get('vanityurl') === 'gaben' ? { success: 1, steamid: VALVE } : { success: 42 } }));
    }
    if (url.pathname.includes('GetOwnedGames')) {
      if (state.ownedDown) return new Response('', { status: 503 });
      const games = [{ appid: 10, name: 'Game One', playtime_forever: 1 }, { appid: 20, name: 'Game Two', playtime_forever: 2 }];
      return new Response(JSON.stringify({ response: url.searchParams.get('steamid') === VALVE ? { game_count: 2, games } : {} }));
    }
    return new Response(JSON.stringify({ response: {} }));
  });
  mock.method(console, 'error', () => {});
  return state;
}

test('lists this server’s members, linked first, without bots or other servers’ people', async (t) => {
  steamApi(t);
  linkSteam('u2', [[1, 'One'], [2, 'Two']]);
  linkSteam('stranger', [[3, 'Three']]);
  const { configured, members } = await accounts();
  assert.equal(configured, true);
  assert.deepEqual(members.map((m) => m.name), ['Ben', 'Ana', 'Cy']);
  assert.deepEqual(members[0].steam, { url: 'https://steamcommunity.com/profiles/steam-u2', private: false, games: 2 });
  assert.equal(members[1].steam, null);
});

test('links someone by profile link, custom URL name or ID, and reads their library', async (t) => {
  steamApi(t);
  assert.deepEqual(await linkTo('u1', `https://steamcommunity.com/profiles/${VALVE}/`), { games: 2 });
  assert.deepEqual(await account('u1'), { url: `https://steamcommunity.com/profiles/${VALVE}`, private: false, games: 2 });
  assert.deepEqual(await linkTo('u2', 'https://steamcommunity.com/id/gaben'), { games: 2 });
  assert.deepEqual(await linkTo('u3', 'gaben'), { games: 2 });
  assert.deepEqual(await linkTo('u3', VALVE), { games: 2 });
  assert.equal(activityText().at(-1), 'Linked Cy’s Steam account');
  for (const line of activityText()) assert.doesNotMatch(line, /7656/);
});

test('changing a link replaces the old library, and a private one says so', async (t) => {
  steamApi(t);
  await linkTo('u1', VALVE);
  assert.deepEqual(await linkTo('u1', OTHER_STEAM), { games: null });
  assert.deepEqual(await account('u1'), { url: `https://steamcommunity.com/profiles/${OTHER_STEAM}`, private: true, games: 0 });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM steam_owned').get() as { n: number }).n, 0);
});

test('unlinking forgets a library, unless someone else still has that account', async (t) => {
  steamApi(t);
  await linkTo('u1', VALVE);
  await linkTo('u2', VALVE);
  await ok(linkUrl('u1'), { method: 'DELETE' });
  assert.equal(await account('u1'), null);
  assert.equal((await account('u2'))!.games, 2);
  await ok(linkUrl('u2'), { method: 'DELETE' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM steam_owned').get() as { n: number }).n, 0);
  assert.equal(activityText().at(-1), 'Unlinked Ben’s Steam account');
  assert.match(await refused(404, linkUrl('u2'), { method: 'DELETE' }), /don’t have a linked/);
});

test('turns down a bad profile, someone not in the server and other methods', async (t) => {
  steamApi(t);
  for (const profile of ['', '   ', 5, null, 'x'.repeat(201)]) assert.match(await refused(400, linkUrl('u1'), { method: 'PUT', json: { profile } }), /Paste their/);
  assert.match(await refused(400, linkUrl('u1'), { method: 'PUT', json: { profile: 'nobody-here' } }), /Couldn’t find/);
  assert.match(await refused(400, linkUrl('u1'), { method: 'PUT', json: { profile: 'not a profile!' } }), /Couldn’t find/);
  assert.match(await refused(404, linkUrl('stranger'), { method: 'PUT', json: { profile: VALVE } }), /aren’t in this server/);
  await refused(404, linkUrl('stranger'), { method: 'DELETE' });
  await refused(405, linkUrl('u1'), { method: 'POST' });
  assert.equal(await account('u1'), null);
  assert.deepEqual(activityText(), []);
});

test('with Steam down, nothing changes', async (t) => {
  const state = steamApi(t);
  await linkTo('u1', VALVE);
  state.ownedDown = true;
  assert.match(await refused(502, linkUrl('u1'), { method: 'PUT', json: { profile: OTHER_STEAM } }), /couldn’t be reached/);
  assert.match(await refused(502, linkUrl('u2'), { method: 'PUT', json: { profile: VALVE } }), /couldn’t be reached/);
  assert.equal(await account('u2'), null);
  assert.deepEqual(await account('u1'), { url: `https://steamcommunity.com/profiles/${VALVE}`, private: false, games: 2 });
  state.ownedDown = false;
  state.down = true;
  assert.match(await refused(502, linkUrl('u3'), { method: 'PUT', json: { profile: 'gaben' } }), /couldn’t be reached/);
  assert.equal(await account('u3'), null);
});

test('without an API key, it says so instead of trying', async () => {
  const key = config.steamApiKey;
  config.steamApiKey = null;
  linkSteam('u1', [[1, 'One']]);
  assert.equal((await accounts()).configured, false);
  assert.match(await refused(409, linkUrl('u2'), { method: 'PUT', json: { profile: VALVE } }), /STEAM_API_KEY/);
  assert.match(await refused(409, linkUrl('u1'), { method: 'DELETE' }), /STEAM_API_KEY/);
  assert.match(await refused(409, `/guilds/${GUILD}/steam-refresh`, { method: 'POST' }), /STEAM_API_KEY/);
  config.steamApiKey = key;
});

test('refreshes libraries', async (t) => {
  steamApi(t);
  await linkTo('u1', VALVE);
  db.prepare('DELETE FROM steam_owned').run();
  await ok(`/guilds/${GUILD}/steam-refresh`, { method: 'POST' });
  assert.equal((await account('u1'))!.games, 2);
  assert.equal(activityText().at(-1), 'Refreshed Steam libraries');
  await refused(404, `/guilds/${GUILD}/steam-refresh`);
});

test('/steam link, list and unlink work as they did', async (t) => {
  steamApi(t);
  const run = async (sub: string, values: Record<string, unknown>) => {
    let reply: any;
    const answer = async (r: unknown) => void (reply = r);
    await steam.commands![0].run({
      inCachedGuild: () => true,
      guild,
      guildId: GUILD,
      user: { id: 'u1', toString: () => '<@u1>' },
      options: { getSubcommand: () => sub, getUser: () => null, getString: (name: string) => values[name] },
      deferReply: async () => {},
      editReply: answer,
      reply: answer,
    } as never);
    return reply;
  };
  assert.match((await run('link', { profile: 'nobody-here' })) as string, /Couldn't find/);
  assert.equal((await run('link', { profile: VALVE })).content, '🔗 Linked <@u1> (2 games).');
  assert.match((await run('link', { profile: OTHER_STEAM })).content, /Linked <@u1>, but: .*private/);
  assert.match((await run('list', {})).embeds[0].toJSON().description, new RegExp(`<@u1> · \\[profile\\]\\(https://steamcommunity.com/profiles/${OTHER_STEAM}\\) · 🔒`));
  assert.equal((await run('unlink', {})).content, 'Unlinked <@u1>.');
  assert.equal(await account('u1'), null);
  const empty = await run('list', {});
  assert.match(empty.content, /Nobody here has linked/);
  assert.equal(empty.components[0].toJSON().components[0].custom_id, 'steam:link');
});

test('the Link my Steam button opens a form that links whoever fills it in', async (t) => {
  steamApi(t);
  let modal: any;
  await steam.onButton!({ customId: 'steam:link', showModal: async (m: unknown) => void (modal = m) } as never);
  assert.equal(modal.toJSON().components[0].components[0].custom_id, 'profile');
  const submit = async (profile: string) => {
    let answer: string | undefined;
    let flags: unknown;
    await steam.onModal!({
      customId: 'steam:link',
      guildId: GUILD,
      user: { id: 'u2' },
      fields: { getTextInputValue: () => profile },
      deferReply: async (o: { flags: unknown }) => void (flags = o.flags),
      editReply: async (r: string) => void (answer = r),
    } as never);
    assert.ok(flags, 'answered privately');
    return answer!;
  };
  assert.match(await submit('nobody-here'), /Couldn’t find that Steam profile/);
  assert.equal(await submit(`  ${VALVE} `), '🔗 Linked (2 games). Picks and sale alerts count your library now.');
  assert.equal((await account('u2'))!.games, 2);
  assert.equal(activityText().at(-1), 'Linked their Steam account');
  unlinkSteam('u2');
});

const pingsUrl = `/guilds/${GUILD}/game-pings`;
const addPing = (json: unknown) => ok(pingsUrl, { method: 'POST', json });
const pingRows = () => db.prepare('SELECT role_id, guild_id, name, created FROM game_roles ORDER BY name').all() as any[];

test('makes a role for a game, and removing it deletes the role', async () => {
  assert.deepEqual(await addPing({ game: '  Valheim ' }), { warning: null });
  const [ping] = (await ok(pingsUrl)).pings;
  assert.deepEqual(ping, { id: ping.id, game: 'Valheim', role: 'Valheim', people: 0, made: true });
  assert.equal(roles.get(ping.id)!.mentionable, true);
  assert.equal(activityText().at(-1), 'Added game pings for **Valheim**');

  await ok(`${pingsUrl}/${ping.id}`, { method: 'DELETE' });
  assert.equal(roles.has(ping.id), false);
  assert.deepEqual(pingRows(), []);
  assert.equal(activityText().at(-1), 'Removed game pings for **Valheim**');
});

test('uses a role that’s picked, and leaves it in place when removed', async () => {
  const gamers = roles.get('r1')!;
  gamers.members = new Map([['u1', {}], ['u2', {}]]);
  await addPing({ game: 'Halo', roleId: 'r1' });
  assert.deepEqual((await ok(pingsUrl)).pings, [{ id: 'r1', game: 'Halo', role: 'Gamers', people: 2, made: false }]);
  await ok(`${pingsUrl}/r1`, { method: 'DELETE' });
  assert.equal(roles.has('r1'), true);
  assert.deepEqual(pingRows(), []);
  gamers.members = new Map();
});

test('only offers games and roles that can still be added', async () => {
  insertGame('Valheim');
  insertGame('Halo');
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'u1', 'Played Game', 'voice', 0, 1)`).run(GUILD);
  let data = await ok(pingsUrl);
  assert.deepEqual(data.games, ['Halo', 'Played Game', 'Valheim']);
  assert.deepEqual(data.roles, [{ id: 'r1', name: 'Gamers' }]);
  await addPing({ game: 'VALHEIM', roleId: 'r1' });
  data = await ok(pingsUrl);
  assert.deepEqual(data.games, ['Halo', 'Played Game']);
  assert.deepEqual(data.roles, []);
});

test('refuses roles the bot can’t hand out, and nothing is saved', async () => {
  for (const roleId of [GUILD, 'r2']) assert.match(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Halo', roleId } }), /^I can’t hand out /);
  assert.equal(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Halo', roleId: '333' } }), 'I can’t hand out @Mods. Pick a normal role below my role (Slopkeeper), or leave the role out and I’ll make one.');
  assert.deepEqual(pingRows(), []);
});

test('a game has one role, and a role is for one game', async () => {
  roles.set('555', role('555', 'Shooters', 1, { guild: { members: { me } } }));
  await addPing({ game: 'Halo', roleId: '555' });
  assert.equal(await refused(409, pingsUrl, { method: 'POST', json: { game: 'halo' } }), 'halo already pings @Shooters.');
  assert.equal(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Valheim', roleId: '555' } }), '@Shooters already pings for Halo.');
  assert.equal(pingRows().length, 1);
  roles.delete('555');
});

test('refuses a bad game ping', async () => {
  for (const game of ['', '   ', 'x'.repeat(101), 5, undefined]) await refused(400, pingsUrl, { method: 'POST', json: { game } });
  await refused(404, pingsUrl, { method: 'POST', json: { game: 'Halo', roleId: 'no-such-role' } });
  assert.deepEqual(pingRows(), []);
});

test('needs Manage Roles to add game pings', async () => {
  manageRoles = false;
  const sizeBefore = roles.size;
  assert.match(await refused(409, pingsUrl, { method: 'POST', json: { game: 'Halo' } }), /Manage Roles/);
  assert.equal(roles.size, sizeBefore);
});

test('says so when Discord won’t make the role', async () => {
  refuseDiscord = new Error('Missing Permissions');
  assert.match(await refused(502, pingsUrl, { method: 'POST', json: { game: 'Halo' } }), /Manage Roles/);
  assert.deepEqual(pingRows(), []);
  assert.deepEqual(activityText(), []);
});

test('warns about a role pings can’t reach', async () => {
  mentionEveryone = false;
  roles.set('556', role('556', 'Quiet', 1, { mentionable: false, guild: { members: { me } } }));
  const { warning } = await addPing({ game: 'Halo', roleId: '556' });
  assert.equal(warning, '⚠️ Pings for @Quiet won’t notify anyone yet. Turn on Allow anyone to @mention this role in Server Settings → Roles.');
  roles.delete('556');
});

test('shows a role deleted while the bot was away, and it can still be cleared', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name, created) VALUES ('gone', ?, 'Halo', 1)`).run(GUILD);
  assert.deepEqual((await ok(pingsUrl)).pings, [{ id: 'gone', game: 'Halo', role: null, people: 0, made: true }]);
  await ok(`${pingsUrl}/gone`, { method: 'DELETE' });
  assert.deepEqual(pingRows(), []);
});

test('game pings stay within their server', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name, created) VALUES ('theirs', 'other', 'Halo', 1)`).run();
  assert.deepEqual((await ok(pingsUrl)).pings, []);
  await refused(404, `${pingsUrl}/theirs`, { method: 'DELETE' });
  assert.equal(pingRows().length, 1);
  await addPing({ game: 'Halo' });
  assert.equal(pingRows().length, 2);
});

const hiddenUrl = `/guilds/${GUILD}/hidden-games`;
const hiddenNames = async () => ((await ok(hiddenUrl)).games as any[]).map((g) => g.name);

test('a game hidden or let back in changes what’s suggested', async (t) => {
  fakeSteam(t);
  const id = insertGame('Portal 2', 620);
  await mark(id, 'u1', { owns: true });
  const suggested = async () => (await candidatesFor(guild as never, ['u1']))!.candidates.map((c) => c.name);
  assert.deepEqual(await suggested(), ['Portal 2']);

  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  assert.deepEqual((await ok(hiddenUrl)).games, [{ appid: 620, name: 'Portal 2' }]);
  assert.deepEqual(await suggested(), []);
  assert.equal(activityText().at(-1), 'Hid **Portal 2** from suggestions');

  await ok(`${hiddenUrl}/620`, { method: 'DELETE' });
  assert.deepEqual(await hiddenNames(), []);
  assert.deepEqual(await suggested(), ['Portal 2']);
  assert.equal(activityText().at(-1), 'Let **Portal 2** be suggested again');
  await refused(404, `${hiddenUrl}/620`, { method: 'DELETE' });
});

test('hiding twice changes nothing', async () => {
  insertGame('Portal 2', 620);
  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  assert.deepEqual(await hiddenNames(), ['Portal 2']);
});

test('only a library game with a Steam link can be hidden', async () => {
  insertGame('Board Game');
  for (const id of ['620', '0', 'abc', 'null']) await refused(404, `${hiddenUrl}/${id}`, { method: 'PUT' });
  assert.deepEqual(await hiddenNames(), []);
});

test('hidden games stay within their server', async () => {
  db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES ('other', 'Theirs', 620, 'u1')`).run();
  db.prepare(`INSERT INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES ('other', 730, 'Also Theirs', 'u1')`).run();
  assert.deepEqual(await hiddenNames(), []);
  await refused(404, `${hiddenUrl}/620`, { method: 'PUT' });
  await refused(404, `${hiddenUrl}/730`, { method: 'DELETE' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hidden_apps').get() as { n: number }).n, 1);
});

test('letting a game back in here leaves it hidden in another server', async () => {
  insertGame('Portal 2', 620);
  await ok(`${hiddenUrl}/620`, { method: 'PUT' });
  db.prepare(`INSERT INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES ('other', 620, 'Portal 2', 'u1')`).run();
  await ok(`${hiddenUrl}/620`, { method: 'DELETE' });
  assert.deepEqual((db.prepare('SELECT guild_id FROM hidden_apps').all() as { guild_id: string }[]).map((r) => r.guild_id), ['other']);
});

const joinUrl = `/guilds/${GUILD}/join-sounds`;
const setJoin = (user: string, json: unknown) => ok(`${joinUrl}/${user}`, { method: 'PUT', json });

test('sets anyone’s join sound, and a new one replaces the old', async () => {
  await upload('horn');
  await upload('bell');
  const data = await ok(joinUrl);
  assert.deepEqual(data.members.map((m: any) => m.name), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(data.sounds.sort(), ['bell', 'horn']);

  assert.deepEqual(await setJoin('u2', { name: 'horn' }), { warning: null });
  assert.deepEqual((await ok(joinUrl)).joinSounds, [{ id: 'u2', who: 'Ben', name: 'horn' }]);
  await setJoin('u2', { name: 'bell' });
  assert.deepEqual((await ok(joinUrl)).joinSounds, [{ id: 'u2', who: 'Ben', name: 'bell' }]);
  assert.equal(activityText().at(-1), 'Set Ben’s join sound to **bell**');
});

test('refuses a join sound that doesn’t exist, or someone who isn’t here', async () => {
  await upload('horn');
  guild.members.cache.set('b1', member('b1', 'Some Bot', true)[1] as never);
  for (const name of ['nope', '', 5, undefined]) await refused(404, `${joinUrl}/u1`, { method: 'PUT', json: { name } });
  await refused(404, `${joinUrl}/nobody`, { method: 'PUT', json: { name: 'horn' } });
  await refused(404, `${joinUrl}/b1`, { method: 'PUT', json: { name: 'horn' } });
  guild.members.cache.delete('b1');
  assert.deepEqual((await ok(joinUrl)).joinSounds, []);
});

test('still sets a join sound while they’re off, and says it won’t play', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/settings/joinSounds`, { method: 'PUT', json: { value: false } });
  assert.match((await setJoin('u1', { name: 'horn' })).warning, /turned off/);
  assert.equal((await ok(joinUrl)).joinSounds.length, 1);
});

const pick = (query: string) => ok(`/guilds/${GUILD}/pick?${query}`);
const hours = (n: number) => n * 3_600_000;
const playedIn = (user: string, game: string, start: number, end: number) =>
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, '702', ?, ?)`).run(GUILD, user, game, start, end);
/** Two library games that Ana and Ben own, and one only Ana does */
async function ownedGames(t: TestContext) {
  fakeSteam(t);
  const [halo, valheim, hades] = [insertGame('Halo'), insertGame('Valheim', 892970), insertGame('Hades', 1145360)];
  for (const id of [halo, valheim, hades]) await mark(id, 'u1', { owns: true });
  for (const id of [halo, valheim]) await mark(id, 'u2', { owns: true });
  return { halo, valheim, hades };
}

test('picks from a voice channel’s people, splitting what fits from what’s one purchase away', async (t) => {
  await ownedGames(t);
  const data = await pick('channel=702');
  assert.equal(data.counted, 2);
  assert.deepEqual(data.ready.map((g: any) => g.name).sort(), ['Halo', 'Valheim']);
  assert.deepEqual(data.almost.map((g: any) => [g.name, g.missing]), [['Hades', ['Ben']]]);
  assert.equal(data.ready.find((g: any) => g.name === 'Valheim').url, 'https://store.steampowered.com/app/892970');
});

test('picks from people chosen by hand, and matches what /whatdoweplay works from', async (t) => {
  await ownedGames(t);
  const data = await pick('users=u1,u2,u1');
  const direct = await candidatesFor(guild as never, ['u1', 'u2']);
  assert.deepEqual(data.ready.map((g: any) => g.name).sort(), direct!.candidates.filter((c) => !c.missing.length).map((c) => c.name).sort());
  assert.equal(data.people, 2);
});

test('compares what each person has put into a game', async (t) => {
  await ownedGames(t);
  const now = Date.now();
  playedIn('u1', 'Halo', now - hours(5), now - hours(3));
  playedIn('u2', 'Halo', now - hours(4), now - hours(1));
  const { ready } = await pick('users=u1,u2');
  const halo = ready.find((g: any) => g.name === 'Halo');
  assert.equal(halo.playedMs, hours(5));
  assert.equal(halo.last, now - hours(1));
  assert.deepEqual(halo.players.map((p: any) => [p.name, p.playedMs]), [['Ana', hours(2)], ['Ben', hours(3)]]);
  assert.equal(ready.find((g: any) => g.name === 'Valheim').playedMs, 0);
});

test('adds Steam hours per person, and leaves out what’s hidden or too full', async (t) => {
  const { halo } = await ownedGames(t);
  await ok(`/guilds/${GUILD}/games/${halo}`, { method: 'PATCH', json: { maxPlayers: 1 } });
  await ok(`/guilds/${GUILD}/hidden-games/892970`, { method: 'PUT' });
  assert.deepEqual((await pick('users=u1,u2')).ready, []);
  assert.deepEqual((await pick('users=u1')).ready.map((g: any) => g.name).sort(), ['Hades', 'Halo']);
});

test('leaves Steam hours blank for someone with no Steam copy, rather than zero', async (t) => {
  await ownedGames(t);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime, recent) VALUES ('s1', 892970, 'Valheim', 120, 30)`).run();
  const valheim = (await pick('users=u1,u2')).ready.find((g: any) => g.name === 'Valheim');
  assert.deepEqual(valheim.players.map((p: any) => [p.name, p.steamMinutes, p.recentMinutes]), [['Ana', 120, 30], ['Ben', null, 0]]);
  assert.deepEqual([valheim.steamMinutes, valheim.recentMinutes], [120, 30]);
});

test('finds time played under another spelling of a game', async (t) => {
  await ownedGames(t);
  playedIn('u1', 'HALO', Date.now() - hours(2), Date.now() - hours(1));
  assert.equal((await pick('users=u1,u2')).ready.find((g: any) => g.name === 'Halo').playedMs, hours(1));
});

test('shows a game’s kind and who’s on a family copy', async (t) => {
  await ownedGames(t);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s1', 620, 'Portal 2', 1)`).run();
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer, coop, pvp, deck, shareable) VALUES (620, 'Portal 2', 1, 1, 0, 3, 1)`).run();
  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'PUT', json: { with: 'u3' } });
  await ok(`/guilds/${GUILD}/steam-links/u1/family`, { method: 'PUT', json: { with: 'u3' } });
  await ok(`/guilds/${GUILD}/steam-links/u1/family`, { method: 'DELETE' });
  assert.equal((await pick('users=u1,u2')).almost.find((g: any) => g.name === 'Portal 2').missing[0], 'Ben');
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u3', 's3')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s3', 620, 'Portal 2', 1)`).run();
  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'DELETE' });
  await refused(404, `/guilds/${GUILD}/steam-links/u2/family`, { method: 'DELETE' });
  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'PUT', json: { with: 'u3' } });
  const game = (await pick('users=u1,u2')).ready.find((g: any) => g.name === 'Portal 2');
  assert.deepEqual([game.borrowed, game.coop, game.pvp, game.deck], [['Ben'], true, false, 3]);
});

test('shows families on Steam accounts, and on the game list', async (t) => {
  fakeSteam(t);
  insertGame('Portal 2', 620);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  db.prepare(`INSERT INTO steam_owned (steam_id, appid, name, playtime) VALUES ('s1', 620, 'Portal 2', 1)`).run();
  db.prepare(`INSERT OR REPLACE INTO app_info (appid, name, multiplayer, shareable) VALUES (620, 'Portal 2', 1, 1)`).run();
  await mark(insertGame('Linked Ben'), 'u2', { owns: true });
  const before = (await ok(`/guilds/${GUILD}/games`)).games.find((g: any) => g.name === 'Portal 2');
  assert.deepEqual([before.family, before.needs.map((p: any) => p.name)], [[], ['Ben']]);

  await ok(`/guilds/${GUILD}/steam-links/u2/family`, { method: 'PUT', json: { with: 'u1' } });
  const after = (await ok(`/guilds/${GUILD}/games`)).games.find((g: any) => g.name === 'Portal 2');
  assert.deepEqual([after.family.map((p: any) => p.name), after.needs], [['Ben'], []]);
  const { members } = await ok(`/guilds/${GUILD}/steam-links`);
  assert.deepEqual(members.find((m: any) => m.name === 'Ana').family, ['Ben']);
  assert.deepEqual(members.find((m: any) => m.name === 'Cy').family, []);
  assert.deepEqual(activityText().at(-1), 'Put Ben in a Steam family with Ana');
});

test('refuses a family with someone who isn’t here, a bot, or themselves', async () => {
  const url = `/guilds/${GUILD}/steam-links/u1/family`;
  await refused(404, url, { method: 'PUT', json: { with: 'nobody' } });
  await refused(404, url, { method: 'PUT', json: {} });
  await refused(404, url, { method: 'PUT', json: { with: 'b1' } });
  await refused(404, `/guilds/${GUILD}/steam-links/nobody/family`, { method: 'PUT', json: { with: 'u1' } });
  assert.equal(await refused(400, url, { method: 'PUT', json: { with: 'u1' } }), 'Pick two different people.');
  await refused(405, url, { method: 'POST', json: { with: 'u2' } });
});

test('tells the page what text to speech offers', async () => {
  const url = config.voiceUrl;
  assert.equal((await ok(`/guilds/${GUILD}/say`)).on, false, 'no voice container set up');
  config.voiceUrl = 'http://voice.test';
  try {
    const data = await ok(`/guilds/${GUILD}/say`);
    assert.deepEqual(data.voices.map((v: { name: string }) => v.name), [
      ...['GLaDOS', 'HAL 9000', 'Bender', 'Optimus Prime', 'Kronk', 'TikTok', 'State broadcast', 'Russian', 'Spanish', 'German'],
      ...['Demon', 'Helium', 'Giant', 'Robot', 'Alien', 'Walkie-talkie', 'Phone call', 'Megaphone', 'Stadium PA', 'Newsreel'],
      ...['Cathedral', 'Underwater', 'Ghost', 'Trailer narrator'],
    ]);
    assert.deepEqual(Object.keys(data.voices[0]), ['id', 'name', 'group']);
    const group = (id: string) => data.voices.find((v: { id: string }) => v.id === id).group;
    assert.deepEqual([group('glados'), group('russian'), group('demon')], ['Characters', 'Accents', 'Effects']);
    assert.deepEqual([data.on, data.voice, data.volume, data.longest], [true, 'tiktok', 100, 200]);
    setSetting(GUILD, 'tts', false);
    assert.equal((await ok(`/guilds/${GUILD}/say`)).on, false);
  } finally {
    config.voiceUrl = url;
    setSetting(GUILD, 'tts', undefined);
  }
});

test('previews a voice for the browser only, a few at a time', async (t) => {
  const url = config.voiceUrl;
  t.after(() => {
    config.voiceUrl = url;
    setSetting(GUILD, 'tts', undefined);
  });
  const preview = `/guilds/${GUILD}/say/preview?voice=demon&text=${encodeURIComponent('hello there')}`;
  assert.equal(await refused(409, preview), 'Text to speech is off for this server.', 'no voice container set up');
  config.voiceUrl = 'http://voice.test';
  const real = fetch;
  const asked: { text: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (target: URL | string, init?: RequestInit) => {
    if (String(target).startsWith(base)) return real(target, init);
    asked.push(JSON.parse(init!.body as string));
    return new Response(wav(0.3));
  });
  const res = await call(preview);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4)), 'RIFF');
  assert.equal(asked[0].text, 'hello there');
  assert.equal(await refused(429, preview), 'Wait a moment before the next preview.');
  assert.deepEqual(recentActivity(GUILD, 50).filter((r) => /preview/i.test(r.action)), [], 'it isn’t said in voice, so it isn’t logged');
  setSetting(GUILD, 'tts', false);
  assert.equal(await refused(409, preview), 'Text to speech is off for this server.');
});

test('answers for someone to a game night from the web, and redraws the card', async () => {
  const id = addNight();
  const answer = (json: unknown) => ok(`/guilds/${GUILD}/game-nights/${id}/rsvp`, { method: 'POST', json });
  const edits = panelEdits.length;
  const { night } = await answer({ answer: 'in', userId: 'u2' });
  assert.equal(panelEdits.length, edits + 1, 'the card is redrawn');
  assert.deepEqual([night.id, night.in], [id, ['Ana', 'Ben']]);
  assert.deepEqual((await answer({ answer: 'out', userId: 'u2' })).night.out.includes('Ben'), true);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Answered **Can’t** for Ben to **Halo** night');
  assert.equal(await refused(409, `/guilds/${GUILD}/game-nights/${id}/rsvp`, { method: 'POST', json: { answer: 'sure', userId: 'u2' } }), 'Answer in, maybe or out.');
  await refused(404, `/guilds/${GUILD}/game-nights/${id}/rsvp`, { method: 'POST', json: { answer: 'in', userId: 'nobody' } });
  await refused(404, `/guilds/${GUILD}/game-nights/99999/rsvp`, { method: 'POST', json: { answer: 'in', userId: 'u2' } });
  const cancelled = addNight({ cancelled: 1 });
  assert.equal(await refused(409, `/guilds/${GUILD}/game-nights/${cancelled}/rsvp`, { method: 'POST', json: { answer: 'in', userId: 'u2' } }), 'This game night was cancelled.');
});

test('the page’s limits on text to speech', async () => {
  const url = config.voiceUrl;
  config.voiceUrl = 'http://voice.test';
  const post = (json: unknown) => refused(400, `/guilds/${GUILD}/say`, { method: 'POST', json });
  try {
    assert.equal(await post({ channelId: '702', text: 5 }), 'Type something to say.');
    assert.equal(await post({ channelId: 'v1', text: 'hello' }), 'Nobody’s in voice any more.');
    assert.equal(await post({ channelId: '702', text: 'x'.repeat(201) }), 'That’s 201 characters, and the limit here is 200.');
    assert.equal(await post({ channelId: '702', text: '🎉' }), 'There’s nothing in that to read out.');
    assert.equal(await post({ channelId: '702', text: 'hello', voice: 'nope' }), 'Pick a voice from the list.');
  } finally {
    config.voiceUrl = url;
  }
});

test('the page’s lines go through the voice container and show as coming from the web', async (t) => {
  const url = config.voiceUrl;
  config.voiceUrl = 'http://voice.test';
  t.after(() => void (config.voiceUrl = url));
  const real = fetch;
  let asked: unknown;
  t.mock.method(globalThis, 'fetch', async (target: URL | string, init?: RequestInit) => {
    if (String(target).startsWith(base)) return real(target, init);
    asked = JSON.parse(init!.body as string);
    return new Response('not audio', { status: 500 });
  });
  t.mock.method(console, 'error', () => {});
  await refused(400, `/guilds/${GUILD}/say`, { method: 'POST', json: { channelId: '702', text: 'hello <@123>', voice: 'alien' } });
  assert.deepEqual(asked, { text: 'hello someone', speaker_id: 0, length_scale: lengthFor(85) });
});

test('the page saves lines and removes them', async () => {
  const start = (await ok(`/guilds/${GUILD}/say`)).phrases as unknown[];
  assert.deepEqual(start, []);
  const { phrases } = (await ok(`/guilds/${GUILD}/phrases`, { method: 'POST', json: { text: 'good game' } })) as { phrases: { id: number; text: string }[] };
  assert.deepEqual(phrases, [{ id: phrases[0].id, text: 'good game' }]);
  assert.deepEqual((await ok(`/guilds/${GUILD}/say`)).phrases, phrases);
  assert.equal(await refused(400, `/guilds/${GUILD}/phrases`, { method: 'POST', json: { text: 5 } }), 'Type something to save.');
  assert.deepEqual(((await ok(`/guilds/${GUILD}/phrases/${phrases[0].id}`, { method: 'DELETE' })) as { phrases: unknown[] }).phrases, []);
  assert.equal(await refused(404, `/guilds/${GUILD}/phrases/${phrases[0].id}`, { method: 'DELETE' }), 'That saved line is gone.');
  const log = recentActivity(GUILD, 5).map((r) => r.action);
  assert.ok(log.includes('Saved the line “good game”') && log.includes('Removed the saved line “good game”'));
});

test('says how each person is getting on with a game’s achievements', async (t) => {
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    if (String(url).startsWith(base)) return real(url, init);
    const path = new URL(url).pathname;
    if (path.includes('GetSchemaForGame')) return new Response(JSON.stringify({ game: { availableGameStats: { achievements: [{ name: 'A', displayName: 'First', hidden: 0 }, { name: 'B', displayName: 'Second', hidden: 0 }] } } }));
    if (path.includes('GetGlobal')) return new Response(JSON.stringify({ achievementpercentages: { achievements: [] } }));
    return new Response(JSON.stringify({ playerstats: { achievements: [{ apiname: 'A', achieved: 1 }, { apiname: 'B', achieved: 0 }] } }));
  });
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  const data = await ok(`/guilds/${GUILD}/achievements?appid=620&users=u1,u2`);
  assert.deepEqual(data, { total: 2, goals: [{ name: 'Second', description: null, percent: null }], people: [{ name: 'Ana', done: 1 }], skipped: ['Ben'] });
  await refused(400, `/guilds/${GUILD}/achievements?appid=abc&users=u1`);
  await refused(400, `/guilds/${GUILD}/achievements?appid=620`);
  await refused(404, `/guilds/${GUILD}/achievements?appid=620&users=nobody`);
  await refused(404, `/guilds/${GUILD}/achievements?appid=620&users=b1`);
});

test('a comparison lists the Steam games two people share', async (t) => {
  await ownedGames(t);
  const { steamGames, shared } = await ok(`/guilds/${GUILD}/compare?a=u1&b=u2`);
  assert.deepEqual(steamGames, [{ name: 'Valheim', appid: 892970 }]);
  assert.deepEqual(shared.toSorted(), ['Halo', 'Valheim']);
});

test('tells a game night who still needs to add who on Steam', async (t) => {
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response(JSON.stringify({ friendslist: { friends: [] } }))));
  const night = addNight();
  db.prepare(`INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, 'u3', 'in'), (?, 'nobody', 'in')`).run(night, night);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1'), ('u3', 's3'), ('u2', 's2')`).run();
  const friends = await ok(`/guilds/${GUILD}/game-nights/${night}/friends`);
  assert.deepEqual(friends.strangers, [[{ name: 'Ana', url: 'https://steamcommunity.com/profiles/s1' }, { name: 'Cy', url: 'https://steamcommunity.com/profiles/s3' }]]);
  assert.equal(friends.unknown.length, 0);
  assert.equal(friends.unlinked.length, 1);
  await refused(404, `/guilds/${GUILD}/game-nights/99999/friends`);
  const elsewhere = addNight({ guild: 'other-guild' });
  await refused(404, `/guilds/${GUILD}/game-nights/${elsewhere}/friends`);
});

test('a friends check says when Steam isn’t set up', async () => {
  const key = config.steamApiKey;
  config.steamApiKey = null;
  const refusal = await refused(409, `/guilds/${GUILD}/game-nights/${addNight()}/friends`);
  config.steamApiKey = key;
  assert.match(refusal, /STEAM_API_KEY/);
});

test('lists joinable lobbies by name, and has none without Steam', async (t) => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/lobbies`), { lobbies: [] });
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1')`).run();
  const real = fetch;
  const fake = t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) =>
    String(url).startsWith(base) ? real(url, init) : new Response(JSON.stringify({ response: { players: [{ steamid: 's1', gameid: '10', gameextrainfo: 'Valheim', lobbysteamid: '999' }] } })),
  );
  assert.deepEqual(await ok(`/guilds/${GUILD}/lobbies`), { lobbies: [{ name: 'Ana', game: 'Valheim', join: 'steam://joinlobby/10/999/s1' }] });
  fake.mock.mockImplementation(async (url: URL | string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response('', { status: 503 })));
  const quiet = t.mock.method(console, 'error', () => {});
  assert.match(await refused(502, `/guilds/${GUILD}/lobbies`), /Steam couldn’t be reached/);
  assert.equal(quiet.mock.callCount(), 1);
});

test('says how many are playing a game on Steam, and refuses nonsense', async (t) => {
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response(JSON.stringify({ response: { player_count: 42 } }))));
  assert.deepEqual(await ok(`/guilds/${GUILD}/steam-apps/620`), { players: 42, patch: null });
  await refused(404, `/guilds/${GUILD}/steam-apps/abc`);
});

test('bots can’t be picked, compared or given pings', async (t) => {
  await ownedGames(t);
  await refused(404, `/guilds/${GUILD}/pick?users=u1,b1`);
  await refused(404, `/guilds/${GUILD}/compare?a=u1&b=b1`);
  await refused(404, `/guilds/${GUILD}/members/b1/pings`);
});

test('says who isn’t counted, by name', async (t) => {
  await ownedGames(t);
  guild.members.cache.set('777', member('777', 'Numeric Ned')[1] as never);
  const { notes, people, counted } = await pick('users=u1,777');
  guild.members.cache.delete('777');
  assert.deepEqual(notes, ['Not counted (no Steam linked): Numeric Ned']);
  assert.deepEqual([people, counted], [2, 1]);
});

test('says so when nobody picked can be counted', async (t) => {
  fakeSteam(t);
  const data = await pick('users=u3');
  assert.deepEqual([data.counted, data.ready], [0, []]);
  assert.match(data.notes[0], /Nobody here has linked Steam/);
  assert.doesNotMatch(data.notes[0], /`/);
});

test('refuses a pick with nobody to pick for', async () => {
  await refused(400, `/guilds/${GUILD}/pick`);
  await refused(400, `/guilds/${GUILD}/pick?users=`);
  await refused(404, `/guilds/${GUILD}/pick?users=u1,nobody`);
  await refused(400, `/guilds/${GUILD}/pick?channel=703`);
  await refused(400, `/guilds/${GUILD}/pick?channel=c2`);
});

test('offers the people and channels to choose from', async () => {
  setSetting(GUILD, 'announceChannel', '111');
  const data = await ok(`/guilds/${GUILD}/pick/options`);
  assert.deepEqual(data.members.map((m: any) => m.name), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(data.voice.map((c: any) => c.name), ['Gaming', 'General']);
  assert.deepEqual(data.channels.map((c: any) => c.id), ['111', 'c2']);
  assert.equal(data.announceChannel, '111');
});

const startVote = (json: unknown) => ok(`/guilds/${GUILD}/votes`, { method: 'POST', json });
const voteRows = () => db.prepare('SELECT * FROM game_votes').all() as any[];

test('posts a vote in the channel picked, for the people in the voice channel', async (t) => {
  await ownedGames(t);
  await startVote({ voiceChannelId: '702', channelId: '111', minutes: 3 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111');
  assert.match(sent[0].message.embeds[0].toJSON().description, /Everyone in <#702> gets one vote/);
  const [vote] = voteRows();
  assert.deepEqual([vote.channel_id, vote.voice_channel_id, vote.message_id], ['111', '702', 'posted-1']);
  assert.ok(Math.abs(vote.closes_at - Date.now() - 180_000) < 5000);
  assert.deepEqual(JSON.parse(vote.options).map((o: any) => o.name).sort(), ['Halo', 'Valheim']);
  assert.equal(activityText().at(-1), 'Started a game vote for <#702> in <#111>');
});

test('a vote from the web offers only the games it names, if they still fit everyone', async (t) => {
  await ownedGames(t);
  await startVote({ voiceChannelId: '702', channelId: '111', games: ['Valheim', 'Halo', 'Not a game'] });
  assert.deepEqual(JSON.parse(voteRows()[0].options).map((o: any) => o.name).sort(), ['Halo', 'Valheim']);
  db.exec('DELETE FROM game_votes');
  const refusal = await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111', games: ['Halo'] } });
  assert.equal(refusal, 'Halo is the only game that fits, so there’s nothing to vote on.');
  assert.equal(await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111', games: 'Halo' } }), 'games has to be a list of up to 2000 game names.');
});

test('a vote runs one at a time per voice channel', async (t) => {
  await ownedGames(t);
  await startVote({ voiceChannelId: '702', channelId: '111' });
  assert.equal(await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111' } }), 'There’s already a vote going in #Gaming.');
  assert.equal(voteRows().length, 1);
});

test('won’t start a vote with nothing to vote on', async (t) => {
  fakeSteam(t);
  await mark(insertGame('Halo'), 'u1', { owns: true });
  const refusal = await refused(400, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '701', channelId: '111' } });
  assert.equal(refusal, 'Halo is the only game that fits, so there’s nothing to vote on.');
  assert.deepEqual(voteRows(), []);
  assert.equal(sent.length, 0);
});

test('refuses a bad vote', async () => {
  const url = `/guilds/${GUILD}/votes`;
  for (const minutes of [0, 11, 1.5, 'two']) assert.equal(await refused(400, url, { method: 'POST', json: { voiceChannelId: '702', channelId: '111', minutes } }), 'A vote lasts from 1 to 10 minutes.');
  await refused(400, url, { method: 'POST', json: { voiceChannelId: 'c2', channelId: '111' } });
  await refused(400, url, { method: 'POST', json: { voiceChannelId: '703', channelId: '111' } });
  permitted = [];
  assert.match(await refused(400, url, { method: 'POST', json: { voiceChannelId: '702', channelId: '111' } }), /^I can’t post in #first/);
});

test('a vote that can’t be posted doesn’t block the next one', async (t) => {
  await ownedGames(t);
  failSend = true;
  await refused(502, `/guilds/${GUILD}/votes`, { method: 'POST', json: { voiceChannelId: '702', channelId: '111' } });
  assert.deepEqual(voteRows(), []);
  failSend = false;
  await startVote({ voiceChannelId: '702', channelId: '111' });
  assert.equal(voteRows().length, 1);
});

const compared = (a: string, b: string) => `/guilds/${GUILD}/compare?a=${a}&b=${b}`;

test('compares two people', async (t) => {
  await ownedGames(t);
  const now = Date.now();
  playedIn('u1', 'Halo', now - hours(5), now - hours(2));
  playedIn('u2', 'Halo', now - hours(4), now - hours(1));
  playedIn('u2', 'Solo Game', now - hours(9), now - hours(8));
  const session = Number(db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', 0, 9000)`).run(GUILD).lastInsertRowid);
  for (const [user, seconds] of [['u1', 3600], ['u2', 7200]] as const) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, ?)').run(session, user, seconds);

  const data = await ok(compared('u1', 'u2'));
  assert.deepEqual(data.people.map((p: any) => [p.name, p.ms]), [['Ana', hours(3)], ['Ben', hours(4)]]);
  assert.equal(data.togetherMs, hours(2));
  assert.deepEqual(data.games, [{ name: 'Halo', ms: hours(2) }]);
  assert.deepEqual(data.voice, { sessions: 1, ms: hours(1) });
  assert.deepEqual([...data.shared].sort(), ['Halo', 'Valheim']);
});

test('lists everything two people both own, past what Discord can fit', async (t) => {
  fakeSteam(t);
  for (let n = 0; n < 20; n++) {
    const id = insertGame(`Game ${n}`);
    await mark(id, 'u1', { owns: true });
    await mark(id, 'u2', { owns: true });
  }
  assert.equal((await ok(compared('u1', 'u2'))).shared.length, 20);
});

test('refuses to compare anyone but two people here', async () => {
  await refused(400, compared('u1', 'u1'));
  await refused(404, compared('u1', 'nobody'));
  await refused(404, `/guilds/${GUILD}/compare?a=u1`);
});

test('shows a month’s recap as plain text', async () => {
  guild.members.cache.set('777', member('777', 'Numeric Ned')[1] as never);
  guild.members.cache.set('778', member('778', 'Numeric Nia')[1] as never);
  const now = Date.now();
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, '777', 'Halo', '702', ?, ?)`).run(GUILD, now - 60_000, now);
  const session = Number(db.prepare(`INSERT INTO sessions (guild_id, channel_id, started_at, ended_at) VALUES (?, '702', ?, ?)`).run(GUILD, now - 60_000, now).lastInsertRowid);
  for (const user of ['777', '778']) db.prepare('INSERT INTO session_members (session_id, user_id, seconds) VALUES (?, ?, 60)').run(session, user);

  const { recap } = await ok(`/guilds/${GUILD}/recap?month=this`);
  guild.members.cache.delete('777');
  guild.members.cache.delete('778');
  assert.match(recap.title, /recap$/);
  const text = JSON.stringify(recap);
  assert.match(text, /Numeric Ned/);
  assert.match(recap.fields.find((f: any) => f.name === 'Longest session').value, /on \w+ \d+, \d{4} with Numeric/);
  assert.doesNotMatch(text, /<@|<t:|\*\*/);
});

test('says when there’s no recap, and refuses a month it doesn’t know', async () => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/recap`), { recap: null });
  await refused(400, `/guilds/${GUILD}/recap?month=march`);
});

test('adds sessions, rank and last played to the stats', async () => {
  const now = Date.now();
  playedIn('u1', 'Halo', now - hours(5), now - hours(4));
  playedIn('u1', 'Halo', now - hours(3), now - hours(2));
  playedIn('u2', 'Halo', now - hours(9), now - hours(1));
  const both = await ok(`/guilds/${GUILD}/stats?period=all&user=u1&game=Halo`);
  assert.deepEqual(both.place, { rank: 2, of: 2, sessions: 2 });
  assert.equal(both.games[0].last, now - hours(2));
  const one = await ok(`/guilds/${GUILD}/stats?period=all&game=Halo`);
  assert.equal(one.place, null);
  assert.equal(one.players[0].last, now - hours(1));
  assert.equal((await ok(`/guilds/${GUILD}/stats?period=all&user=u3&game=Halo`)).place, null);
});

const pings = (user: string) => `/guilds/${GUILD}/members/${user}/pings`;
const setPing = (user: string, json: unknown) => ok(pings(user), { method: 'PUT', json });

test('shows and changes anyone’s pings', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('333', ?, 'Halo')`).run(GUILD);
  heldRoles.add('u2:333');
  assert.deepEqual((await ok(pings('u2'))).pings, [{ id: 'r1', label: 'Hop-on pings', on: false }, { id: '333', label: 'Halo', on: true }]);
  await setPing('u2', { roleId: 'r1', on: true });
  await setPing('u2', { roleId: '333', on: false });
  assert.deepEqual((await ok(pings('u2'))).pings.map((p: any) => p.on), [true, false]);
  assert.deepEqual([...heldRoles], ['u2:r1']);
  assert.deepEqual(activityText().slice(-2), ['Turned Hop-on pings on for Ben', 'Turned Halo off for Ben']);
});

test('only hop-on and game roles can be changed', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  for (const roleId of ['333', 'r2', GUILD, undefined]) await refused(400, pings('u1'), { method: 'PUT', json: { roleId, on: true } });
  await refused(400, pings('u1'), { method: 'PUT', json: { roleId: 'r1', on: 'yes' } });
  assert.deepEqual([...heldRoles], []);
});

test('doesn’t offer a role from another server, or one that’s gone', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('r1', 'other', 'Halo'), ('gone', ?, 'Valheim')`).run(GUILD);
  assert.deepEqual((await ok(pings('u1'))).pings, []);
});

test('lists a role used for hop-ons and a game once', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('r1', ?, 'Halo')`).run(GUILD);
  assert.deepEqual((await ok(pings('u1'))).pings.map((p: any) => p.label), ['Hop-on pings']);
});

test('says so when the bot can’t change someone’s roles', async () => {
  setSetting(GUILD, 'hopOnRole', 'r1');
  failRoles = true;
  assert.match(await refused(409, pings('u1'), { method: 'PUT', json: { roleId: 'r1', on: true } }), /Manage Roles and has to be above @Gamers/);
  assert.deepEqual(activityText().filter((a) => a.startsWith('Turned')), []);
});

test('pings are only for people here', async () => {
  await refused(404, pings('nobody'));
  await refused(405, pings('u1'), { method: 'DELETE' });
});

test('posts a soundboard panel and keeps track of it', async () => {
  await upload('horn');
  db.exec('DELETE FROM sound_panels');
  await ok(`/guilds/${GUILD}/sound-panels`, { method: 'POST', json: { channelId: '111' } });
  assert.equal(sent[0].channelId, '111');
  assert.ok(sent[0].message.components.length > 0);
  assert.deepEqual(db.prepare('SELECT message_id, guild_id, channel_id FROM sound_panels').all().map((r) => ({ ...r })), [{ message_id: 'posted-1', guild_id: GUILD, channel_id: '111' }]);
  assert.equal(activityText().at(-1), 'Posted a soundboard panel in <#111>');
});

test('posts the Choose games button', async () => {
  await ok(`/guilds/${GUILD}/game-pings/menu`, { method: 'POST', json: { channelId: 'c2' } });
  assert.equal(sent[0].channelId, 'c2');
  assert.equal(sent[0].message.components[0].toJSON().components[0].custom_id, 'gr:open');
  assert.equal(activityText().at(-1), 'Posted the game pings button in <#c2>');
});

test('won’t post in a channel it can’t, or say it did when Discord refused', async () => {
  for (const url of [`/guilds/${GUILD}/sound-panels`, `/guilds/${GUILD}/game-pings/menu`]) {
    await refused(400, url, { method: 'POST', json: { channelId: 'nope' } });
    await refused(400, url, { method: 'POST', json: {} });
    permitted = [];
    assert.match(await refused(400, url, { method: 'POST', json: { channelId: '111' } }), /^I can’t post in #first/);
    permitted = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    failSend = true;
    await refused(502, url, { method: 'POST', json: { channelId: '111' } });
    failSend = false;
  }
  assert.deepEqual(activityText(), []);
});

test('hides a Steam game outside the library, by the name it’s given', async () => {
  await ok(`${hiddenUrl}/620`, { method: 'PUT', json: { name: 'Portal 2' } });
  assert.deepEqual(await hiddenNames(), ['Portal 2']);
  await refused(404, `${hiddenUrl}/730`, { method: 'PUT', json: { name: 'x'.repeat(101) } });
  await refused(404, `${hiddenUrl}/730`, { method: 'PUT', json: { name: 5 } });
  await refused(404, `${hiddenUrl}/abc`, { method: 'PUT', json: { name: 'Portal 2' } });
});

test('the music queue can be filled, reordered and emptied from the page', async () => {
  const track = (n: number) => ({ uri: `spotify:track:${String(n).padStart(22, 'a')}`, title: `Song ${n}`, artist: 'Band', album: 'Album', cover: 'https://evil.example/x.png', durationMs: 180_000 });
  let music = await ok(`/guilds/${GUILD}/music`);
  assert.deepEqual(music.queue, []);
  assert.equal(music.phase, 'stopped');
  assert.match(music.problem, /MUSIC_URL/);
  assert.equal(music.volume, 40);
  for (const n of [1, 2, 3]) music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(n) } });
  music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: track(4), next: true } });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['Song 4', 'Song 1', 'Song 2', 'Song 3']);
  assert.equal(music.queue[0].addedBy, 'Web UI');
  assert.equal(music.queue[0].cover, null, 'only Spotify’s covers are kept');
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Added **Song 4** to the music queue to play next');

  music = await ok(`/guilds/${GUILD}/music/queue/${music.queue[3].id}/move`, { method: 'POST', json: { to: 0 } });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['Song 3', 'Song 4', 'Song 1', 'Song 2']);
  music = await ok(`/guilds/${GUILD}/music/queue/${music.queue[1].id}`, { method: 'DELETE' });
  assert.deepEqual(music.queue.map((r: any) => r.title), ['Song 3', 'Song 1', 'Song 2']);
  assert.equal((await call(`/guilds/${GUILD}/music/queue/99999`, { method: 'DELETE' })).status, 404);
  assert.equal((await call(`/guilds/${GUILD}/music/queue/${music.queue[0].id}/move`, { method: 'POST', json: { to: 'top' } })).status, 400);
  music = await ok(`/guilds/${GUILD}/music/queue/shuffle`, { method: 'POST' });
  assert.deepEqual(music.queue.map((r: any) => r.title).sort(), ['Song 1', 'Song 2', 'Song 3']);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Shuffled the music queue');

  const bad = await call(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track: { ...track(5), uri: 'spotify:album:aaaaaaaaaaaaaaaaaaaaaa' } } });
  assert.equal(bad.status, 400);
  const search = await call(`/guilds/${GUILD}/music/search?q=hello`);
  assert.equal(search.status, 502);
  assert.match(((await search.json()) as any).error, /SPOTIFY_CLIENT_ID/);
  assert.match((await ok(`/guilds/${GUILD}/music/playlists`)).problem, /SPOTIFY_REFRESH_TOKEN/);
  const play = await call(`/guilds/${GUILD}/music/play`, { method: 'POST', json: { channelId: 'v1' } });
  assert.equal(play.status, 400);

  music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
  assert.deepEqual(music.queue, []);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Cleared the music queue');
  assert.equal((await call(`/guilds/${GUILD}/music/queue/shuffle`, { method: 'POST' })).status, 409, 'nothing to shuffle');
});

test('the page lists the Spotify account’s own playlists, and can shuffle one into the queue', async (t) => {
  Object.assign(config, { spotifyClientId: 'id', spotifyClientSecret: 'secret', spotifyRefreshToken: 'refresh' });
  t.after(() => {
    Object.assign(config, { spotifyClientId: null, spotifyClientSecret: null, spotifyRefreshToken: null });
    resetSpotify();
  });
  const LIST = 'pppppppppppppppppppppp';
  const songs = Array.from({ length: 150 }, (_, n) => ({ uri: `spotify:track:${String(n).padStart(22, 'b')}`, name: `Tune ${n}`, duration_ms: 1000, artists: [{ name: 'Band' }], album: { name: 'A', images: [] } }));
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === 'accounts.spotify.com') return Response.json({ access_token: 'x', expires_in: 3600 });
    if (url.host !== 'api.spotify.com') return realFetch(input, init);
    if (url.pathname === '/v1/me') return Response.json({ id: 'me' });
    if (url.pathname === '/v1/me/playlists') return Response.json({ items: [{ id: LIST, name: 'Road Trip', owner: { id: 'me' }, images: [], items: { total: 150 } }], next: null });
    if (url.pathname === `/v1/playlists/${LIST}`) return Response.json({ name: 'Road Trip' });
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return Response.json({ items: songs.slice(offset, offset + 100).map((item) => ({ item })), next: offset ? null : `https://api.spotify.com/v1/playlists/${LIST}/items?offset=100` });
  });
  assert.deepEqual(await ok(`/guilds/${GUILD}/music/playlists`), { playlists: [{ id: LIST, name: 'Road Trip', cover: null, songs: 150 }], problem: null });
  const music = await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { query: `spotify:playlist:${LIST}`, shuffle: true } });
  assert.equal(music.message, 'Added 100 random songs from Road Trip.');
  assert.ok(music.queue.some((r: any) => Number(r.title.slice(5)) >= 100), 'from all of it, not just the first 100');
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' });
});

test('looping speech that can’t be made is warned about when it’s set', async () => {
  const { warning } = await ok(`/guilds/${GUILD}/settings/loopText`, { method: 'PUT', json: { value: 'stay a while' } });
  assert.match(warning, /Text to speech/);
  assert.equal(setting(GUILD, 'loopText'), 'stay a while');
  assert.match(await refused(400, `/guilds/${GUILD}/settings/loopText`, { method: 'PUT', json: { value: '   ' } }), /Type something/);
});
