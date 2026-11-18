import './helpers.ts';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { db } from '../src/db.ts';
import { act, actionTools } from '../src/features/chatActions.ts';
import { chatReminders, readReminderTime, readWait, sendDue } from '../src/features/chatReminders.ts';
import { setSetting, setting } from '../src/settings.ts';

const GUILD = 'g-reminders';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const posted: { channelId: string; content: string; allowedMentions: unknown }[] = [];
/** People who can't see the channel, and what posting there does instead of working */
const blind = new Set<string>();
let failing: unknown = null;
const members = new Map<string, unknown>();
const guild = { id: GUILD, name: 'Test Server', members: { cache: members }, channels: { cache: new Map<string, unknown>() }, roles: { cache: new Map(), everyone: { id: GUILD } } };
/** Channels everyone in the server can't see */
const closed = new Set<string>();
const textChannel = (id: string) => ({
  id,
  name: 'general',
  guild,
  isSendable: () => true,
  isDMBased: () => false,
  permissionsFor: (who: { id: string }) => ({ has: () => !blind.has(who.id) && !(who.id === GUILD && closed.has(id)) }),
  send: async (message: { content: string; allowedMentions: unknown }) => {
    if (failing) throw failing;
    posted.push({ channelId: id, ...message });
    return { id: `msg-${posted.length}` };
  },
});
const here = textChannel('c1');
guild.channels.cache.set('c1', here);
/** Channels gone from Discord, as fetching them fails */
const gone = new Set<string>();
const client = {
  channels: {
    fetch: async (id: string) => {
      if (gone.has(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      return textChannel(id);
    },
  },
};
function person(id: string, name: string) {
  const member = { id, displayName: name, user: { bot: false, username: name.toLowerCase() }, guild, client };
  members.set(id, member);
  return member as never;
}
const robin = person('201', 'Robin');
const sam = person('202', 'Sam');
const alex = person('203', 'Alex');
for (const [id, name] of [['204', 'Kim'], ['205', 'Lee'], ['206', 'Max']]) person(id!, name!);

const set = (who: never, input: Record<string, unknown>) => act(who, 'set_reminder', { when: 'in 20 minutes', about: 'check the oven', people: [], ...input }, here as never) as Promise<string>;
const list = (who: never) => act(who, 'reminders', {}, here as never) as Promise<string>;
const cancel = (who: never, id: number) => act(who, 'cancel_reminder', { reminder_id: id }, here as never) as Promise<string>;
const idIn = (text: string) => Number(/reminder (\d+)/.exec(text)![1]);
const waiting = () => db.prepare('SELECT COUNT(*) AS n FROM chat_reminders').get() as { n: number };

beforeEach(() => {
  db.exec('DELETE FROM chat_reminders');
  posted.length = 0;
  blind.clear();
  gone.clear();
  failing = null;
});

test('a wait is read in minutes, hours, days or weeks, and a day and time as game nights read it', () => {
  assert.equal(readWait('in 20 minutes'), 20 * MINUTE);
  assert.equal(readWait('in 1 hour 30 minutes'), 90 * MINUTE);
  assert.equal(readWait('in 1h30m'), 90 * MINUTE);
  assert.equal(readWait('in an hour and 5 mins'), 65 * MINUTE);
  assert.equal(readWait('in 1.5 hours'), 90 * MINUTE);
  assert.equal(readWait('in a day'), 24 * HOUR);
  assert.equal(readWait('in 2 weeks'), 14 * 24 * HOUR);
  for (const no of ['in a while', 'tomorrow 9am', 'in', '20 minutes', 'in 5 parsecs']) assert.equal(readWait(no), null, no);

  const now = Date.now();
  const soon = readReminderTime(GUILD, 'in 20 minutes', now) as { at: number; label: string };
  assert.equal(soon.at, now + 20 * MINUTE);
  assert.match(soon.label, /^\w+day, \w+ \d+, \d+:\d+ [AP]M C[SD]T \(in 20 minutes\)$/);
  assert.match((readReminderTime(GUILD, 'in 3 days', now) as { label: string }).label, /\(in 3 days\)$/);
  // Some days ahead at a time there
  const at9 = readReminderTime(GUILD, 'in 2 days at 9am', now) as { at: number; label: string };
  assert.match(at9.label, /, 9:00 AM C[SD]T \(in .+\)$/);
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { timeZone: setting(GUILD, 'timezone') });
  assert.equal(day(at9.at), day(now + 2 * 24 * HOUR));
  assert.match(readReminderTime(GUILD, 'in 2 hours at 9am', now) as string, /isn’t a time it can read/);
  assert.match((readReminderTime(GUILD, 'in 26 hours', now) as { label: string }).label, /^\w+day, \w+ \d+, \d+:\d+ [AP]M C[SD]T \(in 26 hours\)$/);
  assert.match((readReminderTime(GUILD, 'in 2 hours 15 minutes', now) as { label: string }).label, /\(in 2 hours 15 minutes\)$/);
  assert.match((readReminderTime(GUILD, 'fri 9pm', now) as { label: string }).label, /^Friday, .* 9:00 PM C[SD]T \(in /);
  assert.equal(readReminderTime(GUILD, 'in 31 days', now), 'A reminder can be at most 30 days ahead.');
  assert.match(readReminderTime(GUILD, 'whenever', now) as string, /^“whenever” isn’t a time it can read/);

  // An hour without am or pm could be either
  for (const either of ['tomorrow at 9', 'in 2 days at 9', 'fri 7:30', 'at 9']) {
    assert.equal(readReminderTime(GUILD, either, now), `Is “${either}” in the morning or the evening? Ask them, unless they said, then give it with am or pm.`);
  }
  assert.match((readReminderTime(GUILD, 'tomorrow 9am', now) as { label: string }).label, /, 9:00 AM C[SD]T/);
  assert.match((readReminderTime(GUILD, 'tomorrow 21:00', now) as { label: string }).label, /, 9:00 PM C[SD]T/);
  assert.match((readReminderTime(GUILD, 'tomorrow noon', now) as { label: string }).label, /, 12:00 PM C[SD]T/);

  // Days ahead are on the calendar, so a clock change doesn't skip one: late on the Saturday before spring forward
  const saturdayNight = Date.parse('2027-03-14T05:30:00Z');
  assert.equal(setting(GUILD, 'timezone'), 'America/Chicago');
  assert.equal((readReminderTime(GUILD, 'in 1 day at 9am', saturdayNight) as { at: number }).at, Date.parse('2027-03-14T14:00:00Z'));
});

test('it sets a reminder for the asker or the people named, who must see the channel, at most 5 people and 10 waiting each', async () => {
  const mine = await set(robin, {});
  assert.match(mine, /^Set reminder \d+ for Robin, \w+day, .* \(in 20 minutes\): “check the oven”\. It’s posted here then, pinging them\.$/);
  assert.match(recentActivity(GUILD, 1)[0]!.action, /^Set a reminder for Robin for \w+day, .* C[SD]T$/);
  assert.match(await set(robin, { people: ['Sam', 'me'], about: 'the raid', when: 'fri 8pm' }), /^Set reminder \d+ for Sam and Robin, Friday, .*: “the raid”\. It’s posted here then, pinging each of them\.$/);

  assert.equal(await set(robin, { about: '' }), 'Ask what to remind them of.');
  assert.equal(await set(robin, { when: '' }), 'They didn’t say when: ask them.');
  assert.equal(await set(robin, { about: 'x'.repeat(301) }), 'Put what to remind them of in 300 characters or fewer.');
  assert.equal(await set(robin, { people: ['Nobody'] }), 'Nobody here is called “Nobody”.');
  assert.equal(await set(robin, { people: ['Robin', 'Sam', 'Alex', 'Kim', 'Lee', 'Max'] }), 'A reminder can be for 5 people at most.');
  blind.add('203');
  assert.equal(await set(robin, { people: ['Alex'] }), 'Alex can’t see this channel, so the reminder wouldn’t reach them. Ask them to set it somewhere they can see.');
  assert.equal(waiting().n, 2);

  for (let i = 2; i < 10; i++) await set(robin, {});
  assert.equal(await set(robin, {}), 'Robin has 10 reminders waiting already, the most there can be. They can cancel one first.');
  assert.match(await set(sam, {}), /^Set reminder/);
});

test('each person lists the reminders they set or that are for them, and cancels their own or takes themselves off another’s', async () => {
  const oven = idIn(await set(robin, {}));
  const raid = idIn(await set(robin, { people: ['Sam', 'Alex'], about: 'the raid', when: 'in 2 hours' }));
  await set(alex, { about: 'water the plants' });

  // One that's due but not posted yet
  db.prepare("INSERT INTO chat_reminders (guild_id, channel_id, created_by, people, text, due_at, created_at) VALUES (?, 'c1', '205', '[\"205\"]', 'now', ?, 0)").run(GUILD, Date.now() - 1000);
  assert.match(await list(person('205', 'Lee')), /\(due now\), for Lee/);
  db.exec("DELETE FROM chat_reminders WHERE created_by = '205'");
  const robins = await list(robin);
  assert.match(robins, new RegExp(`^reminder ${oven}: .* \\(in 20 minutes\\), for Robin, set by Robin in #general: check the oven\\nreminder ${raid}: .* \\(in 2 hours\\), for Sam and Alex, set by Robin in #general: the raid$`));
  assert.match(await list(sam), new RegExp(`^reminder ${raid}: `));
  assert.equal((await list(sam)).split('\n').length, 1);
  assert.equal(await list(person('207', 'Pat')), 'No reminders are waiting that Pat set or that are for them.');

  assert.equal(await cancel(sam, oven), 'Only Robin, who set it, can cancel it.');
  assert.equal(await cancel(sam, raid), `Took Sam off reminder ${raid}. It still reminds Alex.`);
  assert.equal(recentActivity(GUILD, 1)[0]!.action, 'Took themselves off a reminder from Robin');
  assert.equal(await cancel(alex, raid), `Took Alex off reminder ${raid}, so it’s cancelled.`);
  assert.equal(await cancel(robin, oven), `Cancelled reminder ${oven}: “check the oven”.`);
  assert.equal(recentActivity(GUILD, 1)[0]!.action, 'Cancelled a reminder for Robin');
  assert.equal(await cancel(robin, oven), 'There’s no reminder waiting with that id. reminders lists them.');
  assert.deepEqual(
    chatReminders(guild as never).map((r) => [r.by, r.people, r.text, r.channel]),
    [['Alex', ['Alex'], 'water the plants', 'general']],
  );
});

test('asked in another channel, a reminder set where not everyone can see doesn’t say what it is', async () => {
  db.exec('DELETE FROM chat_reminders');
  closed.add('c2');
  const staff = textChannel('c2');
  guild.channels.cache.set('c2', staff);
  const id = idIn(await act(robin, 'set_reminder', { when: 'in 20 minutes', about: 'the surprise party', people: [] }, staff as never) as string);
  assert.match(await act(robin, 'reminders', {}, staff as never) as string, /the surprise party/);
  assert.match(await list(robin), new RegExp(`^reminder ${id}: \\w+day, .+ \\(in \\d+ minutes\\), set in a channel not everyone here can see, so what it says isn’t shown here$`));
  assert.doesNotMatch(await list(robin), /surprise/);
  assert.equal(await cancel(robin, id), `Cancelled reminder ${id}.`);
  closed.delete('c2');
});

test('when it’s due it’s posted where it was asked, pinging only those it’s for, and late only up to an hour', async () => {
  const now = Date.now();
  await set(robin, {});
  await set(robin, { people: ['Sam', 'me'], about: 'the raid @everyone' });
  await sendDue(client as never, now + 19 * MINUTE);
  assert.equal(posted.length, 0);

  await sendDue(client as never, now + 20 * MINUTE + 1000);
  assert.deepEqual(
    posted.map((p) => [p.channelId, p.content, p.allowedMentions]),
    [
      ['c1', '⏰ <@201>, you asked me to remind you: check the oven', { users: ['201'] }],
      ['c1', '⏰ <@202> <@201>: a reminder from Robin: the raid @everyone', { users: ['202', '201'] }],
    ],
  );
  assert.equal(waiting().n, 0);

  // After the bot was down: posted late, saying so, within the hour, and dropped after it
  posted.length = 0;
  await set(robin, { when: 'in 5 minutes' });
  await set(robin, { about: 'stretch', when: 'in 30 minutes' });
  await sendDue(client as never, now + 70 * MINUTE + 1000);
  assert.deepEqual(
    posted.map((p) => p.content),
    ['⏰ <@201>, you asked me to remind you: stretch\n-# 40 minutes late, as the bot was offline'],
  );
  assert.equal(waiting().n, 0);
});

test('a reminder whose channel is gone or that Discord refuses is dropped, and one a network failure stops is tried again', async () => {
  const now = Date.now();
  await set(robin, {});
  failing = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  await sendDue(client as never, now + 21 * MINUTE);
  assert.equal(waiting().n, 1);
  failing = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  await sendDue(client as never, now + 22 * MINUTE);
  assert.equal(waiting().n, 0);

  await set(robin, {});
  gone.add('c1');
  await sendDue(client as never, now + 21 * MINUTE);
  assert.equal(waiting().n, 0);
  assert.equal(posted.length, 0);

  // A channel Discord doesn't answer for only holds up its own reminder
  gone.clear();
  failing = null;
  await set(robin, {});
  await set(sam, {});
  const fetching = client.channels.fetch;
  let first = true;
  client.channels.fetch = async (id: string) => {
    if (first) {
      first = false;
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    }
    return fetching(id);
  };
  await sendDue(client as never, now + 21 * MINUTE);
  client.channels.fetch = fetching;
  assert.deepEqual(
    [waiting().n, posted.map((p) => p.content)],
    [1, ['⏰ <@202>, you asked me to remind you: check the oven']],
  );
});

test('with actions off, reminders aren’t offered or set, and those set already are still posted', async (t) => {
  await set(robin, {});
  setSetting(GUILD, 'chatActions', false);
  t.after(() => setSetting(GUILD, 'chatActions', undefined));
  assert.deepEqual(
    actionTools(guild as never).map((tool) => tool.name),
    ['game_nights'],
  );
  assert.equal(await set(robin, {}), 'Taking actions in chat is turned off on this server. Point them to the command, if there is one.');
  await sendDue(client as never, Date.now() + 21 * MINUTE);
  assert.equal(posted.length, 1);
});
