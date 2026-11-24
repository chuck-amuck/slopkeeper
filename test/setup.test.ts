import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType } from 'discord.js';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { checkSetting, GROUPS, SECTIONS, settingPlace, setup, show } from '../src/features/setup.ts';
import { DEFAULTS, setting, storedSetting, type SettingKey } from '../src/settings.ts';

/** Runs a /setup subcommand */
function run(guildId: string, sub: string, values: Record<string, unknown>) {
  const pick = (name: string) => values[name] ?? null;
  // Like discord.js, a second reply to one interaction throws
  let replied = false;
  return setup.commands![0].run({
    inCachedGuild: () => true,
    guildId,
    // Channels given as options are in the server too
    guild: { id: guildId, members: { me: {} }, channels: { cache: new Map(Object.values(values).flatMap((v) => (v && typeof v === 'object' && 'type' in v ? [[(v as unknown as { id: string }).id, v]] : []))) } },
    user: { id: 'admin' },
    options: { getSubcommand: () => sub, getInteger: pick, getNumber: pick, getBoolean: pick, getString: pick, getRole: pick, getChannel: pick },
    reply: async (r: { content: string }) => {
      if (replied) throw new Error('The reply to this interaction has already been sent or deferred.');
      replied = true;
      replies[guildId] = r.content;
    },
    followUp: async () => {},
  } as never);
}
const replies: Record<string, string> = {};

const log = (guildId: string) => recentActivity(guildId, 10).map((r) => r.action);
const role = (id: string) => ({ id, toString: () => `<@&${id}>` });

test('/setup sets the basics, as the web UI’s Basics section has them, and nothing else', async () => {
  const subs = (setup.commands![0].data.toJSON().options as { name: string }[]).map((o) => o.name);
  assert.deepEqual(subs, ['show', 'announce-channel', 'timezone', 'sound-managers', 'music-role', 'speech-role']);
  const basics = SECTIONS.find((s) => s.id === 'basics')!.groups.flatMap((group) => GROUPS.find(([name]) => name === group)![1]);

  // Each one used, then what the server has stored
  const guildId = 'setup-basics';
  await run(guildId, 'announce-channel', { channel: { id: 'news', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) } });
  await run(guildId, 'timezone', { zone: 'Europe/London' });
  for (const sub of ['sound-managers', 'music-role', 'speech-role']) await run(guildId, sub, { role: role(sub) });
  const stored = (Object.keys(DEFAULTS) as SettingKey[]).filter((key) => storedSetting(guildId, key) !== undefined);
  assert.deepEqual(stored.sort(), [...basics].sort());
  assert.deepEqual(
    basics.map((key) => setting(guildId, key)),
    ['news', 'Europe/London', 'sound-managers', 'music-role', 'speech-role'],
  );
});

test('records settings changed in Discord, including a role set back to everyone', async () => {
  await run('setup-log', 'timezone', { zone: 'Europe/London' });
  await run('setup-log', 'speech-role', { everyone: true });
  assert.deepEqual(log('setup-log'), [`Set Who can use text to speech to ${show('ttsRole', '')}`, 'Set Time zone to Europe/London']);
  assert.equal(recentActivity('setup-log', 10)[0].actor, 'admin');
});

test('sets and clears the sound managers role', async () => {
  await run('setup-managers', 'sound-managers', { role: role('managers') });
  assert.equal(setting('setup-managers', 'soundManagerRole'), 'managers');
  // Giving nothing only shows it
  await run('setup-managers', 'sound-managers', {});
  assert.equal(setting('setup-managers', 'soundManagerRole'), 'managers');
  assert.match(replies['setup-managers'], /Give an option to change one/);
  await run('setup-managers', 'sound-managers', { everyone: true });
  assert.equal(setting('setup-managers', 'soundManagerRole'), '');
  assert.equal(log('setup-managers')[0], 'Set Sound managers to everyone can change sounds');
  assert.equal(log('setup-managers')[1], 'Set Sound managers to <@&managers>');
});

test('/setup music-role saves, replies once, and keeps the role until everyone is given', async () => {
  await run('setup-music', 'music-role', { role: role('djs') });
  assert.equal(setting('setup-music', 'musicDjRole'), 'djs');
  assert.match(replies['setup-music'], /✅/);
  await run('setup-music', 'music-role', {});
  assert.equal(setting('setup-music', 'musicDjRole'), 'djs', 'giving nothing keeps it');
  await run('setup-music', 'music-role', { everyone: true });
  assert.equal(setting('setup-music', 'musicDjRole'), '');
});

