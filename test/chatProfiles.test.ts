import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../src/db.ts';
import {
  activeProfile,
  addProfile,
  builtIn,
  DEFAULT_DESPISES,
  editProfile,
  fieldsOf,
  forgetProfileVoices,
  freeName,
  moveChatPersonality,
  nameFrom,
  profileById,
  profileFields,
  profiles,
  removeProfile,
  resetBuiltIn,
  takenProfileNames,
} from '../src/features/chatProfiles.ts';
import { applyNickname, CANT_RENAME, followProfile, nameAs, nicknameProblem } from '../src/features/profileNames.ts';
import { ownSpeech } from '../src/features/say.ts';
import { setSetting, storedSetting } from '../src/settings.ts';

// Profiles: who the bot is, how it talks and its voice, shared by every server, each of which picks one

const KNOWN = { voice: (id: string) => ['yoda', 'scottish'].includes(id), effect: (id: string) => ['none', 'robot'].includes(id) };
const check = (input: Record<string, unknown>) => profileFields(input, takenProfileNames(), KNOWN);
const store = (guildId: string, key: string, value: string) => db.prepare('INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?)').run(guildId, key, value);

beforeEach(() => {
  db.exec('DELETE FROM chat_profiles; DELETE FROM guild_settings;');
});

test('a profile is checked, and what’s left out is at its default', () => {
  assert.deepEqual(check({ name: '  Grumpy   pirate ', personality: '  A grumpy pirate.  ' }), {
    name: 'Grumpy pirate',
    personality: 'A grumpy pirate.',
    length: 'medium',
    opinions: 'straight',
    swearing: 'fits',
    roasts: 'savage',
    despises: DEFAULT_DESPISES,
    voice: null,
    effect: null,
    nickname: '',
  });
  const fine = { name: 'Pirate', personality: 'A pirate.' };
  assert.equal(check({ ...fine, name: '!!' }), 'Give the profile a name.');
  assert.equal(check({ ...fine, name: 'x'.repeat(41) }), 'Keep the name to 40 characters.');
  assert.equal(check({ ...fine, name: 'robot BUTLER' }), 'There’s already a profile called robot BUTLER.');
  assert.equal(check({ ...fine, personality: '!!!' }), 'Describe who the bot is when it answers.');
  assert.equal(check({ ...fine, personality: 'a'.repeat(1001) }), 'Keep the personality to 1000 characters.');
  assert.equal(check({ ...fine, swearing: 'always' }), 'Pick one of the choices for swearing.');
  assert.equal(check({ ...fine, length: 7 }), 'Pick one of the choices for answer length.');
  assert.equal(check({ ...fine, despises: '???' }), 'Name who it can’t stand, or leave it empty for nobody.');
  assert.equal(check({ ...fine, despises: 'x'.repeat(201) }), 'Keep who it can’t stand to 200 characters.');
  assert.equal(check({ ...fine, voice: 'nobody' }), 'Pick a voice from the list.');
  assert.equal(check({ ...fine, effect: 'kazoo' }), 'Pick an effect from the list.');
  // Empty is nobody, and the server's default voice and effect
  assert.deepEqual(
    (({ despises, voice, effect, length, swearing, roasts, opinions }) => ({ despises, voice, effect, length, swearing, roasts, opinions }))(
      check({ ...fine, despises: '', voice: '', effect: null, length: 'chatty', swearing: 'never', roasts: 'playful', opinions: 'diplomatic' }) as never,
    ),
    { despises: '', voice: null, effect: null, length: 'chatty', swearing: 'never', roasts: 'playful', opinions: 'diplomatic' },
  );
  assert.equal((check({ ...fine, voice: 'yoda', effect: 'none' }) as { effect: string }).effect, 'none');
});

test('a server is on the Robot butler until it picks another, and back on it once that’s deleted', () => {
  assert.deepEqual(
    profiles().map((p) => p.name),
    ['Robot butler'],
  );
  assert.equal(activeProfile('g1').id, 'butler');
  const zed = addProfile({ ...fieldsOf(builtIn()), name: 'Zed', personality: 'Z.' }, 'u1');
  const able = addProfile({ ...fieldsOf(builtIn()), name: 'able', personality: 'A.' }, 'u1');
  // The butler first, then by name
  assert.deepEqual(
    profiles().map((p) => p.name),
    ['Robot butler', 'able', 'Zed'],
  );
  assert.equal(addProfile({ ...fieldsOf(builtIn()), name: 'Zed!', personality: 'Z.' }, 'u1'), 'zed-2', 'ids stay apart');
  setSetting('g1', 'chatProfile', zed);
  setSetting('g2', 'chatProfile', zed);
  setSetting('g3', 'chatProfile', able);
  assert.equal(activeProfile('g1').name, 'Zed');
  assert.equal(removeProfile(zed), 2);
  assert.equal(profileById(zed), undefined);
  assert.equal(storedSetting('g1', 'chatProfile'), undefined);
  assert.equal(activeProfile('g1').id, 'butler');
  assert.equal(activeProfile('g3').name, 'able');
});

