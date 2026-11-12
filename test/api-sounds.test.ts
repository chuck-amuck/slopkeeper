import './helpers.ts';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { mock, test, type TestContext } from 'node:test';
import path from 'node:path';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { recentActivity } from '../src/activity.ts';
import { Mixer } from '../src/mixer.ts';
import { activity } from '../src/features/gamestats.ts';
import { BIN_DAYS, clearBin, levelLibrary, soundGain } from '../src/features/soundLibrary.ts';
import { setJoinSound } from '../src/features/joinSounds.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { lengthFor } from '../src/features/say.ts';
import { setting, setSetting } from '../src/settings.ts';
import { GUILD, HOUR, TOKEN, activityText, base, call, client, discordCdn, discordSounds, guild, listed, me, member, ok, onlyOnDiscord, panelEdits, permitted, planned, play, plays, postNight, quietWav, refused, restore, save, sent, setFake, soundFolder, sounds, upload, wav } from './apiFixture.ts';

// The sound library, Discord’s soundboard, the bin, join sounds, panels, what’s playing and speech

test('lists servers, and refuses one the bot isn’t in', async () => {
  assert.deepEqual((await ok('/guilds')).guilds, [{ id: GUILD, name: 'Test server', icon: null }]);
  assert.match(await refused(404, '/guilds/other/sounds'), /isn’t in that server/);
});

test('uploads a sound, copies it to Discord and updates the posted panels', async () => {
  const res = await upload('horn');
  assert.deepEqual(await res.json(), { name: 'horn', replaced: false, discordProblem: null });
  assert.equal(res.status, 200);
  const [sound] = await sounds();
  assert.equal(sound.name, 'horn');
  assert.equal(sound.onDiscord, true);
  assert.equal(sound.fitsDiscord, true);
  assert.ok(Math.abs(sound.seconds - 0.2) < 0.05);
  assert.equal(discordSounds.size, 1);
  assert.equal(panelEdits.length, 1);
});

test('replacing has to be asked for, and puts the old sound in Recently deleted', async () => {
  await upload('horn', 'a.wav', wav() as BodyInit);
  const refusal = await upload('horn', 'b.wav', wav(1) as BodyInit);
  assert.equal(refusal.status, 409);
  assert.equal(((await refusal.json()) as any).error, 'There’s already a sound called horn.');
  assert.ok(Math.abs((await sounds())[0].seconds - 0.2) < 0.05, 'the first sound is untouched');

  const res = await call(`/guilds/${GUILD}/sounds/horn?file=b.wav&replace=1`, { method: 'PUT', body: wav(1) as BodyInit });
  assert.equal(((await res.json()) as any).replaced, true);
  const [sound] = await sounds();
  assert.equal((await sounds()).length, 1);
  assert.ok(Math.abs(sound.seconds - 1) < 0.05);
  const { sounds: binned } = await ok(`/guilds/${GUILD}/deleted-sounds`);
  assert.deepEqual(binned.map((s: any) => s.name), ['horn']);
  await ok(`/guilds/${GUILD}/deleted-sounds/${binned[0].id}/restore`, { method: 'POST' });
  assert.deepEqual((await sounds()).map((s: any) => s.name), ['horn', 'horn-2']);
});

test('keep=1 adds an upload under the next free name instead of replacing', async () => {
  await upload('horn');
  const kept = await ok(`/guilds/${GUILD}/sounds/horn?file=b.wav&keep=1`, { method: 'PUT', body: wav() as never });
  assert.deepEqual([kept.name, kept.replaced], ['horn-2', false]);
  assert.equal((await ok(`/guilds/${GUILD}/sounds/bell?file=c.wav&keep=1`, { method: 'PUT', body: wav() as never })).name, 'bell');
  assert.deepEqual((await sounds()).map((s: any) => s.name), ['bell', 'horn', 'horn-2']);
  assert.deepEqual((await ok(`/guilds/${GUILD}/deleted-sounds`)).sounds, []);
});

test('a sound too long for Discord stays on the bot, with a reason in plain text', async () => {
  const res = await upload('long', 'long.wav', wav(7) as BodyInit);
  const { discordProblem } = (await res.json()) as any;
  assert.equal(discordProblem, 'it’s 7.0 s long and Discord allows 5 s; turn on its Discord switch to pick a part');
  const [sound] = await sounds();
  assert.equal(sound.onDiscord, false);
  assert.equal(sound.fitsDiscord, false);
});

test('turns down uploads the /sound command would', async () => {
  assert.match(await (await upload('Bad%20Name')).json().then((b: any) => b.error), /lowercase/);
  assert.match(await (await upload('ok', 'notes.txt')).json().then((b: any) => b.error), /Unsupported/);
  const fake = await upload('fake', 'fake.mp3', Buffer.from('not audio') as BodyInit);
  assert.equal(fake.status, 400);
  assert.equal((await sounds()).length, 0);
});

test('a name can’t reach outside the server’s sound folder', async () => {
  assert.equal((await upload('..%2F..%2Fescape')).status, 400);
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, 'escape.wav')), false);
  await refused(404, `/guilds/${GUILD}/sounds/..%2F..%2Fbot.db/audio`);
  await upload('horn');
  const res = await call(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: '../escape' } });
  assert.equal(res.status, 400);
  assert.equal((await sounds())[0].name, 'horn');
});

test('an oversized upload is refused without being stored', async () => {
  const res = await upload('big', 'big.wav', Buffer.alloc(6 * 1024 * 1024) as BodyInit);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /over 5 MB/);
  assert.equal((await sounds()).length, 0);
});

test('an upload that doesn’t declare its size is cut off at the limit', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/guilds/${GUILD}/sounds/big?file=big.wav`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    // Written separately, or Node would declare the size
    req.write(Buffer.alloc(6 * 1024 * 1024));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal((await sounds()).length, 0);
});

test('refuses a server that isn’t on the allowed list, even if the bot is still in it', async () => {
  Object.assign(config, { allowedGuildIds: ['someone-else'] });
  await refused(404, `/guilds/${GUILD}/sounds`);
  assert.deepEqual((await ok('/guilds')).guilds, []);
  Object.assign(config, { allowedGuildIds: null });
});

test('serves a sound’s audio', async () => {
  const data = wav();
  await upload('horn', 'horn.wav', data as BodyInit);
  const res = await call(`/guilds/${GUILD}/sounds/horn/audio`);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(data));
});

test('renames a sound everywhere and keeps its play counts', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { emoji: '🎺' } });
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)').run(GUILD, 'u', 'horn', 1);
  setFake({ panelEdits: [] });

  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'trumpet' } });

  const [sound] = await sounds();
  assert.equal(sound.name, 'trumpet');
  assert.equal(sound.emoji, '🎺');
  assert.equal(sound.onDiscord, true);
  assert.equal([...discordSounds.values()][0].name, 'trumpet');
  assert.deepEqual(readdirSync(soundFolder), ['trumpet.wav']);
  assert.equal((db.prepare('SELECT name FROM sound_plays').get() as any).name, 'trumpet');
  assert.equal(panelEdits.length, 1);
});

test('a rename Discord refuses changes nothing', async () => {
  await upload('horn');
  const error = await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'x' } });
  assert.match(error, /at least 2/);
  assert.deepEqual(readdirSync(soundFolder), ['horn.wav']);
  assert.equal([...discordSounds.values()][0].name, 'horn');
});

test('won’t rename onto another sound', async () => {
  await upload('horn', 'horn.wav');
  await upload('bell', 'bell.wav');
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'bell' } }), /already a sound called bell/);
  assert.equal((await sounds()).length, 2);
});

test('sets and clears emoji, with the same rules as /sound emoji', async () => {
  await upload('horn');
  const patch = (emoji: unknown) => ({ method: 'PATCH', json: { emoji } });
  await ok(`/guilds/${GUILD}/sounds/horn`, patch('<:slop:123456789012345678>'));
  assert.equal((await sounds())[0].emoji, '<:slop:123456789012345678>');
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, patch('<:other:999999999999999999>')), /from this server/);
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, patch('words')), /single emoji/);
  await ok(`/guilds/${GUILD}/sounds/horn`, patch(null));
  assert.equal((await sounds())[0].emoji, null);
});

test('deletes a sound from the bot and from Discord, saying where it is in the bin', async () => {
  await upload('horn');
  const { binId } = await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
  assert.equal((await sounds()).length, 0);
  assert.equal(discordSounds.size, 0);
  assert.deepEqual((await ok(`/guilds/${GUILD}/deleted-sounds`)).sounds.map((s: any) => s.id), [binId]);
  await refused(404, `/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
});