test('a role together with everyone is refused, not half-applied', async () => {
  for (const sub of ['sound-managers', 'music-role', 'speech-role']) {
    await run('setup-both', sub, { role: role('r1'), everyone: true });
    assert.match(replies['setup-both'], /not both/, sub);
  }
  assert.deepEqual(log('setup-both'), []);
});

test('a subcommand given nothing shows its settings and changes none', async () => {
  for (const sub of ['timezone', 'sound-managers', 'music-role', 'speech-role']) {
    await run('setup-show-only', sub, {});
    assert.match(replies['setup-show-only'], /Give an option to change one/, sub);
  }
  assert.deepEqual(log('setup-show-only'), []);
});

test('an option Discord still offers after it’s gone says where it went, and changes nothing', async () => {
  await run('setup-gone', 'hopon', { min_people: 3 });
  assert.equal(replies['setup-gone'], 'That setting is in the web UI’s Settings now.');
  assert.deepEqual(log('setup-gone'), []);
});

test('a setting /setup doesn’t have is named, and linked on the server it’s about when the web UI’s address is known', (t) => {
  assert.equal(settingPlace('g7', 'hopOnRole'), '**Hop-on role** in the web UI’s Settings');
  const before = config.webAddress;
  t.after(() => void (config.webAddress = before));
  config.webAddress = 'https://bot.example.com';
  assert.equal(settingPlace('g7', 'hopOnRole'), '**Hop-on role** in [the web UI’s Settings](<https://bot.example.com/?guild=g7#settings?key=hopOnRole>)');
});

test('the announce channel has to be one the bot can post in', async () => {
  const locked = { id: 'locked', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }), toString: () => '#locked' };
  await run('setup-locked', 'announce-channel', { channel: locked });
  assert.match(replies['setup-locked'], /I can’t post in #locked yet/);
  assert.equal(setting('setup-locked', 'announceChannel'), null);
});

test('the join sound delay takes up to 10 seconds', () => {
  const guild = {} as never;
  assert.equal(setting('setup-delay', 'joinSoundDelayMs'), 500);
  assert.deepEqual(checkSetting(guild, 'joinSoundDelayMs', 1200), { value: 1200 });
  assert.match((checkSetting(guild, 'joinSoundDelayMs', 10_001) as { error: string }).error, /0 to 10000/);
  assert.equal(show('joinSoundDelayMs', 1200), '1200 ms');
});

test('sale alerts post wishlists, other stores and bundles unless turned off, and every game unless multiplayer only', () => {
  const keys: SettingKey[] = ['saleSteamWishlists', 'saleOtherStores', 'bundleAlerts', 'bundlesLikeWePlay', 'saleMultiplayer'];
  assert.deepEqual(
    keys.map((key) => setting('setup-sales', key)),
    [true, true, true, true, false],
  );
  assert.equal(show('salePostHour', 20), '20:00');
  assert.equal(show('saleMinDiscount', 40), '40% off');
});

