import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { commandMention, rememberCommands } from '../src/commandIds.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { MessageFlags } from 'discord.js';
import { answer, asksBot, chat, chatNote, chatNotes, chatUsage, COOLDOWN_MS, finished, MODELS, MOST_STRICT_TOOLS, getReady, joinsVoice, strictAtMost, talksNearby, warmUp, withoutOffer, noteOf, onMessage, resetChat, sourcesLine, useTool, type Turn } from '../src/features/chat.ts';
import { clearQueue, queueOf } from '../src/features/music.ts';
import { checkSetting } from '../src/features/setup.ts';
import { ACTIONS } from '../src/features/chatActions.ts';
import { sendPost } from '../src/postFailures.ts';
import { setting, setSetting } from '../src/settings.ts';
import { resetSpotify } from '../src/spotify.ts';

config.anthropicKey = 'test-key';
config.musicUrl = 'http://music.test';
config.spotifyClientId = 'spotify-id';
config.spotifyClientSecret = 'spotify-secret';

const BOT = '100';
const id22 = (n: number | string) => String(n).padStart(22, '0');
const song = (n: number, artist: string, name = `Song ${n}`, artistId = id22(artist.replace(/\W/g, ''))) => ({
  uri: `spotify:track:${id22(n)}`,
  name,
  duration_ms: 200_000,
  artists: [{ id: artistId, name: artist }],
  album: { name: 'An Album', images: [] },
});

// What the model answers, in turn, and what was sent to it
let replies: Record<string, unknown>[] = [];
let sent: { model: string; system: { text: string }[]; tools?: { name: string }[]; tool_choice?: unknown; messages: { role: string; content: unknown }[]; output_config?: unknown }[] = [];
let apiDown = false;
const spotifyAsked: string[] = [];
// What the music container was asked to search on YouTube Music
const ytmAsked: Record<string, string>[] = [];

mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.anthropic.com/v1/messages')) {
    if (apiDown || (replies[0] as { down?: boolean } | undefined)?.down) return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
    // A request the API refuses, as it does web search where an organization has it off
    const refused = (replies[0] as { refused?: string } | undefined)?.refused;
    if (refused) {
      sent.push(JSON.parse(init.body as string));
      replies.shift();
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: refused } }, { status: 400 });
    }
    sent.push(JSON.parse(init.body as string));
    const next = replies.shift();
    assert.ok(next, 'asked the model more often than expected');
    return Response.json({ id: `msg_${sent.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 }, ...next });
  }
  if (url === 'https://accounts.spotify.com/api/token') return Response.json({ access_token: 'token', expires_in: 3600 });
  if (url.startsWith('https://api.spotify.com/v1/')) {
    const where = url.slice('https://api.spotify.com/v1'.length);
    spotifyAsked.push(decodeURIComponent(where));
    const q = new URL(url).searchParams.get('q') ?? '';
    // Everything at once, three of each
    if (where.startsWith('/search?type=track,album,artist')) {
      assert.match(where, /&limit=3&/);
      return Response.json({
        tracks: { items: [song(20, 'The Strokes', 'Lonely in the Future')], next: null },
        albums: { items: [{ id: id22('ra'), uri: `spotify:album:${id22('ra')}`, name: 'Reality Awaits', artists: [{ name: 'The Strokes' }], album_type: 'album', release_date: '2026-03-13' }], next: null },
        artists: { items: [{ id: id22('TheStrokes'), uri: `spotify:artist:${id22('TheStrokes')}`, name: 'The Strokes' }], next: null },
      });
    }
    if (where.startsWith('/search?type=album')) {
      return Response.json({
        albums: {
          items: [
            { uri: `spotify:album:${id22('wall')}`, name: 'The Wall', artists: [{ name: 'Pink Floyd' }], album_type: 'album', release_date: '1979-11-30' },
            { uri: `spotify:album:${id22('ep')}`, name: 'Wall Demos', artists: [{ name: 'Pink Floyd' }], album_type: 'single', release_date: '2011' },
          ],
          next: null,
        },
      });
    }
    // Spotify's order isn't newest first
    if (where.startsWith(`/artists/${id22('TheStrokes')}/albums`)) {
      assert.match(where, /include_groups=album&/);
      const album = (name: string, date: string) => ({ uri: `spotify:album:${id22(name.replace(/\W/g, ''))}`, name, artists: [{ name: 'The Strokes' }], album_type: 'album', release_date: date });
      return Response.json({ items: [album('Is This It', '2001-07-30'), album('Reality Awaits', '2026-03-13'), album('The New Abnormal', '2020-04-10')], next: null });
    }
    if (where.startsWith('/search?type=artist')) return Response.json({ artists: { items: [{ id: id22('TheStrokes'), uri: `spotify:artist:${id22('TheStrokes')}`, name: 'The Strokes' }], next: null } });
    if (where.startsWith('/search?type=track') && q.startsWith('artist:')) {
      return Response.json({ tracks: { items: [song(1, 'The Strokes', 'Last Nite'), song(2, 'The Strokes Tribute Band'), song(3, 'The Strokes', 'Someday'), song(4, 'The Strokes', 'A Namesake’s Song', id22('namesake'))], next: null } });
    }
    // A search by the name alone finds more of their songs, and some of the same
    if (where.startsWith('/search?type=track') && q.toLowerCase() === 'the strokes') {
      return Response.json({ tracks: { items: [song(5, 'The Strokes', 'Reptilia'), song(6, 'The Strokes', 'Last Nite')], next: null } });
    }
    if (where.startsWith(`/albums/${id22('wall')}`)) return Response.json({ name: 'The Wall', images: [], tracks: { items: [song(10, 'Pink Floyd', 'In the Flesh?'), song(11, 'Pink Floyd', 'The Thin Ice')], next: null } });
    if (where.startsWith(`/albums/${id22('ep')}`)) return Response.json({ name: 'Wall Demos', images: [], tracks: { items: [song(12, 'Pink Floyd', 'Demo')], next: null } });
  }
  // YouTube Music, through the music container, for servers that search it
  if (url === 'http://music.test/search') {
    const body = JSON.parse(init.body as string) as Record<string, string>;
    ytmAsked.push(body);
    if (body.search === 'fails for artists' && body.kind === 'artist') return new Response('', { status: 502 });
    const ytmSong = (id: string, title: string, artist: string) => ({ id, title, artists: [artist], album: 'Room On Fire', seconds: 200, cover: null });
    if (body.kind === 'album') return Response.json({ results: [{ id: 'MPREb_wall', title: 'The Wall', artists: ['Pink Floyd'], year: '1979', type: 'Album' }, { id: 'MPREb_ep', title: 'Wall EP', artists: ['Pink Floyd'], year: '2011', type: 'EP' }] });
    if (body.kind === 'artist') return Response.json({ results: [{ id: 'UCnotThem', name: 'The Strokes Tribute' }, { id: 'UCstrokes', name: 'The Strokes' }] });
    if (body.kind === 'song') return Response.json({ results: [ytmSong('aaaaaaaaaa1', 'Reptilia', 'The Strokes'), ytmSong('aaaaaaaaaa2', 'Tribute', 'The Strokes Tribute'), ytmSong('aaaaaaaaaa3', 'Reptilia', 'The Strokes'), ytmSong('aaaaaaaaaa4', 'Someday', 'The Strokes')] });
    if (body.artist === 'UCstrokes') {
      return Response.json({ id: 'UCstrokes', name: 'The Strokes', songs: [], singles: [], albums: [{ id: 'MPREb_iti', title: 'Is This It', artists: ['The Strokes'], year: '2001' }, { id: 'MPREb_ra', title: 'Reality Awaits', artists: ['The Strokes'], year: '2026' }, { id: 'MPREb_s', title: 'The Singles - Volume 01', artists: ['The Strokes'], year: '2023' }] });
    }
    if (body.album === 'MPREb_wall') return Response.json({ id: 'MPREb_wall', title: 'The Wall', songs: [ytmSong('bbbbbbbbbb1', 'In the Flesh?', 'Pink Floyd'), ytmSong('bbbbbbbbbb2', 'The Thin Ice', 'Pink Floyd')] });
    return Response.json({ error: 'YouTube Music’s page didn’t have what was expected' }, { status: 502 });
  }
  // Images people attach, as Discord's CDN serves them
  if (url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([137, 80, 78, 71]));
  // Covers and the music container aren't needed here
  return new Response('{}', { status: 404 });
});

const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const turn = (stop: string, ...content: unknown[]) => ({ stop_reason: stop, content });

function fakeGuild(id: string) {
  const roles = new Map([['300', { id: '300', name: 'DJ' }]]);
  const me = { id: BOT, displayName: 'Slopkeeper', roles: { botRole: { id: '400' } } };
  return { id, name: 'Test Server', members: { me, cache: new Map<string, unknown>([[BOT, me]]), fetch: async () => null }, roles: { cache: roles }, channels: { cache: new Map() } };
}

function fakeMember(guild: ReturnType<typeof fakeGuild>, id = '201', roleIds: string[] = []) {
  const member = { id, displayName: `Person ${id}`, guild, voice: { channel: null }, roles: { cache: new Map(roleIds.map((r) => [r, {}])) }, permissions: { has: () => false } };
  guild.members.cache.set(id, member as never);
  return member;
}

/** A message in a channel, recording what the bot replies and reacts */
function fakeMessage(guild: ReturnType<typeof fakeGuild>, member: ReturnType<typeof fakeMember>, content: string, opts: { mentions?: string[]; repliedTo?: { id: string; author: { id: string; displayName: string }; type: number; content: string }; bot?: boolean } = {}) {
  const answers: string[] = [];
  const reactions: string[] = [];
  const pinged: string[][] = [];
  const flags: unknown[] = [];
  const earlier = new Map([['m0', { id: 'm0', author: { id: '202', displayName: 'Friend' }, member: { displayName: 'Friend' }, content: 'we should listen to <@201>’s album later', attachments: new Map() }]]);
  const channel = {
    name: 'general',
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => undefined,
    messages: { fetch: async () => earlier },
  };
  const message = {
    id: `m-${Math.random()}`,
    content,
    guild,
    member,
    channel,
    author: { id: member.id, bot: opts.bot ?? false, displayName: member.displayName },
    webhookId: null,
    system: false,
    attachments: new Map(),
    inGuild: () => true,
    // Discord lists whoever a reply replies to among the mentions too
    mentions: { users: new Map([...(opts.mentions ?? []), ...(opts.repliedTo ? [opts.repliedTo.author.id] : [])].map((u) => [u, {}])), repliedUser: opts.repliedTo ? opts.repliedTo.author : null },
    reference: opts.repliedTo ? { messageId: opts.repliedTo.id } : null,
    fetchReference: async () => ({ ...opts.repliedTo, member: null, attachments: new Map() }),
    reply: async (m: { content: string; allowedMentions: { parse: string[]; users: string[]; repliedUser: boolean }; flags?: unknown }) => {
      // Never @everyone or a role, nor the person asking just for being replied to
      assert.deepEqual([m.allowedMentions.parse, m.allowedMentions.repliedUser], [[], false]);
      answers.push(m.content);
      pinged.push(m.allowedMentions.users);
      flags.push(m.flags);
    },
    react: async (e: string) => void reactions.push(e),
  };
  return { message: message as never, answers, reactions, pinged, flags };
}

const client = { user: { id: BOT } } as never;

beforeEach(() => {
  replies = [];
  sent = [];
  apiDown = false;
  spotifyAsked.length = 0;
  resetChat();
  resetSpotify();
});

// A reply, as the bot's answers are, and a post of its own that isn't one
const REPLY = 19;
const answerOfBot = { id: 'a1', author: { id: BOT, displayName: 'Slopkeeper' }, type: REPLY, content: 'Your music awaits, my liege!' };
const hopOnPing = { id: 'p1', author: { id: BOT, displayName: 'Slopkeeper' }, type: 0, content: '🎮 Sam and Alex are in voice. Hop on!' };

test('only a message that @mentions the bot, or replies to one of its answers, asks it something', async () => {
  const guild = fakeGuild('g-asks');
  const member = fakeMember(guild);
  assert.equal(asksBot(fakeMessage(guild, member, 'hey <@100>').message, BOT), 'mention');
  assert.equal(asksBot(fakeMessage(guild, member, 'thanks', { repliedTo: answerOfBot }).message, BOT), 'reply');
  // @everyone, someone else, a reply to someone else, and other bots don't
  assert.equal(asksBot(fakeMessage(guild, member, '@everyone hi').message, BOT), null);
  assert.equal(asksBot(fakeMessage(guild, member, 'hey <@202>', { mentions: ['202'], repliedTo: { ...answerOfBot, author: { id: '202', displayName: 'Friend' } } }).message, BOT), null);
  assert.equal(asksBot(fakeMessage(guild, member, 'hey <@100>', { bot: true }).message, BOT), null);
  // The bot's own role, which Discord's @ list offers beside it, asks it too; other roles don't
  assert.equal(asksBot(fakeMessage(guild, member, 'hey <@&400>').message, BOT), 'mention');
  assert.equal(asksBot(fakeMessage(guild, member, 'hey <@&300>').message, BOT), null);

  // A reply to its hop-on ping is people talking to each other, though Discord counts it as mentioning the bot
  const omw = fakeMessage(guild, member, 'omw', { repliedTo: hopOnPing });
  await onMessage(omw.message, client);
  assert.deepEqual([omw.answers, sent.length], [[], 0]);
  // A reply to one of its answers is answered, knowing what it's replying to
  replies = [turn('end_turn', text('Most gracious of you!'))];
  const thanks = fakeMessage(guild, member, 'thanks!', { repliedTo: answerOfBot });
  await onMessage(thanks.message, client);
  assert.deepEqual(thanks.answers, ['Most gracious of you!']);
  assert.match(sent[0].messages[0].content as string, /Person 201 is replying to this message of yours:\nYou: Your music awaits, my liege!/);

  // An @mention in a reply to someone else is answered, and the message it replies to is theirs, not the bot's
  sent = [];
  replies = [turn('end_turn', text('A fine link indeed.'))];
  const link = { id: 'l1', author: { id: '202', displayName: 'Friend' }, type: 0, content: 'https://youtu.be/abc' };
  const queueThis = fakeMessage(guild, fakeMember(guild, '203'), '<@100> queue this', { repliedTo: link });
  await onMessage(queueThis.message, client);
  assert.deepEqual(queueThis.answers, ['A fine link indeed.']);
  assert.match(sent[0].messages[0].content as string, /Person 203 is replying to this message:\nFriend: https:\/\/youtu\.be\/abc/);
});

test('“play the wall” finds the album and queues it, answering in character', async () => {
  const guild = fakeGuild('g-wall');
  const member = fakeMember(guild);
  replies = [
    turn('tool_use', toolUse('t1', 'find_music', { query: 'the wall', kind: 'album' })),
    turn('tool_use', toolUse('t2', 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false })),
    turn('end_turn', text('At once, my liege! The Wall is queued.')),
  ];
  const { message, answers } = fakeMessage(guild, member, '<@100> play the wall');
  await onMessage(message, client);
  assert.deepEqual(answers, ['At once, my liege! The Wall is queued.']);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['In the Flesh?', 'The Thin Ice'],
  );
  // Haiku, at low effort, with the server's personality and the bot's tools
  const first = sent[0];
  assert.equal(first.model, MODELS.haiku.id);
  assert.deepEqual(first.output_config, { effort: 'low' });
  assert.match(first.system[0].text, /robot butler/);
  // Rude people get roasted, until a server turns that off
  assert.match(first.system[0].text, /If someone is rude to you[^\n]*about_person/);
  assert.match(first.system[0].text, /in a few words \(a barb, if they were rude about it\)/);
  // What the web UI has, without an address until the host sets one
  assert.match(first.system[0].text, /web UI has a tab for each part of it: Soundboard[^\n]*whoever runs the bot has its address/);
  assert.deepEqual(
    first.tools?.map((t) => t.name),
    ['find_music', 'artist_albums', 'queue_music', 'undo_queue', 'show_queue', 'control_music', 'find_sound', 'play_sound', 'catch_up', 'remember', 'games_for', 'pick_game', 'game_info', 'play_stats', 'about_person', 'deals', 'music_history', 'patch_notes', 'game_nights', 'plan_game_night', 'change_game_night', 'answer_game_night', 'start_vote', 'set_reminder', 'reminders', 'cancel_reminder', 'web_search'],
  );
  // The channel's last messages, with mentions as names, the music, and where the person is
  const asked = first.messages[0].content as string;
  assert.match(asked, /Friend: we should listen to @Person 201’s album later/);
  assert.match(asked, /No music is playing/);
  assert.match(asked, /Person 201 isn’t in a voice channel/);
  assert.match(asked, /Person 201 asks you:\nPerson 201: @Slopkeeper play the wall/);
  // What the tools said went back to it
  const found = (sent[1].messages[2].content as { content: string }[])[0].content;
  assert.match(found, /album: “The Wall” by Pink Floyd, 1979 \(ref spotify:album:0+wall\)/);
  const queued = (sent[2].messages[4].content as { content: string }[])[0].content;
  assert.match(queued, /^Added 2 songs from The Wall\. Nothing is playing, and they aren’t in a voice channel/);
  // Activity says it was asked in chat, and the answer and its tokens are counted
  assert.ok(recentActivity(guild.id, 10).some((a) => a.action === 'Asked in chat: “@Slopkeeper play the wall”'));
  const usage = chatUsage(guild.id);
  assert.equal(usage.replies, 1);
  // Three calls of 1000 input, 2000 cached and 100 output tokens
  assert.ok(Math.abs(usage.cost - (3 * (1000 * 0.1 + 2000 * 0.01 + 100 * 0.5)) / 1e6) < 1e-9);
  assert.match(chatNote(guild.id).note, /This month: 1 answer, under a cent\./);
  clearQueue(guild.id, 'test');
});

test('an artist adds their best-known songs, and only theirs', async () => {
  const guild = fakeGuild('g-artist');
  const member = fakeMember(guild);
  const ref = `artist:${id22('TheStrokes')}:The Strokes`;
  assert.ok((await useTool(member as never, 'find_music', { query: 'the strokes', kind: 'artist' })).includes(`artist: “The Strokes” (ref ${ref})`));
  // By their id, so not another band's of the same name, nor a tribute band's
  const added = await useTool(member as never, 'queue_music', { ref, next: false, shuffle: false });
  assert.match(added, /^Added 3 songs by The Strokes\./);
  assert.ok(spotifyAsked.some((a) => a.includes('q=artist:"The Strokes"')));
  // The name search's first, then the artist search's, each song once
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday'],
  );
  clearQueue(guild.id, 'test');
  // A ref it made up from a name goes by the name, so a namesake's songs can come too
  await useTool(member as never, 'queue_music', { ref: 'artist:the strokes', next: false, shuffle: false });
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday', 'A Namesake’s Song'],
  );
  clearQueue(guild.id, 'test');
});

test('a name that could be a song, album or artist is searched as all three at once', async (t) => {
  const guild = fakeGuild('g-any');
  const member = fakeMember(guild);
  assert.equal(
    await useTool(member as never, 'find_music', { query: 'reality awaits', kind: 'any' }),
    [
      `song: “Lonely in the Future” by The Strokes (ref spotify:track:${id22(20)})`,
      `album: “Reality Awaits” by The Strokes, 2026 (ref spotify:album:${id22('ra')})`,
      `artist: “The Strokes” (ref artist:${id22('TheStrokes')}:The Strokes)`,
    ].join('\n'),
  );
  // On YouTube Music, the three searches go to the music container together
  config.musicToken = 'music-token';
  t.after(() => (config.musicToken = null));
  setSetting(guild.id, 'musicSearch', 'youtube-music');
  ytmAsked.length = 0;
  const found = await useTool(member as never, 'find_music', { query: 'the wall', kind: 'any' });
  assert.deepEqual(ytmAsked.map((a) => a.kind).sort(), ['album', 'artist', 'song']);
  assert.ok(ytmAsked.every((a) => Number(a.limit) === 3));
  assert.match(found, /^song: “Reptilia”[\s\S]*\nalbum: “The Wall” by Pink Floyd, 1979[\s\S]*\nartist: “The Strokes Tribute”/);
  // One kind failing keeps the others
  const some = await useTool(member as never, 'find_music', { query: 'fails for artists', kind: 'any' });
  assert.match(some, /^song: “Reptilia”[\s\S]*\nalbum: “The Wall”/);
  assert.doesNotMatch(some, /artist:/);
});

test('a server that searches YouTube Music finds, lists and queues from there, and Spotify’s artists fall back to it by name', async (t) => {
  config.musicToken = 'music-token';
  const guild = fakeGuild('g-ytm');
  const member = fakeMember(guild);
  t.after(() => {
    config.musicToken = null;
    clearQueue(guild.id, 'test');
  });
  setSetting(guild.id, 'musicSearch', 'youtube-music');
  assert.equal(
    await useTool(member as never, 'find_music', { query: 'the wall', kind: 'album' }),
    'album: “The Wall” by Pink Floyd, 1979 (ref ytm:album:MPREb_wall)\nsingle or EP: “Wall EP” by Pink Floyd, 2011 (ref ytm:album:MPREb_ep)',
  );
  const artists = await useTool(member as never, 'find_music', { query: 'the strokes', kind: 'artist' });
  assert.ok(artists.includes('artist: “The Strokes” (ref ytm:artist:UCstrokes:The Strokes)'), artists);
  // Newest first, with compilations there for the model to pass over
  assert.deepEqual(
    (await useTool(member as never, 'artist_albums', { ref: 'ytm:artist:UCstrokes:The Strokes' })).split('\n').map((l) => /“(.+?)”/.exec(l)?.[1] ?? l),
    ['Newest first:', 'Reality Awaits', 'The Singles - Volume 01', 'Is This It'],
  );
  assert.match(await useTool(member as never, 'queue_music', { ref: 'ytm:album:MPREb_wall', next: false, shuffle: false }), /^Added 2 songs from The Wall\./);
  // Their songs, each once, not a tribute band's
  assert.match(await useTool(member as never, 'queue_music', { ref: 'ytm:artist:UCstrokes:The Strokes', next: false, shuffle: false }), /^Added 2 songs by The Strokes\./);
  assert.deepEqual(
    queueOf(guild.id).map((r) => [r.title, r.uri]),
    [
      ['In the Flesh?', 'https://music.youtube.com/watch?v=bbbbbbbbbb1'],
      ['The Thin Ice', 'https://music.youtube.com/watch?v=bbbbbbbbbb2'],
      ['Reptilia', 'https://music.youtube.com/watch?v=aaaaaaaaaa1'],
      ['Someday', 'https://music.youtube.com/watch?v=aaaaaaaaaa4'],
    ],
  );

  // On a Spotify server, an artist Spotify can't list is found on YouTube Music by name, the one called exactly that
  setSetting(guild.id, 'musicSearch', undefined);
  ytmAsked.length = 0;
  const albums = await useTool(member as never, 'artist_albums', { ref: `artist:${id22('Gone')}:The Strokes` });
  assert.match(albums, /^Newest first:\nalbum: “Reality Awaits” by The Strokes, 2026 \(ref ytm:album:MPREb_ra\)/);
  assert.deepEqual(ytmAsked, [{ search: 'The Strokes', kind: 'artist', limit: 5 }, { artist: 'UCstrokes' }]);
});

test('it can only do what the person asking could do themselves', async (t) => {
  const guild = fakeGuild('g-dj');
  const member = fakeMember(guild);
  const dj = fakeMember(guild, '203', ['300']);
  setSetting(guild.id, 'musicDjRole', '300');
  t.after(() => setSetting(guild.id, 'musicDjRole', undefined));
  assert.equal(await useTool(member as never, 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false }), 'Only @DJ and people with Manage Server can control the music.');
  assert.equal(await useTool(member as never, 'control_music', { action: 'stop' }), 'Only @DJ and people with Manage Server can control the music.');
  assert.equal(queueOf(guild.id).length, 0);
  assert.match(await useTool(dj as never, 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false }), /^Added 2 songs/);
  // Sounds and speech need them in voice
  assert.equal(await useTool(member as never, 'play_sound', { name: 'nope' }), 'No sound has that name. Use find_sound for the exact name.');
  assert.equal(await useTool(member as never, 'say_aloud', { text: 'hi', voice: '', effect: '' }), 'They aren’t in a voice channel, so there’s nowhere to say it.');
  clearQueue(guild.id, 'test');
});

test('one person waits between answers, and a server stops at its daily limit', async (t) => {
  const guild = fakeGuild('g-limit');
  const a = fakeMember(guild, '211');
  const b = fakeMember(guild, '212');
  setSetting(guild.id, 'chatDailyLimit', 2);
  t.after(() => setSetting(guild.id, 'chatDailyLimit', undefined));
  replies = [turn('end_turn', text('Hello!')), turn('end_turn', text('Hello again!'))];
  const first = fakeMessage(guild, a, '<@100> hi');
  await onMessage(first.message, client);
  assert.deepEqual(first.answers, ['Hello!']);
  // Too soon: a reaction, and nothing sent to the model
  const soon = fakeMessage(guild, a, '<@100> hi again');
  await onMessage(soon.message, client);
  assert.deepEqual([soon.answers, soon.reactions, sent.length], [[], ['⏳'], 1]);
  assert.ok(COOLDOWN_MS >= 10_000);
  await onMessage(fakeMessage(guild, b, '<@100> hi').message, client);
  // Out of answers for today: said once, then quiet
  const out = fakeMessage(guild, fakeMember(guild, '213'), '<@100> hi');
  await onMessage(out.message, client);
  assert.deepEqual(out.answers, ['That’s all the answers I have in me today. Ask me again tomorrow.']);
  const later = fakeMessage(guild, fakeMember(guild, '214'), '<@100> hi');
  await onMessage(later.message, client);
  assert.deepEqual([later.answers, sent.length], [[], 2]);
});

test('it stays quiet when chat is off or there’s no key, and says so when the API is down', async (t) => {
  const guild = fakeGuild('g-off');
  const member = fakeMember(guild);
  setSetting(guild.id, 'chat', false);
  const off = fakeMessage(guild, member, '<@100> hi');
  await onMessage(off.message, client);
  setSetting(guild.id, 'chat', undefined);
  config.anthropicKey = null;
  t.after(() => (config.anthropicKey = 'test-key'));
  const noKey = fakeMessage(guild, fakeMember(guild, '215'), '<@100> hi');
  await onMessage(noKey.message, client);
  assert.deepEqual([off.answers, noKey.answers, sent.length], [[], [], 0]);
  assert.match(chatNote(guild.id).note, /needs an Anthropic API key/);
  config.anthropicKey = 'test-key';

  apiDown = true;
  const down = fakeMessage(guild, fakeMember(guild, '216'), '<@100> hi');
  await onMessage(down.message, client);
  assert.deepEqual(down.answers, ['I can’t answer right now. Try again in a moment.']);
  // A failed answer isn't counted
  assert.equal(chatUsage(guild.id).replies, 0);
  apiDown = false;

  // Failing after it's queued something, it says it's done it, so nobody asks again and gets it twice
  replies = [turn('tool_use', toolUse('t1', 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false })), { down: true }];
  const midway = fakeMessage(guild, fakeMember(guild, '218'), '<@100> play the wall');
  await onMessage(midway.message, client);
  replies = [];
  assert.deepEqual(midway.answers, ['Done as you asked, though my words have deserted me. Do check what I did before asking again.']);
  assert.equal(queueOf(guild.id).length, 2);
  assert.equal(chatUsage(guild.id).replies, 1);
  clearQueue(guild.id, 'test');
});

test('a refusal is declined politely, and the last round has to answer', async () => {
  const guild = fakeGuild('g-rounds');
  replies = [turn('refusal')];
  const refused = fakeMessage(guild, fakeMember(guild, '217'), '<@100> something it won’t do');
  await onMessage(refused.message, client);
  assert.deepEqual(refused.answers, ['I’m afraid that’s one request I must decline.']);

  // It keeps looking for sounds; in the fifth round it can't use them, so its answer is the last. The tools are still
  // sent, as the API won't take tool calls in the history without them
  sent = [];
  replies = [...Array.from({ length: 4 }, (_, n) => turn('tool_use', toolUse(`s${n}`, 'find_sound', { query: '' }))), turn('end_turn', text('Alas, no sounds.'))];
  const looping = fakeMessage(guild, fakeMember(guild, '218'), '<@100> play a sound');
  await onMessage(looping.message, client);
  assert.deepEqual(looping.answers, ['Alas, no sounds.']);
  assert.ok(sent.every((s) => s.tools?.length));
  assert.deepEqual(
    sent.map((s) => s.tool_choice),
    [undefined, undefined, undefined, undefined, { type: 'none' }],
  );
  assert.equal((sent[1].messages[2].content as { content: string }[])[0].content, 'There are no sounds yet.');
});

test('Sonnet and Opus can be picked, and the chat settings are checked', () => {
  const guild = fakeGuild('g-settings') as never;
  assert.deepEqual(checkSetting(guild, 'chatModel', 'opus'), { value: 'opus' });
  assert.deepEqual(checkSetting(guild, 'chatModel', 'sonnet'), { value: 'sonnet' });
  assert.match((checkSetting(guild, 'chatModel', 'gpt') as { error: string }).error, /Haiku 5.5, Claude Sonnet 5.5 or Claude Opus 5.5/);
  assert.deepEqual(checkSetting(guild, 'chatPersonality', '  A grumpy pirate.  '), { value: 'A grumpy pirate.' });
  assert.match((checkSetting(guild, 'chatPersonality', '!!!') as { error: string }).error, /Describe who the bot is/);
  assert.match((checkSetting(guild, 'chatPersonality', 'a'.repeat(1001)) as { error: string }).error, /1000 characters/);
  assert.match((checkSetting(guild, 'chatDailyLimit', 0) as { error: string }).error, /1 to 5000/);
  // Opus costs more
  db.prepare("INSERT INTO chat_usage (guild_id, day, model, replies, input_tokens, output_tokens) VALUES ('g-cost', ?, 'opus', 1, 1000000, 0)").run(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(Date.now()));
  assert.equal(chatUsage('g-cost').cost, 4);
});

test('albums come with their years, and an artist’s albums newest first, for “their latest album”', async () => {
  const guild = fakeGuild('g-albums');
  const member = fakeMember(guild);
  assert.equal(
    await useTool(member as never, 'find_music', { query: 'the wall', kind: 'album' }),
    `album: “The Wall” by Pink Floyd, 1979 (ref spotify:album:${id22('wall')})\nsingle or EP: “Wall Demos” by Pink Floyd, 2011 (ref spotify:album:${id22('ep')})`,
  );
  const albums = await useTool(member as never, 'artist_albums', { ref: `artist:${id22('TheStrokes')}:The Strokes` });
  assert.deepEqual(
    albums.split('\n').map((l) => /“(.+?)”/.exec(l)?.[1] ?? l),
    ['Newest first:', 'Reality Awaits', 'The New Abnormal', 'Is This It'],
  );
  assert.match(albums, /“Reality Awaits” by The Strokes, 2026/);
  // A ref with only their name finds them by it
  assert.equal(await useTool(member as never, 'artist_albums', { ref: 'artist:The Strokes' }), albums);
  assert.equal(await useTool(member as never, 'artist_albums', { ref: 'the strokes' }), 'Give an artist’s ref from find_music.');
});

test('Answer in voice: voice only posts the answer after all when it can’t be said, and the old switch carries over', async () => {
  const guild = fakeGuild('g-voice');
  setSetting(guild.id, 'chatVoice', 'only');
  // Not in voice, so there's nowhere to say it
  replies = [turn('end_turn', text('Your humble servant hears you!'))];
  const asked = fakeMessage(guild, fakeMember(guild, '230'), '<@100> hello');
  await onMessage(asked.message, client);
  assert.deepEqual([asked.answers, asked.reactions], [['Your humble servant hears you!'], []]);
  // Nothing goes in Activity for an answer that only talks
  assert.deepEqual(recentActivity(guild.id, 10), []);
  // One that pings someone is posted, as a ping only works in text, and only once when it can't be said
  fakeMember(guild, '202');
  replies = [turn('end_turn', text('Hail, @Person 202!'))];
  const pinging = fakeMessage(guild, fakeMember(guild, '231'), '<@100> greet my friend');
  await onMessage(pinging.message, client);
  assert.deepEqual([pinging.answers, pinging.pinged, pinging.reactions], [['Hail, <@202>!'], [['202']], []]);

  // A server that had "Say answers aloud" on answers in text and voice; one that had it off is left on the default
  db.prepare("INSERT INTO guild_settings (guild_id, key, value) VALUES ('g-had-aloud', 'chatSpeak', 'true'), ('g-had-quiet', 'chatSpeak', 'false')").run();
  chat.setup!({ on() {} } as never);
  assert.deepEqual([setting('g-had-aloud', 'chatVoice'), setting('g-had-quiet', 'chatVoice')], ['also', 'off']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM guild_settings WHERE key = 'chatSpeak'").get()?.n, 0);
  assert.deepEqual(checkSetting(guild as never, 'chatVoice', 'only'), { value: 'only' });
  assert.match((checkSetting(guild as never, 'chatVoice', 'loud') as { error: string }).error, /voice only/);
});

test('it pings people talking in the channel or in voice by name, and nobody else', async () => {
  const guild = fakeGuild('g-pings');
  const asker = fakeMember(guild);
  // Friend (202) wrote the channel's last message; 203 is in voice; 204 is neither
  const friend = fakeMember(guild, '202');
  friend.displayName = 'Friend';
  fakeMember(guild, '203').displayName = 'Sam';
  fakeMember(guild, '204').displayName = 'Lurker';
  // Someone in voice with the asker's name can't be told from them, so isn't pinged
  fakeMember(guild, '206').displayName = 'Person 201';
  Object.assign(guild, { voiceStates: { cache: new Map(['203', '206'].map((id) => [id, { id, channelId: 'v1' }])) } });
  replies = [turn('end_turn', text('Hear ye, @Friend and @Sam, and @Lurker and @everyone!'))];
  const asked = fakeMessage(guild, asker, '<@100> honour my friends');
  await onMessage(asked.message, client);
  assert.deepEqual(asked.answers, ['Hear ye, <@202> and <@203>, and @Lurker and @everyone!']);
  assert.deepEqual(asked.pinged, [['202', '203']]);
  assert.match(sent[0].messages[0].content as string, /People you can @mention: @Friend, @Sam\./);
});

test('it can show the queue, and take out what it just queued when that was wrong', async () => {
  const guild = fakeGuild('g-undo');
  const member = fakeMember(guild);
  replies = [
    turn('tool_use', toolUse('t1', 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false })),
    turn('end_turn', text('The Wall, my liege.')),
  ];
  await answer(fakeMessage(guild, member, '<@100> play the wall').message, member as never, BOT);
  assert.match(await useTool(member as never, 'show_queue', {}), /Nothing is playing\. First in the queue: “In the Flesh\?” by Pink Floyd, added by Person 201\.\nNext:\n1\. “The Thin Ice” by Pink Floyd, added by Person 201\nAutoplay is off\./);

  // Someone else's songs stay
  const other = fakeMember(guild, '205');
  await useTool(other as never, 'queue_music', { ref: `artist:${id22('TheStrokes')}:The Strokes`, next: false, shuffle: false });
  replies = [turn('tool_use', toolUse('t2', 'undo_queue', {})), turn('end_turn', text('Banished.'))];
  await answer(fakeMessage(guild, member, '<@100> wrong album').message, member as never, BOT);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday'],
  );
  assert.match(String((sent.at(-1)!.messages.at(-1)!.content as { content: string }[])[0]!.content), /^Took out 2 songs: “In the Flesh\?”, “The Thin Ice”\./);
  // Only once
  assert.equal(await useTool(member as never, 'undo_queue', {}), 'You haven’t queued anything for them lately.');
  clearQueue(guild.id, 'test');
});

test('queueing the right thing in place of what it queued last takes that out first', async () => {
  const guild = fakeGuild('g-replace');
  const member = fakeMember(guild);
  replies = [
    turn('tool_use', toolUse('t1', 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false, replaces_last: false })),
    turn('end_turn', text('The Wall, my liege.')),
  ];
  await answer(fakeMessage(guild, member, '<@100> play the wall').message, member as never, BOT);
  // A replacement that finds nothing leaves what was there, and it can still be replaced after
  replies = [
    turn('tool_use', toolUse('t2', 'queue_music', { ref: 'nothing by this name', next: false, shuffle: false, replaces_last: true })),
    turn('end_turn', text('Alas.')),
  ];
  await answer(fakeMessage(guild, member, '<@100> no, the other one').message, member as never, BOT);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['In the Flesh?', 'The Thin Ice'],
  );
  replies = [
    turn('tool_use', toolUse('t3', 'queue_music', { ref: `artist:${id22('TheStrokes')}:The Strokes`, next: false, shuffle: false, replaces_last: true })),
    turn('end_turn', text('The Strokes instead, my liege.')),
  ];
  await answer(fakeMessage(guild, member, '<@100> no, I meant the strokes').message, member as never, BOT);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday'],
  );
  assert.match(String((sent.at(-1)!.messages.at(-1)!.content as { content: string }[])[0]!.content), /^Took out 2 songs: “In the Flesh\?”, “The Thin Ice”\.[^]*Added/);
  clearQueue(guild.id, 'test');
});

test('a correction in the same answer takes out what that answer queued, not what was asked for before', async () => {
  const guild = fakeGuild('g-replace-now');
  const member = fakeMember(guild);
  replies = [
    turn('tool_use', toolUse('t1', 'queue_music', { ref: `artist:${id22('TheStrokes')}:The Strokes`, next: false, shuffle: false, replaces_last: false })),
    turn('end_turn', text('The Strokes, my liege.')),
  ];
  await answer(fakeMessage(guild, member, '<@100> queue the strokes').message, member as never, BOT);
  replies = [
    turn('tool_use', toolUse('t2', 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false, replaces_last: false })),
    turn('tool_use', toolUse('t3', 'queue_music', { ref: `spotify:album:${id22('ep')}`, next: false, shuffle: false, replaces_last: true })),
    turn('end_turn', text('The demos instead.')),
  ];
  await answer(fakeMessage(guild, member, '<@100> add the wall demos').message, member as never, BOT);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday', 'Demo'],
  );
  // And what the answer is remembered for is what it left in
  assert.match(await useTool(member as never, 'undo_queue', {}), /^Took out 1 song: “Demo”\./);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday'],
  );
  clearQueue(guild.id, 'test');

  // Two undos in one answer take out both of its batches, newest first, and leave the answer before alone
  await useTool(member as never, 'queue_music', { ref: `artist:${id22('TheStrokes')}:The Strokes`, next: false, shuffle: false });
  const now: Turn = { queued: [] };
  await useTool(member as never, 'queue_music', { ref: `spotify:album:${id22('wall')}`, next: false, shuffle: false }, now);
  await useTool(member as never, 'queue_music', { ref: `spotify:album:${id22('ep')}`, next: false, shuffle: false }, now);
  assert.match(await useTool(member as never, 'undo_queue', {}, now), /^Took out 1 song: “Demo”/);
  assert.match(await useTool(member as never, 'undo_queue', {}, now), /^Took out 2 songs: “In the Flesh\?”, “The Thin Ice”/);
  assert.deepEqual(
    queueOf(guild.id).map((r) => r.title),
    ['Reptilia', 'Last Nite', 'Someday'],
  );
  clearQueue(guild.id, 'test');
});

test('a closing offer is left off, but not a real question, nor an answer that’s only that', () => {
  const cases: [string, string][] = [
    ['Hades II is $29.99 on Steam. Shall I also check other stores?', 'Hades II is $29.99 on Steam.'],
    ['Alas, I cannot rewrite my words! Might I suggest a fresh ode to tacos, with all the grandeur you deserve?', 'Alas, I cannot rewrite my words!'],
    ['You both own Deep Rock Galactic. Shall I... no, I shan’t offer anything further; do pick one!', 'You both own Deep Rock Galactic.'],
    ['Done. Mr. Brightside is queued. If you’d like, I can add more of theirs.', 'Done. Mr. Brightside is queued.'],
    ['The fixes:\n- Boats float\n- Storms stay out\n\n*Let me know if you want the rest.*', 'The fixes:\n- Boats float\n- Storms stay out'],
    // Tacked onto the last sentence, or asked and taken back
    ['Your gratitude is most gratefully received, esteemed Robin! Do enjoy The Wall, and do let me know if there’s anything else my humble circuits can fetch.', 'Your gratitude is most gratefully received, esteemed Robin! Do enjoy The Wall.'],
    ['I queued Mr. Brightside, shall I add more?', 'I queued Mr. Brightside.'],
    ['Queued and playing; say the word for more!', 'Queued and playing!'],
    ['Splendid, the reminder is set — should you need anything else, I am here.', 'Splendid, the reminder is set.'],
    ['Oh, esteemed guest, yes! "Reality Awaits" is the 2026 album by The Strokes. Shall I play it? No, I shall not ask; I shall simply wait for your command with bated circuits.', 'Oh, esteemed guest, yes! "Reality Awaits" is the 2026 album by The Strokes.'],
    ['Indeed, my liege! *Reality Awaits* is a 2026 album by The Strokes, and I am delighted to have it in my records. Shall I... no, no offers. Carry on, esteemed guest.', 'Indeed, my liege! *Reality Awaits* is a 2026 album by The Strokes, and I am delighted to have it in my records. Carry on, esteemed guest.'],
  ];
  for (const [said, posted] of cases) assert.equal(withoutOffer(said), posted, said);
  for (const kept of [
    'Shall I queue it?',
    'Two people match: Sam and Sasha. Which of them do you mean?',
    'I found two. Would you like the EP or the album?',
    'Shall I play it? No, I shall not ask.',
    'I found it. Shall I queue it? There’s no other version, so ask if you want a live one.',
    'Found it. Shall I queue it? No worries, just ask. It’s #3 in the queue already.',
    'Robin asks if I am useless. No, I merely wonder why anyone would ask that while losing 300 hours to Valheim’s trolls.',
    'Pick one, and let me know which: the EP or the album.',
    'Your reminder is set; let me know.',
    'I couldn’t find that song, but there’s a live version by them. Shall I queue it?',
    'It’s Wednesday. Splendid, is it not?',
  ])
    assert.equal(withoutOffer(kept), kept);
});

test('it sees the images attached to the message asking and the one it replies to, a few at most, within the API’s limits', async () => {
  const guild = fakeGuild('g-images');
  const member = fakeMember(guild);
  replies = [turn('end_turn', text('A fine slime bucket, my liege.'))];
  const asked = fakeMessage(guild, member, '<@100> rate this');
  const image = (id: string, extra: Record<string, unknown> = {}) => ({ id, url: `https://cdn.test/${id}.png`, contentType: 'image/png', size: 4, width: 512, height: 512, ...extra });
  const files = (asked.message as unknown as { attachments: Map<string, unknown> }).attachments;
  files.set('a1', image('a1'));
  files.set('a2', image('a2', { size: 9_000_000 }));
  files.set('a3', { id: 'a3', url: 'https://cdn.test/a3.zip', contentType: 'application/zip', size: 10 });
  files.set('a4', image('a4', { contentType: 'image/heic' }));
  await onMessage(asked.message, client);
  assert.deepEqual(asked.answers, ['A fine slime bucket, my liege.']);
  const [shown, said] = sent.at(-1)!.messages[0]!.content as { type: string; source?: { type: string; media_type: string; data: string }; text?: string }[];
  assert.deepEqual(shown, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') } });
  assert.match(said!.text!, /asks you:\nPerson 201: \S+ rate this \[an image, an image, a file and an image attached\]/);
  assert.match(said!.text!, /Before this text: 1 image from Person 201’s message\. Images attached that you can’t see: 1 in a kind you can’t read and 1 too large\./);
  assert.deepEqual((said as { cache_control?: unknown }).cache_control, { type: 'ephemeral' });

  // Without images it's text, as before
  replies = [turn('end_turn', text('Indeed.'))];
  const plainAsk = fakeMessage(guild, fakeMember(guild, '206'), '<@100> hello');
  await onMessage(plainAsk.message, client);
  assert.equal(typeof sent.at(-1)!.messages[0]!.content, 'string');
});

const cite = (url: string) => ({ type: 'web_search_result_location', url, title: 'A guide', encrypted_index: 'i', cited_text: 'Strength' });
const searched = (id: string, query: string, url: string) => [
  { type: 'server_tool_use', id, name: 'web_search', input: { query } },
  { type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', url, title: 'A guide', encrypted_content: 'e', page_age: null }] },
];

test('it searches the web for a build, and posts the answer whole with its sources under it, each site once and without previews', async () => {
  const guild = fakeGuild('g-search');
  const member = fakeMember(guild);
  replies = [
    {
      ...turn(
        'end_turn',
        text('Let me look that up.'),
        ...searched('srv_1', 'slay the spire 2 ironclad build', 'https://www.thegamer.com/sts2-ironclad/'),
        text('The usual pick is '),
        { type: 'text', text: 'a Strength build with Inflame and Demon Form', citations: [cite('https://www.thegamer.com/sts2-ironclad/'), cite('https://www.thegamer.com/sts2-tier-list/')] },
        text(', though '),
        { type: 'text', text: 'Exhaust has a higher ceiling', citations: [cite('https://example.com/a_(b)')] },
        text('.'),
      ),
      usage: { input_tokens: 15000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
    },
  ];
  const asked = fakeMessage(guild, member, '<@100> good ironclad build in slay the spire 2?');
  await onMessage(asked.message, client);
  assert.deepEqual(asked.answers, [
    'The usual pick is a Strength build with Inflame and Demon Form, though Exhaust has a higher ceiling.\n-# Sources: [thegamer.com](https://www.thegamer.com/sts2-ironclad/) · [example.com](https://example.com/a_%28b%29)',
  ]);
  assert.deepEqual(asked.flags, [MessageFlags.SuppressEmbeds]);
  const offered = sent[0]!.tools!.find((t) => t.name === 'web_search') as unknown as { type: string; max_uses: number };
  assert.deepEqual([offered.type, offered.max_uses], ['web_search_20250305', 2]);
  assert.match(sent[0]!.system[0]!.text, /search the web with web_search/);
  // A search costs a cent on top of its tokens
  assert.ok(Math.abs(chatUsage(guild.id).cost - (0.01 + (15000 * 0.1 + 300 * 0.5) / 1e6)) < 1e-9);
});

test('with everything set up, it offers no more strict tools than the API takes', async (t) => {
  const was = { voiceUrl: config.voiceUrl, steamApiKey: config.steamApiKey, musicUrl: config.musicUrl, musicToken: config.musicToken };
  t.after(() => Object.assign(config, was));
  Object.assign(config, { voiceUrl: 'http://voice.test', steamApiKey: 'steam-key', musicUrl: 'http://music.test', musicToken: 'music-token' });
  const guild = fakeGuild('g-strict');
  setSetting(guild.id, 'tts', true);
  t.after(() => setSetting(guild.id, 'tts', undefined));
  replies = [turn('end_turn', text('Ready, my liege.'))];
  await onMessage(fakeMessage(guild, fakeMember(guild), '<@100> hello').message, client);
  const offered = sent[0]!.tools as unknown as { name: string; strict?: boolean }[];
  assert.ok(offered.some((tool) => tool.name === 'say_aloud') && offered.some((tool) => tool.name === 'achievements'));
  const strict = offered.filter((tool) => tool.strict).map((tool) => tool.name);
  assert.ok(strict.length <= MOST_STRICT_TOOLS, `${strict.length} strict tools: ${strict.join(', ')}`);
  // Those with more than one plain text to give keep it, the last ones too, so none lose it to the limit
  assert.ok(strict.includes('queue_music') && strict.includes('plan_game_night') && !strict.includes('show_queue') && !strict.includes('play_sound'));
  // The actions above all, as their ids, choices and times matter most
  for (const name of ACTIONS) assert.ok(strict.includes(name), `${name} isn’t strict: ${strict.length} strict tools: ${strict.join(', ')}`);
});

test('past the API’s limit of strict tools, the last ones aren’t strict, and those with no input or one plain text never are', () => {
  const tool = (name: string, properties: Record<string, unknown>) => ({ name, strict: true, input_schema: { type: 'object' as const, properties } });
  const many = Array.from({ length: 25 }, (_, n) => tool(`t${n}`, { a: { type: 'string' }, b: { type: 'string' } }));
  const list = strictAtMost([tool('none', {}), tool('text', { a: { type: 'string' } }), tool('choice', { a: { type: 'string', enum: ['x'] } }), ...many, tool('set_reminder', { a: { type: 'string' }, b: { type: 'string' } })]);
  const strict = list.filter((t) => 'strict' in t && t.strict).map((t) => ('name' in t ? t.name : ''));
  // One that does something comes first, even last in the list
  assert.deepEqual(strict, ['choice', ...many.slice(0, MOST_STRICT_TOOLS - 2).map((t) => t.name), 'set_reminder']);
  assert.equal(list.length, 29);
});

test('when the API refuses the tools as too much to check strictly, fewer are strict, and the answer still comes', async () => {
  const guild = fakeGuild('g-grammar');
  const grammar = { refused: 'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.' };
  const warned = mock.method(console, 'warn', () => {});
  replies = [grammar, turn('end_turn', text('Present, my liege.')), turn('end_turn', text('Still here.'))];
  const first = fakeMessage(guild, fakeMember(guild), '<@100> hello');
  await onMessage(first.message, client);
  assert.deepEqual(first.answers, ['Present, my liege.']);
  const strictIn = (n: number) => (sent[n]!.tools as unknown as { strict?: boolean }[]).filter((tool) => tool.strict).length;
  assert.ok(strictIn(0) > 0 && strictIn(1) <= Math.floor(MOST_STRICT_TOOLS / 2), `${strictIn(0)} then ${strictIn(1)}`);
  assert.equal(warned.mock.callCount(), 1);
  // And so are the next answers'
  const second = fakeMessage(guild, fakeMember(guild, '218'), '<@100> you there?');
  await onMessage(second.message, client);
  assert.equal(strictIn(2), strictIn(1));
  warned.mock.restore();
});

test('at the start it sends each set of tools once, for one token, and learns from a refusal before anyone asks', async (t) => {
  const [one, same, quiet, other] = ['g-warm-1', 'g-warm-2', 'g-warm-3', 'g-warm-4'].map(fakeGuild);
  setSetting(quiet.id, 'chat', false);
  setSetting(other.id, 'chatActions', false);
  t.after(() => [quiet, other].forEach((g) => [setSetting(g.id, 'chat', undefined), setSetting(g.id, 'chatActions', undefined)]));
  const warned = t.mock.method(console, 'warn', () => {});
  const grammar = { refused: 'The compiled grammar is too large, which would cause performance issues.' };
  replies = [grammar, turn('max_tokens', text('.')), turn('max_tokens', text('.'))];
  await warmUp([one, same, quiet, other] as never);
  // The first refused and sent again with fewer strict, the same tools not again, a server with chat off not at all, and one with other tools once
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => (s as unknown as { max_tokens: number }).max_tokens === 1 && !s.system));
  const strictIn = (n: number) => (sent[n]!.tools as unknown as { strict?: boolean }[]).filter((tool) => tool.strict).length;
  assert.ok(strictIn(1) < strictIn(0), `${strictIn(0)} then ${strictIn(1)}`);
  assert.ok(!(sent[2]!.tools as unknown as { name: string }[]).some((tool) => tool.name === 'plan_game_night'));
  assert.equal(warned.mock.callCount(), 1);
  assert.equal(replies.length, 0);

  // Nothing goes wrong when the API is down: it's only said
  resetChat();
  apiDown = true;
  await warmUp([one] as never);
  assert.equal(warned.mock.callCount(), 2);
  assert.match(String(warned.mock.calls[1]!.arguments[0]), /couldn’t get ready for server g-warm-1: 529/);
});

test('people getting going warm the tools up again only when they haven’t been sent for 20 hours, and an answer counts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const guild = fakeGuild('g-ready');
  const warned = t.mock.method(console, 'warn', () => {});
  const HOUR = 3_600_000;
  replies = [turn('max_tokens', text('.'))];
  // A burst of activity while it's under way sends it once
  await Promise.all([getReady(guild as never), getReady(guild as never), getReady(guild as never)]);
  assert.equal(sent.length, 1);
  // Ready, so people talking or joining voice for the next 20 hours sends nothing
  t.mock.timers.tick(19 * HOUR);
  await getReady(guild as never);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(2 * HOUR);
  replies = [turn('max_tokens', text('.'))];
  await getReady(guild as never);
  assert.equal(sent.length, 2);

  // An answer sends the same tools, so it counts
  t.mock.timers.tick(19 * HOUR);
  replies = [turn('end_turn', text('At your service.'))];
  await onMessage(fakeMessage(guild, fakeMember(guild), '<@100> hello').message, client);
  t.mock.timers.tick(2 * HOUR);
  await getReady(guild as never);
  assert.equal(sent.length, 3);

  // Failing, it's tried again after 10 minutes, not with every message
  t.mock.timers.tick(21 * HOUR);
  apiDown = true;
  await getReady(guild as never);
  await getReady(guild as never);
  assert.deepEqual([sent.length, warned.mock.callCount()], [3, 1]);
  t.mock.timers.tick(11 * 60_000);
  apiDown = false;
  replies = [turn('max_tokens', text('.'))];
  await getReady(guild as never);
  assert.equal(sent.length, 4);
});

