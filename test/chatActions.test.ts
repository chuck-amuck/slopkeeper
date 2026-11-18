import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { recentActivity } from '../src/activity.ts';
import { db } from '../src/db.ts';
import { act, actionTools } from '../src/features/chatActions.ts';
import { lookUp } from '../src/features/chatLookups.ts';
import { setSetting } from '../src/settings.ts';

const GUILD = 'g-actions';

// What the bot posted, edited and made in Discord
const posted: { channelId: string; message: { content?: string; embeds?: unknown[]; components?: unknown[] } }[] = [];
const events: unknown[] = [];
const textChannel = (id: string) => ({
  id,
  name: 'general',
  guild,
  isTextBased: () => true,
  isSendable: () => true,
  send: async (message: (typeof posted)[number]['message']) => {
    posted.push({ channelId: id, message });
    return { id: `msg-${posted.length}` };
  },
  messages: { edit: async () => ({}) },
  toString: () => `<#${id}>`,
});
const client = { channels: { fetch: async (id: string) => textChannel(id) } };
const members = new Map<string, unknown>();
const channels = new Map<string, unknown>();
const guild = {
  id: GUILD,
  name: 'Test Server',
  members: { me: { id: '100', permissions: { has: () => true } }, cache: members },
  channels: { cache: channels },
  roles: { cache: new Map(), everyone: { id: GUILD } },
  scheduledEvents: {
    create: async (event: unknown) => {
      events.push(event);
      return { id: `event-${events.length}` };
    },
    edit: async () => ({}),
    delete: async () => {},
  },
};
/** Voice channels nobody but the bot can see */
const hidden = new Set<string>();
const voiceChannel = (id: string, name: string) => {
  const voice = {
    id,
    name,
    type: ChannelType.GuildVoice,
    guild,
    isVoiceBased: () => true,
    members: new Map<string, unknown>(),
    permissionsFor: (who: { id: string }) => ({ has: () => who.id === '100' || !hidden.has(id) }),
    toString: () => `<#${id}>`,
  };
  channels.set(id, voice);
  return voice;
};
const gaming = voiceChannel('701', 'Gaming');
voiceChannel('702', 'Gaming Two');
/** Channels where Manage Events is taken away from everyone but the host, by an overwrite */
const noManaging = new Set<string>();
function person(id: string, name: string, { manage = false, inVoice = false } = {}) {
  const has = (flag: bigint) => manage && flag === PermissionFlagsBits.ManageEvents;
  const member = {
    id,
    displayName: name,
    user: { bot: false, username: name.toLowerCase() },
    guild,
    client,
    voice: { channel: inVoice ? gaming : null },
    permissions: { has },
    permissionsIn: (channel: { id: string }) => ({ has: (flag: bigint) => !noManaging.has(channel.id) && has(flag) }),
  };
  members.set(id, member);
  if (inVoice) gaming.members.set(id, member);
  return member as never;
}
members.set('100', { id: '100', displayName: 'Slopkeeper', user: { bot: true } });
const robin = person('201', 'Robin', { inVoice: true });
const sam = person('202', 'Sam', { inVoice: true });
const mod = person('203', 'Mod', { manage: true });
const here = textChannel('c1') as never;
channels.set('c1', here);

const plan = (who: never, input: Record<string, unknown> = {}) =>
  act(who, 'plan_game_night', { game: 'Valheim', when: 'fri 9pm', details: '', voice_channel: '', repeat: 'no', ...input }, here) as Promise<string>;
const change = (who: never, id: number, input: Record<string, unknown>) => act(who, 'change_game_night', { night_id: id, action: 'change', game: '', when: '', details: '', ...input }, here) as Promise<string>;
const list = (who: never = robin) => act(who, 'game_nights', {}, here) as Promise<string>;
const nightId = (text: string) => Number(/night (\d+)/.exec(text)![1]);

