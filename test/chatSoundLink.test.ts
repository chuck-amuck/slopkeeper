import './helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { act, actionTools, readSeconds, soundsMade } from '../src/features/chatActions.ts';
import { findSound } from '../src/features/soundLibrary.ts';
import { resetDownloads, soundLinks } from '../src/features/soundLinks.ts';
import { setSetting } from '../src/settings.ts';
import { client, GUILD, guild } from './apiFixture.ts';

// Sounds made in chat from part of a link, which the music container downloads

const music = mkdtempSync(path.join(tmpdir(), 'slopkeeper-chat-links-'));
mkdirSync(path.join(music, 'clips'));
Object.assign(config, { musicUrl: 'http://music.test', musicToken: 'music-token', musicAudioDir: path.join(music, 'audio') });
// A 12-second clip, and a 40-second one
for (const [file, seconds] of [['Short-1.m4a', 12], ['Long-2.m4a', 40]] as const) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', path.join(music, 'clips', file)]);
}
const SHORT = 'https://www.tiktok.com/@someone/video/1';
const LONG = 'https://www.youtube.com/watch?v=long';

/** Stands in for the music container */
function fakeMusic(t: TestContext) {
  const realFetch = globalThis.fetch;
  resetDownloads();
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('http://music.test/')) return realFetch(url, init);
    const { url: link } = JSON.parse(init!.body as string);
    if (link === SHORT) return Response.json({ file: 'Short-1.m4a', url: link, title: 'A Clip', artist: 'Someone', source: 'tiktok', durationMs: 12_000, video: false });
    if (link === LONG) return Response.json({ file: 'Long-2.m4a', url: link, title: 'A Long One', artist: 'Someone', source: 'youtube', durationMs: 40_000, video: false });
    return Response.json({ missing: 'That link has no video or sound the bot can download.' });
  });
}

const told: string[] = [];
const here = { id: 'c1', send: async (message: { content: string }) => void told.push(message.content) } as never;
const asker = (roles: string[] = [], manage = false) =>
  ({
    id: 'u1',
    displayName: 'Ana',
    guild,
    client,
    permissions: { has: (flag: bigint) => manage && flag === PermissionFlagsBits.ManageGuild },
    roles: { cache: new Map(roles.map((r) => [r, {}])) },
  }) as never;
const make = async (input: Record<string, unknown>, who = asker()) => {
  told.length = 0;
  const said = await act(who, 'make_sound', { link: SHORT, name: 'bonk', start: '', end: '', ...input }, here);
  await soundsMade();
  return { said, told: [...told] };
};

test('times are read in seconds or as a clock', () => {
  assert.equal(readSeconds(''), null);
  assert.equal(readSeconds('65'), 65);
  assert.equal(readSeconds('65s'), 65);
  assert.equal(readSeconds('1:05'), 65);
  assert.equal(readSeconds('1:05.5'), 65.5);
  assert.equal(readSeconds('1:01:05'), 3665);
  for (const no of ['soon', '1:5', '-3', '1:05:']) assert.equal(readSeconds(no), undefined, no);
});

test('a sound is made from all of a short clip, or the part asked for, and how it went is posted after', async (t) => {
  fakeMusic(t);
  const whole = await make({});
  assert.equal(whole.said, 'Started making bonk. Downloading takes a moment, and how it went is posted here by itself, pinging Ana.');
  assert.deepEqual(whole.told, ['<@u1> Added the sound **bonk**: 0:00 to 0:12 of “A Clip”. It’s too long for Discord’s own soundboard, so it’s only on this one.']);
  assert.ok(findSound(GUILD, 'bonk'));
  assert.equal(soundLinks(GUILD).get('bonk')?.url, SHORT);
  assert.match(recentActivity(GUILD, 5).find((r) => r.actor === 'u1')!.action, /^Added sound \*\*bonk\*\* from 12\.\d s of “A Clip”$/);

  assert.deepEqual((await make({ link: LONG, name: 'part', start: '0:05', end: '0:08' })).told, ['<@u1> Added the sound **part**: 0:05 to 0:08 of “A Long One”.']);
  // An end past the end is the end
  assert.deepEqual((await make({ link: LONG, name: 'tail', start: '35', end: '50' })).told, ['<@u1> Added the sound **tail**: 0:35 to 0:40 of “A Long One”.']);
});

test('a long one needs its part, and what’s wrong is said at once or posted after', async (t) => {
  fakeMusic(t);
  assert.deepEqual((await make({ link: LONG, name: 'longone' })).told, ['<@u1> “A Long One” is 0:40 long, so say which part to make **longone** from, like “0:05 to 0:12”.']);
  assert.deepEqual((await make({ link: LONG, name: 'late', start: '45', end: '50' })).told, ['<@u1> I couldn’t make **late**: “A Long One” is 0:40 long.']);
  assert.deepEqual((await make({ link: 'https://example.com/nothing', name: 'nada' })).told, ['<@u1> I couldn’t make **nada**: That link has no video or sound the bot can download.']);
  assert.equal(findSound(GUILD, 'longone') ?? findSound(GUILD, 'late') ?? findSound(GUILD, 'nada'), undefined);

  const now = async (input: Record<string, unknown>, who?: never) => {
    const { said, told } = await make(input, who);
    assert.deepEqual(told, []);
    return said;
  };
  assert.equal(await now({ name: 'Bad Name!' }), 'Name can only use lowercase letters, numbers, - and _.');
  assert.equal(await now({ link: 'not a link', name: 'x1' }), 'Ask them for the link, starting https://.');
  assert.equal(await now({ name: 'x2', start: 'soon' }), 'Give the start and end like “0:05” or “65”.');
  assert.equal(await now({ name: 'x3', start: '0:10', end: '0:05' }), 'The end has to come after the start.');
  assert.equal(await now({ name: 'x4', start: '0', end: '3:01' }), 'A sound can be 3 minutes at most.');
  await make({ name: 'taken' });
  assert.equal(await now({ name: 'taken' }), 'There’s already a sound called taken. Ask for another name; replacing a sound is in the web UI.');
});

test('with a sound managers role, only those with it or Manage Server make sounds, and with actions off nobody does', async (t) => {
  fakeMusic(t);
  setSetting(GUILD, 'soundManagerRole', '444');
  t.after(() => setSetting(GUILD, 'soundManagerRole', undefined));
  assert.match(String((await make({ name: 'nope' })).said), /^Only @.+ and people with Manage Server can change sounds\.$/);
  assert.deepEqual((await make({ name: 'withrole' }, asker(['444']))).told, ['<@u1> Added the sound **withrole**: 0:00 to 0:12 of “A Clip”. It’s too long for Discord’s own soundboard, so it’s only on this one.']);
  assert.match((await make({ name: 'manager' }, asker([], true))).told[0]!, /^<@u1> Added the sound \*\*manager\*\*/);

  assert.ok(actionTools(guild as never).some((tool) => tool.name === 'make_sound'));
  setSetting(GUILD, 'chatActions', false);
  t.after(() => setSetting(GUILD, 'chatActions', undefined));
  assert.ok(!actionTools(guild as never).some((tool) => tool.name === 'make_sound'));
  assert.deepEqual(await make({ name: 'off' }, asker([], true)), { said: 'Taking actions in chat is turned off on this server. Point them to the command, if there is one.', told: [] });
});
