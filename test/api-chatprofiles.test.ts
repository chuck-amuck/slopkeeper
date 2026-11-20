import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../src/db.ts';
import { activeProfile } from '../src/features/chatProfiles.ts';
import { setSetting } from '../src/settings.ts';
import { GUILD, activityText, call, me, ok, refused, setFake } from './apiFixture.ts';

// Profiles in the web UI: listed, added, copied, changed, deleted, and the Robot butler put back

const URL = `/guilds/${GUILD}/chat-profiles`;
const named = (list: { profiles: { name: string }[] }, name: string) => list.profiles.find((p) => p.name === name) as Record<string, any>;

beforeEach(() => {
  db.exec('DELETE FROM chat_profiles; DELETE FROM guild_settings; DELETE FROM activity;');
});

test('the profiles are listed with their traits and choices, the Robot butler first and in use', async () => {
  const list = await ok(URL);
  assert.equal(list.profiles.length, 1);
  assert.deepEqual(
    (({ id, name, builtIn, changed, active, servers, length, swearing, voice, effect }) => ({ id, name, builtIn, changed, active, servers, length, swearing, voice, effect }))(list.profiles[0]),
    { id: 'butler', name: 'Robot butler', builtIn: true, changed: false, active: true, servers: 1, length: 'medium', swearing: 'fits', voice: null, effect: null },
  );
  assert.match(list.profiles[0].personality, /robot butler/);
  assert.deepEqual(
    list.traits.map((t: { key: string }) => t.key),
    ['length', 'opinions', 'swearing', 'roasts'],
  );
  assert.deepEqual(list.traits[2].options[1], ['never', 'Never', 'never swears']);
  assert.deepEqual([list.most, list.longest], [50, { name: 40, personality: 1000, despises: 200, nickname: 32 }]);
  assert.equal(list.profiles[0].nickname, '');
  // Settings has them for the Profile picker
  const { profiles } = await ok(`/guilds/${GUILD}/settings`);
  assert.deepEqual(profiles, [{ id: 'butler', name: 'Robot butler' }]);
});

test('a profile is added, copied, picked, changed and deleted, each in Activity', async () => {
  const added = await ok(URL, { method: 'POST', json: { name: 'Pirate', personality: 'A grumpy pirate.', swearing: 'freely', voice: 'scottish', effect: 'robot', despises: '' } });
  assert.equal(added.id, 'pirate');
  const pirate = named(added, 'Pirate');
  assert.deepEqual([pirate.swearing, pirate.voice, pirate.effect, pirate.despises, pirate.active, pirate.servers], ['freely', 'scottish', 'robot', '', false, 0]);

  const copied = await ok(URL, { method: 'POST', json: { copyOf: 'pirate' } });
  assert.deepEqual((({ name, personality, swearing, voice }) => ({ name, personality, swearing, voice }))(named(copied, 'Pirate copy')), { name: 'Pirate copy', personality: 'A grumpy pirate.', swearing: 'freely', voice: 'scottish' });

  await ok(`/guilds/${GUILD}/settings/chatProfile`, { method: 'PUT', json: { value: 'pirate' } });
  assert.equal(activeProfile(GUILD).name, 'Pirate');
  const listed = await ok(URL);
  assert.deepEqual([named(listed, 'Pirate').active, named(listed, 'Pirate').servers, named(listed, 'Robot butler').servers], [true, 1, 0]);

  // Only what's given changes
  const changed = await ok(`${URL}/pirate`, { method: 'PUT', json: { name: 'Captain', roasts: 'playful', voice: null } });
  assert.deepEqual((({ name, personality, roasts, swearing, voice, effect }) => ({ name, personality, roasts, swearing, voice, effect }))(named(changed, 'Captain')), {
    name: 'Captain',
    personality: 'A grumpy pirate.',
    roasts: 'playful',
    swearing: 'freely',
    voice: null,
    effect: 'robot',
  });

  const deleted = await ok(`${URL}/pirate`, { method: 'DELETE' });
  assert.equal(deleted.servers, 1);
  assert.equal(activeProfile(GUILD).id, 'butler');
  assert.deepEqual(activityText(), [
    'Added the profile Pirate',
    'Added the profile Pirate copy',
    'Set Profile to Pirate',
    'Changed the profile Pirate, now called Captain',
    'Deleted the profile Captain, and 1 server’s pick of it',
  ]);
});

