import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { asksBot, chatNote, chatUsage, COOLDOWN_MS, MODELS, onMessage, resetChat, useTool } from '../src/features/chat.ts';
import { clearQueue, queueOf } from '../src/features/music.ts';
import { checkSetting } from '../src/features/setup.ts';
import { setSetting } from '../src/settings.ts';
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

mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.anthropic.com/v1/messages')) {
    if (apiDown || (replies[0] as { down?: boolean } | undefined)?.down) return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
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
    if (where.startsWith('/search?type=album')) return Response.json({ albums: { items: [{ uri: `spotify:album:${id22('wall')}`, name: 'The Wall', artists: [{ name: 'Pink Floyd' }] }], next: null } });
    if (where.startsWith('/search?type=artist')) return Response.json({ artists: { items: [{ id: id22('TheStrokes'), uri: `spotify:artist:${id22('TheStrokes')}`, name: 'The Strokes' }], next: null } });
    if (where.startsWith('/search?type=track') && q.startsWith('artist:')) {
      return Response.json({ tracks: { items: [song(1, 'The Strokes', 'Last Nite'), song(2, 'The Strokes Tribute Band'), song(3, 'The Strokes', 'Someday'), song(4, 'The Strokes', 'A Namesake’s Song', id22('namesake'))], next: null } });
    }
    // A search by the name alone finds more of their songs, and some of the same
    if (where.startsWith('/search?type=track') && q.toLowerCase() === 'the strokes') {
      return Response.json({ tracks: { items: [song(5, 'The Strokes', 'Reptilia'), song(6, 'The Strokes', 'Last Nite')], next: null } });
    }
    if (where.startsWith(`/albums/${id22('wall')}`)) return Response.json({ name: 'The Wall', images: [], tracks: { items: [song(10, 'Pink Floyd', 'In the Flesh?'), song(11, 'Pink Floyd', 'The Thin Ice')], next: null } });
  }
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
    reply: async (m: { content: string; allowedMentions: unknown }) => {
      assert.deepEqual(m.allowedMentions, { parse: [], repliedUser: false }, 'an answer never pings anyone');
      answers.push(m.content);
    },
    react: async (e: string) => void reactions.push(e),
  };
  return { message: message as never, answers, reactions };
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
  assert.deepEqual(
    first.tools?.map((t) => t.name),
    ['find_music', 'queue_music', 'control_music', 'find_sound', 'play_sound'],
  );
  // The channel's last messages, with mentions as names, the music, and where the person is
  const asked = first.messages[0].content as string;
  assert.match(asked, /Friend: we should listen to @Person 201’s album later/);
  assert.match(asked, /No music is playing/);
  assert.match(asked, /Person 201 isn’t in a voice channel/);
  assert.match(asked, /Person 201 asks you:\nPerson 201: @Slopkeeper play the wall/);
  // What the tools said went back to it
  const found = (sent[1].messages[2].content as { content: string }[])[0].content;
  assert.match(found, /album: “The Wall” by Pink Floyd \(ref spotify:album:0+wall\)/);
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

test('Opus can be picked, and the chat settings are checked', () => {
  const guild = fakeGuild('g-settings') as never;
  assert.deepEqual(checkSetting(guild, 'chatModel', 'opus'), { value: 'opus' });
  assert.match((checkSetting(guild, 'chatModel', 'gpt') as { error: string }).error, /Haiku 5.5 or Claude Opus 5.5/);
  assert.deepEqual(checkSetting(guild, 'chatPersonality', '  A grumpy pirate.  '), { value: 'A grumpy pirate.' });
  assert.match((checkSetting(guild, 'chatPersonality', '!!!') as { error: string }).error, /Describe who the bot is/);
  assert.match((checkSetting(guild, 'chatPersonality', 'a'.repeat(1001)) as { error: string }).error, /1000 characters/);
  assert.match((checkSetting(guild, 'chatDailyLimit', 0) as { error: string }).error, /1 to 5000/);
  // Opus costs more
  db.prepare("INSERT INTO chat_usage (guild_id, day, model, replies, input_tokens, output_tokens) VALUES ('g-cost', ?, 'opus', 1, 1000000, 0)").run(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(Date.now()));
  assert.equal(chatUsage('g-cost').cost, 4);
});
