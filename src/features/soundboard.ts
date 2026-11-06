import {
  AudioPlayerStatus,
  type AudioPlayer,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  getVoiceConnections,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import * as discordBoard from '../discordSounds.ts';
import { measureGain } from '../loudness.ts';
import { Mixer } from '../mixer.ts';
import { isAllowed, setting } from '../settings.ts';
import { cutAudio } from '../trim.ts';
import type { Feature } from '../types.ts';
import { humansIn, requestTimeout, servedGuilds } from '../util.ts';

const EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac'];
const MAX_BYTES = 5 * 1024 * 1024;
const VOLUME = 0.5;
const MAX_VOICES = 12;
const IDLE_LEAVE_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RECONNECT_TIMEOUT_MS = 5_000;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const VOLUME_PERCENT = [25, 200] as const;
const SHORTEST_TRIM = 0.1;
/** How far apart two times can be and still be the same moment, since the page rounds what it sends */
const TRIM_TOLERANCE = 0.05;
const PAGE_SIZE = 20; // 4 rows of 5 buttons; the fifth row holds the controls
const CUSTOM_EMOJI = /^<a?:\w{2,32}:(\d{17,20})>$/;
const UNICODE_EMOJI = /^\p{RGI_Emoji}$/v;
const VOICE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
] as const;
// Control button ids use '#', which sound names can't contain
const PREV = 'sb:#prev';
const NEXT = 'sb:#next';
const STOP = 'sb:#stop';

