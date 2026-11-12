import './helpers.ts';
import { Events, PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import path from 'node:path';
import { webApi } from '../src/api.ts';
import { followVoice } from '../src/api/live.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { logActivity } from '../src/activity.ts';
import { soundGain } from '../src/features/soundboard.ts';
import { setting, setSetting } from '../src/settings.ts';
import { GUILD, TOKEN, as, base, client, guild, ok, onlyOnDiscord, panelEdits, quietWav, refused, setFake, soundFolder, sounds, upload } from './apiFixture.ts';

// Signing in, who’s who, settings, activity, voice channels, live updates and the API server itself

test('every route needs the token', async () => {
  for (const authorization of [undefined, 'Bearer wrong', TOKEN]) {
    const res = await fetch(`${base}/guilds`, { headers: authorization ? { authorization } : {} });
    assert.equal(res.status, 401);
  }
  const res = await fetch(`${base}/guilds/${GUILD}/settings/timezone`, { method: 'PUT', body: '{"value":"UTC"}' });
  assert.equal(res.status, 401);
  assert.notEqual(setting(GUILD, 'timezone'), 'UTC');
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
  setFake({ permitted: [PermissionFlagsBits.ViewChannel] });
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
  setFake({ panelEdits: [] });
  await sounds();
  await ok(`/guilds/${GUILD}/settings`);
  assert.equal(panelEdits.length, 0);
  assert.ok(readFileSync(path.join(soundFolder, 'horn.wav')).length > 0);
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

test('activity stays with its server and goes after a year', async () => {
  logActivity('other', 'u1', 'Elsewhere');
  db.prepare("INSERT INTO activity (guild_id, at, actor, action) VALUES (?, ?, 'u1', 'Ancient')").run(GUILD, Date.now() - 366 * 86_400_000);
  logActivity(GUILD, 'u1', 'Recent');
  assert.deepEqual((await ok(`/guilds/${GUILD}/activity`)).entries.map((e: any) => e.action), ['Recent']);
});

test('a page’s one request for updates waits for a change, then answers with only what changed', async (t) => {
  t.after(() => ok(`/guilds/${GUILD}/music/queue`, { method: 'DELETE' }));
  assert.match(await refused(400, `/guilds/${GUILD}/updates`), /playing, music, voice/);
  // With nothing yet, everything asked for, straight away
  const first = await ok(`/guilds/${GUILD}/updates?playing=&music=&voice=`);
  assert.deepEqual(Object.keys(first).sort(), ['music', 'playing', 'voice']);
  assert.deepEqual(first.playing.playing, []);
  assert.deepEqual(first.music.queue, []);
  assert.deepEqual(first.voice.channels.map((c: { id: string }) => c.id), ['702', '701']);
  assert.equal(first.voice.soundVolume, 100);
  const since = (have: Record<string, string>) => `/guilds/${GUILD}/updates?${new URLSearchParams(have)}`;
  const all = { playing: first.playing.version, music: first.music.version, voice: first.voice.version };

  const waiting = ok(since(all));
  const track = { uri: `spotify:track:${'b'.repeat(22)}`, title: 'Song', artist: 'Band', album: 'Album', cover: null, durationMs: 180_000 };
  await ok(`/guilds/${GUILD}/music/queue`, { method: 'POST', json: { track } });
  const queued = await waiting;
  assert.deepEqual(Object.keys(queued), ['music']);
  assert.deepEqual(queued.music.queue.map((r: { title: string }) => r.title), ['Song']);
  assert.notEqual(queued.music.version, all.music);
  all.music = queued.music.version;

  // People coming and going, a channel renamed and a name changed in voice
  const discord = Object.assign(new EventEmitter(), { user: { id: 'bot' } });
  followVoice(discord as never);
  const guildOf = { guild: { id: GUILD } };
  const joined = ok(since(all));
  discord.emit(Events.VoiceStateUpdate, { channelId: null }, { ...guildOf, id: '1', channelId: '702' });
  const voice = await joined;
  assert.deepEqual(Object.keys(voice), ['voice']);
  all.voice = voice.voice.version;
  // A voice channel renamed, or someone's name changed, which the music page's queue shows too
  for (const [event, ...args] of [
    [Events.ChannelUpdate, { name: 'Gaming' }, { ...guildOf, name: 'Games', isDMBased: () => false, isVoiceBased: () => true }],
    [Events.GuildMemberUpdate, { partial: false, displayName: 'Ana' }, { ...guildOf, displayName: 'Anna', voice: { channelId: '702' } }],
  ] as const) {
    discord.emit(event, ...args);
    const update = await ok(since(all));
    assert.deepEqual(Object.keys(update), ['music', 'voice'], event);
    all.music = update.music.version;
    all.voice = update.voice.version;
  }
  // Muting, a text channel renamed, or a member changed but not their name don't count
  discord.emit(Events.VoiceStateUpdate, { channelId: '702' }, { ...guildOf, id: '1', channelId: '702' });
  discord.emit(Events.ChannelUpdate, { name: 'Gaming' }, { ...guildOf, name: 'Gaming', isDMBased: () => false, isVoiceBased: () => true });
  discord.emit(Events.ChannelUpdate, { name: 'chat' }, { ...guildOf, name: 'talk', isDMBased: () => false, isVoiceBased: () => false });
  discord.emit(Events.GuildMemberUpdate, { partial: false, displayName: 'Ana' }, { ...guildOf, displayName: 'Ana', voice: { channelId: '702' } });
  // The bot moving changes where the music page says it is
  discord.emit(Events.VoiceStateUpdate, { channelId: null }, { ...guildOf, id: 'bot', channelId: '702' });
  const moved = await ok(since(all));
  assert.deepEqual(Object.keys(moved).sort(), ['music', 'voice']);
  const changes = (version: string) => Number(version.split('-').at(-1));
  assert.equal(changes(moved.voice.version), changes(all.voice) + 1, 'only the bot moving counted');
  assert.equal(changes(moved.music.version), changes(all.music) + 1, 'only the bot moving counted');
  all.music = moved.music.version;
  all.voice = moved.voice.version;

  // The sound volume, shown beside Play in
  const louder = ok(since(all));
  await ok(`/guilds/${GUILD}/settings/soundVolume`, { method: 'PUT', json: { value: 80 } });
  const volume = await louder;
  assert.deepEqual(Object.keys(volume), ['voice']);
  assert.equal(volume.voice.soundVolume, 80);
  await ok(`/guilds/${GUILD}/settings/soundVolume`, { method: 'DELETE' });
});