function addGame(name: string, owners: string[]) {
  const id = Number(db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, NULL, '201')`).run(GUILD, name).lastInsertRowid);
  for (const user of owners) db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)').run(id, user);
}

beforeEach(() => {
  db.exec('DELETE FROM game_nights; DELETE FROM game_night_series; DELETE FROM game_night_rsvps; DELETE FROM game_votes; DELETE FROM games;');
  noManaging.clear();
  posted.length = 0;
  events.length = 0;
});

test('with actions off, it can still list game nights, but not plan, change or answer them, start votes or set reminders', (t) => {
  assert.deepEqual(
    actionTools(guild as never).map((tool) => tool.name),
    ['game_nights', 'plan_game_night', 'change_game_night', 'answer_game_night', 'start_vote', 'set_reminder', 'reminders', 'cancel_reminder'],
  );
  setSetting(GUILD, 'chatActions', false);
  t.after(() => setSetting(GUILD, 'chatActions', undefined));
  assert.deepEqual(
    actionTools(guild as never).map((tool) => tool.name),
    ['game_nights'],
  );
});

test('it plans a game night from a typed time, posting its card and event where it was asked, as the library names the game, and not twice', async () => {
  addGame('Valheim', ['201']);
  const said = await plan(robin, { game: 'valheim', voice_channel: 'gaming', repeat: 'weekly', details: 'Bring food' });
  assert.match(said, /^Planned Valheim night for Friday, \w+ \d+, 9:00 PM C[SD]T, repeating every week in Gaming\. Its RSVP message is posted here, with Robin in as host\. It’s a Discord event too\.$/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.channelId, 'c1');
  assert.equal(events.length, 1);
  assert.match(recentActivity(GUILD, 1)[0]!.action, /^Planned \*\*Valheim\*\* night for Friday/);
  assert.match(await plan(robin), /^There’s already a Valheim night then, hosted by Robin \(night \d+\)\.$/);
  assert.equal(posted.length, 1);

  // What it can't read or find, it says, and nothing is posted
  assert.equal(await plan(robin, { when: '' }), 'They didn’t say when: ask them.');
  assert.match(await plan(robin, { when: 'whenever' }), /^“whenever” isn’t a time it can read/);
  assert.match(await plan(robin, { when: '2020-01-01 19:00' }), /has already passed\.$/);
  assert.match(await plan(robin, { when: 'sat 9pm', voice_channel: 'nope' }), /^There’s no voice channel called “nope”\. They are: Gaming and Gaming Two\.$/);
  // Only those the asker can see
  hidden.add('702');
  assert.match(await plan(robin, { when: 'sat 9pm', voice_channel: 'gaming two' }), /^There’s no voice channel called “gaming two”\. They are: Gaming\.$/);
  hidden.clear();
  assert.match(await plan(robin, { when: 'sat 9pm', voice_channel: 'gam' }), /^More than one voice channel matches “gam”: Gaming and Gaming Two\. Ask which\.$/);
  assert.equal(await plan(robin, { game: '' }), 'Ask what they’re playing: a game’s name, in 90 characters or fewer.');
  assert.equal(posted.length, 1);
});

test('anyone answers a night for themselves, and only its host or someone with Manage Events changes, stops or cancels it', async () => {
  await plan(robin, { voice_channel: 'Gaming', repeat: 'weekly', details: 'Bring food' });
  const listed = await list(sam);
  assert.match(listed, /^night \d+: Valheim, Friday, .* 9:00 PM C[SD]T; hosted by Robin; in Gaming; details: Bring food; in: Robin; repeats every week$/);
  const id = nightId(listed);

  assert.equal(await act(sam, 'answer_game_night', { night_id: id, answer: 'maybe' }, here), 'Marked Sam “Maybe” for Valheim night.');
  assert.equal(recentActivity(GUILD, 1)[0]!.action, 'Answered **Maybe** for Sam to **Valheim** night');
  assert.match(await list(), /; in: Robin; maybe: Sam;/);
  assert.equal(await act(sam, 'answer_game_night', { night_id: 9999, answer: 'in' }, here), 'There’s no game night with that id. game_nights lists them.');

  assert.equal(await change(sam, id, { action: 'cancel' }), 'Only its host, Robin, or someone with Manage Events can change or cancel it.');
  // Manage Events counts in the night's channel, as on its buttons
  noManaging.add('c1');
  assert.equal(await change(mod, id, { when: 'sat 10pm' }), 'Only its host, Robin, or someone with Manage Events can change or cancel it.');
  noManaging.clear();
  assert.match(await change(mod, id, { when: 'sat 10pm' }), /^Changed the time\. It’s Valheim night, Saturday, .* 10:00 PM C[SD]T\.$/);
  assert.match(recentActivity(GUILD, 1)[0]!.action, /^Changed the time of \*\*Valheim\*\* night$/);
  assert.equal(await change(robin, id, {}), 'Ask what to change: the game, the time or the details.');
  assert.equal(await change(robin, id, { action: 'stop_repeating' }), 'Valheim night won’t repeat. This one stays on.');
  assert.equal(await change(robin, id, { action: 'stop_repeating' }), 'It doesn’t repeat.');
  assert.equal(await change(robin, id, { action: 'cancel' }), 'Cancelled Valheim night. Robin is told it’s off.');
  assert.match(recentActivity(GUILD, 1)[0]!.action, /^Cancelled \*\*Valheim\*\* night$/);
  assert.equal(await list(), 'No game nights are planned.');
  assert.equal(await change(robin, id, { action: 'cancel' }), 'There’s no upcoming game night with that id. game_nights lists them.');

  // With nobody in, nobody is told
  await plan(robin, { game: 'Halo' });
  const halo = nightId(await list());
  await act(robin, 'answer_game_night', { night_id: halo, answer: 'out' }, here);
  assert.equal(await change(robin, halo, { action: 'cancel' }), 'Cancelled Halo night.');
});

test('a vote is for the asker’s voice channel, on the games named however they’re written, one at a time', async () => {
  addGame('Valheim', ['201', '202']);
  addGame('Deep Rock Galactic', ['201', '202']);
  addGame('Lethal Company', ['201', '202']);
  const vote = (who: never, minutes: number, games: string[] = []) => act(who, 'start_vote', { minutes, games }, here) as Promise<string>;
  assert.equal(await vote(mod, 1), 'They aren’t in a voice channel. A vote is for the people in theirs, so they need to join one first.');
  assert.equal(
    await vote(robin, 99),
    'Started a vote here on what to play, for the people in Gaming, closing in 10 minutes. They vote with its buttons. On it: Deep Rock Galactic, Lethal Company and Valheim.',
  );
  assert.equal(posted.length, 1);
  assert.match(recentActivity(GUILD, 1)[0]!.action, /^Started a game vote for <#701> in <#c1>$/);
  assert.equal(await vote(sam, 1), 'There’s already a vote going in #Gaming.');

  db.exec('DELETE FROM game_votes');
  // Named however, and only those they all own
  addGame('Halo', ['202']);
  assert.equal(
    await vote(sam, 0, ['valheim', 'DEEP ROCK GALACTIC', 'halo']),
    'Started a vote here on what to play, for the people in Gaming, closing in 1 minute. They vote with its buttons. On it: Deep Rock Galactic and Valheim.',
  );
  const { options } = db.prepare('SELECT options FROM game_votes').get() as { options: string };
  assert.deepEqual(
    (JSON.parse(options) as { name: string }[]).map((o) => o.name).sort(),
    ['Deep Rock Galactic', 'Valheim'],
  );
});

test('a pick is random from what the group can all play, and asking again picks another', async () => {
  addGame('Valheim', ['201', '202']);
  addGame('Deep Rock Galactic', ['201', '202']);
  addGame('Lethal Company', ['201']);
  addGame('Halo', ['202']);
  const pick = async () => (await lookUp(robin, 'pick_game', { people: [], kind: 'any', steam_deck: 'any' })) as string;
  const picked = (text: string) => /\n- ([^:]+):/.exec(text)![1];
  const first = await pick();
  assert.match(first, /^For Robin and Sam, picked at random from the 2 games they both have:\n- (Valheim|Deep Rock Galactic): /);
  let last = picked(first);
  for (let i = 0; i < 4; i++) {
    const next = picked(await pick());
    assert.notEqual(next, last);
    last = next;
  }
  db.exec("DELETE FROM games WHERE name = 'Deep Rock Galactic'");
  assert.match(await pick(), /^For Robin and Sam, Valheim is the only game they both have:\n- Valheim: /);
  db.exec("DELETE FROM games WHERE name = 'Valheim'");
  assert.match(await pick(), /^For Robin and Sam: No multiplayer game is owned by both of them and fits 2 players\.\n(.*\n)?One purchase away:\n- Halo: .*Robin doesn’t have it\n- Lethal Company: .*Sam doesn’t have it$/);
});