test('takes a sound off Discord and puts part of a long one on', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn/discord`, { method: 'DELETE' });
  assert.equal((await sounds())[0].onDiscord, false);
  assert.equal(discordSounds.size, 0);

  await upload('long', 'long.wav', wav(7) as BodyInit);
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/long/discord`, { method: 'PUT', json: {} }), /7\.0 s long/);
  await ok(`/guilds/${GUILD}/sounds/long/discord`, { method: 'PUT', json: { start: 1 } });
  assert.equal(discordSounds.size, 1);
  await refused(400, `/guilds/${GUILD}/sounds/long/discord`, { method: 'PUT', json: { start: 'soon' } });
});

test('syncs what fits and reports the rest', async () => {
  await upload('horn', 'horn.wav');
  await upload('long', 'long.wav', wav(7) as BodyInit);
  discordSounds.clear();
  const result = await ok(`/guilds/${GUILD}/discord-sync`, { method: 'POST' });
  assert.deepEqual(result.added, ['horn']);
  assert.deepEqual(result.tooLong, ['long']);
  assert.equal(result.blocker, null);
});

test('plays a sound in a voice channel and counts it, with nobody credited', async (t) => {
  // The audio loop and the leave-when-idle timer would otherwise keep the test process going
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await upload('horn');
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  // After the test, pass or fail, so a failure doesn't leave audio running and hang the run
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });

  const { url, init } = play('horn', '702');
  await ok(url, init);
  assert.deepEqual(plays(), ['web:horn']);
});

test('says what’s playing as it changes, and stops one sound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await upload('horn');
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });

  const quiet = await ok(`/guilds/${GUILD}/playing`);
  assert.deepEqual(quiet.playing, []);
  // Waits at the bot until something starts
  const waiting = ok(`/guilds/${GUILD}/playing?after=${encodeURIComponent(quiet.version)}`);
  const { url, init } = play('horn', '702');
  await ok(url, init);
  const now = await waiting;
  assert.notEqual(now.version, quiet.version);
  assert.deepEqual(
    now.playing.map((p: { name: string; kind: string; loop: boolean }) => [p.name, p.kind, p.loop]),
    [['horn', 'sound', false]],
  );
  // A version from before answers straight away
  const again = await ok(`/guilds/${GUILD}/playing?after=${encodeURIComponent(quiet.version)}`);
  assert.deepEqual(
    again.playing.map((p: { id: number }) => p.id),
    now.playing.map((p: { id: number }) => p.id),
  );

  const id = now.playing[0].id;
  assert.deepEqual(await ok(`/guilds/${GUILD}/playing/${id}/stop`, { method: 'POST' }), { playing: [] });
  assert.match(await refused(404, `/guilds/${GUILD}/playing/${id}/stop`, { method: 'POST' }), /already finished/);
});

test('won’t play somewhere it can’t', async () => {
  await upload('horn');
  const attempts = [
    [400, 'Pick a voice channel', play('horn', '111')],
    [400, 'Pick a voice channel', play('horn', 'nope')],
    [400, 'Pick a voice channel', play('horn', undefined)],
    [400, 'Nobody’s in voice', play('horn', 'v1')],
    [400, 'Nobody’s in Bots', play('horn', '703')],
    [404, 'No sound', play('missing', '702')],
  ] as const;
  for (const [status, message, { url, init }] of attempts) assert.ok((await refused(status, url, init)).includes(message), message);
  assert.deepEqual(plays(), []);
});

test('says why it can’t join, in plain text, without counting the play', async () => {
  await upload('horn');
  const { url, init } = play('horn', '701');
  const error = await refused(400, url, init);
  assert.match(error, /Connect/);
  assert.doesNotMatch(error, /\*\*/);
  assert.deepEqual(plays(), []);
});

test('stop works with nothing playing', async () => {
  assert.deepEqual(await ok(`/guilds/${GUILD}/stop`, { method: 'POST' }), { musicPlaying: false });
});

test('stars a sound and reports how often it’s been played', async () => {
  await upload('horn');
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)').run(GUILD, 'u1', 'horn', 1, GUILD, 'web', 'horn', 2, 'elsewhere', 'u1', 'horn', 3);
  const star = (favourite: boolean) => ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { favourite } });
  assert.deepEqual((await sounds()).map((s) => [s.favourite, s.plays]), [[false, 2]]);
  await star(true);
  await star(true);
  assert.equal((await sounds())[0].favourite, true);
  await star(false);
  assert.equal((await sounds())[0].favourite, false);
});

test('a favourite follows a rename, and doesn’t outlive its sound', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { favourite: true } });
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'trumpet' } });
  assert.equal((await sounds())[0].favourite, true);
  await ok(`/guilds/${GUILD}/sounds/trumpet`, { method: 'DELETE' });
  await upload('trumpet');
  assert.equal((await sounds())[0].favourite, false);
});

/** The labels of the posted panel's sound buttons, from its latest edit */
const panelButtons = () => ((panelEdits.at(-1)![1] as any).components as any[]).slice(0, -1).flatMap((row) => row.toJSON().components.map((c: any) => c.label));
const panelText = () => (panelEdits.at(-1)![1] as any).content as string;
const groups = async () => (await ok(`/guilds/${GUILD}/sounds`)).groups as { id: number; name: string; sounds: string[] }[];
const place = (name: string, group: number | null, before?: string) => ok(`/guilds/${GUILD}/sounds/${name}`, { method: 'PATCH', json: { place: { group, before } } });