test('what counts as people getting going: joining voice, and talking, but not to the bot', () => {
  const state = (channelId: string | null, bot = false) => ({ channelId, member: { user: { bot } } }) as never;
  assert.equal(joinsVoice(state(null), state('v1')), true);
  assert.equal(joinsVoice(state('v1'), state('v2')), false, 'moving between channels');
  assert.equal(joinsVoice(state('v1'), state(null)), false, 'leaving');
  assert.equal(joinsVoice(state(null), state('v1', true)), false, 'a bot');
  const guild = fakeGuild('g-talk');
  const said = (content: string, bot = false) => {
    const { message } = fakeMessage(guild, fakeMember(guild), content) as unknown as { message: { author: Record<string, unknown> } };
    return Object.assign(message, { author: { ...message.author, bot } }) as never;
  };
  assert.equal(talksNearby(said('anyone on tonight?'), BOT), true);
  assert.equal(talksNearby(said('<@100> play the wall'), BOT), false, 'a question gets it ready by itself');
  assert.equal(talksNearby(said('beep', true), BOT), false);
});

test('a long search that pauses is sent back as it is to carry on, and with web search off it isn’t offered', async (t) => {
  const guild = fakeGuild('g-search-more');
  replies = [turn('pause_turn', ...searched('srv_2', 'bonemass tips', 'https://valheim.fandom.com/wiki/Bonemass')), turn('end_turn', text('Bring a mace: Bonemass hates blunt damage.'))];
  const asked = fakeMessage(guild, fakeMember(guild), '<@100> tips for bonemass?');
  await onMessage(asked.message, client);
  assert.deepEqual([asked.answers, asked.flags], [['Bring a mace: Bonemass hates blunt damage.'], [undefined]]);
  assert.equal(sent.length, 2);
  const [, resumed] = sent;
  assert.deepEqual(
    resumed!.messages.map((m) => m.role),
    ['user', 'assistant'],
  );

  setSetting(guild.id, 'chatWebSearch', false);
  t.after(() => setSetting(guild.id, 'chatWebSearch', undefined));
  replies = [turn('end_turn', text('Alas, the wider world is beyond my reach.'))];
  await onMessage(fakeMessage(guild, fakeMember(guild, '205'), '<@100> tips for moder?').message, client);
  assert.ok(!sent.at(-1)!.tools!.some((tool) => tool.name === 'web_search'));
  assert.doesNotMatch(sent.at(-1)!.system[0]!.text, /web_search|searching the web/);
});

