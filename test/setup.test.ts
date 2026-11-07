import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { checkSetting, setup } from '../src/features/setup.ts';
import { setting } from '../src/settings.ts';

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

test('the delay is set with /setup sounds, within its limits', async () => {
  assert.equal(setting('setup-delay', 'joinSoundDelayMs'), 500);
  await run('setup-delay', 'sounds', { join_delay_ms: 1200 });
  assert.equal(setting('setup-delay', 'joinSoundDelayMs'), 1200);
  assert.deepEqual(log('setup-delay'), ['Set Join sound delay to 1200 ms']);
  const sounds = (setup.commands![0].data.toJSON().options as any[]).find((o) => o.name === 'sounds');
  const option = sounds.options.find((o: { name: string }) => o.name === 'join_delay_ms');
  assert.deepEqual([option.min_value, option.max_value], [0, 10_000]);
});

test('/setup reset searches every setting, and refuses anything else', async () => {
  let offered: { name: string; value: string }[] = [];
  const search = (typed: string) =>
    setup.commands![0].autocomplete!({ options: { getSubcommand: () => 'reset', getFocused: () => typed }, respond: async (r: typeof offered) => void (offered = r) } as never);
  await search('');
  assert.equal(offered.length, 25);
  await search('JOIN SOUND DEL');
  assert.deepEqual(offered, [{ name: 'Join sound delay', value: 'joinSoundDelayMs' }]);

  let reply: { content: string } | undefined;
  await setup.commands![0].run({
    inCachedGuild: () => true,
    guildId: 'setup-typed',
    guild: { id: 'setup-typed' },
    options: { getSubcommand: () => 'reset', getString: () => 'made up' },
    reply: async (r: { content: string }) => (reply = r),
  } as never);
  assert.equal(reply!.content, 'Pick a setting from the list.');
  assert.deepEqual(log('setup-typed'), []);
});

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

test('sale alerts set their discount, wishlists and channel, one at a time if wanted', async () => {
  const guildId = 'setup-sales';
  await run(guildId, 'sale-alerts', { min_discount: 40 });
  assert.equal(setting(guildId, 'saleMinDiscount'), 40);
  assert.equal(setting(guildId, 'saleSteamWishlists'), true);
  await run(guildId, 'sale-alerts', { steam_wishlists: false });
  assert.equal(setting(guildId, 'saleSteamWishlists'), false);
  assert.equal(setting(guildId, 'saleMinDiscount'), 40);
  assert.deepEqual(log(guildId), ['Set Steam wishlists in sale alerts to off', 'Set Smallest sale worth posting to 40% off']);
});

test('free game filters set the lowest rating and whether unlisted games show', async () => {
  const guildId = 'setup-free';
  await run(guildId, 'free-game-filters', { min_rating: 85, not_on_steam: true });
  assert.equal(setting(guildId, 'freeGamesMinRating'), 85);
  assert.equal(setting(guildId, 'freeGamesUnlisted'), true);
});

test('sets and clears the sound managers role', async () => {
  await run('setup-managers', 'sound-managers', { role: { id: 'managers', toString: () => '<@&managers>' } });
  assert.equal(setting('setup-managers', 'soundManagerRole'), 'managers');
  await run('setup-managers', 'sound-managers', {});
  assert.equal(setting('setup-managers', 'soundManagerRole'), '');
  assert.equal(log('setup-managers')[0], 'Set Sound managers to everyone can change sounds');
  assert.equal(log('setup-managers')[1], 'Set Sound managers to <@&managers>');
});

test('patch notes start off, take a mode and a channel, and refuse anything else', () => {
  const guild = { channels: { cache: new Map() } } as never;
  assert.equal(setting('patches', 'patchNotes'), 'off');
  assert.deepEqual(checkSetting(guild, 'patchNotes', 'digest'), { value: 'digest' });
  assert.deepEqual(checkSetting(guild, 'patchNotes', 'each'), { value: 'each' });
  assert.match((checkSetting(guild, 'patchNotes', 'often') as { error: string }).error, /Patch notes are/);
  assert.match((checkSetting(guild, 'patchNotes', 'constructor') as { error: string }).error, /Patch notes are/);
  assert.deepEqual(checkSetting(guild, 'patchNotesChannel', 'nope'), { error: 'Pick a text channel.' });
});