test('a profile that isn’t right is turned down, with why', async () => {
  assert.equal(await refused(400, URL, { method: 'POST', json: { name: 'Robot Butler', personality: 'Me.' } }), 'There’s already a profile called Robot Butler.');
  assert.equal(await refused(400, URL, { method: 'POST', json: { name: 'Odd', personality: 'Me.', roasts: 'nuclear' } }), 'Pick one of the choices for roasts.');
  assert.equal(await refused(400, URL, { method: 'POST', json: { name: 'Odd', personality: 'Me.', voice: 'nobody' } }), 'Pick a voice from the list.');
  assert.equal(await refused(400, URL, { method: 'POST', json: { name: 'Odd', personality: 'Me.', effect: 'kazoo' } }), 'Pick an effect from the list.');
  assert.equal(await refused(400, URL, { method: 'POST', json: { name: 'Odd' } }), 'Describe who the bot is when it answers.');
  // Renaming one to its own name in another case is fine
  await ok(URL, { method: 'POST', json: { name: 'Odd', personality: 'Me.' } });
  await ok(`${URL}/odd`, { method: 'PUT', json: { name: 'ODD' } });
  assert.equal(await refused(400, `${URL}/odd`, { method: 'PUT', json: { name: 'robot butler' } }), 'There’s already a profile called robot butler.');
  assert.equal(await refused(404, `${URL}/nobody`, { method: 'PUT', json: {} }), 'That profile isn’t there any more.');
  assert.equal(await refused(404, `${URL}/nobody`, { method: 'DELETE' }), 'That profile isn’t there any more.');
  assert.equal(await refused(400, `/guilds/${GUILD}/settings/chatProfile`, { method: 'PUT', json: { value: 'nobody' } }), 'Pick a profile from the list.');
  assert.equal((await call(`${URL}/odd/more`)).status, 404);
});

test('the Robot butler is changed, and put back rather than deleted', async () => {
  assert.equal(await refused(409, `${URL}/butler`, { method: 'DELETE' }), 'Robot butler is built in, and hasn’t been changed.');
  const changed = await ok(`${URL}/butler`, { method: 'PUT', json: { personality: 'A weary butler.', length: 'short' } });
  assert.deepEqual([changed.profiles.length, changed.profiles[0].personality, changed.profiles[0].length, changed.profiles[0].changed], [1, 'A weary butler.', 'short', true]);
  const reset = await ok(`${URL}/butler`, { method: 'DELETE' });
  assert.deepEqual([reset.profiles[0].changed, reset.profiles[0].length, reset.servers], [false, 'medium', 0]);
  assert.match(reset.profiles[0].personality, /robot butler/);
  assert.deepEqual(activityText(), ['Changed the profile Robot butler', 'Put the profile Robot butler back to how it started']);
  // A server on it stays on it
  setSetting(GUILD, 'chatProfile', 'butler');
  assert.equal(activeProfile(GUILD).id, 'butler');
  // Saving it unchanged doesn't keep it apart from the host's
  await ok(`${URL}/butler`, { method: 'PUT', json: {} });
  assert.equal((await ok(URL)).profiles[0].changed, false);
  // Not put back while another profile has its name
  await ok(`${URL}/butler`, { method: 'PUT', json: { name: 'Jeeves' } });
  await ok(URL, { method: 'POST', json: { name: 'Robot butler', personality: 'An impostor.' } });
  assert.equal(await refused(409, `${URL}/butler`, { method: 'DELETE' }), 'Another profile is called Robot butler. Rename it first.');
  assert.equal(activityText().length, 4);
});

