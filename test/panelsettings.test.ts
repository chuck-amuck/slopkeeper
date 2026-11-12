import './helpers.ts';
import { Collection, DiscordAPIError, MessageFlags, PermissionFlagsBits } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { recentActivity } from '../src/activity.ts';
import { db } from '../src/db.ts';
import { findSound, listSounds, nameFromFile, refreshPanels, soundboard, soundLevels } from '../src/features/soundboard.ts';
import { setSetting, setting } from '../src/settings.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const logged = mock.method(console, 'error', () => {});

let nextServer = 0;

function server(sounds: string[] = ['horn']) {
  const id = `panel-${++nextServer}`;
  const dir = path.join(process.env.DATA_DIR!, 'sounds', id);
  mkdirSync(dir, { recursive: true });
  for (const name of sounds) writeFileSync(path.join(dir, `${name}.wav`), 'x');
  const uploads: { name: string }[] = [];
  const guild = {
    id,
    name: id,
    client: { user: { id: 'bot' } },
    emojis: { cache: new Map() },
    soundboardSounds: {
      create: async (sound: { name: string }) => {
        if (guild.boardFull) throw new Error('the soundboard is full');
        uploads.push(sound);
        return { soundId: `discord-${sound.name}` };
      },
      delete: async () => {},
      edit: async () => {},
    },
    boardFull: false,
  };
  return { id, guild, uploads };
}

type Reply = { content: string; components: { toJSON(): { components: Record<string, any>[] } }[]; flags?: number };

/** Fakes a click on a settings control, and keeps what the private message shows afterwards */
function clicker(s: ReturnType<typeof server>, options: { admin?: boolean; voice?: unknown; roles?: string[] } = {}) {
  const state: { shown?: Reply; modal?: { toJSON(): Record<string, any> }; said: string[] } = { said: [] };
  const edits: unknown[] = [];
  const base = {
    inCachedGuild: () => true,
    guildId: s.id,
    guild: s.guild,
    channelId: 'text',
    user: { id: 'clicker' },
    member: { voice: { channel: options.voice }, roles: { cache: new Set(options.roles) } },
    memberPermissions: { has: (flag: bigint) => flag === PermissionFlagsBits.ManageGuild && !!options.admin },
    client: { channels: { fetch: async () => ({ isTextBased: () => true, messages: { edit: async (...args: unknown[]) => edits.push(args) } }) } },
    deferUpdate: async () => {},
    update: async (r: Reply) => void (state.shown = r),
    reply: async (r: Reply) => void (state.shown = r),
    editReply: async (r: Reply) => void (state.shown = r),
    showModal: async (m: typeof state.modal) => void (state.modal = m),
    followUp: async (r: string) => void state.said.push(r),
  };
  return {
    state,
    edits,
    press: (customId: string, message = { id: 'private' }) => soundboard.onButton!({ ...base, customId, message } as never),
    pick: (name: string, page = 0) => soundboard.onSelect!({ ...base, customId: `sb:#pick:${page}`, values: [name] } as never),
    submit: (customId: string, value: string) =>
      soundboard.onModal!({ ...base, customId, isFromMessage: () => true, fields: { getTextInputValue: () => value } } as never),
    /** Sends Add a sound's form with this file and these boxes filled in */
    upload: (file: { name: string; size?: number }, boxes: { value?: string; emoji?: string } = {}) =>
      soundboard.onModal!({
        ...base,
        customId: 'sb:#add:0:',
        isFromMessage: () => true,
        fields: {
          getUploadedFiles: () => new Collection([['a', { url: `http://files/${file.name}`, size: 100, ...file }]]),
          getTextInputValue: (id: 'value' | 'emoji') => boxes[id] ?? '',
        },
      } as never),
  };
}

const flat = (r: Reply) => r.components.flatMap((row) => row.toJSON().components);
const button = (r: Reply, id: string) => flat(r).find((c) => c.custom_id === id)!;
const log = (guildId: string) => recentActivity(guildId, 10).map((r) => r.action);
const insertPanel = (guildId: string, id: string, page = 0) => db.prepare('INSERT INTO sound_panels (message_id, guild_id, channel_id, page) VALUES (?, ?, ?, ?)').run(id, guildId, 'text', page);

