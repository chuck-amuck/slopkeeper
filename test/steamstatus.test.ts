import './helpers.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { beforeEach, test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { hopOn } from '../src/features/hopon.ts';
import { join, noteGames, sessions } from '../src/features/sessions.ts';
import { checkSteamStatus, checkSteamStatusOf, friendsCheck, lobbiesIn, steam } from '../src/features/steam.ts';
import { setSetting } from '../src/settings.ts';
import { onSteamChange, setSteamGames, steamGame } from '../src/steamStatus.ts';
import { playingGames } from '../src/util.ts';
import { fakeClient } from './helpers.ts';

const NO_KEY = config.steamApiKey;
const MINUTE = 60_000;

function useKey(t: TestContext) {
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = NO_KEY));
}

const link = (user: string) => db.prepare('INSERT OR IGNORE INTO steam_links (user_id, steam_id) VALUES (?, ?)').run(user, `s-${user}`);
const human = (id: string, guild: unknown, games: string[] = []) => ({ id, displayName: id, user: { bot: false }, guild, presence: { activities: games.map((name) => ({ type: 0, name })) } });

/** A server with people in its voice channels: { channel id: people } */
function server(id: string, voice: Record<string, string[]>, afkChannelId: string | null = null) {
  const guild = { id, name: id, afkChannelId, channels: { cache: new Map<string, unknown>() }, members: { cache: new Map<string, unknown>() } };
  for (const [channelId, people] of Object.entries(voice)) {
    const members = new Map(people.map((p) => [p, human(p, guild)]));
    guild.channels.cache.set(channelId, { id: channelId, guild, members, isVoiceBased: () => true });
    for (const [p, member] of members) guild.members.cache.set(p, member);
  }
  guild.channels.cache.set('text', { id: 'text', isVoiceBased: () => false });
  return guild;
}

const clientOf = (...guilds: ReturnType<typeof server>[]) => ({ guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } }) as never;

/** Steam, with what each linked person is doing: { steam id: their summary } */
function fakeSteam(t: TestContext, players: Record<string, object>) {
  const asked: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const ids = url.searchParams.get('steamids')!.split(',');
    asked.push(ids);
    return new Response(JSON.stringify({ response: { players: ids.flatMap((id) => (players[id] ? [{ steamid: id, ...players[id] }] : [])) } }));
  });
  return asked;
}

beforeEach(() => {
  db.exec('DELETE FROM steam_links; DELETE FROM guild_settings;');
  setSteamGames(new Map());
});

test('only looks up linked people in voice', async (t) => {
  useKey(t);
  for (const id of ['a', 'b', 'afk']) link(id);
  const guild = server('look', { v: ['a', 'unlinked'], gone: ['afk'] }, 'gone');
  guild.members.cache.set('b', human('b', guild));
  const asked = fakeSteam(t, { 's-a': { gameid: '10', gameextrainfo: 'Valheim' } });
  await checkSteamStatus(clientOf(guild));
  assert.deepEqual(asked, [['s-a']]);
  assert.deepEqual(steamGame('a'), { appid: 10, name: 'Valheim', lobby: null });
});

test('a server with this off isn’t looked up', async (t) => {
  useKey(t);
  link('a');
  setSetting('off', 'steamStatus', false);
  const asked = fakeSteam(t, {});
  await checkSteamStatus(clientOf(server('off', { v: ['a'] })));
  assert.deepEqual(asked, []);
});

test('asks about 100 people at a time', async (t) => {
  useKey(t);
  const people = Array.from({ length: 150 }, (_, n) => `p${n}`);
  people.forEach(link);
  const asked = fakeSteam(t, {});
  await checkSteamStatus(clientOf(server('many', { v: people })));
  assert.deepEqual(asked.map((ids) => ids.length), [100, 50]);
});

test('forgets someone who stopped playing or left voice', async (t) => {
  useKey(t);
  link('a');
  const guild = server('left', { v: ['a'] });
  fakeSteam(t, { 's-a': { gameid: '10', gameextrainfo: 'Valheim' } });
  await checkSteamStatus(clientOf(guild));
  assert.ok(steamGame('a'));
  (guild.channels.cache.get('v') as { members: Map<string, unknown> }).members.clear();
  await checkSteamStatus(clientOf(guild));
  assert.equal(steamGame('a'), undefined);
});

test('a profile that hides its game shows nothing', async (t) => {
  useKey(t);
  link('a');
  fakeSteam(t, { 's-a': { personaname: 'Ana' } });
  await checkSteamStatus(clientOf(server('hid', { v: ['a'] })));
  assert.equal(steamGame('a'), undefined);
});