test('a profile keeps a voice that isn’t on offer for now, and a copy’s name fits', async () => {
  db.prepare(
    "INSERT INTO chat_profiles (id, name, personality, voice, effect, added_by, added_at, changed_at) VALUES ('teller', ?, 'A storyteller.', 'downloading', 'robot', 'u1', 0, 0)",
  ).run('t'.repeat(40));
  const changed = await ok(`${URL}/teller`, { method: 'PUT', json: { roasts: 'cutting' } });
  assert.deepEqual([changed.profiles[1].roasts, changed.profiles[1].voice], ['cutting', 'downloading']);
  // but can't be given one that isn't
  assert.equal(await refused(400, `${URL}/teller`, { method: 'PUT', json: { voice: 'elsewhere' } }), 'Pick a voice from the list.');
  const copied = await ok(URL, { method: 'POST', json: { copyOf: 'teller' } });
  const copy = copied.profiles.find((p: { id: string }) => p.id === copied.id);
  assert.ok(copy.name.length <= 40, copy.name);
  await ok(`${URL}/${copied.id}`, { method: 'PUT', json: { swearing: 'never' } });
});

const SETTING = `/guilds/${GUILD}/settings/chatProfile`;

test('a profile’s nickname renames the bot where it’s used, and its own name comes back when it isn’t', async () => {
  await ok(URL, { method: 'POST', json: { name: 'Pirate', personality: 'A pirate.', nickname: '  Captain ' } });
  assert.deepEqual(me.renamed, [], 'not until it’s picked');
  assert.equal((await ok(SETTING, { method: 'PUT', json: { value: 'pirate' } })).warning, undefined);
  assert.equal(me.nickname, 'Captain');
  // A new nickname renames it again; another change doesn't
  await ok(`${URL}/pirate`, { method: 'PUT', json: { nickname: 'Cap’n' } });
  await ok(`${URL}/pirate`, { method: 'PUT', json: { roasts: 'playful' } });
  assert.deepEqual(me.renamed, ['Captain', 'Cap’n']);
  // Back on the Robot butler, and deleted while picked, it has its own name
  await ok(SETTING, { method: 'DELETE' });
  assert.equal(me.nickname, null);
  await ok(SETTING, { method: 'PUT', json: { value: 'pirate' } });
  await ok(`${URL}/pirate`, { method: 'DELETE' });
  assert.deepEqual(me.renamed, ['Captain', 'Cap’n', null, 'Cap’n', null]);
  // A nickname an admin gave it stays while profiles without one are picked
  me.nickname = 'Jeeves';
  await ok(URL, { method: 'POST', json: { name: 'Plain', personality: 'Plain.' } });
  await ok(SETTING, { method: 'PUT', json: { value: 'plain' } });
  await ok(SETTING, { method: 'DELETE' });
  assert.equal(me.nickname, 'Jeeves');
  assert.equal(me.renamed.length, 5);
});

test('without Change Nickname, a profile with a nickname is still picked, and Settings says what’s missing', async () => {
  setFake({ changeNickname: false });
  await ok(URL, { method: 'POST', json: { name: 'Pirate', personality: 'A pirate.', nickname: 'Captain' } });
  const { warning } = await ok(SETTING, { method: 'PUT', json: { value: 'pirate' } });
  assert.equal(warning, 'I can’t change my nickname here: give my role Change Nickname.');
  assert.equal(activeProfile(GUILD).id, 'pirate');
  assert.equal(me.nickname, null);
  const { problems } = await ok(`/guilds/${GUILD}/settings`);
  assert.deepEqual(
    problems.filter((p: { key: string }) => p.key === 'chatProfile').map((p: { text: string }) => p.text),
    ['Profile: it’s called **Captain**, but I can’t change my nickname here. Give my role **Change Nickname**.'],
  );
  // and saying so again when its nickname changes
  assert.match((await ok(`${URL}/pirate`, { method: 'PUT', json: { nickname: 'Cap’n' } })).warning, /Change Nickname/);
});

test('a nickname Discord wouldn’t take is turned down', async () => {
  const post = (nickname: unknown) => ({ method: 'POST', json: { name: 'Odd', personality: 'Me.', nickname } });
  assert.equal(await refused(400, URL, post('x'.repeat(33))), 'Keep the nickname to 32 characters, the most Discord allows.');
  for (const bad of ['@everyone', 'Bot#1', 'a:b', '`x`', '!!!']) assert.equal(await refused(400, URL, post(bad)), 'A nickname can’t have @, #, : or ` in it, and needs a letter or number.', bad);
  assert.equal(await refused(400, URL, post(7)), 'Type a nickname, or leave it empty for the bot’s own name.');
  assert.equal(named(await ok(URL, post('Señor Bot 9')), 'Odd').nickname, 'Señor Bot 9');
});