test('the Robot butler can be changed and put back to how it started', () => {
  assert.equal(profiles()[0]!.changed, false);
  editProfile('butler', { ...fieldsOf(builtIn()), personality: 'A tired butler.', swearing: 'never' }, 'u1');
  const changed = profiles()[0]!;
  assert.deepEqual([changed.id, changed.personality, changed.swearing, changed.builtIn, changed.changed], ['butler', 'A tired butler.', 'never', true, true]);
  assert.equal(profiles().length, 1, 'still one butler');
  assert.equal(activeProfile('g1').personality, 'A tired butler.');
  resetBuiltIn();
  assert.deepEqual(profiles()[0], builtIn());
  // Changed only in its voice, it still takes its personality from the host
  editProfile('butler', { ...fieldsOf(builtIn()), voice: 'scottish' }, 'u1');
  const before = process.env.CHAT_PERSONALITY;
  process.env.CHAT_PERSONALITY = 'A butler set by the host.';
  try {
    assert.deepEqual([activeProfile('g1').personality, activeProfile('g1').voice, activeProfile('g1').changed], ['A butler set by the host.', 'scottish', true]);
  } finally {
    if (before === undefined) delete process.env.CHAT_PERSONALITY;
    else process.env.CHAT_PERSONALITY = before;
  }
  // And changed back to how it started, it's the built-in one again
  editProfile('butler', fieldsOf(builtIn()), 'u1');
  assert.equal(profiles()[0]!.changed, false);
});

test('a profile whose voice is removed speaks in the server’s default voice', () => {
  const id = addProfile({ ...fieldsOf(builtIn()), name: 'Scot', personality: 'A Scot.', voice: 'scottish', effect: 'robot' }, 'u1');
  setSetting('g1', 'chatProfile', id);
  assert.deepEqual([ownSpeech('g1').voice.id, ownSpeech('g1').effect?.id], ['scottish', 'robot']);
  // The server's own default effect isn't used while the profile has one
  setSetting('g1', 'ttsEffect', 'none');
  assert.equal(ownSpeech('g1').effect?.id, 'robot');
  assert.equal(forgetProfileVoices(['scottish', 'other']), 1);
  assert.equal(profileById(id)!.voice, null);
  assert.equal(ownSpeech('g1').voice.id, 'southern-man');
  // On the butler, the server's voice and effect
  setSetting('g1', 'chatProfile', undefined);
  setSetting('g1', 'ttsVoice', 'scottish');
  assert.deepEqual([ownSpeech('g1').voice.id, ownSpeech('g1').effect], ['scottish', null]);
});

test('a personality from before profiles becomes a profile with the server’s voice, picked for it, once', (t) => {
  t.mock.method(console, 'log', () => undefined);
  const yoda = 'Yoda, the ancient Jedi Master, now keeping watch over a Discord server.';
  store('g1', 'chatPersonality', yoda);
  store('g1', 'ttsVoice', 'yoda');
  // Another server with the same shares it
  store('g2', 'chatPersonality', yoda);
  store('g2', 'ttsVoice', 'yoda');
  // Another Yoda, with only an effect of its own, gets a name of its own
  store('g3', 'chatPersonality', 'Yoda: but grumpier');
  store('g3', 'ttsEffect', 'robot');
  store('g4', 'chatModel', 'opus');
  moveChatPersonality();
  const first = activeProfile('g1');
  assert.deepEqual(
    [first.name, first.personality, first.voice, first.effect, first.length, first.roasts, first.despises],
    ['Yoda', yoda, 'yoda', null, 'medium', 'savage', DEFAULT_DESPISES],
  );
  assert.equal(activeProfile('g2').id, first.id);
  assert.deepEqual([activeProfile('g3').name, activeProfile('g3').voice, activeProfile('g3').effect], ['Yoda 2', null, 'robot']);
  assert.equal(activeProfile('g4').id, 'butler');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM guild_settings WHERE key = 'chatPersonality'").get() as { n: number }).n, 0);
  // Once
  moveChatPersonality();
  assert.equal(profiles().length, 3);
});

test('a profile made from a personality is named from its first words', () => {
  assert.equal(nameFrom('Yoda, the ancient Jedi Master'), 'Yoda');
  assert.equal(nameFrom('Bender: a foul-mouthed robot'), 'Bender');
  assert.equal(nameFrom(builtIn().personality), 'A robot butler with impeccable manners');
  assert.equal(nameFrom('!!! ...'), 'Custom');
  assert.equal(nameFrom(`${'x'.repeat(60)}, and more`), 'x'.repeat(40));
  // A name taken gets a number, within the longest a name can be
  addProfile({ ...fieldsOf(builtIn()), name: 'y'.repeat(40), personality: 'Y.' }, 'u1');
  assert.equal(freeName(`${'y'.repeat(40)} copy`), `${'y'.repeat(38)} 2`);
});