test('sounds are sorted into groups in any order, the rest come after most played first, and the panel follows', async () => {
  for (const name of ['a', 'b', 'c', 'd']) await upload(name);
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, 1), (?, ?, ?, 2), (?, ?, ?, 3)').run(GUILD, 'u', 'd', GUILD, 'u', 'd', GUILD, 'u', 'c');
  let { groups: made } = await ok(`/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: '  Memes ' } });
  assert.deepEqual(made.map((g: any) => [g.name, g.sounds]), [['Memes', []]]);
  const memes = made[0].id;
  assert.match(await refused(400, `/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: 'memes' } }), /already a group called memes/);
  assert.match(await refused(400, `/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: 'Everything else' } }), /Pick another name/);
  assert.match(await refused(400, `/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: ' ' } }), /Give the group a name/);

  await place('b', memes);
  await place('a', memes, 'b');
  assert.deepEqual((await groups()).map((g) => g.sounds), [['a', 'b']]);
  assert.equal(activityText().at(-1), 'Moved **a** to the sound group **Memes**');
  assert.deepEqual(panelButtons(), ['a', 'b', 'd', 'c'], 'Memes, then the rest most played first');
  assert.match(panelText(), /-# Memes · Everything else/);

  ({ groups: made } = await ok(`/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: 'Reactions' } }));
  const reactions = made[1].id;
  await place('c', reactions);
  ({ groups: made } = await ok(`/guilds/${GUILD}/sound-groups/${reactions}`, { method: 'PATCH', json: { to: 0, name: 'Reacts' } }));
  assert.deepEqual(made.map((g: any) => [g.name, g.sounds]), [['Reacts', ['c']], ['Memes', ['a', 'b']]]);
  assert.equal(activityText().at(-1), 'Renamed the sound group **Reactions** to **Reacts**');
  assert.deepEqual(panelButtons(), ['c', 'a', 'b', 'd']);

  await place('a', null);
  assert.equal(activityText().at(-1), 'Took **a** out of the sound group **Memes**');
  assert.deepEqual(panelButtons(), ['c', 'b', 'd', 'a'], 'a has no plays, so it comes last');
  await refused(404, `/guilds/${GUILD}/sounds/a`, { method: 'PATCH', json: { place: { group: 999 } } });

  ({ groups: made } = await ok(`/guilds/${GUILD}/sound-groups/${memes}`, { method: 'DELETE' }));
  assert.deepEqual(made.map((g: any) => g.name), ['Reacts']);
  assert.equal(activityText().at(-1), 'Deleted the sound group **Memes**');
  // Undo puts it back as it was
  ({ groups: made } = await ok(`/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: 'Memes', sounds: ['b', 'nope'], at: 0 } }));
  assert.deepEqual(made.map((g: any) => [g.name, g.sounds]), [['Memes', ['b']], ['Reacts', ['c']]]);
  await refused(404, `/guilds/${GUILD}/sound-groups/999`, { method: 'DELETE' });

  // Undo leaves a sound where it's been put since
  const again = made[0].id;
  await ok(`/guilds/${GUILD}/sound-groups/${again}`, { method: 'DELETE' });
  await place('b', reactions);
  ({ groups: made } = await ok(`/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: 'Memes', sounds: ['b'], at: 0 } }));
  assert.deepEqual(made.map((g: any) => [g.name, g.sounds]), [['Memes', []], ['Reacts', ['c', 'b']]]);
  assert.ok(made[0].id > again, 'a deleted group’s id isn’t used again, as the bin remembers groups by id');

  // A group's name is shown as typed on the panel, and never pings
  ({ groups: made } = await ok(`/guilds/${GUILD}/sound-groups/${made[0].id}`, { method: 'PATCH', json: { name: '@everyone **loud**', to: 0 } }));
  await place('d', made[0].id);
  assert.match(panelText(), /-# @everyone \\\*\\\*loud\\\*\\\* · Reacts/);
  assert.deepEqual((panelEdits.at(-1)![1] as any).allowedMentions, { parse: [] });
});

test('the star makes Favourites at the top, and a sound keeps its place through a rename, a delete and a restore', async () => {
  for (const name of ['x', 'y', 'w', 'horn']) await upload(name);
  const { groups: made } = await ok(`/guilds/${GUILD}/sound-groups`, { method: 'POST', json: { name: 'Memes' } });
  await place('y', made[0].id);
  await place('x', made[0].id, 'y');
  const { groups: starred } = await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { favourite: true } });
  assert.deepEqual(starred.map((g: any) => [g.name, g.sounds]), [['Favourites', ['horn']], ['Memes', ['x', 'y']]], 'the star answers with the groups');
  await ok(`/guilds/${GUILD}/sounds/x`, { method: 'PATCH', json: { name: 'z' } });
  assert.deepEqual((await groups())[1].sounds, ['z', 'y']);
  const { binId } = await ok(`/guilds/${GUILD}/sounds/z`, { method: 'DELETE' });
  assert.deepEqual((await groups())[1].sounds, ['y']);
  // Something else goes first meanwhile, and the restored sound still comes back first
  await place('w', made[0].id, 'y');
  await restore(binId);
  assert.deepEqual((await groups())[1].sounds, ['z', 'w', 'y'], 'back where it was');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { favourite: false } });
  assert.deepEqual((await groups()).map((g) => [g.name, g.sounds]), [['Favourites', []], ['Memes', ['z', 'w', 'y']]]);
});

test('a play across midnight is split between the days', () => {
  const midnight = Date.parse('2026-03-10T05:00:00Z'); // In Chicago, on CDT
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, channel_id, started_at, ended_at) VALUES (?, ?, ?, 'voice', ?, ?)`).run(GUILD, 'u1', 'Halo', midnight - HOUR / 2, midnight + HOUR);
  const { step, buckets } = activity(GUILD, midnight - 2 * 24 * HOUR, midnight + 24 * HOUR, 'America/Chicago');
  assert.equal(step, 'day');
  assert.deepEqual(buckets.filter((b) => b.ms).map((b) => b.ms), [HOUR / 2, HOUR]);
  assert.equal(buckets.filter((b) => b.ms)[1].start, midnight);
});

test('uploading measures a sound and plays a quiet one louder, here and on Discord', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  const [sound] = await sounds();
  assert.ok(sound.gainDb > 3, String(sound.gainDb));
  assert.equal(sound.percent, 100);
  assert.ok(soundGain(GUILD, 'quiet') > 1.4);
  assert.ok(sound.volume > 0.5 && sound.volume <= 1);
  assert.equal(onlyOnDiscord().volume, sound.volume);
});

test('Discord’s volume stops at its limit of 1', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  await ok(`/guilds/${GUILD}/sounds/quiet`, { method: 'PATCH', json: { volume: 200 } });
  assert.equal(onlyOnDiscord().volume, 1);
  assert.ok(soundGain(GUILD, 'quiet') > 2.8);
});

test('a sound’s loudness is what plays in voice, even past Discord’s limit', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  await ok(`/guilds/${GUILD}/sounds/quiet`, { method: 'PATCH', json: { volume: 200 } });
  const [sound] = await sounds();
  assert.equal(sound.volume, 1);
  assert.equal(sound.loudness, soundGain(GUILD, 'quiet') / 2);
  assert.ok(sound.loudness > 1);
});

test('the picked volume multiplies the measured one and reaches Discord without re-uploading', async () => {
  await upload('horn');
  const before = soundGain(GUILD, 'horn');
  const id = [...discordSounds.keys()][0];
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  assert.ok(Math.abs(soundGain(GUILD, 'horn') / before - 0.5) < 0.001);
  assert.equal((await sounds())[0].percent, 50);
  assert.deepEqual([...discordSounds.keys()], [id]);
  assert.equal(onlyOnDiscord().volume, (await sounds())[0].volume);
});

test('refuses a volume outside the slider', async () => {
  await upload('horn');
  for (const volume of [24, 201, 50.5, '50', null]) assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume } }), /whole number from 25 to 200/);
  assert.equal((await sounds())[0].percent, 100);
});

test('new audio under an old name starts from a new measurement and normal volume', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  const loud = (await sounds())[0].gainDb;
  await upload('horn', 'q.wav', quietWav() as BodyInit, true);
  const [sound] = await sounds();
  assert.equal(sound.percent, 100);
  assert.ok(sound.gainDb > loud);
});

test('renaming keeps its level and whoever’s join sound it is', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  setJoinSound(GUILD, 'u1', 'horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'honk' } });
  assert.equal((await sounds())[0].percent, 50);
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, [{ id: 'u1', who: 'Ana', name: 'honk' }]);
});

test('deleting clears its level and any join sound using it', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  setJoinSound(GUILD, 'u1', 'horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' });
  assert.equal(db.prepare('SELECT 1 FROM sound_levels WHERE guild_id = ?').get(GUILD), undefined);
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, []);
});

test('turned off, the picked volume still counts', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  await ok(`/guilds/${GUILD}/settings/evenVolume`, { method: 'PUT', json: { value: false } });
  assert.equal(soundGain(GUILD, 'horn'), 0.5);
});

test('measures sounds from before levelling, once, keeping a volume already picked', async () => {
  await upload('quiet', 'q.wav', quietWav() as BodyInit);
  db.exec('UPDATE sound_levels SET gain_db = NULL, percent = 70');
  onlyOnDiscord().volume = 0.5;
  const logged = mock.method(console, 'log', () => {});
  logged.mock.resetCalls();
  await levelLibrary(client);
  const [sound] = await sounds();
  assert.ok(sound.gainDb > 3);
  assert.equal(sound.percent, 70);
  assert.notEqual(onlyOnDiscord().volume, 0.5);
  const lines = logged.mock.callCount();
  assert.equal(lines, 1);
  await levelLibrary(client);
  assert.equal(logged.mock.callCount(), lines);
});

test('an upload can stay off Discord', async () => {
  const res = await call(`/guilds/${GUILD}/sounds/horn?file=a.wav&discord=0`, { method: 'PUT', body: wav() as BodyInit });
  assert.deepEqual(await res.json(), { name: 'horn', replaced: false, discordProblem: null });
  assert.equal(discordSounds.size, 0);
  assert.equal((await sounds())[0].onDiscord, false);
});