test('a game stays through a short outage, but not a long one', async (t) => {
  useKey(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  link('a');
  const client = clientOf(server('down', { v: ['a'] }));
  let down = false;
  t.mock.method(globalThis, 'fetch', async () => (down ? new Response('', { status: 503 }) : new Response(JSON.stringify({ response: { players: [{ steamid: 's-a', gameid: '10', gameextrainfo: 'Valheim' }] } }))));
  const quiet = t.mock.method(console, 'error', () => {});
  await checkSteamStatus(client);
  down = true;
  t.mock.timers.tick(2 * MINUTE);
  await checkSteamStatus(client);
  assert.ok(steamGame('a'), 'kept for a moment');
  t.mock.timers.tick(10 * MINUTE);
  await checkSteamStatus(client);
  assert.equal(steamGame('a'), undefined);
  assert.equal(quiet.mock.callCount(), 2);
});

test('only says so when something changed', () => {
  let changes = 0;
  onSteamChange(() => changes++);
  const game = new Map([['a', { appid: 1, name: 'Valheim', lobby: null }]]);
  setSteamGames(game);
  setSteamGames(new Map(game));
  assert.equal(changes, 1);
  setSteamGames(new Map());
  assert.equal(changes, 2);
});

test('updating a few people leaves everyone else alone', () => {
  setSteamGames(new Map([['a', { appid: 1, name: 'A', lobby: null }], ['b', { appid: 2, name: 'B', lobby: null }]]));
  setSteamGames(new Map(), ['a']);
  assert.equal(steamGame('a'), undefined);
  assert.equal(steamGame('b')!.name, 'B');
});

test('Discord wins, and Steam fills in when it shows nothing', () => {
  const guild = { id: 'both' };
  setSteamGames(new Map([['a', { appid: 1, name: 'Steam Name', lobby: null }]]));
  assert.deepEqual(playingGames(human('a', guild) as never), ['Steam Name']);
  assert.deepEqual(playingGames(human('a', guild, ['Discord Name']) as never), ['Discord Name']);
  assert.deepEqual(playingGames(human('b', guild) as never), []);
  setSetting('both', 'steamStatus', false);
  assert.deepEqual(playingGames(human('a', guild) as never), []);
});

test('a session picks up a game from Steam', () => {
  const guild = server('session', { v: ['a'] });
  const channel = guild.channels.cache.get('v') as never;
  join(channel, human('a', guild) as never, Date.now() - 3_600_000);
  setSteamGames(new Map([['a', { appid: 1, name: 'Valheim', lobby: null }]]));
  noteGames({ channels: { cache: guild.channels.cache } } as never);
  sessions.shutdown!();
  const rows = db.prepare(`SELECT g.game FROM session_games g JOIN sessions s ON s.id = g.session_id WHERE s.guild_id = 'session'`).all() as { game: string }[];
  assert.deepEqual(rows.map((r) => r.game), ['Valheim']);
});

/** People hopping into voice, with a real hop-on feature watching */
function hopServer(id: string) {
  setSetting(id, 'announceChannel', `channel-${id}`);
  const sent: { content: string }[] = [];
  const guild = { id, name: id, afkChannelId: null, channels: { cache: new Map() } };
  const client: EventEmitter = Object.assign(new EventEmitter(), fakeClient([guild], async (_guild, message) => sent.push(message as { content: string })));
  hopOn.setup!(client as never);
  const channel = { id: 'v', guild, members: new Map(), toString: () => '#voice' };
  const hop = (userId: string) => {
    const member = human(userId, guild);
    channel.members.set(userId, member);
    client.emit(Events.VoiceStateUpdate, { channelId: null }, { channelId: 'v', channel, guild, member });
  };
  return { sent, hop };
}

const settle = async () => {
  for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
};

test('a hop-on post checks Steam first, so it knows the game', async (t) => {
  useKey(t);
  link('a');
  fakeSteam(t, { 's-a': { gameid: '10', gameextrainfo: 'Valheim' } });
  const { sent, hop } = hopServer('hop1');
  hop('a');
  hop('b');
  await settle();
  assert.match(sent[0].content, /playing \*\*Valheim\*\*/);
});

test('a hop-on post still goes out if Steam is down', async (t) => {
  useKey(t);
  link('a');
  const quiet = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const { sent, hop } = hopServer('hop2');
  hop('a');
  hop('b');
  await settle();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].content, /playing/);
  assert.equal(quiet.mock.callCount(), 1);
});

test('checking Steam does nothing with this off, or with no key', async (t) => {
  const asked = fakeSteam(t, {});
  link('a');
  await checkSteamStatusOf('nokey', ['a']);
  useKey(t);
  setSetting('nokeyoff', 'steamStatus', false);
  await checkSteamStatusOf('nokeyoff', ['a']);
  assert.deepEqual(asked, []);
});

test('lists lobbies for this server’s members only', async (t) => {
  useKey(t);
  for (const id of ['a', 'b', 'c', 'outsider']) link(id);
  fakeSteam(t, {
    's-a': { gameid: '10', gameextrainfo: 'Valheim', lobbysteamid: '999' },
    's-b': { gameid: '20', gameextrainfo: 'Hades' },
    's-outsider': { gameid: '10', gameextrainfo: 'Valheim', lobbysteamid: '888' },
  });
  const lobbies = await lobbiesIn(server('lobby', { v: ['a', 'b', 'c'] }) as never);
  assert.deepEqual(lobbies, [{ userId: 'a', game: 'Valheim', profile: 'https://steamcommunity.com/profiles/s-a', join: 'steam://joinlobby/10/999/s-a' }]);
});

