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
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { logActivity } from '../src/activity.ts';
import { Mixer } from '../src/mixer.ts';
import { noteGame } from '../src/gameNames.ts';
import { activity, stats } from '../src/features/gamestats.ts';
import { levelLibrary, setJoinSound, soundboard, soundGain } from '../src/features/soundboard.ts';
import { setting, setSetting } from '../src/settings.ts';

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
  toString: () => `<#${id}>`,
});
const role = (id: string, name: string, position: number, extra = {}) => ({ id, name, position, managed: false, mentionable: true, guild: null as unknown, toString: () => `<@&${id}>`, ...extra });

const roles = new Map([
  [GUILD, role(GUILD, '@everyone', 0)],
  ['r1', role('r1', 'Gamers', 1)],
  ['r2', role('r2', 'Bot role', 2, { managed: true })],
  ['333', role('333', 'Mods', 5)],
]);
const me = { permissions: { has: () => true }, roles: { highest: { name: 'Slopkeeper', position: 3 } } };
for (const r of roles.values()) r.guild = { members: { me } };

const guild = {
  id: GUILD,
  name: 'Test server',
  client: { user: { id: 'the-bot' } },
  afkChannelId: '704',
  voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  iconURL: () => null,
  premiumTier: 0,
  members: { me, cache: new Map([member('u1', 'Ana'), member('u2', 'Ben'), member('u3', 'Cy')]) },
  scheduledEvents: {
    create: async (event: unknown) => {
      createdEvents.push(event);
      return { id: `new-event-${createdEvents.length}` };
    },
    delete: async (id: string) => void deletedEvents.push(id),
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
  roles: { cache: roles },
  emojis: {
    cache: new Collection([['123456789012345678', { id: '123456789012345678', name: 'slop', animated: false, toString: () => '<:slop:123456789012345678>' }]]),
    fetch: async (id: string) => {
      if (id !== '123456789012345678') throw new Error('Unknown Emoji');
      return { id };
    },
  },
  soundboardSounds: {
    fetch: async () => new Map([...discordSounds].map(([id, sound]) => [id, { ...sound, url: `https://cdn.test/${id}` }])),
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
  panelEdits = [];
  sent = [];
  deletedEvents = [];
  createdEvents = [];
  failSend = false;
  permitted = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  db.exec(`DELETE FROM sound_emoji; DELETE FROM discord_sounds; DELETE FROM sound_plays; DELETE FROM guild_settings; DELETE FROM sound_panels;
    DELETE FROM sound_favourites; DELETE FROM game_nights; DELETE FROM game_night_series; DELETE FROM game_plays; DELETE FROM session_members; DELETE FROM sessions;
    DELETE FROM sound_levels; DELETE FROM join_sounds; DELETE FROM activity; DELETE FROM game_aliases`);
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

const upload = (name: string, file = 'clip.wav', body: BodyInit = wav() as BodyInit) => call(`/guilds/${GUILD}/sounds/${name}?file=${file}`, { method: 'PUT', body });
const sounds = async () => (await ok(`/guilds/${GUILD}/sounds`)).sounds as any[];

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
  assert.deepEqual(await res.json(), { replaced: false, discordProblem: null });
  assert.equal(res.status, 200);
  const [sound] = await sounds();
  assert.equal(sound.name, 'horn');
  assert.equal(sound.onDiscord, true);
  assert.equal(sound.fitsDiscord, true);
  assert.ok(Math.abs(sound.seconds - 0.2) < 0.05);
  assert.equal(discordSounds.size, 1);
  assert.equal(panelEdits.length, 1);
});

test('replacing keeps the sound and says so', async () => {
  await upload('horn', 'a.wav');
  const res = await upload('horn', 'b.wav');
  assert.equal(((await res.json()) as any).replaced, true);
  assert.equal((await sounds()).length, 1);
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

test('deletes a sound from the bot and from Discord', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
  assert.equal((await sounds()).length, 0);
  assert.equal(discordSounds.size, 0);
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
  assert.deepEqual(await ok(`/guilds/${GUILD}/stop`, { method: 'POST' }), {});
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
  const { startsAt, ...rest } = nights[0];
  assert.ok(startsAt > Date.now());
  assert.deepEqual(rest, { id, game: 'Halo', details: 'Bring snacks', voiceChannel: 'General', host: 'Ana', in: ['Ana'], maybe: ['Ben'], out: ['Someone who left'], repeats: 'Every week' });
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
  await upload('horn', 'q.wav', quietWav() as BodyInit);
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
  assert.deepEqual(await res.json(), { replaced: false, discordProblem: null });
  assert.equal(discordSounds.size, 0);
  assert.equal((await sounds())[0].onDiscord, false);
});

test('replacing a sound that’s on Discord updates its copy even when told to stay off', async () => {
  await upload('horn');
  const old = [...discordSounds.keys()][0];
  await call(`/guilds/${GUILD}/sounds/horn?file=a.wav&discord=0`, { method: 'PUT', body: wav() as BodyInit });
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
  await addFile('second', '.mp3', steps('.mp3'));
  assert.equal((await listed('second')).trimmed, false);

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
  await ok(takeOff('theirs'), { method: 'DELETE' });
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
  assert.deepEqual(added.mock.calls[0].arguments, [file, 0.8 / 0.5]);
  assert.deepEqual(plays(), [], 'not a library sound, so nothing to count');

  await save(id);
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  assert.equal(added.mock.calls[2].arguments[0], path.join(soundFolder, 'theirs.mp3'));
  assert.deepEqual(plays(), ['web:theirs']);
  assert.match(await refused(400, url, { method: 'POST', json: { channelId: 'v1' } }), /Nobody’s in voice/);
});
