import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { config } from '../src/config.ts';
import { feeds } from '../src/changes.ts';
import { db } from '../src/db.ts';
import { gameNights, nextOccurrence, parseWhen, tick, whenText } from '../src/features/gamenight.ts';
import { setSetting } from '../src/settings.ts';

const zone = 'America/Chicago';
const thursday3pm = Date.UTC(2026, 9, 29, 20, 0);
const local = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleString('sv-SE', { timeZone: zone }).slice(0, 16));

test('reads day and time phrases in the server’s time zone', () => {
  const cases: [string, string | null][] = [
    ['fri 8pm', '2026-10-30 20:00'],
    ['friday 8', '2026-10-30 20:00'],
    ['Thu 9pm', '2026-10-29 21:00'],
    ['thu 2pm', '2026-11-05 14:00'],
    ['next thu 9pm', '2026-11-05 21:00'],
    ['tomorrow 20:30', '2026-10-30 20:30'],
    ['tonight at 9', '2026-10-29 21:00'],
    ['9pm', '2026-10-29 21:00'],
    ['2pm', '2026-10-30 14:00'],
    ['nov 3 7pm', '2026-11-03 19:00'],
    ['November 3rd at 7:30 pm', '2026-11-03 19:30'],
    ['11/3 9', '2026-11-03 21:00'],
    ['2026-11-03 19:00', '2026-11-03 19:00'],
    ['sat noon', '2026-10-31 12:00'],
    ['8pm fri', '2026-10-30 20:00'],
    ['sun 10am', '2026-11-01 10:00'],
    ['jan 2 8pm', '2027-01-02 20:00'],
    ['sat at 11:30am', '2026-10-31 11:30'],
    ['blah', null],
    ['fri', null],
    ['25:00', null],
    ['fri 8pm with snacks', null],
  ];
  for (const [text, expected] of cases) assert.equal(local(parseWhen(text, thursday3pm, zone)), expected, text);
});

test('uses the offset on the day itself, across a daylight saving change', () => {
  assert.equal(new Date(parseWhen('nov 2 8pm', thursday3pm, zone)!).toISOString(), '2026-11-03T02:00:00.000Z');
  assert.equal(new Date(parseWhen('fri 8pm', thursday3pm, 'Europe/London')!).toISOString(), '2026-10-30T20:00:00.000Z');
});

