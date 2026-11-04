import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db.ts';
import { gamePings, rolesForGames } from '../src/features/gameroles.ts';

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

test('says so when the bot can’t change roles', async () => {
  const pick = click([], ['r1'], { failOn: 'r1' });
  await pick.run();
  assert.match(pick.reply().content, /Manage Roles/);
});

test('matches game names without caring about case', () => {
  assert.deepEqual(rolesForGames('g', ['valheim', 'Unknown Game']), ['r1']);
});