/** Each server has its own sounds, in sounds/<server id>/ */
function soundDir(guildId: string): string {
  const dir = path.join(config.dataDir, 'sounds', guildId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Untrimmed sounds, in their own folder so they aren't listed as sounds */
const originalsDir = (guildId: string) => path.join(soundDir(guildId), 'originals');

function originalOf(guildId: string, name: string): string | undefined {
  const dir = originalsDir(guildId);
  const file = existsSync(dir) ? readdirSync(dir).find((f) => path.parse(f).name === name) : undefined;
  return file && path.join(dir, file);
}

export const isTrimmed = (guildId: string, name: string) => originalOf(guildId, name) !== undefined;

function dropOriginal(guildId: string, name: string) {
  const original = originalOf(guildId, name);
  if (original) rmSync(original);
}

export interface Sound {
  name: string;
  file: string;
  emoji?: string;
  onDiscord: boolean;
}

export function listSounds(guildId: string): Sound[] {
  const dir = soundDir(guildId);
  const onDiscord = discordBoard.synced(guildId);
  const emojis = new Map(
    (db.prepare('SELECT name, emoji FROM sound_emoji WHERE guild_id = ?').all(guildId) as { name: string; emoji: string }[]).map((r) => [
      r.name,
      r.emoji,
    ]),
  );
  return readdirSync(dir)
    .filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const name = path.parse(f).name;
      return { name, file: path.join(dir, f), emoji: emojis.get(name), onDiscord: onDiscord.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const findSound = (guildId: string, name: string) => listSounds(guildId).find((s) => s.name === name);

function setEmoji(guildId: string, name: string, emoji: string | null) {
  if (emoji) {
    db.prepare('INSERT INTO sound_emoji (guild_id, name, emoji) VALUES (?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET emoji = excluded.emoji').run(
      guildId,
      name,
      emoji,
    );
  } else db.prepare('DELETE FROM sound_emoji WHERE guild_id = ? AND name = ?').run(guildId, name);
}

/** Clears custom emoji the server no longer has, since one on a button stops its whole panel posting. Returns whether any were */
export function dropMissingEmoji(guild: Guild): boolean {
  const rows = db.prepare('SELECT name, emoji FROM sound_emoji WHERE guild_id = ?').all(guild.id) as { name: string; emoji: string }[];
  const missing = rows.filter((r) => {
    const id = CUSTOM_EMOJI.exec(r.emoji)?.[1];
    return id && !guild.emojis.cache.has(id);
  });
  for (const r of missing) setEmoji(guild.id, r.name, null);
  return missing.length > 0;
}

/**
 * Stores an upload as a sound, replacing any sound of that name, unless it isn't audio. It only takes the place of
 * the old file once it's known to be good, so a bad upload can't cost the sound it was replacing.
 */
export async function saveUpload(guildId: string, name: string, ext: string, data: Buffer): Promise<boolean> {
  const target = path.join(soundDir(guildId), name + ext);
  const upload = `${target}.upload`;
  writeFileSync(upload, data);
  if (!(await discordBoard.hasAudio(upload))) {
    rmSync(upload);
    return false;
  }
  const existing = findSound(guildId, name);
  renameSync(upload, target);
  // The new file may have a different extension
  if (existing && existing.file !== target) rmSync(existing.file);
  // That was the old audio, so restoring it now would bring back the wrong sound
  dropOriginal(guildId, name);
  return true;
}

/** Why an upload can't be stored, or null if it can */
export function uploadProblem(name: string, ext: string, size: number): string | null {
  if (!NAME_PATTERN.test(name)) return 'Name can only use lowercase letters, numbers, - and _.';
  if (!EXTENSIONS.includes(ext)) return `Unsupported file type. Use one of: ${EXTENSIONS.join(', ')}`;
  return size > MAX_BYTES ? 'File is over 5 MB.' : null;
}

/** Each sound's measured gain and picked volume, by name */
export function soundLevels(guildId: string): Map<string, { gainDb: number | null; percent: number }> {
  const rows = db.prepare('SELECT name, gain_db, percent FROM sound_levels WHERE guild_id = ?').all(guildId) as { name: string; gain_db: number | null; percent: number }[];
  return new Map(rows.map((r) => [r.name, { gainDb: r.gain_db, percent: r.percent }]));
}

/** What a sound's samples get multiplied by. The file itself is never changed, so all of this can be undone */
export function soundGain(guildId: string, name: string): number {
  const level = soundLevels(guildId).get(name);
  const levelled = setting(guildId, 'evenVolume') ? (level?.gainDb ?? 0) : 0;
  return 10 ** (levelled / 20) * ((level?.percent ?? 100) / 100);
}

/** How loud a sound plays in voice, where 1 is the file as it is */
export const voiceVolume = (guildId: string, name: string) => VOLUME * soundGain(guildId, name);

/** Discord's own volume for a sound's copy. It can't go over 1, so that's as far as it can be turned up there */
export const discordVolume = (guildId: string, name: string) => Math.min(1, Math.round(voiceVolume(guildId, name) * 100) / 100);

/** Measures a sound, starting from its picked volume being reset, since that was for the audio it had before */
async function levelSound(guildId: string, sound: Sound, keepPercent = false) {
  const gain = await measureGain(sound.file).catch((err: Error) => {
    console.error(`Couldn’t measure ${sound.name} in server ${guildId}:`, err.message);
    return 0;
  });
  db.prepare(
    `INSERT INTO sound_levels (guild_id, name, gain_db) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, name) DO UPDATE SET gain_db = excluded.gain_db, percent = ${keepPercent ? 'percent' : 100}`,
  ).run(guildId, sound.name, gain);
}

/** Measures sounds from before levelling existed, one at a time so it doesn't get in the way of playback */
export async function levelLibrary(client: Client<true>) {
  for (const guild of servedGuilds(client)) {
    const known = soundLevels(guild.id);
    const waiting = listSounds(guild.id).filter((s) => (known.get(s.name)?.gainDb ?? null) === null);
    for (const sound of waiting) {
      await levelSound(guild.id, sound, true);
      await discordBoard.setVolume(guild, sound.name, discordVolume(guild.id, sound.name));
    }
    if (waiting.length) console.log(`Measured ${waiting.length} sound${waiting.length === 1 ? '' : 's'} in ${guild.name}`);
  }
}

/** Sets how loud a sound plays, here and on Discord's soundboard */
export async function setSoundVolume(guild: Guild, name: string, percent: number) {
  db.prepare('INSERT INTO sound_levels (guild_id, name, percent) VALUES (?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET percent = excluded.percent').run(guild.id, name, percent);
  await discordBoard.setVolume(guild, name, discordVolume(guild.id, name));
}

/** Brings the Discord copies in line after levelling is turned on or off */
export async function applyLevels(guild: Guild) {
  for (const name of discordBoard.synced(guild.id).keys()) await discordBoard.setVolume(guild, name, discordVolume(guild.id, name));
}

export const volumeProblem = (percent: unknown) =>
  Number.isInteger(percent) && (percent as number) >= VOLUME_PERCENT[0] && (percent as number) <= VOLUME_PERCENT[1] ? null : `Volume has to be a whole number from ${VOLUME_PERCENT[0]} to ${VOLUME_PERCENT[1]}.`;

/**
 * Stores a sound and copies it into Discord's soundboard if it can, unless told not to. A sound already there is
 * always updated, or Discord would keep the old audio. Returns null if the file isn't audio, otherwise whether it
 * replaced a sound and why it isn't on Discord, if it isn't.
 */
export async function addSound(guild: Guild, name: string, ext: string, data: Buffer, emoji?: string, toDiscord = true) {
  const previous = findSound(guild.id, name);
  const replaced = !!previous;
  if (!(await saveUpload(guild.id, name, ext, data))) return null;
  // Replacing a sound keeps its emoji unless a new one was given
  if (emoji) setEmoji(guild.id, name, emoji);
  const sound = findSound(guild.id, name)!;
  await levelSound(guild.id, sound);
  if (!toDiscord && !previous?.onDiscord) return { replaced, problem: null };
  const problem = await discordBoard.upload(guild, sound, discordVolume(guild.id, name));
  // A replaced sound that no longer fits mustn't leave the old audio on Discord's soundboard
  if (problem) await discordBoard.remove(guild, name).catch(() => {});
  return { replaced, problem };
}

/** Deletes a sound. Returns why it couldn't come off Discord's soundboard, if it couldn't */
export async function removeSound(guild: Guild, sound: Sound): Promise<string | null> {
  const problem = await discordBoard.remove(guild, sound.name).then(
    () => null,
    (err: Error) => err.message,
  );
  rmSync(sound.file);
  dropOriginal(guild.id, sound.name);
  setEmoji(guild.id, sound.name, null);
  setFavourite(guild.id, sound.name, false);
  db.prepare('DELETE FROM sound_levels WHERE guild_id = ? AND name = ?').run(guild.id, sound.name);
  db.prepare('DELETE FROM join_sounds WHERE guild_id = ? AND name = ?').run(guild.id, sound.name);
  return problem;
}

/** Favourites sit at the top of the web UI's soundboard */
export function favourites(guildId: string): Set<string> {
  return new Set((db.prepare('SELECT name FROM sound_favourites WHERE guild_id = ?').all(guildId) as { name: string }[]).map((r) => r.name));
}

export function setFavourite(guildId: string, name: string, on: boolean) {
  if (on) db.prepare('INSERT INTO sound_favourites (guild_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING').run(guildId, name);
  else db.prepare('DELETE FROM sound_favourites WHERE guild_id = ? AND name = ?').run(guildId, name);
}

/** Sound name → how often it's been played */
export function playCounts(guildId: string): Map<string, number> {
  const rows = db.prepare('SELECT name, COUNT(*) AS n FROM sound_plays WHERE guild_id = ? GROUP BY name').all(guildId) as { name: string; n: number }[];
  return new Map(rows.map((r) => [r.name, r.n]));
}

export async function changeEmoji(guild: Guild, name: string, emoji: string | null) {
  setEmoji(guild.id, name, emoji);
  await discordBoard.setEmoji(guild, name, emoji);
}

/** Renames a sound everywhere, keeping its play counts. Returns null on success or the reason it couldn't */
export async function renameSound(guild: Guild, sound: Sound, name: string): Promise<string | null> {
  if (!NAME_PATTERN.test(name)) return 'Name can only use lowercase letters, numbers, - and _.';
  if (findSound(guild.id, name)) return `There’s already a sound called **${name}**.`;
  // First, since it's the one step that can fail
  const problem = await discordBoard.rename(guild, sound.name, name);
  if (problem) return problem;
  renameSync(sound.file, path.join(path.dirname(sound.file), name + path.extname(sound.file)));
  const original = originalOf(guild.id, sound.name);
  if (original) renameSync(original, path.join(path.dirname(original), name + path.extname(original)));
  db.prepare('UPDATE OR REPLACE sound_emoji SET name = ? WHERE guild_id = ? AND name = ?').run(name, guild.id, sound.name);
  db.prepare('UPDATE sound_plays SET name = ? WHERE guild_id = ? AND name = ?').run(name, guild.id, sound.name);
  db.prepare('UPDATE OR REPLACE sound_favourites SET name = ? WHERE guild_id = ? AND name = ?').run(name, guild.id, sound.name);
  db.prepare('UPDATE OR REPLACE sound_levels SET name = ? WHERE guild_id = ? AND name = ?').run(name, guild.id, sound.name);
  db.prepare('UPDATE join_sounds SET name = ? WHERE guild_id = ? AND name = ?').run(name, guild.id, sound.name);
  return null;
}

/** Why this part of a sound can't be kept, or null if it can. `seconds` is how long the sound is */
export function trimProblem(start: unknown, end: unknown, seconds: number): string | null {
  if (!Number.isFinite(seconds)) return 'The bot can’t tell how long that sound is, so it can’t be trimmed.';
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Start and end have to be numbers of seconds.';
  const [from, to] = [start as number, end as number];
  if (from < 0 || to > seconds + TRIM_TOLERANCE) return 'Pick a start and end inside the sound.';
  if (to - from < SHORTEST_TRIM) return `Keep at least ${SHORTEST_TRIM} s of the sound.`;
  return from < TRIM_TOLERANCE && to > seconds - TRIM_TOLERANCE ? 'That keeps the whole sound.' : null;
}

/**
 * Cuts a sound down, keeping the first version so it can be restored. It only takes the place of the file once it's
 * known to be good. Discord's copy stays as it is. Returns whether it worked.
 */
export async function trimSound(guild: Guild, sound: Sound, start: number, end: number): Promise<boolean> {
  const ext = path.extname(sound.file);
  const dir = originalsDir(guild.id);
  mkdirSync(dir, { recursive: true });
  const cut = path.join(dir, `${sound.name}.cut${ext}`);
  const seconds = await cutAudio(sound.file, cut, start, end - start)
    .then(() => discordBoard.durationOf(cut))
    .catch((err: Error) => {
      console.error(`Couldn’t trim ${sound.name} in server ${guild.id}:`, err.message);
      return 0;
    });
  // ffmpeg is happy to write nothing at all if the audio stops before the start
  if (!(seconds > 0)) {
    rmSync(cut, { force: true });
    return false;
  }
  if (!isTrimmed(guild.id, sound.name)) copyFileSync(sound.file, path.join(dir, path.basename(sound.file)));
  renameSync(cut, sound.file);
  // The part that's left may be louder or quieter than the whole was
  await levelSound(guild.id, sound, true);
  return true;
}

/** Puts a trimmed sound back as it was. Returns whether there was anything to put back */
export async function restoreSound(guild: Guild, sound: Sound): Promise<boolean> {
  const original = originalOf(guild.id, sound.name);
  if (!original) return false;
  renameSync(original, sound.file);
  await levelSound(guild.id, sound, true);
  return true;
}

export const addToDiscord = (guild: Guild, sound: Sound, start?: number) => discordBoard.upload(guild, sound, discordVolume(guild.id, sound.name), start);

/** Copies every sound that fits into Discord's soundboard, until it's full */
export async function syncToDiscord(guild: Guild) {
  await discordBoard.reconcile(guild);
  const added: string[] = [];
  const tooLong: string[] = [];
  const failed: string[] = [];
  const waiting: string[] = [];
  let blocker: string | null = null;
  for (const sound of listSounds(guild.id).filter((s) => !s.onDiscord)) {
    if (blocker) {
      waiting.push(sound.name);
      continue;
    }
    if (!discordBoard.fits(await discordBoard.durationOf(sound.file).catch(() => Infinity))) {
      tooLong.push(sound.name);
      continue;
    }
    const problem = await discordBoard.upload(guild, sound, discordVolume(guild.id, sound.name));
    if (!problem) added.push(sound.name);
    else if (problem === discordBoard.FULL || problem === discordBoard.NO_PERMISSION) {
      blocker = problem;
      waiting.push(sound.name);
    } else failed.push(`${sound.name} (${problem})`);
  }
  return { added, tooLong, failed, waiting, blocker };
}

/** Returns the emoji to store, or an error message for the user */
export async function parseEmoji(guild: Guild, input: string): Promise<{ emoji: string } | { error: string }> {
  const trimmed = input.trim();
  if (UNICODE_EMOJI.test(trimmed)) return { emoji: trimmed };
  const custom = CUSTOM_EMOJI.exec(trimmed);
  if (!custom) return { error: 'That isn’t a single emoji. Pick one from the emoji picker.' };
  // Bots can only show custom emoji from servers they're in
  const found = await guild.emojis.fetch(custom[1]).catch(() => null);
  return found ? { emoji: trimmed } : { error: 'Custom emoji have to be from this server.' };
}

interface GuildAudio {
  player: AudioPlayer;
  mixer?: Mixer;
  idleTimer?: NodeJS.Timeout;
}

/** Server id → its audio; the bot can be in a voice channel in every server at once */
const audio = new Map<string, GuildAudio>();

function audioFor(guildId: string): GuildAudio {
  const existing = audio.get(guildId);
  if (existing) return existing;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  const a: GuildAudio = { player };
  player.on('error', (err) => console.error('Audio player error:', err.message));
  player.on(AudioPlayerStatus.Idle, () => {
    clearTimeout(a.idleTimer);
    a.idleTimer = setTimeout(() => getVoiceConnection(guildId)?.destroy(), IDLE_LEAVE_MS);
  });
  audio.set(guildId, a);
  return a;
}

/** Why the bot can't play in a channel, or null if it can */
export function cantJoin(channel: VoiceBasedChannel): string | null {
  const perms = channel.permissionsFor(channel.guild.members.me!);
  const missing = VOICE_PERMISSIONS.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
  if (missing.length) return `I can’t play in ${channel}. A server admin needs to give my role **${missing.join('**, **')}** there.`;
  return channel.joinable ? null : `I can’t join ${channel}, it’s full.`;
}

function destroy(connection: VoiceConnection) {
  if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
}

function watch(connection: VoiceConnection, guildId: string) {
  // Without a listener, a voice network error would be thrown and take the whole bot down
  connection.on('error', (err) => console.error(`Voice connection error in server ${guildId}:`, err.message));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Being dragged to another channel also lands here, and reconnects by itself
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
      ]);
    } catch {
      // Disconnected by someone, or the channel went away. Nothing else clears this, and every click would wait on it
      destroy(connection);
    }
  });
}