function night(guildId: string, startsIn: number) {
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO game_nights (guild_id, channel_id, game, starts_at, created_by) VALUES (?, ?, 'Valheim', ?, 'host')`)
    .run(guildId, `channel-${guildId}`, Date.now() + startsIn);
  db.prepare(`INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, 'host', 'in')`).run(lastInsertRowid);
  return Number(lastInsertRowid);
}
const reminded = (id: number) => (db.prepare('SELECT reminded FROM game_nights WHERE id = ?').get(id) as { reminded: number }).reminded;

test('a reminder is a plain message, so it doesn’t need Read Message History', async () => {
  const id = night('plain', 600_000);
  db.prepare(`UPDATE game_nights SET message_id = 'card' WHERE id = ?`).run(id);
  const sent: Record<string, unknown>[] = [];
  await tick(
    fakeClient([{ id: 'plain', name: 'Plain' }], async (_guild, message) => {
      sent.push(message);
    }),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply, undefined);
  assert.match(String(sent[0].content), /<@host>/);
  assert.match(String(sent[0].content), /channels\/plain\/channel-plain\/card/);
});

test('a reminder is said in the night’s voice channel when that’s turned on', async (t) => {
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(init.body as string) as { text: string }).text);
    return new Response('', { status: 500 });
  });
  t.mock.method(console, 'error', () => {});
  const url = config.voiceUrl;
  config.voiceUrl = 'http://voice.test';
  t.after(() => void (config.voiceUrl = url));

  const server = (id: string, works = true) => {
    const guild = { id, name: id, channels: { cache: new Map() } };
    guild.channels.cache.set('room', { id: 'room', guild, isVoiceBased: () => true, members: new Map([['a', { user: { bot: false } }]]) });
    setSetting(id, 'ttsNightReminders', true);
    const nightId = night(id, 600_000);
    db.prepare(`UPDATE game_nights SET voice_channel_id = 'room' WHERE id = ?`).run(nightId);
    return tick(
      fakeClient([guild as never], async () => {
        if (!works) throw new Error('Missing Permissions');
      }),
    );
  };
  await server('spoken');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ['Valheim night starts in 10 minutes']);
  await server('unsent', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, 'nothing said if the reminder didn’t go out');
});

test('a reminder that fails doesn’t hold up other servers, and is tried again', async () => {
  mock.method(console, 'error', () => {});
  const broken = night('a', 600_000);
  const fine = night('b', 600_000);
  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], async (guildId) => {
    if (guildId === 'a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await tick(client);
  assert.deepEqual(sent, ['b']);
  assert.equal(reminded(broken), 0);
  assert.equal(reminded(fine), 1);

  aWorks = true;
  await tick(client);
  assert.deepEqual(sent, ['b', 'a'], 'b isn’t reminded twice');
  assert.equal(reminded(broken), 1);
});

test('repeats at the same local time across a daylight saving change', () => {
  const fri = parseWhen('fri 8pm', thursday3pm, zone)!;
  assert.equal(local(nextOccurrence(fri, 7, fri, zone)), '2026-11-06 20:00');
  assert.equal(local(nextOccurrence(fri, 14, fri, zone)), '2026-11-13 20:00');
  assert.equal(new Date(fri).getUTCHours() + 1, new Date(nextOccurrence(fri, 7, fri, zone)).getUTCHours(), 'an hour later in UTC');
  assert.equal(local(nextOccurrence(fri, 7, fri + 15 * 86_400_000, zone)), '2026-11-20 20:00', 'skips what has already gone by');
});

const DAY = 86_400_000;
const allNights = (guildId: string) => db.prepare('SELECT * FROM game_nights WHERE guild_id = ? ORDER BY starts_at').all(guildId) as unknown as (Record<string, number | string | null> & { id: number; starts_at: number; series_id: number | null })[];
const seriesIn = (guildId: string) => db.prepare('SELECT * FROM game_night_series WHERE guild_id = ?').get(guildId) as { id: number; next_at: number; post_at: number } | undefined;
const buttonIds = (reply: { components: { toJSON(): { components: { custom_id: string }[] } }[] }) => reply.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));

/** Runs /gamenight plan and returns its card */
async function plan(guildId: string, repeat: number | null) {
  let card: Parameters<typeof buttonIds>[0] & { id: string };
  const interaction = {
    inCachedGuild: () => true,
    guildId,
    channelId: `channel-${guildId}`,
    guild: { id: guildId, members: {} },
    user: { id: 'host' },
    options: {
      getSubcommand: () => 'plan',
      getString: (name: string) => ({ game: 'Valheim', when: 'tomorrow 8pm' })[name] ?? null,
      getChannel: () => null,
      getInteger: () => repeat,
    },
    deferReply: async () => {},
    editReply: async (r: typeof card) => (card = { ...r, id: 'card' }),
    followUp: async () => {},
  };
  await gameNights.commands![0].run(interaction as never);
  return card!;
}

/** Presses a card's button */
async function press(customId: string, user: string, manageEvents = false) {
  let update: Parameters<typeof buttonIds>[0] | undefined;
  let reply: (Parameters<typeof buttonIds>[0] & { content: string }) | undefined;
  // The card itself, redrawn when a private confirmation is pressed
  let card: Parameters<typeof buttonIds>[0] | undefined;
  let modal: { toJSON(): any } | undefined;
  await gameNights.onButton!({
    showModal: async (m: typeof modal) => (modal = m),
    customId,
    inCachedGuild: () => true,
    user: { id: user },
    guild: { scheduledEvents: { delete: async () => {} } },
    client: { channels: { fetch: async () => ({ isTextBased: () => true, messages: { edit: async (_id: string, r: typeof card) => (card = r) } }) } },
    memberPermissions: { has: () => manageEvents },
    update: async (r: typeof update) => (update = r),
    deferUpdate: async () => {},
    editReply: async (r: typeof update) => (update = r),
    reply: async (r: typeof reply) => (reply = r),
    followUp: async () => {},
  } as never);
  return { update, reply, card, modal };
}

/** Sends a card's Edit form */
async function submitEdit(id: number, user: string, fields: Record<string, string>) {
  let answer: string | undefined;
  const posted: { content: string; allowedMentions: unknown }[] = [];
  let card: Parameters<typeof buttonIds>[0] | undefined;
  await gameNights.onModal!({
    customId: `gn:edit:${id}`,
    inCachedGuild: () => true,
    guildId: 'edits',
    user: { id: user },
    guild: { id: 'edits' },
    memberPermissions: { has: () => false },
    fields: { getTextInputValue: (name: string) => fields[name] },
    client: {
      channels: {
        fetch: async () => ({ isTextBased: () => true, isSendable: () => true, send: async (m: (typeof posted)[0]) => posted.push(m), messages: { edit: async (_id: string, r: typeof card) => (card = r) } }),
      },
    },
    reply: async (r: { content: string }) => (answer = r.content),
    deferReply: async () => {},
    editReply: async (r: string) => (answer = r),
  } as never);
  return { answer, posted, card };
}

/** Presses a card's Cancel night or Stop repeating, then the confirmation it asks for */
async function confirm(action: 'cancel' | 'stop', id: number, user: string, manageEvents = false) {
  const asked = await press(`gn:${action}:${id}`, user, manageEvents);
  assert.deepEqual(buttonIds(asked.reply!), [`gn:${action}-yes:${id}`], 'asks before doing it');
  return press(`gn:${action}-yes:${id}`, user, manageEvents);
}

const makeDue = (guildId: string) => db.prepare('UPDATE game_night_series SET post_at = ? WHERE guild_id = ?').run(Date.now() - 1, guildId);

test('a one-off night has no series and no stop button', async () => {
  const card = await plan('once', null);
  assert.equal(seriesIn('once'), undefined);
  assert.ok(!buttonIds(card).some((id) => id.startsWith('gn:stop')));
});

test('a repeating night posts its next card, once, with the host in', async () => {
  const card = await plan('weekly', 7);
  assert.ok(buttonIds(card).some((id) => id.startsWith('gn:stop')));
  const first = allNights('weekly')[0];
  const series = seriesIn('weekly')!;
  assert.equal(first.series_id, series.id);
  assert.equal(local(series.next_at), local(nextOccurrence(first.starts_at, 7, first.starts_at, zone)));
  assert.equal(series.post_at, series.next_at - 6 * DAY);

  const sent: { id?: string; embeds: unknown[] }[] = [];
  const client = fakeClient([{ id: 'weekly', name: 'Weekly' }], async (_guild, message) => {
    sent.push(message as never);
    return { id: `posted-${sent.length}` };
  });
  await tick(client);
  assert.equal(sent.length, 0, 'not due yet');

  makeDue('weekly');
  await tick(client);
  await tick(client);
  assert.equal(sent.length, 1);
  const nights = allNights('weekly');
  assert.equal(nights.length, 2);
  assert.equal(nights[1].starts_at, series.next_at);
  assert.equal(nights[1].message_id, 'posted-1');
  assert.equal(nights[1].series_id, series.id);
  assert.deepEqual({ ...(db.prepare('SELECT user_id, status FROM game_night_rsvps WHERE night_id = ?').get(nights[1].id) as object) }, { user_id: 'host', status: 'in' });
  const moved = seriesIn('weekly')!;
  assert.equal(moved.next_at, nextOccurrence(series.next_at, 7, series.next_at, zone));
  assert.ok(moved.post_at > Date.now());
});

test('a card missed while the bot was down goes on to the next night ahead', async () => {
  await plan('missed', 7);
  const series = seriesIn('missed')!;
  const longAgo = Date.now() - 20 * DAY;
  db.prepare('UPDATE game_night_series SET next_at = ?, post_at = ? WHERE id = ?').run(longAgo, longAgo - 6 * DAY, series.id);
  await tick(fakeClient([{ id: 'missed', name: 'Missed' }], async () => ({ id: 'x' })));
  const nights = allNights('missed');
  assert.equal(nights.length, 2);
  assert.ok(nights.every((n) => n.starts_at > Date.now()), 'nothing posted in the past');
  assert.ok(nights[1].starts_at < Date.now() + 8 * DAY, 'the very next one, not one further on');
});

test('a card that can’t be posted leaves nothing behind and is tried again in an hour', async () => {
  mock.method(console, 'error', () => {});
  await plan('blocked', 7);
  makeDue('blocked');
  const before = allNights('blocked').length;
  let works = false;
  const client = fakeClient([{ id: 'blocked', name: 'Blocked' }], async () => {
    if (!works) throw new Error('Missing Permissions');
    return { id: 'ok' };
  });
  await tick(client);
  assert.equal(allNights('blocked').length, before);
  assert.ok(seriesIn('blocked')!.post_at > Date.now() + 3_500_000, 'not retried every minute');

  works = true;
  makeDue('blocked');
  await tick(client);
  assert.equal(allNights('blocked').length, before + 1);
});

test('cancelling one night keeps the series, and the card can still stop it', async () => {
  await plan('skip', 7);
  const { id } = allNights('skip')[0];
  const asked = await press(`gn:cancel:${id}`, 'host');
  assert.equal(allNights('skip')[0].cancelled, 0, 'nothing happens until it’s confirmed');
  assert.match(asked.reply!.content, /Cancel \*\*Valheim\*\* night\?/);
  const { card } = await confirm('cancel', id, 'host');
  assert.ok(seriesIn('skip'));
  assert.deepEqual(buttonIds(card!), [`gn:stop:${id}`]);

  const stopped = await confirm('stop', id, 'host');
  assert.equal(seriesIn('skip'), undefined);
  assert.deepEqual(buttonIds(stopped.card!), []);
  assert.deepEqual(stopped.update, { content: '🛑 **Valheim** night won’t repeat.', components: [] });
});

test('an RSVP button left on a cancelled night does nothing', async () => {
  await plan('late', null);
  const { id } = allNights('late')[0];
  await confirm('cancel', id, 'host');
  const { update } = await press(`gn:in:${id}`, 'latecomer');
  assert.deepEqual(update, { components: [] });
  assert.equal(db.prepare(`SELECT 1 FROM game_night_rsvps WHERE night_id = ? AND user_id = 'latecomer'`).get(id), undefined);
});

test('buttons record who cancelled and who stopped repeating', async () => {
  await plan('activity-log', 7);
  const { id } = db.prepare("SELECT id FROM game_nights WHERE guild_id = 'activity-log'").get() as { id: number };
  await confirm('stop', id, 'host');
  await confirm('cancel', id, 'mod', true);
  assert.deepEqual(recentActivity('activity-log', 10).map((r) => [r.actor, r.action.replace(/ for .*/, '')]), [
    ['mod', 'Cancelled **Valheim** night'],
    ['host', 'Stopped **Valheim** night repeating'],
    ['host', 'Planned **Valheim** night'],
  ]);
});

test('only the host or Manage Events can stop a series', async () => {
  await plan('perms', 14);
  const { id } = allNights('perms')[0];
  assert.match((await press(`gn:stop:${id}`, 'stranger')).reply!.content, /host/);
  assert.match((await press(`gn:stop-yes:${id}`, 'stranger')).reply!.content, /host/, 'the confirmation checks too');
  assert.ok(seriesIn('perms'));
  await confirm('stop', id, 'admin', true);
  assert.equal(seriesIn('perms'), undefined);
  makeDue('perms');
  const sent: unknown[] = [];
  await tick(fakeClient([{ id: 'perms', name: 'Perms' }], async (_g, m) => sent.push(m)));
  assert.equal(sent.length, 0);
});

test('the host edits a night from its card, and people who are in hear when it moves', async () => {
  setSetting('edits', 'timezone', zone);
  await plan('edits', null);
  const night = allNights('edits')[0];
  db.prepare(`INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, 'friend', 'maybe'), (?, 'nope', 'out')`).run(night.id, night.id);
  db.prepare('UPDATE game_nights SET reminded = 1 WHERE id = ?').run(night.id);

  assert.match((await press(`gn:edit:${night.id}`, 'stranger')).reply!.content, /Only the host/);
  assert.match((await submitEdit(night.id, 'stranger', { game: 'x', when: 'fri 8pm', details: '' })).answer!, /Only the host/, 'the form checks too');
  const { modal } = await press(`gn:edit:${night.id}`, 'host');
  const inputs = modal!.toJSON().components.map((row: any) => row.components[0]);
  assert.deepEqual(inputs.map((c: any) => [c.custom_id, c.value]), [['game', 'Valheim'], ['when', whenText(night.starts_at, zone)], ['details', undefined]]);
  assert.equal(parseWhen(inputs[1].value, Date.now(), zone), night.starts_at, 'the form’s time reads back as the same time');

  assert.equal((await submitEdit(night.id, 'host', { game: 'Valheim', when: inputs[1].value, details: '' })).answer, 'Nothing changed.');
  const bad = await submitEdit(night.id, 'host', { game: 'Valheim', when: 'someday', details: '' });
  assert.match(bad.answer!, /couldn’t tell when someday is/);

  const later = whenText(night.starts_at + DAY, zone);
  const { answer, posted, card } = await submitEdit(night.id, 'host', { game: 'Valheim', when: later, details: 'Bring mead' });
  assert.equal(answer, '✏️ Changed the time, details.');
  const changed = allNights('edits')[0];
  assert.deepEqual([changed.starts_at, changed.details, changed.reminded], [night.starts_at + DAY, 'Bring mead', 0]);
  assert.equal(card!.components.length, 2, 'redrawn with the answers and the host’s buttons on separate rows');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].allowedMentions, { users: ['friend'] }, 'not the host, who did it, nor anyone who can’t come');
  assert.equal(recentActivity('edits', 1)[0].action, 'Changed the time, details of **Valheim** night');
});

test('a night dropping off the web UI’s list three hours in tells an open Nights tab, once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const client = fakeClient([], async () => {});
  await tick(client);
  night('dropping', -3 * 3_600_000 + 30_000);
  const at = feeds.nights.version('dropping');
  await tick(client);
  assert.equal(feeds.nights.version('dropping'), at, 'still listed');
  t.mock.timers.tick(60_000);
  await tick(client);
  const dropped = feeds.nights.version('dropping');
  assert.notEqual(dropped, at);
  t.mock.timers.tick(60_000);
  await tick(client);
  assert.equal(feeds.nights.version('dropping'), dropped, 'once');
});
