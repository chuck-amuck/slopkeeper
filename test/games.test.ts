import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { choose, games, hiddenGames } from '../src/features/games.ts';
import { hopOn, onTheWay } from '../src/features/hopon.ts';
import { GROUPS, setup } from '../src/features/setup.ts';
import { DiscordAPIError } from 'discord.js';
import { db } from '../src/db.ts';
import { DEFAULTS, setSetting } from '../src/settings.ts';

test('a reroll doesn’t land on the game on screen', () => {
  const ready = [{ name: 'A' }, { name: 'B' }];
  for (let n = 0; n < 50; n++) assert.equal(choose(ready, 'A').name, 'B');
});

test('with only one game, that’s the pick', () => {
  assert.equal(choose([{ name: 'A' }], 'A').name, 'A');
});

/** Runs /game list, then returns the reply and how to press its buttons */
async function list() {
  const guild = { id: 'list', members: { cache: new Map() } };
  let reply: { embeds: { toJSON(): { description: string; footer?: { text: string } } }[]; components: { toJSON(): { components: { custom_id: string; disabled?: boolean }[] } }[] };
  const shared = { inCachedGuild: () => true, guildId: 'list', guild };
  await games.commands![0].run({ ...shared, options: { getSubcommand: () => 'list' }, reply: async (r: typeof reply) => (reply = r) } as never);
  const press = async (customId: string) => {
    await games.onButton!({ ...shared, customId, update: async (r: typeof reply) => (reply = r) } as never);
    return reply;
  };
  return { reply: reply!, press };
}

test('a long /game list goes on to more pages, with nothing lost', async () => {
  const add = db.prepare(`INSERT INTO games (guild_id, name, added_by) VALUES ('list', ?, 'x')`);
  for (let n = 0; n < 300; n++) add.run(`Game ${String(n).padStart(3, '0')} ${'x'.repeat(40)}`);
  const { reply, press } = await list();
  assert.match(reply.embeds[0].toJSON().footer!.text, /^Page 1 of \d+$/);
  assert.equal(reply.components[0].toJSON().components[0].disabled, true, 'nothing before the first page');

  let page = reply;
  let text = '';
  for (;;) {
    text += page.embeds[0].toJSON().description;
    const next = page.components[0].toJSON().components[1];
    if (next.disabled) break;
    page = await press(next.custom_id);
  }
  assert.equal(text.match(/Game \d+/g)!.length, 300);
});

test('On my way adds and takes off names on the hop-on post', () => {
  const post = '🎮 **Ana** and **Ben** are in <#v>. Hop on!';
  const one = onTheWay(post, '1');
  assert.equal(one, `${post}\n-# 🏃 On the way: <@1>`);
  const two = onTheWay(one, '2');
  assert.equal(two, `${post}\n-# 🏃 On the way: <@1>, <@2>`);
  assert.equal(onTheWay(two, '1'), `${post}\n-# 🏃 On the way: <@2>`);
  assert.equal(onTheWay(onTheWay(two, '1'), '2'), post);
});

test('/notify explains a role the bot can’t hand out', async () => {
  setSetting('notify', 'hopOnRole', 'r');
  const denied = new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'PUT', '/x', {} as never);
  let reply: string | undefined;
  await hopOn.commands![0].run({
    inCachedGuild: () => true,
    guildId: 'notify',
    member: { roles: { cache: new Map(), add: async () => { throw denied; } } },
    deferReply: async () => {},
    editReply: async (r: string) => (reply = r),
  } as never);
  assert.match(reply!, /Manage Roles/);
});