/** Plays a sound in a channel. Returns null on success or the reason it couldn't, for the user */
export async function play(channel: VoiceBasedChannel, file: string, gain = 1): Promise<string | null> {
  const problem = cantJoin(channel);
  if (problem) return problem;

  const a = audioFor(channel.guild.id);
  clearTimeout(a.idleTimer);
  let connection = getVoiceConnection(channel.guild.id);
  // Joining again also revives a connection that dropped, which is otherwise only cleared up a few seconds later
  if (!connection || connection.joinConfig.channelId !== channel.id || connection.state.status === VoiceConnectionStatus.Disconnected) {
    const isNew = !connection;
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    if (isNew) watch(connection, channel.guild.id);
    connection.subscribe(a.player);
  }
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
  } catch {
    console.error(`Voice connection to ${channel.name} in ${channel.guild.name} (${channel.guild.id}) timed out in state ${connection.state.status}`);
    // Left in place it would be reused, and every later click would time out as well
    destroy(connection);
    return `I couldn’t connect to ${channel}. Try again in a moment.`;
  }
  // Layer onto whatever is already playing (or restart this sound if it's one of them); a fresh mixer is only needed once the last one has gone quiet
  if (a.mixer && !a.mixer.finished) {
    a.mixer.add(file, gain);
    return null;
  }
  a.mixer = new Mixer(VOLUME, MAX_VOICES);
  a.mixer.add(file, gain);
  a.player.play(createAudioResource(a.mixer, { inputType: StreamType.Raw }));
  return null;
}

