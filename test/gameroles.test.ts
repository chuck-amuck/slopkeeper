import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db.ts';
import { gamePings, rolesForGames } from '../src/features/gameroles.ts';
import { setSetting } from '../src/settings.ts';

for (const [role, name] of [['r1', 'Valheim'], ['r2', 'Lethal Company'], ['r3', 'Deep Rock']]) {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES (?, 'g', ?)`).run(role, name);
}

/** A select menu click by someone whose real roles are `held`, with discord.js's per-role calls recorded */
function click(held: string[], chosen: string[], options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const roles = new Map(['r1', 'r2', 'r3'].map((id) => [id, {}]));
  const fresh = {
    roles: {
      cache: new Map(held.map((id) => [id, {}])),
      add: async (id: string) => {
        if (id === options.failOn) throw new Error('Missing Permissions');
        calls.push(`+${id}`);
      },
      remove: async (id: string) => {
        calls.push(`-${id}`);
      },
    },
  };
  let reply: { content: string; components: { toJSON(): { components: { options: { value: string; default: boolean }[] }[] } }[] } | undefined;
  const interaction = {
    inCachedGuild: () => true,
    user: { id: 'u' },
    guild: { id: 'g', roles: { cache: roles }, members: { fetch: async () => fresh } },
    // The cached member, which hasn't heard about recent changes
    member: { roles: { cache: new Map() } },
    component: { options: ['r1', 'r2', 'r3'].map((value) => ({ value })) },
    values: chosen,
    deferUpdate: async () => {},
    editReply: async (r: never) => (reply = r),
  };
  return { run: () => gamePings.onSelect!(interaction as never), calls, reply: () => reply! };
}

test('adds and removes in one pick, working from the member’s real roles', async () => {
  const pick = click(['r1'], ['r2', 'r3']);
  await pick.run();
  assert.deepEqual(pick.calls, ['+r2', '+r3', '-r1']);
});

test('the menu shows what was just picked', async () => {
  const pick = click(['r1'], ['r2']);
  await pick.run();
  assert.match(pick.reply().content, /Lethal Company/);
  assert.doesNotMatch(pick.reply().content, /Valheim/);
  const ticked = pick.reply().components[0].toJSON().components[0].options.filter((o) => o.default).map((o) => o.value);
  assert.deepEqual(ticked, ['r2']);
});

test('/pings offers hop-on pings first, beside the games', async () => {
  db.prepare(`INSERT INTO game_roles (role_id, guild_id, name) VALUES ('r4', 'hop', 'Halo')`).run();
  setSetting('hop', 'hopOnRole', 'hop-role');
  let reply: { content: string; components: { toJSON(): { components: { options: { label: string; value: string; default: boolean }[] }[] } }[] } | undefined;
  await gamePings.commands![0].run({
    inCachedGuild: () => true,
    guildId: 'hop',
    guild: { id: 'hop', roles: { cache: new Map([['hop-role', {}], ['r4', {}]]) } },
    member: { roles: { cache: new Map([['hop-role', {}]]) } },
    reply: async (r: never) => void (reply = r),
  } as never);
  assert.equal(reply!.content, '🔔 You get pings for people hopping on.\nPick what you want to be pinged for:');
  const options = reply!.components[0].toJSON().components[0].options;
  assert.deepEqual(options.map((o) => [o.label, o.default]), [['Hop-on pings', true], ['Halo', false]]);
});

test('says so when the bot can’t change roles', async () => {
  const pick = click([], ['r1'], { failOn: 'r1' });
  await pick.run();
  assert.match(pick.reply().content, /Manage Roles/);
});

test('matches game names without caring about case', () => {
  assert.deepEqual(rolesForGames('g', ['valheim', 'Unknown Game']), ['r1']);
});

/** Runs a /gamerole subcommand, recording what it does to the server's roles */
async function gamerole(sub: string, game: string, role: object | null = null, guildId = 'cmd', manages = true) {
  const made: { name: string; mentionable: boolean; reason: string }[] = [];
  const deleted: [string, string][] = [];
  const me = { permissions: { has: () => manages }, roles: { highest: { name: 'Bot', position: 3 } } };
  const guild = {
    id: guildId,
    members: { me },
    roles: {
      cache: new Map(),
      create: async (o: (typeof made)[number]) => {
        made.push(o);
        return { id: `new-${game}`, mentionable: true, toString: () => `<@&new-${game}>` };
      },
      delete: async (id: string, reason: string) => void deleted.push([id, reason]),
    },
  };
  let reply: { content: string } | undefined;
  await gamePings.commands![1].run({
    inCachedGuild: () => true,
    guildId,
    guild,
    user: { id: 'ana', tag: 'ana' },
    options: { getSubcommand: () => sub, getString: () => game, getRole: () => role },
    reply: async (r: { content: string }) => (reply = r),
    deferReply: async () => {},
    editReply: async (r: string | { content: string }) => (reply = typeof r === 'string' ? { content: r } : r),
  } as never);
  return { made, deleted, content: reply!.content };
}

const plainRole = (id: string, position: number, extra = {}) => ({ id, position, managed: false, mentionable: true, guild: { members: { me: { permissions: { has: () => true } } } }, toString: () => `<@&${id}>`, ...extra });
const rowsIn = (guildId: string) => db.prepare('SELECT role_id, name, created FROM game_roles WHERE guild_id = ? ORDER BY name').all(guildId).map((r) => ({ ...r }));

test('/gamerole add makes a mentionable role, and remove deletes it', async () => {
  const add = await gamerole('add', 'Halo', null, 'cmd-make');
  assert.deepEqual(add.made, [{ name: 'Halo', mentionable: true, reason: '/gamerole add by ana' }]);
  assert.equal(add.content, '✅ Made <@&new-Halo> for **Halo**. People pick it with `/pings`.');
  assert.deepEqual(rowsIn('cmd-make'), [{ role_id: 'new-Halo', name: 'Halo', created: 1 }]);

  const remove = await gamerole('remove', 'Halo', null, 'cmd-make');
  assert.deepEqual(remove.deleted, [['new-Halo', '/gamerole remove by ana']]);
  assert.equal(remove.content, '🗑️ Removed pings for **Halo**.');
  assert.deepEqual(rowsIn('cmd-make'), []);
});

test('/gamerole add uses a role it’s given, and remove leaves that role', async () => {
  const add = await gamerole('add', 'Halo', plainRole('mine', 1), 'cmd-use');
  assert.deepEqual(add.made, []);
  assert.equal(add.content, '✅ Using <@&mine> for **Halo**. People pick it with `/pings`.');
  assert.deepEqual((await gamerole('remove', 'Halo', null, 'cmd-use')).deleted, []);
  assert.deepEqual(rowsIn('cmd-use'), []);
});

test('/gamerole add refuses what it can’t do', async () => {
  assert.match((await gamerole('add', 'Halo', null, 'cmd-no', false)).content, /needs the \*\*Manage Roles\*\*/);
  for (const role of [plainRole('cmd-no', 0), plainRole('managed', 1, { managed: true }), plainRole('high', 3)]) {
    assert.match((await gamerole('add', 'Halo', role, 'cmd-no')).content, /^I can’t hand out <@&.*below my role \(\*\*Bot\*\*\)/);
  }
  assert.deepEqual(rowsIn('cmd-no'), []);
  assert.equal((await gamerole('remove', 'Halo', null, 'cmd-no')).content, '**Halo** has no ping role.');
});

test('/gamerole add says when a game or role is taken', async () => {
  await gamerole('add', 'Halo', plainRole('mine', 1), 'cmd-taken');
  assert.equal((await gamerole('add', 'halo', null, 'cmd-taken')).content, '**halo** already pings <@&mine>.');
  assert.equal((await gamerole('add', 'Valheim', plainRole('mine', 1), 'cmd-taken')).content, '<@&mine> already pings for **Halo**.');
  assert.equal(rowsIn('cmd-taken').length, 1);
});