test('replacing a sound that’s on Discord updates its copy even when told to stay off', async () => {
  await upload('horn');
  const old = [...discordSounds.keys()][0];
  await call(`/guilds/${GUILD}/sounds/horn?file=a.wav&discord=0&replace=1`, { method: 'PUT', body: wav() as BodyInit });
  assert.equal(discordSounds.size, 1);
  assert.notEqual([...discordSounds.keys()][0], old);
});

test('lists and removes join sounds, only for this server', async () => {
  setJoinSound(GUILD, 'u1', 'horn');
  setJoinSound('other', 'u2', 'bell');
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, [{ id: 'u1', who: 'Ana', name: 'horn' }]);
  await refused(404, `/guilds/${GUILD}/join-sounds/u2`, { method: 'DELETE' });
  await ok(`/guilds/${GUILD}/join-sounds/u1`, { method: 'DELETE' });
  assert.deepEqual((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM join_sounds WHERE guild_id = 'other'").get() as { n: number }).n, 1);
});

test('records what the page changes, newest first, in plain text', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 50 } });
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'honk' } });
  await ok(`/guilds/${GUILD}/settings/announceChannel`, { method: 'PUT', json: { value: '111' } });
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'PUT', json: { value: 0 } });
  await ok(`/guilds/${GUILD}/settings/hopOnCooldownMin`, { method: 'DELETE' });
  await postNight(planned());
  await ok(`/guilds/${GUILD}/sounds/honk`, { method: 'DELETE' });
  const { entries } = await ok(`/guilds/${GUILD}/activity`);
  assert.deepEqual(entries.map((e: any) => [e.who, e.action.replace(/ for .*/, '')]), [
    ['Web UI', 'Removed sound honk'],
    ['Web UI', 'Planned Valheim night'],
    ['Web UI', 'Put Hop-on cooldown back to the default'],
    ['Web UI', 'Set Hop-on cooldown to 0 min'],
    ['Web UI', 'Set Announce channel to #first'],
    ['Web UI', 'Renamed horn to honk'],
    ['Web UI', 'Set the volume of horn to 50%'],
    ['Web UI', 'Added sound horn'],
  ]);
});

test('a refused change isn’t recorded', async () => {
  await upload('horn');
  await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { volume: 5 } });
  await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'BAD NAME' } });
  await refused(400, `/guilds/${GUILD}/settings/hopOnMinPeople`, { method: 'PUT', json: { value: 999 } });
  assert.equal((await ok(`/guilds/${GUILD}/activity`)).entries.length, 1);
});

