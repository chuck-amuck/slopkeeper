import { GUILD, guild, ok, roles, setFake } from './apiFixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import { settingProblems, settingsEmbed } from '../src/features/setup.ts';
import { postFailures, sendPost } from '../src/postFailures.ts';
import { setSetting } from '../src/settings.ts';

const problems = () => settingProblems(guild as never).map(({ key, text }): [string | null, string] => [key, text]);
const VIEW_SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const refused = (code: number, message: string) => new DiscordAPIError({ code, message }, code, 403, 'POST', '/channels/111/messages', { body: undefined, files: undefined });

test('nothing is posted without an announce channel, and a channel the bot can’t post in says what to give it', () => {
  assert.deepEqual(problems(), [['announceChannel', 'Nothing gets posted until an announce channel is set.']]);
  setSetting(GUILD, 'announceChannel', '111');
  assert.deepEqual(problems(), []);
  setFake({ permitted: VIEW_SEND });
  assert.deepEqual(problems(), [['announceChannel', 'Announcements: I can’t post in #first. Give my role **Embed Links** there.']]);
});

test('a post’s own channel is checked only while that post is on, and a gone one says so', () => {
  setSetting(GUILD, 'announceChannel', '111');
  setSetting(GUILD, 'freeGamesChannel', 'gone');
  setSetting(GUILD, 'freeGames', false);
  setSetting(GUILD, 'saleChannel', 'gone-too');
  assert.deepEqual(problems(), [['saleChannel', 'Sale alerts: the channel is gone. Pick another one.']]);
  setSetting(GUILD, 'freeGames', true);
  assert.deepEqual(problems().map(([key]) => key), ['saleChannel', 'freeGamesChannel']);
});

test('the speech channel only has to be seen, and roles that are gone or out of reach are named', () => {
  setSetting(GUILD, 'announceChannel', '111');
  setSetting(GUILD, 'ttsChannel', 'c2');
  setFake({ permitted: [] });
  setSetting(GUILD, 'announceChannel', null);
  assert.ok(problems().some(([key, text]) => key === 'ttsChannel' && /can’t see #second/.test(text)));
  setFake({ permitted: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] });
  setSetting(GUILD, 'announceChannel', '111');
  setSetting(GUILD, 'hopOnRole', '333');
  setSetting(GUILD, 'musicDjRole', 'deleted-role');
  const found = problems();
  // A server needn't let the bot hand out roles: /notify sends people to an admin
  assert.ok(!found.some(([key]) => key === 'hopOnRole'), 'above the bot’s role');
  assert.ok(found.some(([key, text]) => key === 'musicDjRole' && /Controlling music: the role it needs is gone/.test(text)));
  assert.ok(roles.has('333'));
});

test('a post Discord refused is shown until the next one goes out, while it’s on and recent, and other failures aren’t', async (t) => {
  setSetting(GUILD, 'announceChannel', '111');
  setSetting(GUILD, 'weeklyLeaderboard', true);
  setSetting(GUILD, 'sessionRecap', true);
  let answer: Error | null = refused(50013, 'Missing Permissions');
  const channel = { id: '111', send: async () => (answer ? Promise.reject(answer) : { id: 'm1' }) } as never;
  await assert.rejects(sendPost('weekly', GUILD, channel, { content: 'hi' }));
  await assert.rejects(sendPost('sessionRecap', GUILD, channel, { content: 'hi' }));
  const [failure] = settingProblems(guild as never);
  assert.equal(failure.key, 'announceChannel');
  assert.equal(failure.text, 'Discord refused the last session recap and weekly leaderboard in #first: “Missing Permissions”.');
  assert.ok(failure.at && Date.now() - failure.at < 5000);
  // A post that's off says nothing
  setSetting(GUILD, 'sessionRecap', false);
  assert.match(problems()[0][1], /^Discord refused the last weekly leaderboard in #first/);
  // What the live check finds says it all
  setFake({ permitted: VIEW_SEND });
  assert.deepEqual(problems(), [['announceChannel', 'Announcements: I can’t post in #first. Give my role **Embed Links** there.']]);
  setFake({ permitted: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] });
  // Moved to another channel, the next post there is the test
  setSetting(GUILD, 'announceChannel', 'c2');
  assert.deepEqual(problems(), []);
  setSetting(GUILD, 'announceChannel', '111');
  // After two days it's most likely been put right
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 86_400_000 });
  assert.deepEqual(problems(), []);
  t.mock.timers.reset();
  answer = null;
  await sendPost('weekly', GUILD, channel, { content: 'hi' });
  assert.deepEqual(postFailures(GUILD).map((f) => f.post), ['sessionRecap']);
  // Discord being down isn't something a setting fixes
  answer = new Error('ECONNRESET');
  await assert.rejects(sendPost('weekly', GUILD, channel, { content: 'hi' }));
  assert.deepEqual(postFailures(GUILD).map((f) => f.post), ['sessionRecap']);
  await sendPost('sessionRecap', GUILD, { id: '111', send: async () => ({ id: 'm2' }) } as never, { content: 'hi' });
});

test('/setup show says which command sets the announce channel', () => {
  const embed = settingsEmbed(guild as never).toJSON();
  assert.match(embed.description ?? '', /announce channel is set with /);
});

test('the web UI gets the problems, and which channels and roles the bot can use', async () => {
  setSetting(GUILD, 'announceChannel', '111');
  setFake({ permitted: VIEW_SEND });
  const data = (await ok(`/guilds/${GUILD}/settings`)) as { problems: { key: string }[]; channels: { id: string; canPost: boolean }[]; roles: { id: string; canGive: boolean }[] };
  assert.deepEqual(data.problems.map((p) => p.key), ['announceChannel']);
  assert.equal(data.channels.find((c) => c.id === '111')?.canPost, false);
  assert.equal(data.roles.find((r) => r.id === 'r1')?.canGive, true);
  assert.equal(data.roles.find((r) => r.id === '333')?.canGive, false);
  assert.ok((data as unknown as { postChannels: string[] }).postChannels.includes('saleChannel'));
});
