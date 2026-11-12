import { type Client, type Guild } from 'discord.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { db } from '../db.ts';
import * as discordBoard from '../discordSounds.ts';
import { measureGain } from '../loudness.ts';
import { MIX_VOLUME } from '../mixer.ts';
import { setSetting, setting, storedSetting } from '../settings.ts';
import { cutAudio } from '../trim.ts';
import type { DiscordSound } from '../discordSounds.ts';
import { servedGuilds } from '../util.ts';
import { refreshLoopRoom } from './loopRoom.ts';

// The sound library: files on disk, loudness and volume, the bin, renaming, trimming, emoji, favourites, plays, and copies on Discord’s own soundboard

export const EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac'];

const MAX_BYTES = 5 * 1024 * 1024;

export const VOLUME = MIX_VOLUME;

const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

export const VOLUME_PERCENT = [25, 200] as const;

export const BIN_DAYS = 30;

export const DAY = 86_400_000;

const SHORTEST_TRIM = 0.1;

/** How far apart two times can be and still be the same moment, since the page rounds what it sends */
const TRIM_TOLERANCE = 0.05;

const CUSTOM_EMOJI = /^<a?:\w{2,32}:(\d{17,20})>$/;

const UNICODE_EMOJI = /^\p{RGI_Emoji}$/v;

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

/** Every trimmed sound's name, from one look at the folder */
export function trimmedSounds(guildId: string): Set<string> {
  const dir = originalsDir(guildId);
  return new Set(existsSync(dir) ? readdirSync(dir).map((f) => path.parse(f).name) : []);
}

/** A deleted sound's folder, inside the server's so its files can be moved rather than copied */
const binDir = (guildId: string, id: number) => path.join(soundDir(guildId), 'bin', String(id));

const audioIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).find((f) => EXTENSIONS.includes(path.extname(f).toLowerCase())) : undefined);

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
 * the old file once it's known to be good, so a bad upload can't cost the sound it was replacing. The sound it
 * replaces goes to the bin, so a replacement can be undone.
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
  // Its trim original goes with it, as restoring that now would bring back the wrong sound
  if (existing) moveToBin(guildId, existing);
  renameSync(upload, target);
  return true;
}

/** Why an upload can't be stored, or null if it can */
export function uploadProblem(name: string, ext: string, size: number): string | null {
  if (!NAME_PATTERN.test(name)) return 'Name can only use lowercase letters, numbers, - and _.';
  if (!EXTENSIONS.includes(ext)) return `Unsupported file type. Use one of: ${EXTENSIONS.join(', ')}`;
  return size > MAX_BYTES ? 'File is over 5 MB.' : null;
}

/** A sound name made from a file's name, for an upload that didn't give one: "Air Horn (1).mp3" → air-horn-1 */
export function nameFromFile(fileName: string): string {
  const name = path
    .parse(fileName)
    .name.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return name || 'sound';
}

/** Each sound's measured gain and picked volume, by name */
export function soundLevels(guildId: string): Map<string, { gainDb: number | null; percent: number }> {
  const rows = db.prepare('SELECT name, gain_db, percent FROM sound_levels WHERE guild_id = ?').all(guildId) as { name: string; gain_db: number | null; percent: number }[];
  return new Map(rows.map((r) => [r.name, { gainDb: r.gain_db, percent: r.percent }]));
}

const gainOf = (level: { gainDb: number | null; percent: number } | undefined, even: boolean) => 10 ** ((even ? (level?.gainDb ?? 0) : 0) / 20) * ((level?.percent ?? 100) / 100);

/** What a sound's samples get multiplied by. The file itself is never changed, so all of this can be undone */
export function soundGain(guildId: string, name: string): number {
  return gainOf(soundLevels(guildId).get(name), setting(guildId, 'evenVolume'));
}

/** voiceVolume and discordVolume for any of a server's sounds, reading the levels once rather than once per sound */
export function soundVolumes(guildId: string) {
  const levels = soundLevels(guildId);
  const even = setting(guildId, 'evenVolume');
  return (name: string) => {
    const loudness = VOLUME * gainOf(levels.get(name), even);
    return { loudness, volume: Math.min(1, Math.round(loudness * 100) / 100) };
  };
}