/** Steam friends lists: { steam id: friends }, with a number for what Steam answers instead */
function fakeFriends(t: TestContext, lists: Record<string, string[] | number>) {
  return t.mock.method(globalThis, 'fetch', async (url: URL) => {
    const list = lists[url.searchParams.get('steamid')!];
    return typeof list === 'number' ? new Response('', { status: list }) : new Response(JSON.stringify({ friendslist: { friends: list.map((steamid) => ({ steamid, relationship: 'friend' })) } }));
  });
}

test('one visible friends list is enough', async (t) => {
  useKey(t);
  for (const id of ['f1', 'f2', 'f3']) link(id);
  fakeFriends(t, { 's-f1': ['s-f2'], 's-f2': 401, 's-f3': [] });
  assert.deepEqual(await friendsCheck(['f1', 'f2', 'f3']), { strangers: [['f1', 'f3'], ['f2', 'f3']], unknown: [], unlinked: [] });
});

test('being on the other person’s list counts', async (t) => {
  useKey(t);
  for (const id of ['g1', 'g2']) link(id);
  fakeFriends(t, { 's-g1': 401, 's-g2': ['s-g1'] });
  assert.deepEqual((await friendsCheck(['g1', 'g2'])).strangers, []);
});

test('two private lists can’t be told apart from strangers', async (t) => {
  useKey(t);
  for (const id of ['h1', 'h2']) link(id);
  fakeFriends(t, { 's-h1': 401, 's-h2': 403 });
  assert.deepEqual(await friendsCheck(['h1', 'h2']), { strangers: [], unknown: [['h1', 'h2']], unlinked: [] });
});

test('says who isn’t linked, and doesn’t compare an account with itself', async (t) => {
  useKey(t);
  link('i1');
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('i2', 's-i1')`).run();
  fakeFriends(t, { 's-i1': [] });
  assert.deepEqual(await friendsCheck(['i1', 'i2', 'i3']), { strangers: [], unknown: [], unlinked: ['i3'] });
});

test('remembers friends lists, but not Steam being down', async (t) => {
  useKey(t);
  for (const id of ['j1', 'j2']) link(id);
  const quiet = t.mock.method(console, 'error', () => {});
  const fetcher = fakeFriends(t, { 's-j1': 500, 's-j2': [] });
  assert.deepEqual((await friendsCheck(['j1', 'j2'])).strangers, [['j1', 'j2']]);
  assert.equal(quiet.mock.callCount(), 1);
  await friendsCheck(['j1', 'j2']);
  assert.equal(fetcher.mock.callCount(), 3, 'only the failed one is asked again');
});

async function runSteam(t: TestContext, sub: string, voice: { members: Map<string, unknown> } | null, guild: unknown = { members: { cache: new Map() } }) {
  useKey(t);
  let reply: { content: string; flags?: number } | string | undefined;
  await steam.commands![0].run({
    options: { getSubcommand: () => sub, getUser: () => null },
    user: { id: 'me' },
    inCachedGuild: () => true,
    guild,
    member: { voice: { channel: voice } },
    reply: async (r: typeof reply) => (reply = r),
    deferReply: async () => {},
    editReply: async (r: typeof reply) => (reply = r),
  } as never);
  return reply as { content: string; flags?: number };
}

test('/steam friends needs a voice channel', async (t) => {
  const reply = await runSteam(t, 'friends', null);
  assert.match(reply.content, /Join a voice channel/);
  assert.ok(reply.flags);
});

test('/steam friends lists who to add, or says everyone’s fine', async (t) => {
  for (const id of ['k1', 'k2']) link(id);
  const voice = (ids: string[]) => ({ members: new Map(ids.map((id) => [id, { id, user: { bot: false } }])) });
  fakeFriends(t, { 's-k1': [], 's-k2': [] });
  assert.equal((await runSteam(t, 'friends', voice(['k1', 'k2', 'k3']))).content, '<@k1> and <@k2> aren’t friends on Steam yet.\nNot linked: <@k3>');
  assert.match((await runSteam(t, 'friends', voice(['k1']))).content, /Everyone here is friends/);
});

test('/steam lobbies links to a profile, as Discord won’t open steam:// links', async (t) => {
  link('l1');
  fakeSteam(t, { 's-l1': { gameid: '10', gameextrainfo: 'Valheim', lobbysteamid: '999' } });
  const { content } = await runSteam(t, 'lobbies', null, server('cmd', { v: ['l1'] }));
  assert.match(content, /<@l1> · Valheim · \[open their profile to join\]\(https:\/\/steamcommunity\.com\/profiles\/s-l1\)/);
  assert.doesNotMatch(content, /steam:\/\//);
});

test('/steam lobbies says so when there are none', async (t) => {
  link('l2');
  fakeSteam(t, {});
  assert.match((await runSteam(t, 'lobbies', null, server('none', { v: ['l2'] }))).content, /Nobody’s in a joinable Steam lobby/);
});