function steps(ext: string, seconds = 4) {
  const half = seconds / 2;
  const filter = `sine=frequency=440:duration=${half},volume=-30dB[a];sine=frequency=440:duration=${half},volume=-3dB[b];[a][b]concat=n=2:v=0:a=1`;
  const out = path.join(process.env.DATA_DIR!, `steps${ext}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex', filter, out]);
  return readFileSync(out);
}

const lengthOf = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

const addFile = (name: string, ext: string, data: Buffer) => ok(`/guilds/${GUILD}/sounds/${name}?file=${name}${ext}`, { method: 'PUT', body: data as never });

const trim = (name: string, json: unknown) => call(`/guilds/${GUILD}/sounds/${name}/trim`, { method: 'POST', json });

for (const ext of ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac']) {
  test(`trims ${ext} to the right length and keeps the format`, async () => {
    await addFile('cutme', ext, steps(ext));
    assert.equal((await trim('cutme', { start: 1, end: 2.5 })).status, 200);
    assert.ok(Math.abs(lengthOf(path.join(soundFolder, `cutme${ext}`)) - 1.5) < 0.1, String(lengthOf(path.join(soundFolder, `cutme${ext}`))));
    assert.equal((await listed('cutme')).trimmed, true);
  });
}

test('trimming keeps the part asked for, and the sound is measured again', async () => {
  await addFile('quietloud', '.wav', steps('.wav'));
  const whole = (await listed('quietloud')).gainDb;
  await ok(`/guilds/${GUILD}/sounds/quietloud/trim`, { method: 'POST', json: { start: 2.2, end: 3.8 } });
  const loud = (await listed('quietloud')).gainDb;
  assert.ok(loud < whole, `${loud} should be under ${whole}`);

  await addFile('loudquiet', '.wav', steps('.wav'));
  await ok(`/guilds/${GUILD}/sounds/loudquiet/trim`, { method: 'POST', json: { start: 0.2, end: 1.8 } });
  assert.ok((await listed('loudquiet')).gainDb > whole);
});

test('a second trim keeps the first original, and restoring brings it back exactly', async () => {
  const data = wav(3);
  await addFile('twice', '.wav', data);
  await ok(`/guilds/${GUILD}/sounds/twice/trim`, { method: 'POST', json: { start: 0, end: 2 } });
  await ok(`/guilds/${GUILD}/sounds/twice/trim`, { method: 'POST', json: { start: 0.5, end: 1.5 } });
  assert.ok(Math.abs(lengthOf(path.join(soundFolder, 'twice.wav')) - 1) < 0.1);
  await ok(`/guilds/${GUILD}/sounds/twice/restore`, { method: 'POST' });
  assert.ok(readFileSync(path.join(soundFolder, 'twice.wav')).equals(data));
  assert.equal((await listed('twice')).trimmed, false);
  assert.equal((await listed('twice')).seconds, 3);
});

test('restoring measures the sound again and needs something to restore', async () => {
  await addFile('backagain', '.wav', steps('.wav'));
  const whole = (await listed('backagain')).gainDb;
  await ok(`/guilds/${GUILD}/sounds/backagain/trim`, { method: 'POST', json: { start: 2.2, end: 3.8 } });
  await ok(`/guilds/${GUILD}/sounds/backagain/restore`, { method: 'POST' });
  assert.equal((await listed('backagain')).gainDb, whole);
  const res = await call(`/guilds/${GUILD}/sounds/backagain/restore`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('an original follows a renamed sound, and goes with a deleted or replaced one', async () => {
  const data = wav(3);
  await addFile('first', '.wav', data);
  await ok(`/guilds/${GUILD}/sounds/first/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  await ok(`/guilds/${GUILD}/sounds/first`, { method: 'PATCH', json: { name: 'second' } });
  assert.equal((await listed('second')).trimmed, true);
  await ok(`/guilds/${GUILD}/sounds/second/restore`, { method: 'POST' });
  assert.ok(readFileSync(path.join(soundFolder, 'second.wav')).equals(data));

  await ok(`/guilds/${GUILD}/sounds/second/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  await ok(`/guilds/${GUILD}/sounds/second?file=second.mp3&replace=1`, { method: 'PUT', body: steps('.mp3') as never });
  assert.equal((await listed('second')).trimmed, false);
  // The replaced sound took its original to the bin with it
  assert.deepEqual(readdirSync(path.join(soundFolder, 'originals')), []);

  await ok(`/guilds/${GUILD}/sounds/second/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  await ok(`/guilds/${GUILD}/sounds/second`, { method: 'DELETE' });
  assert.deepEqual(readdirSync(path.join(soundFolder, 'originals')), []);
});

test('originals aren’t listed as sounds', async () => {
  await addFile('shadow', '.wav', wav(3));
  await ok(`/guilds/${GUILD}/sounds/shadow/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  assert.deepEqual((await ok(`/guilds/${GUILD}/sounds`)).sounds.map((s: { name: string }) => s.name), ['shadow']);
});

test('refuses a range that doesn’t make sense and leaves the sound alone', async () => {
  const data = wav(3);
  await addFile('safe', '.wav', data);
  for (const [json, why] of [
    [{ start: 'a', end: 1 }, /numbers/],
    [{ start: 1 }, /numbers/],
    [{ start: 1, end: null }, /numbers/],
    [{ start: -1, end: 1 }, /inside/],
    [{ start: 1, end: 4 }, /inside/],
    [{ start: 2, end: 1 }, /at least/],
    [{ start: 1, end: 1.05 }, /at least/],
    [{ start: 0, end: 3 }, /whole/],
  ] as [unknown, RegExp][]) {
    const res = await trim('safe', json);
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.match(((await res.json()) as { error: string }).error, why);
  }
  assert.ok(readFileSync(path.join(soundFolder, 'safe.wav')).equals(data));
  assert.equal((await listed('safe')).trimmed, false);
  assert.equal((await trim('nothing-here', { start: 0, end: 1 })).status, 404);
});

function fakeProgram(t: TestContext, name: string, script: string) {
  mock.method(console, 'error', () => {});
  const bin = mkdtempSync(path.join(process.env.DATA_DIR!, 'bin-'));
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath}`;
  t.after(() => {
    process.env.PATH = realPath;
    mock.restoreAll();
  });
}

test('a sound whose length can’t be read isn’t trimmed', async (t) => {
  const data = wav(3);
  await addFile('unknown', '.wav', data);
  fakeProgram(t, 'ffprobe', 'exit 1');
  const res = await trim('unknown', { start: 1, end: 2 });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /can’t tell how long/);
  assert.ok(readFileSync(path.join(soundFolder, 'unknown.wav')).equals(data));
});

for (const [what, script] of [
  ['fails', 'exit 1'],
  ['writes nothing', 'for last; do :; done; : > "$last"'],
]) {
  test(`when ffmpeg ${what}, the sound stays as it was with nothing left behind`, async (t) => {
    const data = wav(3);
    await addFile('stuck', '.wav', data);
    fakeProgram(t, 'ffmpeg', script);
    const res = await trim('stuck', { start: 1, end: 2 });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /couldn’t be cut/);
    assert.ok(readFileSync(path.join(soundFolder, 'stuck.wav')).equals(data));
    assert.equal((await listed('stuck')).trimmed, false);
    assert.deepEqual(readdirSync(path.join(soundFolder, 'originals')), []);
  });
}

test('a trimmed sound keeps its volume, emoji and star, and logs what happened', async () => {
  await addFile('kept', '.wav', wav(3));
  await ok(`/guilds/${GUILD}/sounds/kept`, { method: 'PATCH', json: { volume: 150, emoji: '📯', favourite: true } });
  await ok(`/guilds/${GUILD}/sounds/kept/trim`, { method: 'POST', json: { start: 0, end: 1.5 } });
  await ok(`/guilds/${GUILD}/sounds/kept/restore`, { method: 'POST' });
  const sound = await listed('kept');
  assert.deepEqual([sound.percent, sound.emoji, sound.favourite], [150, '📯', true]);
  const { entries } = await ok(`/guilds/${GUILD}/activity`);
  const actions = entries.map((e: { action: string }) => e.action);
  assert.ok(actions.includes('Trimmed kept to 1.5 s'), actions.join(', '));
  assert.ok(actions.includes('Restored the original kept'), actions.join(', '));
});

test('trimming leaves Discord’s copy alone', async () => {
  await addFile('mirrored', '.wav', wav(3));
  const before = new Map(discordSounds);
  await ok(`/guilds/${GUILD}/sounds/mirrored/trim`, { method: 'POST', json: { start: 0, end: 1 } });
  assert.deepEqual(discordSounds, before);
  assert.equal((await listed('mirrored')).onDiscord, true);
  await ok(`/guilds/${GUILD}/sounds/mirrored/restore`, { method: 'POST' });
  assert.deepEqual(discordSounds, before);
});

const missingPermissions = () => new DiscordAPIError({ code: RESTJSONErrorCodes.MissingPermissions, message: 'Missing Permissions' }, RESTJSONErrorCodes.MissingPermissions, 403, 'DELETE', '', {});

const discordList = async () => (await ok(`/guilds/${GUILD}/sounds`)).discordSounds as any[];

const takeOff = (id: string) => `/guilds/${GUILD}/discord-sounds/${id}`;

const swapIn = (name: string, replacing: string, start?: number) => [`/guilds/${GUILD}/sounds/${name}/discord`, { method: 'PUT', json: { replacing, start } }] as const;

const libraryOnly = (name: string, body: Buffer = wav()) => call(`/guilds/${GUILD}/sounds/${name}?file=clip.wav&discord=0`, { method: 'PUT', body: body as BodyInit });

test('lists what’s on Discord’s soundboard, whoever added it', async () => {
  await upload('horn');
  discordSounds.set('theirs', { name: 'Their Sound', volume: 0.8, emoji: { id: null, name: '🔊' } });
  discordSounds.set('own', { name: 'custom', emoji: { id: '123456789012345678', name: null } });
  discordSounds.set('other', { name: 'foreign', emoji: { id: '999999999999999999', name: null } });
  const list = await discordList();
  assert.deepEqual(
    list.map((s) => [s.name, s.library, s.emoji]),
    [
      ['horn', 'horn', null],
      ['Their Sound', null, '🔊'],
      ['custom', null, '<:slop:123456789012345678>'],
      ['foreign', null, null],
    ],
  );
  assert.equal(list[1].volume, 0.8);
  assert.ok(list.every((s) => !('url' in s)));
  assert.deepEqual((await ok(`/guilds/${GUILD}/sounds`)).slots, { used: 4, total: 8 });
});

test('says which sounds the bot can’t remove', async (t) => {
  discordSounds.set('mine', { name: 'mine', user: { id: 'the-bot' } });
  discordSounds.set('theirs', { name: 'theirs', user: { id: 'u1' } });
  discordSounds.set('unknown', { name: 'unknown', user: null });
  assert.ok((await discordList()).every((s) => s.removable));
  t.mock.method(me.permissions, 'has', (flag: bigint) => flag !== PermissionFlagsBits.ManageGuildExpressions);
  assert.deepEqual(
    (await discordList()).map((s) => [s.name, s.removable]),
    [
      ['mine', true],
      ['theirs', false],
      ['unknown', true],
    ],
  );
});

test('a soundboard Discord won’t show leaves the library working', async (t) => {
  await upload('horn');
  t.mock.method(guild.soundboardSounds, 'fetch', async () => {
    throw new Error('Discord is down');
  });
  // Past when the gateway's copy is trusted, so it asks Discord
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 });
  const body = await ok(`/guilds/${GUILD}/sounds`);
  assert.equal(body.slots, null);
  assert.deepEqual(body.discordSounds, []);
  assert.equal(body.sounds.length, 1);
});

test('saving keeps the sound’s emoji and links it, without touching Discord’s copy or the sound with that name', async (t) => {
  discordCdn(t);
  await libraryOnly('horn');
  const before = readFileSync(path.join(soundFolder, 'horn.wav'));
  discordSounds.set('theirs', { name: 'Horn', volume: 0.8, emoji: { id: null, name: '🔊' } });
  const { name } = await save('theirs');
  assert.equal(name, 'horn-2');
  assert.ok(readFileSync(path.join(soundFolder, 'horn.wav')).equals(before));
  const sound = (await sounds()).find((s) => s.name === 'horn-2');
  assert.equal(sound.emoji, '🔊');
  assert.equal(sound.onDiscord, true);
  assert.deepEqual(discordSounds.get('theirs'), { name: 'Horn', volume: 0.8, emoji: { id: null, name: '🔊' } });
  assert.equal((await discordList()).find((s) => s.id === 'theirs').library, 'horn-2');
});

test('saving twice keeps one copy and one line of history', async (t) => {
  const asked = discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  assert.equal((await save('theirs')).name, 'horn');
  assert.equal((await save('theirs')).name, 'horn');
  assert.equal(asked.length, 1);
  assert.equal((await sounds()).length, 1);
  const saves = (await ok(`/guilds/${GUILD}/activity`)).entries.filter((e: any) => e.action.includes('Saved'));
  assert.equal(saves.length, 1);
});

test('an ogg from Discord is stored as one', async (t) => {
  discordCdn(t, () => new Response(new Uint8Array(wav()), { headers: { 'content-type': 'audio/ogg' } }));
  discordSounds.set('theirs', { name: 'Horn' });
  await save('theirs');
  assert.ok(existsSync(path.join(soundFolder, 'horn.ogg')));
});