test('the sources line links each site once, at most three, only web pages, and the answer is cut to leave room for it', () => {
  assert.equal(sourcesLine([]), '');
  assert.equal(sourcesLine(['ftp://files.example.com/a', 'not a link', `https://long.example.com/${'a'.repeat(400)}`]), '');
  assert.equal(sourcesLine(['https://www.a.com/1', 'https://a.com/2', 'https://b.com/1', 'https://c.com/1', 'https://d.com/1']), '\n-# Sources: [a.com](https://www.a.com/1) · [b.com](https://b.com/1) · [c.com](https://c.com/1)');
  const tail = sourcesLine([`https://a.com/${'x'.repeat(280)}`]);
  const { reply, post } = finished('g-tail', 'y'.repeat(3000), new Map(), tail);
  assert.ok(post.length <= 2000 && reply.endsWith('…') && post === reply + tail);
});

test('web search is limited across an answer, its pages are cached for the next round, and it’s dropped where the API refuses it', async () => {
  const guild = fakeGuild('g-search-limits');
  const used = (n: number) => ({ input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: n, web_fetch_requests: 0 } });
  replies = [
    { ...turn('tool_use', ...searched('srv_3', 'deep rock builds', 'https://a.com/1'), ...searched('srv_4', 'deep rock driller', 'https://b.com/1'), toolUse('t1', 'show_queue', {})), usage: used(2) },
    { ...turn('tool_use', toolUse('t2', 'show_queue', {})), usage: used(0) },
    turn('end_turn', text('Driller it is.')),
  ];
  await onMessage(fakeMessage(guild, fakeMember(guild), '<@100> best deep rock class?').message, client);
  const maxUses = (s: (typeof sent)[number]) => (s.tools!.find((tool) => tool.name === 'web_search') as unknown as { max_uses: number }).max_uses;
  // Two searches is all an answer gets, as near as the API allows
  assert.deepEqual(sent.map(maxUses), [2, 1, 1]);
  // One moving breakpoint on the tool results, besides the instructions
  const marks = (s: (typeof sent)[number]) =>
    s.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as { cache_control?: unknown }[]) : [])).filter((b) => b.cache_control).length;
  assert.deepEqual(sent.map(marks), [0, 1, 1]);
  assert.deepEqual((sent[2]!.messages.at(-1)!.content as { cache_control?: unknown }[]).at(-1)!.cache_control, { type: 'ephemeral' });

  replies = [{ refused: 'web search is not enabled for this organization' }, turn('end_turn', text('From memory: Driller.'))];
  const asked = fakeMessage(guild, fakeMember(guild, '206'), '<@100> best deep rock class?');
  await onMessage(asked.message, client);
  assert.deepEqual(asked.answers, ['From memory: Driller.']);
  assert.ok(sent.at(-2)!.tools!.some((tool) => tool.name === 'web_search') && !sent.at(-1)!.tools!.some((tool) => tool.name === 'web_search'));
  assert.doesNotMatch(sent.at(-1)!.system[0]!.text, /web_search/);
});