/** For the monthly recap */
function recordPlay(guildId: string, userId: string, name: string) {
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)').run(guildId, userId, name, Date.now());
}

/** Plays a sound for the web UI, which has nobody to credit. It still counts towards the recap's top sounds */
export async function playFromWeb(channel: VoiceBasedChannel, sound: Sound): Promise<string | null> {
  const problem = await play(channel, sound.file, soundGain(channel.guild.id, sound.name));
  if (!problem) recordPlay(channel.guild.id, 'web', sound.name);
  return problem;
}

/** Everyone's join sounds in a server */
export function joinSounds(guildId: string) {
  return db.prepare('SELECT user_id, name FROM join_sounds WHERE guild_id = ? ORDER BY name').all(guildId) as { user_id: string; name: string }[];
}

export function setJoinSound(guildId: string, userId: string, name: string | null) {
  if (name) db.prepare('INSERT INTO join_sounds (guild_id, user_id, name) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET name = excluded.name').run(guildId, userId, name);
  else db.prepare('DELETE FROM join_sounds WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

/** Server and person → when their join sound last played */
const lastJoinSound = new Map<string, number>();

/** Plays someone's join sound as they connect to voice. These aren't clicks, so they stay out of the recap's top sounds */
export async function playJoinSound(oldState: VoiceState, newState: VoiceState) {
  const { channel, guild } = newState;
  // Coming from another channel, or muting, is not joining
  if (!channel || oldState.channelId || newState.member?.user.bot || channel.id === guild.afkChannelId) return;
  if (!setting(guild.id, 'joinSounds')) return;
  const name = joinSounds(guild.id).find((r) => r.user_id === newState.id)?.name;
  const sound = name && findSound(guild.id, name);
  if (!sound) return;
  // One person arriving shouldn't pull the bot away from people using it in another channel
  const botChannel = getVoiceConnection(guild.id)?.joinConfig.channelId;
  if (botChannel && botChannel !== channel.id) return;
  const key = `${guild.id}:${newState.id}`;
  const now = Date.now();
  if (now - (lastJoinSound.get(key) ?? -Infinity) < setting(guild.id, 'joinSoundCooldownMin') * 60_000) return;
  lastJoinSound.set(key, now);
  const problem = await play(channel, sound.file, soundGain(guild.id, sound.name));
  if (problem) console.log(`Join sound ${sound.name} in ${guild.name} didn’t play: ${problem}`);
}

export function stopPlayback(guildId: string) {
  const a = audio.get(guildId);
  a?.mixer?.stopAll();
  a?.player.stop(true);
}

function leaveVoice(guildId: string) {
  stopPlayback(guildId);
  const connection = getVoiceConnection(guildId);
  if (connection) destroy(connection);
}

/** Leaves voice once the last person has gone, rather than sitting there alone until the idle timer */
export function leaveIfAlone(guild: Guild) {
  const channelId = getVoiceConnection(guild.id)?.joinConfig.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
  if (channel?.isVoiceBased() && !humansIn(channel).length) leaveVoice(guild.id);
}

const pageCount = (sounds: Sound[]) => Math.max(1, Math.ceil(sounds.length / PAGE_SIZE));

function panel(guildId: string, page: number) {
  const sounds = listSounds(guildId);
  if (!sounds.length) return { content: '🔊 No sounds yet. Add one with `/sound add`.', components: [] };
  const pages = pageCount(sounds);
  page = Math.min(Math.max(page, 0), pages - 1);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const shown = sounds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  for (let idx = 0; idx < shown.length; idx += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown.slice(idx, idx + 5).map((s) => {
          const button = new ButtonBuilder()
            .setCustomId(`sb:${s.name}`)
            .setLabel(s.name)
            .setStyle(s.onDiscord ? ButtonStyle.Primary : ButtonStyle.Secondary);
          return s.emoji ? button.setEmoji(s.emoji) : button;
        }),
      ),
    );
  }

  const controls = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) {
    controls.addComponents(
      new ButtonBuilder().setCustomId(PREV).setEmoji('◀️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(NEXT).setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    );
  }
  controls.addComponents(new ButtonBuilder().setCustomId(STOP).setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger));
  rows.push(controls);

  const title = pages > 1 ? `🔊 **Soundboard** · page ${page + 1} of ${pages}` : '🔊 **Soundboard**';
  const legend = sounds.some((s) => s.onDiscord) ? '\n-# Blue sounds are also in Discord’s own soundboard, for instant spamming' : '';
  return { content: title + legend, components: rows };
}