test('a download that fails or isn’t audio saves nothing', async (t) => {
  discordSounds.set('theirs', { name: 'Horn' });
  let answer = new Response('nope', { status: 500 });
  discordCdn(t, () => answer);
  const url = `/guilds/${GUILD}/discord-sounds/theirs/save`;
  assert.match(await refused(400, url, { method: 'POST' }), /wouldn’t hand over Horn/);
  answer = new Response('this is not audio', { headers: { 'content-type': 'audio/mpeg' } });
  assert.match(await refused(400, url, { method: 'POST' }), /couldn’t be read/);
  assert.equal((await sounds()).length, 0);
  assert.equal((await discordList())[0].library, null);
});

test('taking off a sound that isn’t saved saves it first', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  // The library name comes back, so the page can put it back on
  assert.deepEqual(await ok(takeOff('theirs'), { method: 'DELETE' }), { name: 'horn' });
  assert.equal(discordSounds.size, 0);
  const [sound] = await sounds();
  assert.equal(sound.name, 'horn');
  assert.equal(sound.onDiscord, false);
});

test('a sound that can’t be saved stays on Discord', async (t) => {
  discordCdn(t, () => new Response('nope', { status: 500 }));
  discordSounds.set('theirs', { name: 'Horn' });
  await refused(400, takeOff('theirs'), { method: 'DELETE' });
  assert.ok(discordSounds.has('theirs'));
});

test('taking off a saved sound only frees the slot', async (t) => {
  const asked = discordCdn(t);
  await upload('horn');
  const [{ id }] = await discordList();
  await ok(takeOff(id), { method: 'DELETE' });
  assert.equal(discordSounds.size, 0);
  assert.equal(asked.length, 0);
  assert.equal((await sounds())[0].onDiscord, false);
});

test('without permission a sound stays where it is, and the page says what’s needed', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  await libraryOnly('bell');
  setFake({ refuseDiscord: missingPermissions() });
  assert.match(await refused(400, takeOff('theirs'), { method: 'DELETE' }), /Manage Expressions/);
  assert.ok(discordSounds.has('theirs'));
  assert.equal((await sounds()).find((s) => s.name === 'horn').onDiscord, true);
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /Manage Expressions/);
});

test('renaming a saved sound that was someone else’s says what’s needed', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  await save('theirs');
  setFake({ refuseDiscord: missingPermissions() });
  assert.match(await refused(400, `/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { name: 'bell' } }), /Manage Expressions/);
});

test('deleting a saved sound Discord won’t let go of unlinks it', async (t) => {
  discordCdn(t);
  discordSounds.set('theirs', { name: 'Horn' });
  await save('theirs');
  setFake({ refuseDiscord: missingPermissions() });
  assert.match((await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'DELETE' })).discordProblem, /Manage Expressions/);
  setFake({ refuseDiscord: null });
  assert.equal((await discordList())[0].library, null);
  assert.equal((await save('theirs')).name, 'horn');
});

test('swapping puts a library sound in another’s slot, keeping the one that came off', async (t) => {
  discordCdn(t);
  await libraryOnly('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  await ok(...swapIn('bell', 'theirs'));
  assert.ok(!discordSounds.has('theirs'));
  assert.ok([...discordSounds.values()].some((s) => s.name === 'bell'));
  const list = await sounds();
  assert.equal(list.find((s) => s.name === 'theirs').onDiscord, false);
  assert.equal(list.find((s) => s.name === 'bell').onDiscord, true);
  const { entries } = await ok(`/guilds/${GUILD}/activity`);
  assert.ok(entries.some((e: any) => e.action === 'Swapped Theirs for bell on Discord’s soundboard'));
});

test('swapping in a long sound uses the part picked', async (t) => {
  discordCdn(t);
  await libraryOnly('long', wav(7));
  discordSounds.set('theirs', { name: 'Theirs' });
  await ok(...swapIn('long', 'theirs', 1.5));
  assert.ok([...discordSounds.values()].some((s) => s.name === 'long'));
});

test('a sound that can’t go on leaves the old one alone', async (t) => {
  const asked = discordCdn(t);
  await libraryOnly('long', wav(7));
  discordSounds.set('theirs', { name: 'Theirs' });
  assert.match(await refused(400, ...swapIn('long', 'theirs')), /7\.0 s long/);
  assert.match(await refused(400, ...swapIn('long', 'theirs', 50)), /only 7\.0 s/);
  assert.ok(discordSounds.has('theirs'));
  assert.equal(asked.length, 0);
  assert.equal((await sounds()).length, 1);
});

test('a sound already on Discord can’t be swapped in', async (t) => {
  discordCdn(t);
  await upload('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /already on Discord/);
  assert.ok(discordSounds.has('theirs'));
});

test('if Discord turns the new sound down, the old one goes back', async (t) => {
  discordCdn(t);
  await libraryOnly('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  const { create } = guild.soundboardSounds;
  t.mock.method(guild.soundboardSounds, 'create', async (sound: { name: string; volume: number }) => {
    if (sound.name === 'bell') throw new Error('Discord said no');
    return create(sound);
  });
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /Discord said no/);
  assert.deepEqual([...discordSounds.values()].map((s) => s.name), ['theirs']);
  const list = await sounds();
  assert.equal(list.find((s) => s.name === 'theirs').onDiscord, true);
  assert.equal(list.find((s) => s.name === 'bell').onDiscord, false);
});

test('if the old sound can’t go back, the page says it’s in the library', async (t) => {
  discordCdn(t);
  await libraryOnly('bell');
  discordSounds.set('theirs', { name: 'Theirs' });
  t.mock.method(guild.soundboardSounds, 'create', async () => {
    throw new Error('Discord said no');
  });
  assert.match(await refused(400, ...swapIn('bell', 'theirs')), /theirs couldn’t go back on, but it’s safe in the library/);
  assert.ok((await sounds()).some((s) => s.name === 'theirs'));
});

test('only sounds on this server’s soundboard can be asked for', async (t) => {
  const asked = discordCdn(t);
  await upload('bell');
  for (const part of ['/audio', '/save']) await refused(404, `/guilds/${GUILD}/discord-sounds/nope${part}`, { method: part === '/audio' ? 'GET' : 'POST' });
  await refused(404, takeOff('nope'), { method: 'DELETE' });
  await refused(404, ...swapIn('bell', 'nope'));
  assert.equal(asked.length, 0);
  discordSounds.set('theirs', { name: 'Theirs' });
  await refused(404, `/guilds/${GUILD}/discord-sounds/theirs/nope`);
  await refused(404, `/guilds/${GUILD}/discord-sounds/theirs/save`);
  await refused(404, '/guilds/other/discord-sounds/theirs/audio');
});

test('previews a Discord sound without saving it', async (t) => {
  const asked = discordCdn(t);
  discordSounds.set('theirs', { name: 'Theirs' });
  const res = await call(`/guilds/${GUILD}/discord-sounds/theirs/audio`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(wav()));
  assert.deepEqual(asked, ['https://cdn.test/theirs']);
  assert.equal((await sounds()).length, 0);
});

test('plays a Discord sound in voice as loud as it is there, or as the library has it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = discordCdn(t);
  permitted.push(PermissionFlagsBits.Connect, PermissionFlagsBits.Speak);
  const connection = joinVoiceChannel({ channelId: '702', guildId: GUILD, adapterCreator: guild.voiceAdapterCreator as never });
  Object.assign(connection, { state: { ...connection.state, status: VoiceConnectionStatus.Ready } });
  t.after(async () => {
    await ok(`/guilds/${GUILD}/stop`, { method: 'POST' });
    soundboard.shutdown!();
  });
  const added = t.mock.method(Mixer.prototype, 'add', () => {});
  const id = `played${Date.now()}`;
  discordSounds.set(id, { name: 'Theirs', volume: 0.8 });
  const url = `/guilds/${GUILD}/discord-sounds/${id}/play`;
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  const file = path.join(tmpdir(), `slopkeeper-discord-${id}`);
  t.after(() => rmSync(file));
  assert.ok(readFileSync(file).equals(wav()));
  assert.equal(asked.length, 1, 'the second play uses the same copy');
  assert.deepEqual(added.mock.calls[0].arguments.slice(0, 2), [file, 0.8 / 0.5]);
  assert.deepEqual(plays(), [], 'not a library sound, so nothing to count');

  await save(id);
  await ok(url, { method: 'POST', json: { channelId: '702' } });
  assert.equal(added.mock.calls[2].arguments[0], path.join(soundFolder, 'theirs.mp3'));
  assert.deepEqual(plays(), ['web:theirs']);
  assert.match(await refused(400, url, { method: 'POST', json: { channelId: 'v1' } }), /Nobody’s in voice/);
});

const DAY = 86_400_000;

const bin = async () => (await ok(`/guilds/${GUILD}/deleted-sounds`)).sounds as any[];

const remove = (name: string) => ok(`/guilds/${GUILD}/sounds/${name}`, { method: 'DELETE' });

test('a deleted sound comes back with everything it had, but not on Discord', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn`, { method: 'PATCH', json: { emoji: '📯', volume: 150, favourite: true } });
  await ok(`/guilds/${GUILD}/sounds/horn/trim`, { method: 'POST', json: { start: 0, end: 0.1 } });
  const before = (await sounds())[0];
  const trimmed = readFileSync(path.join(soundFolder, 'horn.wav'));
  setJoinSound(GUILD, 'u1', 'horn');

  await remove('horn');
  assert.deepEqual(await sounds(), []);
  assert.equal(existsSync(path.join(soundFolder, 'horn.wav')), false);
  assert.equal(discordSounds.size, 0);
  const [deleted] = await bin();
  assert.equal(deleted.name, 'horn');
  assert.equal(deleted.emoji, '📯');
  assert.equal(deleted.expiresAt - deleted.deletedAt, BIN_DAYS * DAY);

  assert.deepEqual(await restore(deleted.id), { name: 'horn' });
  const after = (await sounds())[0];
  for (const key of ['name', 'emoji', 'favourite', 'volume', 'trimmed', 'loudness']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.trimmed, true);
  assert.equal(after.onDiscord, false);
  assert.deepEqual(readFileSync(path.join(soundFolder, 'horn.wav')), trimmed);
  assert.deepEqual(await bin(), []);
  assert.deepEqual(readdirSync(path.join(soundFolder, 'bin')), []);
  assert.equal((await ok(`/guilds/${GUILD}/join-sounds`)).joinSounds.length, 0);
  assert.equal(activityText().at(-1), 'Restored sound **horn**');
  await ok(`/guilds/${GUILD}/sounds/horn/restore`, { method: 'POST' });
  assert.notDeepEqual(readFileSync(path.join(soundFolder, 'horn.wav')), trimmed, 'its untrimmed version came back too');
});