test('⚙️ Settings opens privately on the panel’s page', async () => {
  const names = Array.from({ length: 25 }, (_, n) => `sound-${String(n).padStart(2, '0')}`);
  const s = server(names);
  insertPanel(s.id, 'panel-message', 1);
  const c = clicker(s);
  await c.press('sb:#settings', { id: 'panel-message' });
  assert.equal(c.state.shown!.flags, MessageFlags.Ephemeral);
  const [menu] = flat(c.state.shown!);
  assert.equal(menu.custom_id, 'sb:#pick:1');
  assert.deepEqual(menu.options.map((o: { value: string }) => o.value), names.slice(20));
  assert.match(c.state.shown!.content, /\(page 2 of 2\)$/);
  assert.deepEqual([button(c.state.shown!, 'sb:#back:0:').disabled, button(c.state.shown!, 'sb:#back:2:').disabled], [false, true]);

  // Its own pages, which leave the panel where it is
  await c.press('sb:#back:0:');
  assert.deepEqual(flat(c.state.shown!)[0].options.map((o: { value: string }) => o.value), names.slice(0, 20));
  assert.equal((db.prepare(`SELECT page FROM sound_panels WHERE message_id = 'panel-message'`).get() as { page: number }).page, 1);
});

test('a settings control isn’t mistaken for a panel', async () => {
  const s = server();
  const c = clicker(s);
  await c.pick('horn');
  await c.press('sb:#up:0:horn');
  assert.equal(db.prepare('SELECT 1 FROM sound_panels WHERE message_id = ?').get('private'), undefined);
});