function trackPanel(messageId: string, guildId: string, channelId: string, page: number) {
  db.prepare(
    'INSERT INTO sound_panels (message_id, guild_id, channel_id, page) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET page = excluded.page',
  ).run(messageId, guildId, channelId, page);
}

/** Re-renders a server's posted panels after its sound list changes */
export async function refreshPanels(client: Client, guildId: string) {
  const panels = db.prepare('SELECT message_id, channel_id, page FROM sound_panels WHERE guild_id = ?').all(guildId) as {
    message_id: string;
    channel_id: string;
    page: number;
  }[];
  for (const p of panels) {
    try {
      const channel = await client.channels.fetch(p.channel_id);
      if (!channel?.isTextBased()) throw new Error(`channel ${p.channel_id} is not text-based`);
      // Editing by id avoids fetching the message, which would need Read Message History
      await channel.messages.edit(p.message_id, panel(guildId, p.page));
    } catch (err) {
      const gone =
        err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel);
      if (gone) db.prepare('DELETE FROM sound_panels WHERE message_id = ?').run(p.message_id);
      else console.error(`Soundboard panel ${p.message_id} refresh failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export const soundboard: Feature = {
  title: 'Soundboard',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('sound')
        .setDescription('Bot soundboard')
        .addSubcommand((s) =>
          s
            .setName('play')
            .setDescription('Play a sound in your voice channel')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Upload a sound (max 5 MB)')
            .addStringOption((o) => o.setName('name').setDescription('Lowercase letters, numbers, - and _').setRequired(true).setMaxLength(32))
            .addAttachmentOption((o) => o.setName('file').setDescription('mp3, ogg, wav, m4a, opus, webm or flac').setRequired(true))
            .addStringOption((o) => o.setName('emoji').setDescription('Emoji shown on its button')),
        )
        .addSubcommand((s) =>
          s
            .setName('emoji')
            .setDescription('Set or clear the emoji on a sound’s button')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName('emoji').setDescription('Leave empty to clear')),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Delete a sound')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('volume')
            .setDescription('Set how loud one sound plays, for any that even volume doesn’t get right')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true))
            .addIntegerOption((o) => o.setName('percent').setDescription('100 is normal').setRequired(true).setMinValue(VOLUME_PERCENT[0]).setMaxValue(VOLUME_PERCENT[1])),
        )
        .addSubcommand((s) =>
          s
            .setName('join')
            .setDescription('Pick a sound that plays when you join voice')
            .addStringOption((o) => o.setName('name').setDescription('Leave empty to stop having one').setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('discord-add')
            .setDescription('Copy a sound into Discord’s own soundboard')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true))
            .addNumberOption((o) =>
              o.setName('start').setDescription(`For sounds over ${discordBoard.CLIP_SECONDS} s: second to start the clip at`).setMinValue(0),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('discord-remove')
            .setDescription('Take a sound out of Discord’s soundboard (the bot keeps it)')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('discord-sync').setDescription('Copy every short sound into Discord’s soundboard while there are free slots'))
        .addSubcommand((s) => s.setName('stop').setDescription('Stop playback and leave voice'))
        .addSubcommand((s) => s.setName('panel').setDescription('Post a soundboard panel in this channel; it updates itself as sounds change')),
      async autocomplete(i) {
        if (!i.guildId) return i.respond([]);
        const query = i.options.getFocused().toLowerCase();
        return i.respond(
          listSounds(i.guildId)
            .filter((s) => s.name.includes(query))
            .slice(0, 25)
            .map((s) => ({
              name: `${s.emoji && !s.emoji.startsWith('<') ? `${s.emoji} ` : ''}${s.name}${s.onDiscord ? ' (on Discord’s soundboard)' : ''}`,
              value: s.name,
            })),
        );
      },
      async run(i) {
        const ephemeral = { flags: MessageFlags.Ephemeral } as const;
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', ...ephemeral });
        const sub = i.options.getSubcommand();

        if (sub === 'play') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!i.member.voice.channel) return i.reply({ content: 'Join a voice channel first.', ...ephemeral });
          await i.deferReply(ephemeral);
          const problem = await play(i.member.voice.channel, sound.file, soundGain(i.guildId, sound.name));
          if (!problem) recordPlay(i.guildId, i.user.id, sound.name);
          return i.editReply(problem ?? `🔊 ${sound.name}`);
        }

        if (sub === 'add') {
          const name = i.options.getString('name', true).toLowerCase();
          const file = i.options.getAttachment('file', true);
          const emojiInput = i.options.getString('emoji');
          const ext = path.extname(file.name).toLowerCase();
          const problem = uploadProblem(name, ext, file.size);
          if (problem) return i.reply({ content: problem, ...ephemeral });
          const emoji = emojiInput ? await parseEmoji(i.guild, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.reply({ content: emoji.error, ...ephemeral });

          await i.deferReply();
          const res = await fetch(file.url, { signal: requestTimeout() });
          if (!res.ok) return i.editReply(`Download failed (HTTP ${res.status}).`);
          const added = await addSound(i.guild, name, ext, Buffer.from(await res.arrayBuffer()), emoji?.emoji);
          if (!added) return i.editReply(`**${file.name}** doesn’t have any audio I can read, so I didn’t save it.`);
          logActivity(i.guildId, i.user.id, `${added.replaced ? 'Replaced' : 'Added'} sound **${name}**`);
          const note = added.problem ? `\nBot soundboard only: ${added.problem}.` : '\n🟦 Also added to Discord’s soundboard.';
          await i.editReply(`${added.replaced ? '♻️ Replaced' : '➕ Added'} sound ${emoji ? emoji.emoji + ' ' : ''}**${name}**.${note}`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'emoji') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const emojiInput = i.options.getString('emoji');
          const emoji = emojiInput ? await parseEmoji(i.guild, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.reply({ content: emoji.error, ...ephemeral });
          await changeEmoji(i.guild, sound.name, emoji?.emoji ?? null);
          logActivity(i.guildId, i.user.id, emoji ? `Set the emoji on **${sound.name}**` : `Cleared the emoji on **${sound.name}**`);
          await i.reply({ content: emoji ? `${emoji.emoji} set on **${sound.name}**.` : `Cleared the emoji on **${sound.name}**.`, ...ephemeral });
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'remove') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const problem = await removeSound(i.guild, sound);
          logActivity(i.guildId, i.user.id, `Removed sound **${sound.name}**`);
          await i.reply(`🗑️ Removed sound **${sound.name}**.${problem ? `\nCouldn’t remove it from Discord’s soundboard: ${problem}.` : ''}`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'volume') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const percent = i.options.getInteger('percent', true);
          await i.deferReply(ephemeral);
          await setSoundVolume(i.guild, sound.name, percent);
          logActivity(i.guildId, i.user.id, `Set the volume of **${sound.name}** to ${percent}%`);
          return i.editReply(`🔉 **${sound.name}** plays at ${percent}% now.`);
        }

        if (sub === 'join') {
          const name = i.options.getString('name');
          if (!name) {
            setJoinSound(i.guildId, i.user.id, null);
            logActivity(i.guildId, i.user.id, 'Cleared their join sound');
            return i.reply({ content: 'You don’t have a join sound any more.', ...ephemeral });
          }
          const sound = findSound(i.guildId, name);
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          setJoinSound(i.guildId, i.user.id, sound.name);
          logActivity(i.guildId, i.user.id, `Set their join sound to **${sound.name}**`);
          const off = setting(i.guildId, 'joinSounds') ? '' : ' Join sounds are turned off in this server for now, so it won’t play until an admin turns them on.';
          return i.reply({ content: `🚪 **${sound.name}** plays when you join voice.${off}`, ...ephemeral });
        }

        if (sub === 'discord-add') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          await i.deferReply();
          const problem = await addToDiscord(i.guild, sound, i.options.getNumber('start') ?? undefined);
          if (problem) return i.editReply(`Couldn’t add **${sound.name}** to Discord’s soundboard: ${problem}.`);
          logActivity(i.guildId, i.user.id, `Added **${sound.name}** to Discord’s soundboard`);
          const { used, total } = await discordBoard.slots(i.guild);
          await i.editReply(`🟦 **${sound.name}** is on Discord’s soundboard (${used}/${total} slots used).`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-remove') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!sound.onDiscord) return i.reply({ content: `**${sound.name}** isn’t on Discord’s soundboard.`, ...ephemeral });
          await i.deferReply();
          await discordBoard.remove(i.guild, sound.name);
          logActivity(i.guildId, i.user.id, `Took **${sound.name}** off Discord’s soundboard`);
          const { used, total } = await discordBoard.slots(i.guild);
          await i.editReply(`Took **${sound.name}** off Discord’s soundboard; it’s still on the bot’s (${used}/${total} slots used).`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-sync') {
          await i.deferReply();
          const { added, tooLong, failed, waiting, blocker } = await syncToDiscord(i.guild);
          if (added.length) logActivity(i.guildId, i.user.id, `Copied ${added.length} sound${added.length === 1 ? '' : 's'} to Discord’s soundboard`);
          const { used, total } = await discordBoard.slots(i.guild);
          const lines = [
            added.length ? `🟦 Added to Discord’s soundboard: ${added.join(', ')}` : 'Nothing new to add to Discord’s soundboard.',
            blocker && `Stopped because ${blocker}. Still bot-only: ${waiting.join(', ')}`,
            tooLong.length && `Over ${discordBoard.CLIP_SECONDS} s, so bot-only unless you pick a part with \`/sound discord-add start:\`: ${tooLong.join(', ')}`,
            failed.length && `Failed: ${failed.join(', ')}`,
            `${used}/${total} Discord soundboard slots used.`,
          ];
          await i.editReply(lines.filter(Boolean).join('\n'));
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'stop') {
          leaveVoice(i.guildId);
          return i.reply({ content: '⏹️ Stopped.', ...ephemeral });
        }

        const reply = await i.reply({ ...panel(i.guildId, 0), withResponse: true });
        const message = reply.resource?.message;
        if (message) trackPanel(message.id, i.guildId, message.channelId, 0);
      },
    },
  ],
  async setup(client) {
    for (const guild of servedGuilds(client)) {
      await discordBoard.reconcile(guild).catch((err) => console.error(`Soundboard reconcile failed in ${guild.name}:`, err.message));
      dropMissingEmoji(guild);
      await refreshPanels(client, guild.id);
    }
    client.on(Events.GuildEmojiDelete, (emoji) => {
      if (isAllowed(emoji.guild.id) && dropMissingEmoji(emoji.guild)) void refreshPanels(client, emoji.guild.id);
    });
    client.on(Events.VoiceStateUpdate, (old, state) => {
      if (!isAllowed(state.guild.id)) return;
      leaveIfAlone(state.guild);
      void playJoinSound(old, state).catch(console.error);
    });
    client.on(Events.GuildSoundboardSoundDelete, (sound) => {
      if (discordBoard.forget(sound.soundId) && sound.guildId) void refreshPanels(client, sound.guildId);
    });
    // Not waited for: a whole library takes a while the first time, and nothing else depends on it
    void levelLibrary(client).catch(console.error);
  },
  shutdown() {
    for (const guildId of getVoiceConnections().keys()) leaveVoice(guildId);
  },
  componentPrefix: 'sb',
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    // Discord greys the button out until the click is acknowledged, so do that before anything else
    if (!i.customId.startsWith('sb:#') || i.customId === STOP) await i.deferUpdate();

    // Adopt panels posted before tracking existed, so they update on the next change too
    db.prepare('INSERT INTO sound_panels (message_id, guild_id, channel_id) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING').run(
      i.message.id,
      i.guildId,
      i.channelId,
    );

    if (i.customId === PREV || i.customId === NEXT) {
      const row = db.prepare('SELECT page FROM sound_panels WHERE message_id = ?').get(i.message.id) as { page: number };
      const pages = pageCount(listSounds(i.guildId));
      const page = (Math.min(row.page, pages - 1) + (i.customId === NEXT ? 1 : pages - 1)) % pages;
      trackPanel(i.message.id, i.guildId, i.channelId, page);
      return i.update(panel(i.guildId, page));
    }

    if (i.customId === STOP) return stopPlayback(i.guildId);

    const sound = findSound(i.guildId, i.customId.slice('sb:'.length));
    if (!sound) return i.followUp({ content: 'That sound was removed.', flags: MessageFlags.Ephemeral });
    if (!i.member.voice.channel) {
      return i.followUp({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    const problem = await play(i.member.voice.channel, sound.file, soundGain(i.guildId, sound.name));
    if (problem) return i.followUp({ content: problem, flags: MessageFlags.Ephemeral });
    recordPlay(i.guildId, i.user.id, sound.name);
  },
};