test('an answer full of pings is cut to fit once they’re made', () => {
  const people = new Map(['Al', 'Bo', 'Cy', 'Di', 'Ed', 'Fi'].map((name, i) => [name, `12345678901234567${i}`]));
  const pings = ' @Al @Bo @Cy @Di @Ed @Fi';
  const long = finished('g-pings', `${'x'.repeat(1900 - pings.length)}${pings}`, people);
  assert.ok(long.reply.length <= 2000, String(long.reply.length));
  // A name cut in half isn't a ping
  assert.equal(long.users.length, 3);
  assert.match(long.reply, /<@123456789012345672> @D…$/);
  assert.deepEqual(finished('g-pings', 'hi @Al', people), { reply: 'hi <@123456789012345670>', post: 'hi <@123456789012345670>', users: ['123456789012345670'] });
  // Nothing but pings: cut to what fits, not to nothing
  const dense = finished('g-pings', '@Al '.repeat(475).trim(), people);
  assert.ok(dense.reply.length <= 2000 && dense.reply.length > 1500, String(dense.reply.length));
  assert.deepEqual(dense.users, ['123456789012345670']);
});

test('it remembers what people ask it to about themselves, and tells it to itself when they ask again', async () => {
  const guild = fakeGuild('g-notes');
  const member = fakeMember(guild);
  const turnOf: Turn = { queued: [] };
  assert.equal(await useTool(member as never, 'remember', { note: '  Wants to be called   Master. ' }, turnOf), 'Remembered about them: Wants to be called Master.');
  assert.equal(noteOf(guild.id, member.id), 'Wants to be called Master.');
  assert.deepEqual(
    chatNotes(guild as never).map((n) => [n.userId, n.name, n.note]),
    [['201', 'Person 201', 'Wants to be called Master.']],
  );
  replies = [turn('end_turn', text('As you wish, Master.'))];
  await answer(fakeMessage(guild, member, '<@100> hello').message, member as never, BOT);
  assert.match(sent.at(-1)!.messages[0]!.content as string, /What you remember about Person 201: Wants to be called Master\./);
  // Up to the longest note, and empty forgets
  await useTool(member as never, 'remember', { note: 'x'.repeat(500) });
  assert.equal(noteOf(guild.id, member.id)?.length, 200);
  assert.equal(await useTool(member as never, 'remember', { note: '' }), 'Forgot what you remembered about them.');
  assert.equal(noteOf(guild.id, member.id), null);
});

