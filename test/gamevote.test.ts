import './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { chooseOptions, finish, gameVotes, tick } from '../src/features/gamevote.ts';

function openVote(voice: string, options: string[], closesIn = 60_000) {
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO game_votes (guild_id, channel_id, message_id, voice_channel_id, options, closes_at) VALUES ('g', 'text', 'msg', ?, ?, ?)`)
    .run(voice, JSON.stringify(options.map((name) => ({ name, appid: null }))), Date.now() + closesIn);
  return Number(lastInsertRowid);
}
const getVote = (id: number) => db.prepare('SELECT * FROM game_votes WHERE id = ?').get(id) as never;
const ballot = (id: number, user: string, choice: number) => db.prepare('INSERT INTO game_vote_ballots (vote_id, user_id, choice) VALUES (?, ?, ?)').run(id, user, choice);

/** Presses a vote button as someone in a voice channel holding `people` */
async function press(customId: string, user: string, inVoice: string | null, people: string[]) {
  let update: { embeds?: { toJSON(): { title: string; description: string } }[]; components: unknown[] } | undefined;
  let reply: { content: string } | undefined;
  const channel = { isVoiceBased: () => true, members: new Map(people.map((id) => [id, { id, user: { bot: false } }])) };
  await gameVotes.onButton!({
    customId,
    inCachedGuild: () => true,
    user: { id: user },
    member: { voice: { channelId: inVoice } },
    guild: { channels: { cache: { get: () => channel } } },
    update: async (r: typeof update) => (update = r),
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  return { update, reply };
}

test('options are capped, keep the most played and don’t repeat', () => {
  const ready = Array.from({ length: 30 }, (_, n) => ({ name: `Game ${n}`, appid: null, missing: [], playtime: n }));
  const options = chooseOptions(ready);
  assert.equal(options.length, 10);
  assert.equal(new Set(options.map((o) => o.name)).size, 10);
  assert.deepEqual(options.slice(0, 5).map((o) => o.name), ['Game 29', 'Game 28', 'Game 27', 'Game 26', 'Game 25']);
});

test('a vote stays open until everyone in voice has voted, and a vote can be changed', async () => {
  const id = openVote('v1', ['Valheim', 'Deep Rock']);
  const people = ['a', 'b'];
  const first = await press(`vote:${id}:0`, 'a', 'v1', people);
  assert.equal(first.update!.embeds![0].toJSON().title, '🗳️ What do we play?');
  assert.equal(first.update!.components.length, 1);
  await press(`vote:${id}:1`, 'a', 'v1', people);
  assert.ok(getVote(id));

  const last = await press(`vote:${id}:1`, 'b', 'v1', people);
  const result = last.update!.embeds![0].toJSON();
  assert.equal(result.title, '🏆 Deep Rock');
  assert.match(result.description, /2 of 2 votes/);
  assert.deepEqual(last.update!.components, []);
  assert.equal(getVote(id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM game_vote_ballots WHERE vote_id = ?').get(id), undefined);
});

test('only people in the voice channel can vote', async () => {
  const id = openVote('v2', ['Valheim', 'Deep Rock']);
  const elsewhere = await press(`vote:${id}:0`, 'a', 'other', ['b']);
  assert.match(elsewhere.reply!.content, /<#v2>/);
  assert.equal(db.prepare('SELECT 1 FROM game_vote_ballots WHERE vote_id = ?').get(id), undefined);
});

test('a button on a finished vote just clears itself', async () => {
  const { update } = await press('vote:999999:0', 'a', 'v', ['a']);
  assert.deepEqual(update, { components: [] });
});

test('a tie picks one of the leaders and says so', () => {
  const wins = new Set<string>();
  for (let n = 0; n < 40; n++) {
    const id = openVote(`tie${n}`, ['A', 'B', 'C']);
    ballot(id, 'x', 0);
    ballot(id, 'y', 1);
    const embed = finish(getVote(id)).embeds[0].toJSON();
    wins.add(embed.title!);
    assert.match(embed.description!, /Tied with (A|B), so I picked at random/);
  }
  assert.deepEqual([...wins].sort(), ['🏆 A', '🏆 B']);
});

test('votes close when time runs out, even with nobody voting', async () => {
  const empty = openVote('t1', ['A', 'B'], -1);
  const voted = openVote('t2', ['A', 'B'], -1);
  const later = openVote('t3', ['A', 'B']);
  ballot(voted, 'x', 1);
  const edits: { title: string; components: unknown[] }[] = [];
  const client = {
    channels: {
      fetch: async () => ({
        isSendable: () => true,
        messages: { edit: async (_id: string, r: { embeds: { toJSON(): { title: string } }[]; components: unknown[] }) => edits.push({ title: r.embeds[0].toJSON().title, components: r.components }) },
      }),
    },
  };
  await tick(client as never);
  assert.deepEqual(edits, [
    { title: '🗳️ Nobody voted', components: [] },
    { title: '🏆 B', components: [] },
  ]);
  assert.equal(getVote(empty), undefined);
  assert.equal(getVote(voted), undefined);
  assert.ok(getVote(later));
  await tick(client as never);
  assert.equal(edits.length, 2, 'closes once');
});

test('a message that can’t be edited doesn’t stop the next vote closing', async () => {
  mock.method(console, 'error', () => {});
  openVote('e1', ['A', 'B'], -1);
  const next = openVote('e2', ['A', 'B'], -1);
  let calls = 0;
  await tick({ channels: { fetch: async () => ({ isSendable: () => true, messages: { edit: async () => { if (!calls++) throw new Error('Unknown Message'); } } }) } } as never);
  assert.equal(calls, 2);
  assert.equal(getVote(next), undefined);
});

/** Runs /gamevote for people in a voice channel, with games they've all marked as owned */
async function start(guildId: string, people: string[], gameNames: string[], ownedByOne: string[] = []) {
  const addGame = db.prepare(`INSERT INTO games (guild_id, name, added_by) VALUES (?, ?, 'x')`);
  const addOwner = db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)');
  for (const name of gameNames) {
    const { lastInsertRowid } = addGame.run(guildId, name);
    for (const id of people) addOwner.run(lastInsertRowid, id);
  }
  for (const name of ownedByOne) addOwner.run(addGame.run(guildId, name).lastInsertRowid, people[0]);
  const members = new Map(people.map((id) => [id, { id, user: { bot: false } }]));
  const voice = { id: `voice-${guildId}`, members, toString: () => '#voice' };
  let reply: unknown;
  let edit: { embeds?: { toJSON(): { description: string } }[]; components?: { toJSON(): { components: { custom_id: string; label: string }[] } }[] } | string | undefined;
  await gameVotes.commands![0].run({
    inCachedGuild: () => true,
    guildId,
    channelId: 'text',
    guild: { id: guildId, members: { cache: members } },
    member: { voice: { channel: voice } },
    options: { getInteger: () => null },
    reply: async (r: unknown) => (reply = r),
    deferReply: async () => {},
    editReply: async (r: typeof edit) => {
      edit = r;
      return { id: 'msg' };
    },
  } as never);
  return { reply, edit };
}

test('/gamevote puts up the games everyone owns', async () => {
  const { edit } = await start('s1', ['a', 'b'], ['Valheim', 'Deep Rock'], ['Only A Has This']);
  const row = (edit as Exclude<typeof edit, string | undefined>).components![0].toJSON();
  assert.deepEqual(row.components.map((c) => c.label).sort(), ['Deep Rock (0)', 'Valheim (0)']);
  const vote = db.prepare(`SELECT message_id, closes_at FROM game_votes WHERE guild_id = 's1'`).get() as { message_id: string; closes_at: number };
  assert.equal(vote.message_id, 'msg');
  assert.ok(Math.abs(vote.closes_at - Date.now() - 60_000) < 5_000);
});

test('a second vote in the same channel points at the first', async () => {
  const { reply } = await start('s1', ['a', 'b'], []);
  assert.match((reply as { content: string }).content, /already a vote/);
  assert.match((reply as { content: string }).content, /channels\/s1\/text\/msg/);
});

test('with one game or none there’s nothing to vote on', async () => {
  assert.match(String((await start('s2', ['a'], ['Valheim'])).edit), /only game that fits/);
  assert.match(String((await start('s3', ['a', 'b'], [])).edit), /Nobody here|No game fits/);
  assert.equal(db.prepare(`SELECT 1 FROM game_votes WHERE guild_id IN ('s2', 's3')`).get(), undefined);
});