test('a sound comes back under a new name if its own has been taken, original and all', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/sounds/horn/trim`, { method: 'POST', json: { start: 0, end: 0.1 } });
  await remove('horn');
  await upload('horn');
  const [deleted] = await bin();
  assert.deepEqual(await restore(deleted.id), { name: 'horn-2' });
  assert.deepEqual((await sounds()).map((s) => [s.name, s.trimmed]), [['horn', false], ['horn-2', true]]);

  await remove('horn-2');
  await upload('horn-2');
  assert.deepEqual(await restore((await bin())[0].id), { name: 'horn-2-2' });
});

test('a long name stays within the limit when it has to change', async () => {
  const name = 'x'.repeat(32);
  await upload(name);
  await remove(name);
  await upload(name);
  const { name: back } = await restore((await bin())[0].id);
  assert.equal(back, `${'x'.repeat(30)}-2`);
});

test('two deleted sounds of one name are kept apart, newest first', async () => {
  await upload('horn', 'a.wav', wav(0.2) as BodyInit);
  await remove('horn');
  await upload('horn', 'a.wav', wav(0.4) as BodyInit);
  await remove('horn');
  const [newest, oldest] = await bin();
  assert.ok(newest.id > oldest.id);
  await restore(oldest.id);
  assert.ok(readFileSync(path.join(soundFolder, 'horn.wav')).length < wav(0.3).length);
});

test('sounds in the bin aren’t listed, and go after 30 days', async () => {
  await upload('old');
  await upload('recent');
  await remove('old');
  await remove('recent');
  const [recent, old] = await bin();
  db.prepare('UPDATE deleted_sounds SET deleted_at = ? WHERE id = ?').run(Date.now() - (BIN_DAYS + 1) * DAY, old.id);
  db.prepare('UPDATE deleted_sounds SET deleted_at = ? WHERE id = ?').run(Date.now() - (BIN_DAYS - 1) * DAY, recent.id);
  clearBin();
  assert.deepEqual((await bin()).map((s) => s.name), ['recent']);
  assert.deepEqual(readdirSync(path.join(soundFolder, 'bin')), [String(recent.id)]);
  assert.deepEqual(await sounds(), []);
});

test('delete forever erases a sound, for this server only', async () => {
  await upload('horn');
  await remove('horn');
  const [deleted] = await bin();
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${deleted.id + 1}`, { method: 'DELETE' });
  await refused(404, `/guilds/${GUILD}/deleted-sounds/nope/restore`, { method: 'POST' });
  await refused(405, `/guilds/${GUILD}/deleted-sounds/${deleted.id}`, { method: 'POST' });
  await refused(405, `/guilds/${GUILD}/deleted-sounds/${deleted.id}/restore`, { method: 'DELETE' });
  const { lastInsertRowid } = db.prepare(`INSERT INTO deleted_sounds (guild_id, name, favourite, percent, deleted_at) VALUES ('elsewhere', 'theirs', 0, 100, 0)`).run();
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${lastInsertRowid}/restore`, { method: 'POST' });
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${lastInsertRowid}`, { method: 'DELETE' });

  await ok(`/guilds/${GUILD}/deleted-sounds/${deleted.id}`, { method: 'DELETE' });
  assert.deepEqual(await bin(), []);
  assert.equal(existsSync(path.join(soundFolder, 'bin', String(deleted.id))), false);
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${deleted.id}/restore`, { method: 'POST' });
  assert.equal(activityText().at(-1), 'Erased deleted sound **horn**');
});

test('a sound whose files have gone says so instead of breaking', async () => {
  await upload('horn');
  await remove('horn');
  const [deleted] = await bin();
  rmSync(path.join(soundFolder, 'bin', String(deleted.id)), { recursive: true });
  await refused(404, `/guilds/${GUILD}/deleted-sounds/${deleted.id}/restore`, { method: 'POST' });
  assert.deepEqual(await bin(), []);
});

test('the web UI sets and clears the sound managers role, but isn’t limited by it', async () => {
  const url = `/guilds/${GUILD}/settings/soundManagerRole`;
  assert.equal(await refused(400, url, { method: 'PUT', json: { value: 'nope' } }), 'Pick a role.');
  await ok(url, { method: 'PUT', json: { value: '333' } });
  assert.equal(setting(GUILD, 'soundManagerRole'), '333');
  await upload('horn');
  assert.equal((await sounds()).length, 1);
  await remove('horn');
  await ok(url, { method: 'DELETE' });
  assert.equal(setting(GUILD, 'soundManagerRole'), null);
});

const joinUrl = `/guilds/${GUILD}/join-sounds`;

const setJoin = (user: string, json: unknown) => ok(`${joinUrl}/${user}`, { method: 'PUT', json });

test('sets anyone’s join sound, and a new one replaces the old', async () => {
  await upload('horn');
  await upload('bell');
  const data = await ok(joinUrl);
  assert.deepEqual(data.members.map((m: any) => m.name), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(data.sounds.sort(), ['bell', 'horn']);

  assert.deepEqual(await setJoin('u2', { name: 'horn' }), { warning: null });
  assert.deepEqual((await ok(joinUrl)).joinSounds, [{ id: 'u2', who: 'Ben', name: 'horn' }]);
  await setJoin('u2', { name: 'bell' });
  assert.deepEqual((await ok(joinUrl)).joinSounds, [{ id: 'u2', who: 'Ben', name: 'bell' }]);
  assert.equal(activityText().at(-1), 'Set Ben’s join sound to **bell**');
});

test('refuses a join sound that doesn’t exist, or someone who isn’t here', async () => {
  await upload('horn');
  guild.members.cache.set('b1', member('b1', 'Some Bot', true)[1] as never);
  for (const name of ['nope', '', 5, undefined]) await refused(404, `${joinUrl}/u1`, { method: 'PUT', json: { name } });
  await refused(404, `${joinUrl}/nobody`, { method: 'PUT', json: { name: 'horn' } });
  await refused(404, `${joinUrl}/b1`, { method: 'PUT', json: { name: 'horn' } });
  guild.members.cache.delete('b1');
  assert.deepEqual((await ok(joinUrl)).joinSounds, []);
});

test('still sets a join sound while they’re off, and says it won’t play', async () => {
  await upload('horn');
  await ok(`/guilds/${GUILD}/settings/joinSounds`, { method: 'PUT', json: { value: false } });
  assert.match((await setJoin('u1', { name: 'horn' })).warning, /turned off/);
  assert.equal((await ok(joinUrl)).joinSounds.length, 1);
});

test('tells the page what text to speech offers', async () => {
  const url = config.voiceUrl;
  assert.equal((await ok(`/guilds/${GUILD}/say`)).on, false, 'no voice container set up');
  config.voiceUrl = 'http://voice.test';
  try {
    const data = await ok(`/guilds/${GUILD}/say`);
    assert.deepEqual(data.voices.map((v: { name: string }) => v.name), [
      ...['GLaDOS', 'HAL 9000', 'Bender', 'Optimus Prime', 'Kronk', 'TikTok', 'State broadcast', 'Russian', 'Spanish', 'German'],
      ...['Demon', 'Helium', 'Giant', 'Robot', 'Alien', 'Walkie-talkie', 'Phone call', 'Megaphone', 'Stadium PA', 'Newsreel'],
      ...['Cathedral', 'Underwater', 'Ghost', 'Trailer narrator'],
    ]);
    assert.deepEqual(Object.keys(data.voices[0]), ['id', 'name', 'group']);
    const group = (id: string) => data.voices.find((v: { id: string }) => v.id === id).group;
    assert.deepEqual([group('glados'), group('russian'), group('demon')], ['Characters', 'Accents', 'Effects']);
    assert.deepEqual([data.on, data.voice, data.volume, data.longest], [true, 'tiktok', 100, 200]);
    setSetting(GUILD, 'tts', false);
    assert.equal((await ok(`/guilds/${GUILD}/say`)).on, false);
  } finally {
    config.voiceUrl = url;
    setSetting(GUILD, 'tts', undefined);
  }
});

test('previews a voice for the browser only, a few at a time', async (t) => {
  const url = config.voiceUrl;
  t.after(() => {
    config.voiceUrl = url;
    setSetting(GUILD, 'tts', undefined);
  });
  const preview = `/guilds/${GUILD}/say/preview?voice=demon&text=${encodeURIComponent('hello there')}`;
  assert.equal(await refused(409, preview), 'Text to speech is off for this server.', 'no voice container set up');
  config.voiceUrl = 'http://voice.test';
  const real = fetch;
  const asked: { text: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (target: URL | string, init?: RequestInit) => {
    if (String(target).startsWith(base)) return real(target, init);
    asked.push(JSON.parse(init!.body as string));
    return new Response(wav(0.3));
  });
  const res = await call(preview);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4)), 'RIFF');
  assert.equal(asked[0].text, 'hello there');
  assert.equal(await refused(429, preview), 'Wait a moment before the next preview.');
  assert.deepEqual(recentActivity(GUILD, 50).filter((r) => /preview/i.test(r.action)), [], 'it isn’t said in voice, so it isn’t logged');
  setSetting(GUILD, 'tts', false);
  assert.equal(await refused(409, preview), 'Text to speech is off for this server.');
});

test('the page’s limits on text to speech', async () => {
  const url = config.voiceUrl;
  config.voiceUrl = 'http://voice.test';
  const post = (json: unknown) => refused(400, `/guilds/${GUILD}/say`, { method: 'POST', json });
  try {
    assert.equal(await post({ channelId: '702', text: 5 }), 'Type something to say.');
    assert.equal(await post({ channelId: 'v1', text: 'hello' }), 'Nobody’s in voice any more.');
    assert.equal(await post({ channelId: '702', text: 'x'.repeat(201) }), 'That’s 201 characters, and the limit here is 200.');
    assert.equal(await post({ channelId: '702', text: '🎉' }), 'There’s nothing in that to read out.');
    assert.equal(await post({ channelId: '702', text: 'hello', voice: 'nope' }), 'Pick a voice from the list.');
  } finally {
    config.voiceUrl = url;
  }
});

test('the page’s lines go through the voice container and show as coming from the web', async (t) => {
  const url = config.voiceUrl;
  config.voiceUrl = 'http://voice.test';
  t.after(() => void (config.voiceUrl = url));
  const real = fetch;
  let asked: unknown;
  t.mock.method(globalThis, 'fetch', async (target: URL | string, init?: RequestInit) => {
    if (String(target).startsWith(base)) return real(target, init);
    asked = JSON.parse(init!.body as string);
    return new Response('not audio', { status: 500 });
  });
  t.mock.method(console, 'error', () => {});
  await refused(400, `/guilds/${GUILD}/say`, { method: 'POST', json: { channelId: '702', text: 'hello <@123>', voice: 'alien' } });
  assert.deepEqual(asked, { text: 'hello someone', speaker_id: 0, length_scale: lengthFor(85) });
});

test('the page saves lines and removes them', async () => {
  const start = (await ok(`/guilds/${GUILD}/say`)).phrases as unknown[];
  assert.deepEqual(start, []);
  const { phrases } = (await ok(`/guilds/${GUILD}/phrases`, { method: 'POST', json: { text: 'good game' } })) as { phrases: { id: number; text: string }[] };
  assert.deepEqual(phrases, [{ id: phrases[0].id, text: 'good game' }]);
  assert.deepEqual((await ok(`/guilds/${GUILD}/say`)).phrases, phrases);
  assert.equal(await refused(400, `/guilds/${GUILD}/phrases`, { method: 'POST', json: { text: 5 } }), 'Type something to save.');
  assert.deepEqual(((await ok(`/guilds/${GUILD}/phrases/${phrases[0].id}`, { method: 'DELETE' })) as { phrases: unknown[] }).phrases, []);
  assert.equal(await refused(404, `/guilds/${GUILD}/phrases/${phrases[0].id}`, { method: 'DELETE' }), 'That saved line is gone.');
  const log = recentActivity(GUILD, 5).map((r) => r.action);
  assert.ok(log.includes('Saved the line “good game”') && log.includes('Removed the saved line “good game”'));
});

test('posts a soundboard panel and keeps track of it', async () => {
  await upload('horn');
  db.exec('DELETE FROM sound_panels');
  await ok(`/guilds/${GUILD}/sound-panels`, { method: 'POST', json: { channelId: '111' } });
  assert.equal(sent[0].channelId, '111');
  assert.ok(sent[0].message.components.length > 0);
  assert.deepEqual(db.prepare('SELECT message_id, guild_id, channel_id FROM sound_panels').all().map((r) => ({ ...r })), [{ message_id: 'posted-1', guild_id: GUILD, channel_id: '111' }]);
  assert.equal(activityText().at(-1), 'Posted a soundboard panel in <#111>');
});

test('looping speech that can’t be made is warned about when it’s set', async () => {
  const { warning } = await ok(`/guilds/${GUILD}/settings/loopText`, { method: 'PUT', json: { value: 'stay a while' } });
  assert.match(warning, /Text to speech/);
  assert.equal(setting(GUILD, 'loopText'), 'stay a while');
  assert.match(await refused(400, `/guilds/${GUILD}/settings/loopText`, { method: 'PUT', json: { value: '   ' } }), /Type something/);
});