test('it knows the date, who’s in voice and playing what, and the bot’s commands, which its answers make clickable', async () => {
  const guild = fakeGuild('g-knows');
  rememberCommands(guild.id, [
    { name: 'whatdoweplay', id: '900', description: 'Pick a game everyone in voice can play', type: 1 },
    { name: 'gamenight', id: '901', description: 'Game nights', type: 1, options: [{ type: 1, name: 'plan', description: 'Plans a game night' }, { type: 1, name: 'list', description: 'Upcoming game nights' }] },
    { name: 'setup', id: '902', description: 'Server settings', type: 1, defaultMemberPermissions: {}, options: [{ type: 1, name: 'show', description: 'Show settings' }] },
    { name: 'Compare with me', id: '903', type: 2 },
  ]);
  const asker = fakeMember(guild);
  const sam = fakeMember(guild, '202');
  Object.assign(sam, { displayName: 'Sam', presence: { activities: [{ type: 0, name: 'Deep Rock Galactic' }] } });
  Object.assign(fakeMember(guild, '203'), { displayName: 'Alex', presence: { activities: [{ type: 0, name: 'Valheim' }] } });
  guild.channels.cache.set('v1', { id: 'v1', name: 'Hangout', permissionsFor: () => ({ has: () => true }) });
  Object.assign(guild, { voiceStates: { cache: new Map([['202', { id: '202', channelId: 'v1' }]]) } });
  // Someone in a channel not everyone can see is neither named nor said to be outside voice
  Object.assign(fakeMember(guild, '204'), { displayName: 'Jo', presence: { activities: [{ type: 0, name: 'Halo' }] } });
  guild.channels.cache.set('v2', { id: 'v2', name: 'Secret', permissionsFor: () => ({ has: () => false }) });
  Object.assign(guild, {
    voiceStates: {
      cache: new Map([
        ['202', { id: '202', channelId: 'v1' }],
        ['204', { id: '204', channelId: 'v2' }],
      ]),
    },
  });
  replies = [turn('end_turn', text('Try `/gamenight plan`, or /whatdoweplay, or /setup show, or _/whatdoweplay_ or __/whatdoweplay__. /gamenight alone runs nothing, /gamenights is no command, nor is example.com/whatdoweplay.'))];
  const asked = fakeMessage(guild, asker, '<@100> what should we play friday?');
  await onMessage(asked.message, client);
  assert.deepEqual(asked.answers, [
    'Try </gamenight plan:901>, or </whatdoweplay:900>, or </setup show:902>, or _</whatdoweplay:900>_ or __</whatdoweplay:900>__. /gamenight alone runs nothing, /gamenights is no command, nor is example.com/whatdoweplay.',
  ]);
  const context = sent.at(-1)!.messages[0]!.content as string;
  assert.match(context, /Now: \w+day, \w+ \d+, \d{4} at \d+:\d\d\s[AP]M\./);
  assert.match(context, /\nIn voice: Hangout: Sam \(playing Deep Rock Galactic\)\. Playing outside voice: Alex \(playing Valheim\)\.\n/);
  const prompt = (sent.at(-1)!.system as { text: string }[])[0]!.text;
  assert.match(prompt, /\n\/whatdoweplay: Pick a game everyone in voice can play\n\/gamenight plan: Plans a game night\n\/gamenight list: Upcoming game nights\n\/setup: Server settings \(for server admins\)\nApps on a message or a member [^\n]*: Compare with me\n\nThe bot’s web UI/);
  // With the web UI's address set, it's given to link to
  config.webAddress = 'https://bot.example.test';
  resetChat();
  try {
    replies = [turn('end_turn', text('It’s at https://bot.example.test.'))];
    await onMessage(fakeMessage(guild, asker, '<@100> how do i use the web ui?').message, client);
    assert.match((sent.at(-1)!.system as { text: string }[])[0]!.text, /web UI, at https:\/\/bot\.example\.test, has a tab[^\n]*with the link\./);
  } finally {
    config.webAddress = null;
  }
  // A command that's gone isn't made clickable from what was registered before
  rememberCommands(guild.id, [{ name: 'whatdoweplay', id: '900', description: 'Pick a game', type: 1 }]);
  assert.equal(commandMention(guild.id, 'gamenight plan'), '`/gamenight plan`');
});