/** A server whose bot can be renamed, and each name it was given */
function renamable(id: string, canRename = true) {
  const me = {
    nickname: null as string | null,
    renamed: [] as (string | null)[],
    fail: false,
    get displayName() {
      return this.nickname ?? 'Slopkeeper';
    },
    user: { displayName: 'Slopkeeper' },
    permissions: { has: () => canRename },
    async setNickname(nickname: string | null) {
      if (me.fail) throw new Error('Missing Permissions');
      me.nickname = nickname;
      me.renamed.push(nickname);
    },
  };
  return { guild: { id, members: { me } } as never, me };
}

test('a nickname is renamed to and from, and one given by hand is left alone', async (t) => {
  const { guild, me } = renamable('g1');
  const none = { nickname: '' };
  const captain = { nickname: 'Captain' };
  // Neither has one: nothing, even over a nickname given by hand
  me.nickname = 'Jeeves';
  assert.equal(await applyNickname(guild, none, none), null);
  assert.equal(await applyNickname(guild, null, none), null);
  assert.equal(me.nickname, 'Jeeves');
  assert.equal(await applyNickname(guild, none, captain), null);
  assert.equal(me.nickname, 'Captain');
  // Already that: not asked again
  await applyNickname(guild, captain, captain);
  assert.deepEqual(me.renamed, ['Captain']);
  await applyNickname(guild, captain, none);
  assert.equal(me.nickname, null);
  // One given by hand since isn't cleared for a profile it isn't, only replaced by another nickname
  me.nickname = 'Butler Bot';
  assert.equal(await applyNickname(guild, captain, none), null);
  assert.equal(me.nickname, 'Butler Bot');
  me.renamed.length = 0;
  // Without the permission, or turned down, it says why and doesn't throw
  const { guild: locked, me: lockedMe } = renamable('g2', false);
  assert.equal(await applyNickname(locked, none, captain), CANT_RENAME);
  assert.deepEqual(lockedMe.renamed, []);
  me.fail = true;
  const warned = t.mock.method(console, 'warn', () => undefined);
  assert.match((await applyNickname(guild, none, captain))!, /didn’t let me change my nickname here: Missing Permissions/);
  assert.equal(warned.mock.callCount(), 1);
});

test('the bot’s name follows the profile picked, and is what it would be with another', async () => {
  const { guild, me } = renamable('g1');
  const pirate = addProfile({ ...fieldsOf(builtIn()), name: 'Pirate', personality: 'A pirate.', nickname: 'Captain' }, 'u1');
  const plain = addProfile({ ...fieldsOf(builtIn()), name: 'Plain', personality: 'Plain.' }, 'u1');
  // On the butler, what it's called now, even by hand; a profile with a nickname, that
  me.nickname = 'Jeeves';
  assert.equal(nameAs(guild, activeProfile('g1')), 'Jeeves');
  assert.equal(nameAs(guild, profileById(plain)!), 'Jeeves');
  assert.equal(nameAs(guild, profileById(pirate)!), 'Captain');
  setSetting('g1', 'chatProfile', pirate);
  await followProfile(guild);
  assert.equal(me.nickname, 'Captain');
  // Named for a profile, another without a nickname would put its own name back
  assert.equal(nameAs(guild, activeProfile('g1')), 'Captain');
  assert.equal(nameAs(guild, profileById(plain)!), 'Slopkeeper');
  setSetting('g1', 'chatProfile', plain);
  await followProfile(guild);
  assert.equal(me.nickname, null);
  assert.deepEqual(me.renamed, ['Captain', null]);
});

test('Settings is told when the profile’s nickname can’t be taken', () => {
  const { guild } = renamable('g1', false);
  assert.equal(nicknameProblem(guild), null);
  setSetting('g1', 'chatProfile', addProfile({ ...fieldsOf(builtIn()), name: 'Pirate', personality: 'A pirate.', nickname: 'Captain' }, 'u1'));
  assert.match(nicknameProblem(guild)!, /called \*\*Captain\*\*.*Change Nickname/);
  // and chat goes by the name it has, not the one it couldn't take
  assert.equal(nameAs(guild, activeProfile('g1')), 'Slopkeeper');
  assert.equal(nicknameProblem(renamable('g1').guild), null, 'with the permission, it’s renamed');
});

test('a database from before nicknames gets the column', async () => {
  db.exec('ALTER TABLE chat_profiles DROP COLUMN nickname');
  await import(`../src/features/chatProfiles.ts?older=${Date.now()}`);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('chat_profiles') WHERE name = 'nickname'").get());
  assert.equal(profiles()[0]!.nickname, '');
});
