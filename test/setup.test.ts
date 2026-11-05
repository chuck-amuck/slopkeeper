import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { setup } from '../src/features/setup.ts';

/** Runs a /setup subcommand */
function run(guildId: string, sub: string, values: Record<string, unknown>) {
  const pick = (name: string) => values[name] ?? null;
  return setup.commands![0].run({
    inCachedGuild: () => true,
    guildId,
    guild: { id: guildId },
    user: { id: 'admin' },
    options: { getSubcommand: () => sub, getInteger: pick, getBoolean: pick, getString: pick, getRole: pick, getChannel: pick },
    reply: async () => {},
  } as never);
}

const log = (guildId: string) => recentActivity(guildId, 10).map((r) => r.action);

test('records settings changed in Discord, including ones set to nothing or zero', async () => {
  await run('setup-log', 'hopon', { cooldown_minutes: 0 });
  await run('setup-log', 'hopon-role', {});
  await run('setup-log', 'sounds', { join_sounds: false });
  assert.deepEqual(log('setup-log'), ['Set Join sounds to off', 'Set Hop-on role to none, hop-on pings don’t ping anyone', 'Set Hop-on cooldown to 0 min']);
  assert.equal(recentActivity('setup-log', 10)[0].actor, 'admin');
});

test('records putting a setting back', async () => {
  await run('setup-reset', 'reset', { setting: 'hopOnMinPeople' });
  assert.deepEqual(log('setup-reset'), ['Put Hop-on ping at back to the default']);
});
