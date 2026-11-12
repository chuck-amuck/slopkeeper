import './helpers.ts';
import { PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { recentActivity } from '../src/activity.ts';
import { setting, setSetting } from '../src/settings.ts';
import { GUILD, base, createdEvents, deletedEvents, editedEvents, guild, member, ok, panelEdits, planned, postNight, refused, sent, setFake } from './apiFixture.ts';

// Game nights

function addNight(fields: { guild?: string; startsIn?: number; cancelled?: number; series?: number | null; messageId?: string | null; eventId?: string | null } = {}): number {
  const { guild: guildId = GUILD, startsIn = 86_400_000, cancelled = 0, series = null, messageId = 'card', eventId = 'event' } = fields;
  const id = Number(
    db
      .prepare(
        `INSERT INTO game_nights (guild_id, channel_id, message_id, event_id, game, details, voice_channel_id, starts_at, created_by, cancelled, series_id)
         VALUES (?, '111', ?, ?, 'Halo', 'Bring snacks', '701', ?, 'u1', ?, ?)`,
      )
      .run(guildId, messageId, eventId, Date.now() + startsIn, cancelled, series).lastInsertRowid,
  );
  const rsvp = db.prepare('INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, ?, ?)');
  rsvp.run(id, 'u1', 'in');
  rsvp.run(id, 'u2', 'maybe');
  rsvp.run(id, 'gone', 'out');
  return id;
}

function addSeries(guildId = GUILD): number {
  return Number(
    db
      .prepare(
        `INSERT INTO game_night_series (guild_id, channel_id, game, created_by, every_days, next_at, post_at)
         VALUES (?, '111', 'Halo', 'u1', 7, ?, ?)`,
      )
      .run(guildId, Date.now() + 8 * 86_400_000, Date.now() + 2 * 86_400_000).lastInsertRowid,
  );
}

const isCancelled = (id: number) => (db.prepare('SELECT cancelled FROM game_nights WHERE id = ?').get(id) as { cancelled: number }).cancelled === 1;

test('lists this server’s upcoming nights, with names', async () => {
  const series = addSeries();
  const id = addNight({ series });
  addNight({ cancelled: 1 });
  addNight({ startsIn: -4 * 3_600_000 });
  addNight({ guild: 'other' });
  addSeries('other');
  const { nights, series: repeating, timeZone } = await ok(`/guilds/${GUILD}/game-nights`);
  assert.equal(timeZone, setting(GUILD, 'timezone'));
  assert.equal(nights.length, 1);
  const { startsAt, when, ...rest } = nights[0];
  assert.ok(startsAt > Date.now());
  assert.match(when, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual(rest, { id, game: 'Halo', details: 'Bring snacks', voiceChannel: 'General', voiceChannelId: '701', hostId: 'u1', host: 'Ana', in: ['Ana'], maybe: ['Ben'], out: ['Someone who left'], answers: { u1: 'in', u2: 'maybe', gone: 'out' }, repeats: 'Every week' });
  assert.deepEqual(repeating.map((s: any) => [s.id, s.repeats, s.host]), [[series, 'Every week', 'Ana']]);
});

test('still shows a night that started in the last few hours', async () => {
  addNight({ startsIn: -3_600_000 });
  assert.equal((await ok(`/guilds/${GUILD}/game-nights`)).nights.length, 1);
});

test('cancelling removes the event, redraws the card and tells only the people who are in', async () => {
  const id = addNight();
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  assert.equal(isCancelled(id), true);
  assert.deepEqual(deletedEvents, ['event']);
  const [channelEdit] = panelEdits as [[string, any]];
  assert.equal(channelEdit[0], 'card');
  assert.match(channelEdit[1].embeds[0].toJSON().title, /Cancelled/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111');
  assert.match(sent[0].message.content, /Halo night\*\* is off/);
  assert.deepEqual(sent[0].message.allowedMentions, { users: ['u1'] });
});

test('editing a night moves its event and card, and tells whoever’s in or maybe', async () => {
  const id = addNight();
  const edit = (json: unknown) => ok(`/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json });
  const { night: before } = await edit({});
  assert.match(before.when, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual([before.voiceChannelId, before.hostId], ['701', 'u1']);
  assert.equal(sent.length + editedEvents.length + panelEdits.length, 0, 'nothing changed, so nothing happens');

  const { changed, night } = await edit({ game: 'Halo 3', when: 'tomorrow 9pm', details: '', voiceChannelId: '702' });
  assert.deepEqual(changed, ['game', 'time', 'details', 'voice channel']);
  assert.deepEqual([night.game, night.details, night.voiceChannel], ['Halo 3', null, 'Gaming']);
  const [[eventId, event]] = editedEvents;
  assert.equal(eventId, 'event');
  assert.deepEqual([event.name, event.description, event.channel, +event.scheduledStartTime], ['Halo 3 night', '', '702', night.startsAt]);
  assert.equal((panelEdits[0] as [string, any])[0], 'card');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /Halo 3 night\*\* now starts <t:\d+:F> .* and meets in <#702>/);
  assert.deepEqual(sent[0].message.allowedMentions, { users: ['u1', 'u2'] });
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Changed the game, time, details, voice channel of **Halo 3** night');

  await edit({ voiceChannelId: null });
  assert.deepEqual(editedEvents[1][1].entityMetadata, { location: 'Voice chat' }, 'no voice channel makes it an outside event, which needs an end');
  assert.ok(editedEvents[1][1].scheduledEndTime);

  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json: { when: 'whenever' } }), 'I couldn’t tell when whenever is. Try something like fri 8pm, tomorrow 20:30 or nov 3 7pm.');
  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json: { game: ' ' } }), 'Say what you’re playing, in 90 characters or fewer.');
  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${id}`, { method: 'PATCH', json: { voiceChannelId: '111' } }), 'Pick a voice channel.');
  await refused(404, `/guilds/${GUILD}/game-nights/99999`, { method: 'PATCH', json: {} });
  const started = addNight({ startsIn: -60_000 });
  assert.equal(await refused(400, `/guilds/${GUILD}/game-nights/${started}`, { method: 'PATCH', json: { when: 'tomorrow 9pm' } }), 'It’s already started, so its time can’t change.');
});

test('cancelling twice doesn’t ping twice', async () => {
  const id = addNight();
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  assert.equal(sent.length, 1);
  assert.equal(deletedEvents.length, 1);
});

test('doesn’t announce a night that has already started', async () => {
  const id = addNight({ startsIn: -3_600_000 });
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  assert.equal(isCancelled(id), true);
  assert.equal(sent.length, 0);
});

test('can’t touch another server’s night or series', async () => {
  const night = addNight({ guild: 'other' });
  const series = addSeries('other');
  await refused(404, `/guilds/${GUILD}/game-nights/${night}/cancel`, { method: 'POST' });
  await refused(404, `/guilds/${GUILD}/game-night-series/${series}`, { method: 'DELETE' });
  assert.equal(isCancelled(night), false);
  assert.ok(db.prepare('SELECT 1 FROM game_night_series WHERE id = ?').get(series));
  assert.equal(deletedEvents.length, 0);
});

test('refuses nights that don’t exist', async () => {
  for (const id of ['99999', 'abc', '1.5']) await refused(404, `/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  await refused(404, `/guilds/${GUILD}/game-night-series/99999`, { method: 'DELETE' });
});

test('stopping a series leaves posted nights on, without their Stop repeating button', async () => {
  const series = addSeries();
  const id = addNight({ series });
  await ok(`/guilds/${GUILD}/game-night-series/${series}`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT 1 FROM game_night_series WHERE id = ?').get(series), undefined);
  assert.equal(isCancelled(id), false);
  assert.equal(sent.length, 0);
  const [[, card]] = panelEdits as [[string, any]];
  assert.doesNotMatch(JSON.stringify(card.components), /gn:stop/);
  assert.doesNotMatch(JSON.stringify(card.embeds), /Repeats/);
});

const nightRows = () => db.prepare('SELECT * FROM game_nights WHERE guild_id = ?').all(GUILD) as any[];

test('offers what the planning form needs', async () => {
  setSetting(GUILD, 'announceChannel', '111');
  db.prepare("INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, 'u1', 'Halo', 'voice', 0, 1)").run(GUILD);
  const data = await ok(`/guilds/${GUILD}/game-nights`);
  assert.deepEqual(data.games, ['Halo']);
  assert.equal(data.defaultChannel, '111');
  assert.deepEqual(data.channels.map((c: any) => c.name), ['first', 'second']);
  assert.deepEqual(data.voiceChannels.slice(0, 2).map((c: any) => c.name), ['voice', 'General']);
  assert.deepEqual(data.members.map((m: any) => m.name), ['Ana', 'Ben', 'Cy']);
});

test('reads a typed time back before anything is posted', async () => {
  const { time } = await ok(`/guilds/${GUILD}/game-nights/when?text=${encodeURIComponent('tomorrow 8pm')}`);
  assert.match(time.label, /8:00 PM/);
  assert.equal(time.passed, false);
  assert.equal((await ok(`/guilds/${GUILD}/game-nights/when?text=whenever`)).time, null);
  assert.equal(nightRows().length, 0);
});

test('planning posts the card and event, with the picked host in', async () => {
  await postNight(planned());
  const [night] = nightRows();
  assert.equal(night.game, 'Valheim');
  assert.equal(night.created_by, 'u2');
  assert.equal(night.channel_id, '111');
  assert.equal(night.voice_channel_id, 'v1');
  assert.equal(night.message_id, 'posted-1');
  assert.equal(night.event_id, 'new-event-1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111');
  assert.match(sent[0].message.embeds[0].toJSON().title, /Valheim night/);
  assert.equal(createdEvents[0].name, 'Valheim night');
  const { nights } = await ok(`/guilds/${GUILD}/game-nights`);
  assert.deepEqual(nights[0].in, ['Ben']);
});

test('planning a repeating night starts the series', async () => {
  await postNight(planned({ repeat: 14 }));
  const series = db.prepare('SELECT * FROM game_night_series WHERE guild_id = ?').get(GUILD) as any;
  assert.equal(series.every_days, 14);
  assert.equal(nightRows()[0].series_id, series.id);
});

test('a card that can’t be posted leaves no night, event or series behind', async () => {
  setFake({ failSend: true });
  const errors = mock.method(console, 'error', () => {});
  await refused(500, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned({ repeat: 7 }) });
  errors.mock.restore();
  assert.equal(nightRows().length, 0);
  assert.deepEqual(deletedEvents, ['new-event-1']);
  assert.equal(db.prepare('SELECT 1 FROM game_night_series WHERE guild_id = ?').get(GUILD), undefined);
  assert.deepEqual((await ok(`/guilds/${GUILD}/activity`)).entries, []);
});

test('refuses a night it can’t plan, before posting anything', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ game: '' }, /what you’re playing/],
    [{ game: 'x'.repeat(91) }, /what you’re playing/],
    [{ game: 5 }, /what you’re playing/],
    [{ when: 'whenever' }, /couldn’t tell when whenever/],
    [{ when: '2020-01-01 8pm' }, /already passed/],
    [{ details: 'x'.repeat(1001) }, /1000 characters/],
    [{ hostId: 'nobody' }, /Pick a host/],
    [{ channelId: 'v1' }, /Pick a text channel/],
    [{ voiceChannelId: '111' }, /Pick a voice channel/],
    [{ repeat: 3 }, /every 1 or 2 weeks/],
  ];
  for (const [fields, message] of cases) assert.match(await refused(400, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned(fields) }), message);
  assert.equal(nightRows().length, 0);
  assert.equal(sent.length, 0);
  assert.equal(createdEvents.length, 0);
});

test('details that aren’t text are left out', async () => {
  await postNight(planned({ details: 42 }));
  assert.equal(nightRows()[0].details, null);
});

test('a bot can’t host', async () => {
  guild.members.cache.set('b1', member('b1', 'Some Bot', true)[1] as never);
  assert.match(await refused(400, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned({ hostId: 'b1' }) }), /Pick a host/);
  guild.members.cache.delete('b1');
});

test('won’t post where the bot can’t', async () => {
  setFake({ permitted: [PermissionFlagsBits.ViewChannel] });
  assert.match(await refused(400, `/guilds/${GUILD}/game-nights`, { method: 'POST', json: planned() }), /can’t post in #first/);
  assert.equal(sent.length, 0);
});

test('records cancelling and stopping, with the game', async () => {
  const series = addSeries();
  const id = addNight();
  await ok(`/guilds/${GUILD}/game-nights/${id}/cancel`, { method: 'POST' });
  await ok(`/guilds/${GUILD}/game-night-series/${series}`, { method: 'DELETE' });
  assert.deepEqual((await ok(`/guilds/${GUILD}/activity`)).entries.map((e: any) => e.action), ['Stopped Halo night repeating', 'Cancelled Halo night']);
});

test('answers for someone to a game night from the web, and redraws the card', async () => {
  const id = addNight();
  const answer = (json: unknown) => ok(`/guilds/${GUILD}/game-nights/${id}/rsvp`, { method: 'POST', json });
  const edits = panelEdits.length;
  const { night } = await answer({ answer: 'in', userId: 'u2' });
  assert.equal(panelEdits.length, edits + 1, 'the card is redrawn');
  assert.deepEqual([night.id, night.in], [id, ['Ana', 'Ben']]);
  assert.deepEqual((await answer({ answer: 'out', userId: 'u2' })).night.out.includes('Ben'), true);
  assert.equal(recentActivity(GUILD, 1)[0].action, 'Answered **Can’t** for Ben to **Halo** night');
  assert.equal(await refused(409, `/guilds/${GUILD}/game-nights/${id}/rsvp`, { method: 'POST', json: { answer: 'sure', userId: 'u2' } }), 'Answer in, maybe or out.');
  await refused(404, `/guilds/${GUILD}/game-nights/${id}/rsvp`, { method: 'POST', json: { answer: 'in', userId: 'nobody' } });
  await refused(404, `/guilds/${GUILD}/game-nights/99999/rsvp`, { method: 'POST', json: { answer: 'in', userId: 'u2' } });
  const cancelled = addNight({ cancelled: 1 });
  assert.equal(await refused(409, `/guilds/${GUILD}/game-nights/${cancelled}/rsvp`, { method: 'POST', json: { answer: 'in', userId: 'u2' } }), 'This game night was cancelled.');
});

test('tells a game night who still needs to add who on Steam', async (t) => {
  const key = config.steamApiKey;
  config.steamApiKey = 'key';
  t.after(() => void (config.steamApiKey = key));
  const real = fetch;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => (String(url).startsWith(base) ? real(url, init) : new Response(JSON.stringify({ friendslist: { friends: [] } }))));
  const night = addNight();
  db.prepare(`INSERT INTO game_night_rsvps (night_id, user_id, status) VALUES (?, 'u3', 'in'), (?, 'nobody', 'in')`).run(night, night);
  db.prepare(`INSERT INTO steam_links (user_id, steam_id) VALUES ('u1', 's1'), ('u3', 's3'), ('u2', 's2')`).run();
  const friends = await ok(`/guilds/${GUILD}/game-nights/${night}/friends`);
  assert.deepEqual(friends.strangers, [[{ name: 'Ana', url: 'https://steamcommunity.com/profiles/s1' }, { name: 'Cy', url: 'https://steamcommunity.com/profiles/s3' }]]);
  assert.equal(friends.unknown.length, 0);
  assert.equal(friends.unlinked.length, 1);
  await refused(404, `/guilds/${GUILD}/game-nights/99999/friends`);
  const elsewhere = addNight({ guild: 'other-guild' });
  await refused(404, `/guilds/${GUILD}/game-nights/${elsewhere}/friends`);
});

test('a friends check says when Steam isn’t set up', async () => {
  const key = config.steamApiKey;
  config.steamApiKey = null;
  const refusal = await refused(409, `/guilds/${GUILD}/game-nights/${addNight()}/friends`);
  config.steamApiKey = key;
  assert.match(refusal, /STEAM_API_KEY/);
});