test('/setup show groups the settings as the web UI does, marks changed ones and warns about problems', async () => {
  setSetting('show', 'hopOnMinPeople', 3);
  let reply: { embeds: { toJSON(): { description?: string; fields: { name: string; value: string }[] } }[] } | undefined;
  await setup.commands![0].run({
    inCachedGuild: () => true,
    guildId: 'show',
    guild: { id: 'show', members: { me: {} }, channels: { cache: new Map() }, roles: { cache: new Map() } },
    options: { getSubcommand: () => 'show' },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  const { description, fields } = reply!.embeds[0].toJSON();
  assert.deepEqual(fields.map((f) => f.name), GROUPS.map(([name]) => name));
  const all = fields.map((f) => f.value).join('\n');
  assert.doesNotMatch(all, /-#|\*default\*/);
  assert.match(all, /Hop-on ping at:\*\* 3 people · \*set here\*/);
  assert.match(description!, /announce channel/);
  assert.ok(JSON.stringify(reply!.embeds[0].toJSON()).length < 6000);
});

test('every setting is in exactly one group', () => {
  const grouped = GROUPS.flatMap(([, keys]) => keys);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual([...grouped].sort(), Object.keys(DEFAULTS).sort());
});

test('Never suggest this hides a game, and /game unhide lets it back', async () => {
  const guild = { id: 'hide', members: { cache: new Map() } };
  let shown: { content?: string } | undefined;
  let told: { content: string } | undefined;
  await games.onButton!({
    customId: 'wdp:hide:620',
    inCachedGuild: () => true,
    guildId: 'hide',
    guild,
    user: { id: 'u1' },
    member: { voice: { channel: { members: new Map() } } },
    message: { embeds: [{ title: '🎲 Portal 2' }] },
    deferUpdate: async () => {},
    editReply: async (r: typeof shown) => (shown = r),
    followUp: async (r: typeof told) => (told = r),
  } as never);
  assert.ok(shown, 'the card is redrawn');
  assert.deepEqual(hiddenGames('hide').map((g) => ({ ...g })), [{ appid: 620, name: 'Portal 2' }]);
  assert.equal(told!.content, '🙈 **Portal 2** won’t be suggested again. `/game unhide` brings it back.', 'the person who pressed it is told how to undo it');
  assert.equal(recentActivity('hide', 1)[0].action, 'Hid **Portal 2** from suggestions');

  const unhide = async (name: string) => {
    let reply: string | { content: string } | undefined;
    await games.commands![0].run({
      inCachedGuild: () => true,
      guildId: 'hide',
      guild,
      user: { id: 'u1' },
      options: { getSubcommand: () => 'unhide', getString: () => name },
      reply: async (r: typeof reply) => (reply = r),
    } as never);
    return reply;
  };
  assert.equal(await unhide('Portal 2'), '👀 **Portal 2** can be suggested again.');
  assert.deepEqual(hiddenGames('hide'), []);
  assert.equal(((await unhide('Portal 2')) as { content: string }).content, 'That game is not hidden.');
});

// ---------- Undo on /game own, want and remove ----------

const undoGuild = { id: 'undo', members: { cache: new Map(['u1', 'u2'].map((id) => [id, { id, displayName: id.toUpperCase() }])) } };

/** Runs a /game subcommand on a library game, returning the reply */
async function gameCommand(sub: string, name: string, user = 'u1') {
  let reply: { content: string; components?: { toJSON(): { components: { custom_id: string }[] } }[] } | undefined;
  await games.commands![0].run({
    inCachedGuild: () => true,
    guildId: 'undo',
    guild: undoGuild,
    user: { id: user, username: user, toString: () => `<@${user}>` },
    member: { displayName: user },
    options: { getSubcommand: () => sub, getString: () => name, getUser: () => null },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  return reply!;
}

/** Presses the Undo button on a reply */
async function pressUndo(reply: Awaited<ReturnType<typeof gameCommand>>, user = 'u1') {
  let answer: { content: string; components?: unknown[] } | undefined;
  await games.onButton!({
    customId: reply.components![0].toJSON().components[0].custom_id,
    inCachedGuild: () => true,
    guildId: 'undo',
    guild: undoGuild,
    user: { id: user },
    member: { displayName: user },
    update: async (r: typeof answer) => (answer = r),
    reply: async (r: typeof answer) => (answer = r),
  } as never);
  return answer!;
}

const halo = () => db.prepare(`SELECT id FROM games WHERE guild_id = 'undo' AND name = 'Halo'`).get() as { id: number } | undefined;
const usersIn = (table: string, id: number) => (db.prepare(`SELECT user_id FROM ${table} WHERE game_id = ? ORDER BY user_id`).all(id) as { user_id: string }[]).map((r) => r.user_id);

test('Undo on /game own puts back owning and wanting, and only for whoever did it', async () => {
  const id = Number(db.prepare(`INSERT INTO games (guild_id, name, added_by) VALUES ('undo', 'Halo', 'u1')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (?, 'u1')`).run(id);
  const owned = await gameCommand('own', 'Halo');
  assert.deepEqual([usersIn('game_owners', id), usersIn('game_wants', id)], [['u1'], []], 'owning it ends wanting it');
  assert.match((await pressUndo(owned, 'u2')).content, /Only <@u1>/);
  const undone = await pressUndo(owned);
  assert.equal(undone.content, '↩️ Undone: <@u1> doesn’t own **Halo** again.');
  assert.deepEqual(undone.components, []);
  assert.deepEqual([usersIn('game_owners', id), usersIn('game_wants', id)], [[], ['u1']]);
});

test('Undo on /game remove puts the game back as it was, owners and all, under the same id', async () => {
  const id = halo()!.id;
  db.prepare(`INSERT INTO game_owners (game_id, user_id) VALUES (?, 'u2')`).run(id);
  const gone = await gameCommand('remove', 'Halo');
  assert.equal(halo(), undefined);
  assert.equal((await pressUndo(gone)).content, '↩️ **Halo** is back in the library.');
  assert.equal(halo()!.id, id);
  assert.deepEqual([usersIn('game_owners', id), usersIn('game_wants', id)], [['u2'], ['u1']]);
  assert.match((await pressUndo(gone)).content, /too late/, 'once only');
  assert.equal(recentActivity('undo', 1)[0].action, 'Put **Halo** back in the game library');
});