test('free game filters take the lowest rating and whether unlisted games show', () => {
  const guild = {} as never;
  assert.deepEqual(checkSetting(guild, 'freeGamesMinRating', 85), { value: 85 });
  assert.match((checkSetting(guild, 'freeGamesMinRating', 101) as { error: string }).error, /0 to 100/);
  assert.deepEqual(checkSetting(guild, 'freeGamesUnlisted', true), { value: true });
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

test('text to speech settings take a known voice, a role and sensible limits', () => {
  const guild = { channels: { cache: new Map() }, roles: { cache: new Map([['talkers', { id: 'talkers' }]]) } } as never;
  assert.equal(setting('speech', 'tts'), true);
  assert.equal(setting('speech', 'ttsVoice'), 'southern-man');
  assert.deepEqual(checkSetting(guild, 'ttsVoice', 'american-deep'), { value: 'american-deep' });
  assert.deepEqual(checkSetting(guild, 'ttsVoice', 'demon'), { error: 'Pick a voice from the list.' }, 'an effect now, picked on its own');
  assert.equal(setting('speech', 'ttsEffect'), 'none');
  assert.deepEqual(checkSetting(guild, 'ttsEffect', 'demon'), { value: 'demon' });
  assert.deepEqual(checkSetting(guild, 'ttsEffect', 'none'), { value: 'none' });
  assert.deepEqual(checkSetting(guild, 'ttsEffect', 'scottish'), { error: 'Pick an effect from the list.' });
  assert.deepEqual(checkSetting(guild, 'ttsVoice', '5'), { error: 'Pick a voice from the list.' }, 'the numbered voices are gone');
  assert.deepEqual(checkSetting(guild, 'ttsVoice', '3'), { error: 'Pick a voice from the list.' });
  assert.deepEqual(checkSetting(guild, 'ttsRole', 'talkers'), { value: 'talkers' });
  assert.deepEqual(checkSetting(guild, 'ttsRole', 'nope'), { error: 'Pick a role.' });
  assert.equal(setting('speech', 'ttsSpeed'), 85);
  assert.equal(setting('speech', 'ttsVolume'), 100);
  assert.deepEqual(checkSetting(guild, 'ttsVolume', 200), { value: 200 });
  assert.match((checkSetting(guild, 'ttsVolume', 201) as { error: string }).error, /10 to 200/);
  assert.match((checkSetting(guild, 'ttsVolume', 9) as { error: string }).error, /10 to 200/);
  assert.deepEqual(checkSetting(guild, 'ttsSpeed', 50), { value: 50 });
  assert.match((checkSetting(guild, 'ttsSpeed', 49) as { error: string }).error, /50 to 150/);
  assert.match((checkSetting(guild, 'ttsSpeed', 151) as { error: string }).error, /50 to 150/);
  assert.equal(setting('speech', 'ttsPauseMs'), 200);
  assert.deepEqual(checkSetting(guild, 'ttsPauseMs', 0), { value: 0 });
  assert.match((checkSetting(guild, 'ttsPauseMs', 2001) as { error: string }).error, /0 to 2000/);
  assert.deepEqual(checkSetting(guild, 'ttsMaxChars', 6000), { value: 6000 });
  assert.match((checkSetting(guild, 'ttsMaxChars', 6001) as { error: string }).error, /20 to 6000/);
  assert.deepEqual(checkSetting(guild, 'ttsCooldownSec', 0), { value: 0 });
  assert.match((checkSetting(guild, 'ttsCooldownSec', -1) as { error: string }).error, /0 to 3600/);
});

test('the channel read aloud has to be one the bot can see', () => {
  const channel = (see: boolean) => ({ id: 'general', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => see }), toString: () => '#general' });
  const guild = (see: boolean) => ({ members: { me: {} }, channels: { cache: new Map([['general', channel(see)]]) } }) as never;
  assert.deepEqual(checkSetting(guild(true), 'ttsChannel', 'general'), { value: 'general' });
  assert.match((checkSetting(guild(false), 'ttsChannel', 'general') as { error: string }).error, /can’t see #general/);
  assert.deepEqual(checkSetting(guild(true), 'ttsChannel', 'nope'), { error: 'Pick a text channel.' });
  assert.deepEqual(checkSetting(guild(true), 'ttsChannelWho', 'voice'), { value: 'voice' });
  assert.match((checkSetting(guild(true), 'ttsChannelWho', 'cats') as { error: string }).error, /Read everyone/);
  assert.equal(setting('speech', 'ttsChannel'), null);
  assert.equal(setting('speech', 'ttsChannelWho'), 'everyone');
});

test('what counts as talking is one of three, talking unless changed', () => {
  const guild = { members: { me: {} } } as never;
  assert.equal(setting('talk-check', 'musicDucksFor'), 'talking');
  for (const value of ['any', 'talking', 'loud']) assert.deepEqual(checkSetting(guild, 'musicDucksFor', value), { value });
  assert.match((checkSetting(guild, 'musicDucksFor', 'loudest') as { error: string }).error, /only loud talking/);
});

test('the greeting has to have words, and stay short', () => {
  const guild = {} as never;
  assert.equal(setting('greeting', 'ttsGreeting'), '{name} joined');
  assert.deepEqual(checkSetting(guild, 'ttsGreeting', '  Hi {name} '), { value: 'Hi {name}' });
  assert.match((checkSetting(guild, 'ttsGreeting', '   ') as { error: string }).error, /Type what it should say/);
  assert.match((checkSetting(guild, 'ttsGreeting', '🎉') as { error: string }).error, /Type what it should say/, 'no words in it');
  assert.match((checkSetting(guild, 'ttsGreeting', 'x'.repeat(101)) as { error: string }).error, /100 characters/);
});

test('the looping room has to be a voice channel the bot can use, with a sound from the library', () => {
  const room = (id: string, type: ChannelType, missing = false) => ({ id, type, guild: null as unknown, name: id, joinable: true, permissionsFor: () => ({ has: () => !missing }) });
  const guild: any = { id: 'looping', afkChannelId: 'afk', members: { me: {} }, channels: { cache: new Map() } };
  for (const r of [room('therapy', ChannelType.GuildVoice), room('afk', ChannelType.GuildVoice), room('general', ChannelType.GuildText), room('locked', ChannelType.GuildVoice, true)]) {
    r.guild = guild;
    guild.channels.cache.set(r.id, r);
  }
  assert.deepEqual(checkSetting(guild, 'loopRoom', 'therapy'), { value: 'therapy' });
  for (const bad of ['afk', 'general', 'nope']) assert.deepEqual(checkSetting(guild, 'loopRoom', bad), { error: 'Pick a voice channel.' });
  assert.match((checkSetting(guild, 'loopRoom', 'locked') as { error: string }).error, /Connect/);
  assert.deepEqual(checkSetting(guild, 'loopSound', 'nope'), { error: 'Pick a sound from the library.' });
  assert.equal(setting('looping', 'loopRoom'), null);
  assert.equal(setting('looping', 'loopVolume'), 50);
  assert.equal(setting('looping', 'soundVolume'), 60);
});

test('the loop gap takes tenths of a second', () => {
  const guild = { channels: { cache: new Map() } } as never;
  assert.equal(setting('loop-every', 'loopEvery'), 0, 'loops without a gap until set');
  assert.deepEqual(checkSetting(guild, 'loopEvery', 0.5), { value: 0.5 });
  assert.deepEqual(checkSetting(guild, 'loopEvery', 0.1 + 0.2), { value: 0.3 }, 'not thrown by floating point');
  for (const bad of [0.25, -1, 61, '1', NaN]) assert.match((checkSetting(guild, 'loopEvery', bad) as { error: string }).error, /Loop every has to be from 0 to 60, in steps of 0.1/);
  assert.match((checkSetting(guild, 'loopVolume', 50.5) as { error: string }).error, /whole number/, 'the rest still take whole numbers');
  assert.equal(show('loopEvery', 1.5), '1.5 seconds, layered');
});

test('music’s volume and who can control it are checked', () => {
  assert.equal(setting('setup-music-check', 'musicVolume'), 100);
  const guild = { id: 'setup-music-check', roles: { cache: new Map([['djs', { id: 'djs' }]]) } } as never;
  assert.deepEqual(checkSetting(guild, 'musicVolume', 500), { error: 'Music volume has to be a whole number from 0 to 200.' });
  assert.deepEqual(checkSetting(guild, 'musicDjRole', 'djs'), { value: 'djs' });
  assert.deepEqual(checkSetting(guild, 'musicDjRole', 'nope'), { error: 'Pick a role.' });
});

test('looping speech takes up to 500 characters, a voice of its own, and its own gap', () => {
  const guild = { channels: { cache: new Map() } } as never;
  assert.deepEqual(checkSetting(guild, 'loopText', '  stay a while  '), { value: 'stay a while' });
  assert.match((checkSetting(guild, 'loopText', '   ') as { error: string }).error, /Type something/);
  assert.match((checkSetting(guild, 'loopText', 'a'.repeat(501)) as { error: string }).error, /up to 500/);
  assert.deepEqual(checkSetting(guild, 'loopVoice', 'scottish'), { value: 'scottish' });
  assert.deepEqual(checkSetting(guild, 'loopEffect', 'ghost'), { value: 'ghost' });
  assert.match((checkSetting(guild, 'loopEffect', 'nope') as { error: string }).error, /Pick an effect/);
  assert.match((checkSetting(guild, 'loopVoice', '7') as { error: string }).error, /Pick a voice/);
  assert.deepEqual(checkSetting(guild, 'loopTextEvery', 2.5), { value: 2.5 });
  assert.equal(show('loopText', 'stay a while'), '“stay a while”');
});

test('the looping room’s intro, its delay, and each part’s delay and volume after it', () => {
  const guild = { id: 'loop-intro', channels: { cache: new Map() } } as never;
  assert.deepEqual(checkSetting(guild, 'loopIntroDelayMs', 250), { value: 250 });
  assert.match((checkSetting(guild, 'loopIntroDelayMs', 10_001) as { error: string }).error, /0 to 10000/);
  assert.match((checkSetting(guild, 'loopIntro', 'nothing-here') as { error: string }).error, /Pick a sound/);
  assert.equal(show('loopIntroDelayMs', 400), '400 ms');
  assert.equal(show('loopTextDelayMs', 1500), '1500 ms');
  assert.equal(show('loopTextVolume', 70), '70%');
});