// A line in its personality above the bot's own posts

/** A channel that keeps what's posted in it */
function postChannel(guild: ReturnType<typeof fakeGuild>) {
  const posted: { content?: string; embeds?: unknown[]; allowedMentions?: unknown }[] = [];
  return { channel: { id: '900', guild, send: async (m: (typeof posted)[number]) => (posted.push(m), { id: 'posted' }) } as never, posted };
}
const LEADERBOARD = { embeds: [{ title: '🏆 This week', description: '1. **Sam**: 12 h\n2. **Alex**: 3 h', footer: { text: 'Monday to Sunday' } }] };

test('lines on automatic posts are on by default, one above the post, written from what it says, until a server turns them off', async (t) => {
  const guild = fakeGuild('g-lines');
  const { channel, posted } = postChannel(guild);
  setSetting(guild.id, 'chatPostLines', false);
  t.after(() => setSetting(guild.id, 'chatPostLines', undefined));
  await sendPost('weekly', guild.id, channel, LEADERBOARD);
  assert.deepEqual([posted, sent], [[LEADERBOARD], []]);
  posted.length = 0;

  setSetting(guild.id, 'chatPostLines', undefined);
  // It can't ping or link, and only its first line counts
  replies = [turn('end_turn', text('“Sam, you magnificent <@123> menace! https://example.com @everyone”\nAnd another thing.'))];
  await sendPost('weekly', guild.id, channel, LEADERBOARD);
  assert.deepEqual(posted[0], { ...LEADERBOARD, content: 'Sam, you magnificent menace! @\u200beveryone' });
  assert.match(sent[0]!.system as unknown as string, /You are Slopkeeper, a bot in the Discord server “Test Server”\.[\s\S]*a weekly leaderboard/);
  assert.equal(sent[0]!.messages[0]!.content, 'The weekly leaderboard:\n🏆 This week\n1. **Sam**: 12 h\n2. **Alex**: 3 h\nMonday to Sunday');
  assert.equal(sent[0]!.model, MODELS.haiku.id);
  assert.equal(sent[0]!.tools, undefined);

  // Above a post with text of its own, which still pings who it did; roles read as names for the model
  replies = [turn('end_turn', text('The gang assembles.'))];
  const hopOn = { content: '<@&300> 🎮 **Sam** and **Alex** are in <#5>. Hop on!', allowedMentions: { roles: ['300'] } };
  await sendPost('hopOn', guild.id, channel, hopOn);
  assert.deepEqual(posted[1], { ...hopOn, content: `The gang assembles.\n${hopOn.content}` });
  assert.match(sent[1]!.messages[0]!.content as string, /^The hop-on ping:\n@DJ 🎮/);

  // Later pages of one post don't get one
  await sendPost('patchNotes', guild.id, channel, LEADERBOARD, false);
  assert.deepEqual([posted[2], sent.length], [LEADERBOARD, 2]);

  // Its cost counts toward the month, but not as an answer toward the day's limit
  const used = db.prepare('SELECT SUM(replies) AS replies, SUM(input_tokens) AS input FROM chat_usage WHERE guild_id = ?').get(guild.id) as { replies: number; input: number };
  assert.deepEqual({ ...used }, { replies: 0, input: 2000 });
});

test('a post goes out without its line when the model is down, refuses, or chat is off', async (t) => {
  const guild = fakeGuild('g-lines-2');
  const { channel, posted } = postChannel(guild);
  setSetting(guild.id, 'chatPostLines', true);
  t.after(() => setSetting(guild.id, 'chatPostLines', undefined));
  const warned = t.mock.method(console, 'warn', () => undefined);

  apiDown = true;
  await sendPost('weekly', guild.id, channel, LEADERBOARD);
  apiDown = false;
  replies = [turn('refusal')];
  await sendPost('weekly', guild.id, channel, LEADERBOARD);
  setSetting(guild.id, 'chat', false);
  t.after(() => setSetting(guild.id, 'chat', undefined));
  await sendPost('weekly', guild.id, channel, LEADERBOARD);
  assert.deepEqual(posted, [LEADERBOARD, LEADERBOARD, LEADERBOARD]);
  // The refusal was asked; being down says so in the log
  assert.equal(sent.length, 1);
  assert.equal(warned.mock.callCount(), 1);
});