test('volume moves a step at a time and stops at each end', async () => {
  const s = server();
  const c = clicker(s);
  await c.press('sb:#up:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 125);
  assert.match(c.state.shown!.content, /125% volume/);
  await c.press('sb:#down:0:horn');
  await c.press('sb:#down:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 75);
  assert.deepEqual(log(s.id)[0], 'Set the volume of **horn** to 75%');

  db.prepare('UPDATE sound_levels SET percent = 200 WHERE guild_id = ?').run(s.id);
  await c.pick('horn');
  assert.equal(button(c.state.shown!, 'sb:#up:0:horn').disabled, true);
  assert.equal(button(c.state.shown!, 'sb:#down:0:horn').disabled, false);
  await c.press('sb:#up:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 200);

  db.prepare('UPDATE sound_levels SET percent = 25 WHERE guild_id = ?').run(s.id);
  await c.pick('horn');
  assert.equal(button(c.state.shown!, 'sb:#down:0:horn').disabled, true);
  await c.press('sb:#down:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 25);
});

test('a level set on the page lands on the nearest step', async () => {
  const s = server();
  const c = clicker(s);
  await c.press('sb:#up:0:horn');
  db.prepare('UPDATE sound_levels SET percent = 110 WHERE guild_id = ?').run(s.id);
  await c.press('sb:#up:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 125);
  db.prepare('UPDATE sound_levels SET percent = 110 WHERE guild_id = ?').run(s.id);
  await c.press('sb:#down:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 100);
});

test('testing a sound needs you to be in voice', async () => {
  const s = server();
  const c = clicker(s);
  await c.press('sb:#test:0:horn');
  assert.match(c.state.shown!.content, /Join a voice channel first/);
});

test('an emoji can be set, cleared, or refused with the reason', async () => {
  const s = server();
  const c = clicker(s);
  await c.press('sb:#emoji:0:horn');
  assert.equal(c.state.modal!.toJSON().custom_id, 'sb:#emoji:0:horn');
  await c.submit('sb:#emoji:0:horn', '🔊');
  assert.equal(findSound(s.id, 'horn')!.emoji, '🔊');
  assert.match(c.state.shown!.content, /🔊 \*\*horn\*\*/);
  assert.equal(c.edits.length, 0, 'there are no panels to update here');

  await c.submit('sb:#emoji:0:horn', 'not an emoji');
  assert.equal(findSound(s.id, 'horn')!.emoji, '🔊');
  assert.ok(c.state.shown!.content.split('\n').length === 2, 'the reason sits above the sound');

  await c.submit('sb:#emoji:0:horn', '');
  assert.equal(findSound(s.id, 'horn')!.emoji, undefined);
  assert.equal(log(s.id)[0], 'Cleared the emoji on **horn**');
});

test('a sound can be renamed, and a bad name says why', async () => {
  const s = server(['horn', 'bell']);
  insertPanel(s.id, 'renamed-panel');
  const c = clicker(s);
  await c.press('sb:#rename:0:horn');
  assert.equal(c.state.modal!.toJSON().components[0].components[0].value, 'horn');
  await c.submit('sb:#rename:0:horn', 'Bad Name!');
  assert.match(c.state.shown!.content, /lowercase/);
  await c.submit('sb:#rename:0:horn', 'bell');
  assert.match(c.state.shown!.content, /already a sound/);
  assert.ok(findSound(s.id, 'horn'));

  await c.submit('sb:#rename:0:horn', 'horn');
  assert.deepEqual(log(s.id), [], 'keeping the name changes nothing');

  await c.submit('sb:#rename:0:horn', 'siren');
  assert.equal(findSound(s.id, 'horn'), undefined);
  assert.ok(findSound(s.id, 'siren'));
  assert.ok(button(c.state.shown!, 'sb:#up:0:siren'), 'the controls follow the new name');
  assert.equal(c.edits.length, 1, 'panels update');
  assert.equal(log(s.id)[0], 'Renamed **horn** to **siren**');
});

test('deleting asks first, and can be called off', async () => {
  const s = server(['horn', 'bell']);
  const c = clicker(s);
  await c.press('sb:#delete:0:horn');
  assert.ok(findSound(s.id, 'horn'));
  assert.match(c.state.shown!.content, /Delete \*\*horn\*\*\?/);
  await c.press('sb:#open:0:horn');
  assert.ok(findSound(s.id, 'horn'));
  assert.ok(button(c.state.shown!, 'sb:#up:0:horn'));

  await c.press('sb:#delete:0:horn');
  await c.press('sb:#confirm:0:horn');
  assert.equal(findSound(s.id, 'horn'), undefined);
  assert.match(c.state.shown!.content, /Removed \*\*horn\*\*/);
  assert.equal(flat(c.state.shown!)[0].options.length, 1);
  assert.equal(log(s.id)[0], 'Removed sound **horn**');
});

test('a sound deleted meanwhile says so', async () => {
  const s = server();
  const c = clicker(s);
  for (const open of [() => c.press('sb:#up:0:gone'), () => c.pick('gone'), () => c.submit('sb:#rename:0:gone', 'new')]) {
    c.state.shown = undefined;
    await open();
    assert.equal(c.state.shown!.content, 'That sound was removed.');
  }
});

test('a sound can go on and off Discord', { skip: !hasFfmpeg }, async () => {
  const s = server([]);
  const dir = path.join(process.env.DATA_DIR!, 'sounds', s.id);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(dir, 'horn.wav')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', path.join(dir, 'long.wav')]);
  const c = clicker(s);

  await c.press('sb:#discord:0:long');
  assert.match(c.state.shown!.content, /Couldn’t add it.*discord-add/);

  s.guild.boardFull = true;
  await c.press('sb:#discord:0:horn');
  assert.match(c.state.shown!.content, /Couldn’t add it.*full/);
  assert.equal(findSound(s.id, 'horn')!.onDiscord, false);

  s.guild.boardFull = false;
  await c.press('sb:#discord:0:horn');
  assert.equal(findSound(s.id, 'horn')!.onDiscord, true);
  assert.match(c.state.shown!.content, /on Discord’s soundboard/);
  assert.equal(log(s.id)[0], 'Added **horn** to Discord’s soundboard');

  await c.press('sb:#discord:0:horn');
  assert.equal(findSound(s.id, 'horn')!.onDiscord, false);
  assert.equal(log(s.id)[0], 'Took **horn** off Discord’s soundboard');
});

test('server switches need Manage Server, and work', async () => {
  const s = server();
  const member = clicker(s);
  insertPanel(s.id, 'switch-panel');
  await member.press('sb:#settings', { id: 'switch-panel' });
  assert.equal(button(member.state.shown!, 'sb:#even:0:'), undefined);
  await member.press('sb:#even:0:');
  assert.match(member.state.shown!.content, /Manage Server/);
  assert.equal(setting(s.id, 'evenVolume'), true);

  const admin = clicker(s, { admin: true });
  await admin.press('sb:#settings', { id: 'switch-panel' });
  assert.equal(button(admin.state.shown!, 'sb:#even:0:').label, 'Even volume: on');
  await admin.press('sb:#even:0:');
  assert.equal(setting(s.id, 'evenVolume'), false);
  assert.equal(button(admin.state.shown!, 'sb:#even:0:').label, 'Even volume: off');
  await admin.press('sb:#joins:0:');
  assert.equal(setting(s.id, 'joinSounds'), false);
  assert.deepEqual(log(s.id), ['Set Join sounds to off', 'Set Even volume to off']);
});

test('settings on an empty library say so', async () => {
  const s = server([]);
  insertPanel(s.id, 'empty-panel');
  const c = clicker(s);
  await c.press('sb:#settings', { id: 'empty-panel' });
  assert.match(c.state.shown!.content, /No sounds yet\. Add one with the button below/);
  assert.deepEqual(flat(c.state.shown!).map((b) => b.custom_id), ['sb:#add:0:']);
});

function panelCommand(s: ReturnType<typeof server>, edit: () => Promise<unknown>) {
  const followUps: { content: string; flags: number }[] = [];
  const run = soundboard.commands![0].run({
    inCachedGuild: () => true,
    guildId: s.id,
    guild: s.guild,
    client: { channels: { fetch: async () => ({ isTextBased: () => true, messages: { edit } }) } },
    options: { getSubcommand: () => 'panel' },
    reply: async () => ({ resource: { message: { id: `posted-${s.id}`, channelId: 'text' } } }),
    followUp: async (r: { content: string; flags: number }) => void followUps.push(r),
  } as never);
  return run.then(() => followUps);
}

test('/sound panel warns, privately, if it won’t be able to update itself', async () => {
  const s = server();
  const followUps = await panelCommand(s, async () => {
    throw new DiscordAPIError({ code: 50001, message: 'Missing Access' }, 50001, 403, 'PATCH', '/x', {});
  });
  assert.equal(followUps.length, 1);
  assert.match(followUps[0].content, /private.*Edit Channel/);
  assert.equal(followUps[0].flags, MessageFlags.Ephemeral);
  assert.ok(db.prepare('SELECT 1 FROM sound_panels WHERE message_id = ?').get(`posted-${s.id}`), 'it still works for clicks');
});

test('/sound panel says nothing in a channel it can see', async () => {
  const s = server();
  assert.deepEqual(await panelCommand(s, async () => {}), []);
});

test('a stuck panel is logged once, names its channel, and again if the reason changes', async () => {
  const s = server();
  insertPanel(s.id, 'stuck');
  let reason: string | null = 'Missing Access';
  const client = {
    channels: {
      fetch: async () => {
        if (reason) throw new Error(reason);
        return { isTextBased: () => true, messages: { edit: async () => {} } };
      },
    },
  } as never;
  const lines = () => logged.mock.calls.filter((c) => String(c.arguments[0]).includes('stuck')).map((c) => c.arguments.join(' '));
  await refreshPanels(client, s.id);
  await refreshPanels(client, s.id);
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /in channel text can’t be updated: Missing Access/);
  reason = 'Something else';
  await refreshPanels(client, s.id);
  assert.equal(lines().length, 2);
  reason = null;
  await refreshPanels(client, s.id);
  reason = 'Something else';
  await refreshPanels(client, s.id);
  assert.equal(lines().length, 3, 'a panel that recovered counts as new if it sticks again');
});

test('the even volume switch updates the copies on Discord too', async (t) => {
  const s = server();
  db.prepare(`INSERT INTO discord_sounds (guild_id, name, sound_id) VALUES (?, 'horn', 'discord-horn')`).run(s.id);
  const edited = t.mock.method(s.guild.soundboardSounds, 'edit', async () => {});
  await clicker(s, { admin: true }).press('sb:#even:0:');
  assert.equal(edited.mock.callCount(), 1);
});

test('Add a sound opens a form, names the sound after its file when left empty, and tells everyone', { skip: !hasFfmpeg }, async (t) => {
  const s = server();
  const c = clicker(s);
  await c.press('sb:#settings', { id: 'no-panel' });
  assert.equal(button(c.state.shown!, 'sb:#add:0:').label, 'Add a sound');
  await c.press('sb:#add:0:');
  const form = c.state.modal!.toJSON();
  assert.equal(form.custom_id, 'sb:#add:0:');
  assert.deepEqual(form.components.map((l: { component: { custom_id: string; type: number } }) => [l.component.custom_id, l.component.type]), [['file', 19], ['value', 4], ['emoji', 4]]);

  const file = path.join(process.env.DATA_DIR!, 'upload-tone.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
  t.mock.method(globalThis, 'fetch', async () => new Response(readFileSync(file)));
  await c.upload({ name: 'Air Horn (1).WAV' }, { emoji: '📯' });
  assert.match(c.state.said[0], /➕ Added sound 📯 \*\*air-horn-1\*\*/);
  assert.deepEqual(listSounds(s.id).map((sound) => [sound.name, sound.emoji]), [['air-horn-1', '📯'], ['horn', undefined]]);
  assert.match(c.state.shown!.content, /Pick a sound to change/, 'back to the settings');
  assert.deepEqual(log(s.id)[0], 'Added sound **air-horn-1**');

  // A taken name asks first, as /sound add does
  await c.upload({ name: 'x.wav' }, { value: 'Horn' });
  assert.match(c.state.shown!.content, /already a sound called \*\*horn\*\*/);
  await c.upload({ name: 'notes.txt' });
  assert.match(c.state.shown!.content, /^⚠️ Unsupported file type/);
  await c.upload({ name: 'big.mp3', size: 6 * 1024 * 1024 });
  assert.match(c.state.shown!.content, /^⚠️ File is over 5 MB/);
  await c.upload({ name: 'a.mp3' }, { value: 'no spaces' });
  assert.match(c.state.shown!.content, /^⚠️ Name can only use/);
  assert.equal(c.state.said.length, 1);
});

test('without the sound managers role there’s no Add a sound, and a form left open is refused', async () => {
  const s = server();
  setSetting(s.id, 'soundManagerRole', 'managers');
  const c = clicker(s);
  await c.press('sb:#settings', { id: 'no-panel' });
  assert.equal(flat(c.state.shown!).find((b) => b.custom_id === 'sb:#add:0:'), undefined);
  await c.press('sb:#add:0:');
  assert.equal(c.state.modal, undefined);
  await c.upload({ name: 'a.wav' });
  assert.match(c.state.shown!.content, /Only <@&managers>/);
  assert.deepEqual(listSounds(s.id).map((sound) => sound.name), ['horn']);
});

test('a file’s name makes a sound name', () => {
  assert.equal(nameFromFile('Air Horn (1).mp3'), 'air-horn-1');
  assert.equal(nameFromFile('__bruh__.ogg'), '__bruh__');
  assert.equal(nameFromFile('😀.wav'), 'sound');
  assert.equal(nameFromFile(`${'a'.repeat(31)} b.wav`), 'a'.repeat(31));
});

const CHANGES = ['up', 'down', 'discord', 'emoji', 'rename', 'delete', 'confirm'];

test('with a sound managers role, everyone else can test a sound but not change it', async () => {
  const s = server();
  setSetting(s.id, 'soundManagerRole', 'managers');
  insertPanel(s.id, 'managers-panel');
  const c = clicker(s, { roles: ['someone-else'] });
  await c.press('sb:#settings', { id: 'managers-panel' });
  assert.match(c.state.shown!.content, /Pick a sound to test\. Only <@&managers> and people with \*\*Manage Server\*\* can change sounds\./);
  assert.equal(flat(c.state.shown!).length, 1, 'just the sound picker');

  await c.pick('horn');
  assert.deepEqual(flat(c.state.shown!).map((b) => b.custom_id), ['sb:#test:0:horn', 'sb:#back:0:']);
  assert.match(c.state.shown!.content, /Only <@&managers>/);
  await c.press('sb:#test:0:horn');
  assert.match(c.state.shown!.content, /Join a voice channel first/);
});

test('a control left open is refused once someone isn’t allowed, and changes nothing', async () => {
  const s = server();
  setSetting(s.id, 'soundManagerRole', 'managers');
  const c = clicker(s);
  for (const action of CHANGES) {
    c.state.modal = undefined;
    c.state.shown = undefined;
    await c.press(`sb:#${action}:0:horn`);
    assert.equal(c.state.modal, undefined, action);
    assert.match(c.state.shown!.content, /Only <@&managers>/, action);
  }
  for (const [action, value] of [['rename', 'other'], ['emoji', '📯']]) {
    c.state.shown = undefined;
    await c.submit(`sb:#${action}:0:horn`, value);
    assert.match(c.state.shown!.content, /Only <@&managers>/, action);
  }
  assert.deepEqual(listSounds(s.id).map((sound) => [sound.name, sound.emoji]), [['horn', undefined]]);
  assert.equal(soundLevels(s.id).get('horn')?.percent ?? 100, 100);
  assert.deepEqual(s.uploads, []);
  assert.deepEqual(log(s.id), []);
});

test('the role or Manage Server can change sounds, and with no role set anyone can', async () => {
  const check = async (options: Parameters<typeof clicker>[1], role: string | null) => {
    const s = server();
    if (role) setSetting(s.id, 'soundManagerRole', role);
    const c = clicker(s, options);
    await c.pick('horn');
    assert.ok(flat(c.state.shown!).some((b) => b.custom_id === 'sb:#up:0:horn'));
    await c.press('sb:#up:0:horn');
    assert.equal(soundLevels(s.id).get('horn')!.percent, 125);
  };
  await check({ roles: ['managers'] }, 'managers');
  await check({ admin: true }, 'managers');
  await check({}, null);
});

test('an empty sound managers setting means everyone', async () => {
  const s = server();
  setSetting(s.id, 'soundManagerRole', null);
  const c = clicker(s);
  await c.press('sb:#up:0:horn');
  assert.equal(soundLevels(s.id).get('horn')!.percent, 125);
});