/** Discord's own volume for a sound's copy. It can't go over 1, so that's as far as it can be turned up there */
export const discordVolume = (guildId: string, name: string) => soundVolumes(guildId)(name).volume;

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

/** Returns its id in the bin */
function moveToBin(guildId: string, sound: Sound): number {
  const level = soundLevels(guildId).get(sound.name);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO deleted_sounds (guild_id, name, emoji, favourite, gain_db, percent, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(guildId, sound.name, sound.emoji ?? null, favourites(guildId).has(sound.name) ? 1 : 0, level?.gainDb ?? null, level?.percent ?? 100, Date.now());
  const dir = binDir(guildId, Number(lastInsertRowid));
  mkdirSync(path.join(dir, 'originals'), { recursive: true });
  const original = originalOf(guildId, sound.name);
  if (original) renameSync(original, path.join(dir, 'originals', path.basename(original)));
  renameSync(sound.file, path.join(dir, path.basename(sound.file)));
  return Number(lastInsertRowid);
}

export interface DeletedSound {
  id: number;
  name: string;
  emoji: string | null;
  favourite: number;
  gain_db: number | null;
  percent: number;
  deleted_at: number;
}

/** What's in the bin, newest first */
export function deletedSounds(guildId: string): DeletedSound[] {
  return db.prepare('SELECT id, name, emoji, favourite, gain_db, percent, deleted_at FROM deleted_sounds WHERE guild_id = ? ORDER BY deleted_at DESC, id DESC').all(guildId) as unknown as DeletedSound[];
}

export const expiresAt = (sound: DeletedSound) => sound.deleted_at + BIN_DAYS * DAY;

/** Empties one place in the bin for good. Returns whether there was anything there */
export function eraseDeleted(guildId: string, id: number): boolean {
  const { changes } = db.prepare('DELETE FROM deleted_sounds WHERE guild_id = ? AND id = ?').run(guildId, id);
  if (changes) rmSync(binDir(guildId, id), { recursive: true, force: true });
  return changes > 0;
}

/** Erases whatever has been in the bin too long */
export function clearBin(now = Date.now()) {
  const old = db.prepare('SELECT guild_id, id FROM deleted_sounds WHERE deleted_at <= ?').all(now - BIN_DAYS * DAY) as { guild_id: string; id: number }[];
  for (const { guild_id, id } of old) eraseDeleted(guild_id, id);
}

/** A name no sound is using: this one, or this one numbered */
export function untaken(guildId: string, base: string) {
  const taken = new Set(listSounds(guildId).map((s) => s.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
  return name;
}

/**
 * Puts a deleted sound back in the library and returns the name it came back with, or null if it's gone. It
 * stays off Discord's soundboard, as its slot may be in use by now.
 */
export function restoreDeleted(guildId: string, id: number): string | null {
  const sound = deletedSounds(guildId).find((s) => s.id === id);
  if (!sound) return null;
  const dir = binDir(guildId, id);
  const file = audioIn(dir);
  if (!file) {
    eraseDeleted(guildId, id);
    return null;
  }
  const name = untaken(guildId, sound.name);
  const original = audioIn(path.join(dir, 'originals'));
  if (original) {
    mkdirSync(originalsDir(guildId), { recursive: true });
    renameSync(path.join(dir, 'originals', original), path.join(originalsDir(guildId), `${name}${path.extname(original)}`));
  }
  renameSync(path.join(dir, file), path.join(soundDir(guildId), `${name}${path.extname(file)}`));
  setEmoji(guildId, name, sound.emoji);
  setFavourite(guildId, name, sound.favourite === 1);
  db.prepare('INSERT OR REPLACE INTO sound_levels (guild_id, name, gain_db, percent) VALUES (?, ?, ?, ?)').run(guildId, name, sound.gain_db, sound.percent);
  eraseDeleted(guildId, id);
  return name;
}

/** Moves a sound to the bin. Returns its id there, and why it couldn't come off Discord's soundboard if it couldn't */
export async function removeSound(guild: Guild, sound: Sound): Promise<{ problem: string | null; binId: number }> {
  const problem = await discordBoard.remove(guild, sound.name).then(
    () => null,
    (err: Error) => err.message,
  );
  // Whatever's still on Discord is no longer this sound
  if (problem) discordBoard.forget(discordBoard.synced(guild.id).get(sound.name)!);
  const binId = moveToBin(guild.id, sound);
  setEmoji(guild.id, sound.name, null);
  setFavourite(guild.id, sound.name, false);
  db.prepare('DELETE FROM sound_levels WHERE guild_id = ? AND name = ?').run(guild.id, sound.name);
  db.prepare('DELETE FROM join_sounds WHERE guild_id = ? AND name = ?').run(guild.id, sound.name);
  if (storedSetting(guild.id, 'loopIntro') === sound.name) setSetting(guild.id, 'loopIntro', '');
  if (storedSetting(guild.id, 'loopSound') === sound.name) {
    setSetting(guild.id, 'loopSound', '');
    await refreshLoopRoom(guild);
  }
  return { problem, binId };
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
  if (storedSetting(guild.id, 'loopSound') === sound.name) setSetting(guild.id, 'loopSound', name);
  if (storedSetting(guild.id, 'loopIntro') === sound.name) setSetting(guild.id, 'loopIntro', name);
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

/** A library name for a Discord sound, which can be called anything, that no sound is using */
function freeName(guildId: string, sound: DiscordSound) {
  const cleaned = sound.name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const base = cleaned.length >= 2 ? cleaned : `sound-${sound.id.slice(-6)}`;
  return untaken(guildId, base);
}

/** Copies a Discord sound into the library and links the two. Returns the name it's under. Throws if it couldn't, changing nothing */
export async function saveFromDiscord(guild: Guild, sound: DiscordSound): Promise<string> {
  if (sound.library) return sound.library;
  const name = freeName(guild.id, sound);
  const { data, ext } = await discordBoard.download(sound);
  if (!(await addSound(guild, name, ext, data, sound.emoji ?? undefined, false))) throw new Error(`Discord’s copy of ${sound.name} couldn’t be read`);
  discordBoard.link(guild.id, name, sound.id);
  return name;
}

/** Frees a sound's slot, saving it to the library first so it can't be lost. Returns its library name */
export async function takeOffDiscord(guild: Guild, sound: DiscordSound): Promise<string> {
  const name = await saveFromDiscord(guild, sound);
  await discordBoard.remove(guild, name);
  return name;
}

/** Puts a library sound in another's slot. Returns why it couldn't, with the old sound back in place */
export async function swapOnDiscord(guild: Guild, outgoing: DiscordSound, sound: Sound, start?: number): Promise<string | null> {
  if (sound.onDiscord) return `${sound.name} is already on Discord’s soundboard.`;
  const problem = await discordBoard.uploadProblem(sound, start);
  if (problem) return problem;
  const name = await saveFromDiscord(guild, outgoing);
  await discordBoard.remove(guild, name);
  const failed = await addToDiscord(guild, sound, start);
  if (!failed) return null;
  const stuck = await addToDiscord(guild, findSound(guild.id, name)!);
  return stuck ? `${failed}, and ${name} couldn’t go back on, but it’s safe in the library` : failed;
}

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

/**
 * Counts a sound someone played from Discord's own soundboard, which Discord only reports in the voice channel the bot is
 * in. Under its library name when it's a copy of a library sound, otherwise under its name on Discord
 */
export function recordDiscordPlay(guild: Guild, userId: string, soundId: string) {
  if (userId === guild.client.user.id || guild.members.cache.get(userId)?.user.bot) return;
  const library = [...discordBoard.synced(guild.id)].find(([, id]) => id === soundId)?.[0];
  // Discord's built-in sounds aren't in the server's soundboard, and have no name to count them under
  const name = library ?? guild.soundboardSounds.cache.get(soundId)?.name;
  if (name) recordPlay(guild.id, userId, name);
}

/** For the monthly recap */
export function recordPlay(guildId: string, userId: string, name: string) {
  db.prepare('INSERT INTO sound_plays (guild_id, user_id, name, played_at) VALUES (?, ?, ?, ?)').run(guildId, userId, name, Date.now());
}
