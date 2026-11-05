import './helpers.ts';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, beforeEach, mock, test } from 'node:test';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi, webApi } from '../src/api.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { activity, stats } from '../src/features/gamestats.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { setting, setSetting } from '../src/settings.ts';

const TOKEN = 'secret';
const GUILD = 'g1';
const soundFolder = path.join(process.env.DATA_DIR!, 'sounds', GUILD);

const wav = (seconds = 0.2) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-f', 'wav', 'pipe:1'], {
    maxBuffer: 16 * 1024 * 1024,
  });

let discordSounds: Map<string, { name: string }>;
let nextSoundId = 0;
let panelEdits: unknown[][];
let permitted: bigint[];
let sent: { channelId: string; message: any }[];
let deletedEvents: string[];

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
  afkChannelId: '704',
  voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }),
  iconURL: () => null,
  premiumTier: 0,
  members: { me, cache: new Map([member('u1', 'Ana'), member('u2', 'Ben'), member('u3', 'Cy')]) },
  scheduledEvents: { delete: async (id: string) => void deletedEvents.push(id) },
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
    fetch: async () => new Map(discordSounds),
    create: async ({ name }: { name: string }) => {
      const soundId = `s${++nextSoundId}`;
      discordSounds.set(soundId, { name });
      return { soundId };
    },
    edit: async (id: string, data: { name?: string }) => {
      const sound = discordSounds.get(id)!;
      if (data.name) sound.name = data.name;
    },
    delete: async (id: string) => void discordSounds.delete(id),
  },
};

const client = {
  guilds: { cache: new Map([[GUILD, guild]]) },
  channels: {
    fetch: async (channelId: string) => ({
      isTextBased: () => true,
      isSendable: () => true,
      send: async (message: unknown) => void sent.push({ channelId, message }),
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
  panelEdits = [];
  sent = [];
  deletedEvents = [];
  permitted = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  db.exec(`DELETE FROM sound_emoji; DELETE FROM discord_sounds; DELETE FROM sound_plays; DELETE FROM guild_settings; DELETE FROM sound_panels;
    DELETE FROM sound_favourites; DELETE FROM game_nights; DELETE FROM game_night_series; DELETE FROM game_plays; DELETE FROM session_members; DELETE FROM sessions`);
  db.prepare("INSERT INTO sound_panels (message_id, guild_id, channel_id, page) VALUES ('m', ?, '111', 0)").run(GUILD);
  if (existsSync(soundFolder)) for (const f of readdirSync(soundFolder)) execFileSync('rm', [path.join(soundFolder, f)]);
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
  db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(guildId, user, game, start, start + hours * HOUR);
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
  assert.equal(Math.round(data.totals.gameMs / HOUR), 6);
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
  db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(GUILD, 'u1', 'Halo', midnight - HOUR / 2, midnight + HOUR);
  const { step, buckets } = activity(GUILD, midnight - 2 * 24 * HOUR, midnight + 24 * HOUR, 'America/Chicago', () => true);
  assert.equal(step, 'day');
  assert.deepEqual(buckets.filter((b) => b.ms).map((b) => b.ms), [HOUR / 2, HOUR]);
  assert.equal(buckets.filter((b) => b.ms)[1].start, midnight);
});

test('longer periods are grouped by week, then by month from the 1st', () => {
  const now = Date.parse('2026-06-15T17:00:00Z');
  db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(GUILD, 'u1', 'Halo', now - 500 * 24 * HOUR, now - 500 * 24 * HOUR + HOUR);
  db.prepare('INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(GUILD, 'u1', 'Halo', now - 50 * 24 * HOUR, now - 50 * 24 * HOUR + HOUR);
  assert.equal(activity(GUILD, now - 100 * 24 * HOUR, now, 'UTC', () => true).step, 'week');
  const months = activity(GUILD, 0, now, 'UTC', () => true);
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
