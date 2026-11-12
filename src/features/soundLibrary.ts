import { type Client, type Guild } from 'discord.js';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { db, transaction } from '../db.ts';
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
  // Where it was: which group, and how many sounds were ahead of it there
  const group = soundGroups(guildId).find((g) => g.sounds.includes(sound.name));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO deleted_sounds (guild_id, name, emoji, favourite, gain_db, percent, deleted_at, group_id, place) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)')
    .run(guildId, sound.name, sound.emoji ?? null, level?.gainDb ?? null, level?.percent ?? 100, Date.now(), group?.id ?? null, group ? group.sounds.indexOf(sound.name) : null);
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
  /** From before groups: whether it was starred */
  favourite: number;
  group_id: number | null;
  place: number | null;
  gain_db: number | null;
  percent: number;
  deleted_at: number;
}

/** What's in the bin, newest first */
export function deletedSounds(guildId: string): DeletedSound[] {
  return db
    .prepare('SELECT id, name, emoji, favourite, group_id, place, gain_db, percent, deleted_at FROM deleted_sounds WHERE guild_id = ? ORDER BY deleted_at DESC, id DESC')
    .all(guildId) as unknown as DeletedSound[];
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
  // Back where it was in its group, if the group's still there, with as many ahead of it as there were
  const group = sound.group_id === null ? undefined : soundGroups(guildId).find((g) => g.id === sound.group_id);
  if (group) placeSound(guildId, name, group.id, group.sounds[sound.place ?? group.sounds.length] ?? null);
  else if (sound.favourite === 1) setFavourite(guildId, name, true);
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
  placeSound(guild.id, sound.name, null);
  db.prepare('DELETE FROM sound_levels WHERE guild_id = ? AND name = ?').run(guild.id, sound.name);
  db.prepare('DELETE FROM join_sounds WHERE guild_id = ? AND name = ?').run(guild.id, sound.name);
  if (storedSetting(guild.id, 'loopIntro') === sound.name) setSetting(guild.id, 'loopIntro', '');
  if (storedSetting(guild.id, 'loopSound') === sound.name) {
    setSetting(guild.id, 'loopSound', '');
    await refreshLoopRoom(guild);
  }
  return { problem, binId };
}

// ---------- groups and order ----------

export const FAVOURITES = 'Favourites';
/** What the sounds in no group are called, which a group can't be */
export const EVERYTHING_ELSE = 'Everything else';
const GROUP_NAME_MAX = 40;

export interface SoundGroup {
  id: number;
  name: string;
  /** Its sounds in their order, only those still in the library */
  sounds: string[];
}

/** The server's groups in their order, each with its sounds in order */
export function soundGroups(guildId: string, names = new Set(listSounds(guildId).map((s) => s.name))): SoundGroup[] {
  const groups = db.prepare('SELECT id, name FROM sound_groups WHERE guild_id = ? ORDER BY pos, id').all(guildId) as { id: number; name: string }[];
  const places = db.prepare('SELECT name, group_id FROM sound_places WHERE guild_id = ? ORDER BY pos, name').all(guildId) as { name: string; group_id: number }[];
  return groups.map((g) => ({ ...g, sounds: places.filter((p) => p.group_id === g.id && names.has(p.name)).map((p) => p.name) }));
}

/** Every sound in the order people see them: the groups' in theirs, then the rest most played first */
export function orderedSounds(guildId: string): Sound[] {
  const sounds = listSounds(guildId);
  const byName = new Map(sounds.map((s) => [s.name, s]));
  const grouped = soundGroups(guildId, new Set(byName.keys())).flatMap((g) => g.sounds);
  const placed = new Set(grouped);
  const plays = playCounts(guildId);
  const rest = sounds.filter((s) => !placed.has(s.name)).sort((a, b) => (plays.get(b.name) ?? 0) - (plays.get(a.name) ?? 0) || a.name.localeCompare(b.name));
  return [...grouped.map((name) => byName.get(name)!), ...rest];
}

const groupOf = (guildId: string, id: number) => db.prepare('SELECT id, name FROM sound_groups WHERE guild_id = ? AND id = ?').get(guildId, id) as { id: number; name: string } | undefined;

/** Why a group can't have this name, or null if it can */
function groupNameProblem(guildId: string, name: string, except?: number): string | null {
  if (!name) return 'Give the group a name.';
  if (name.length > GROUP_NAME_MAX) return `Group names can be up to ${GROUP_NAME_MAX} characters.`;
  if (name.toLowerCase() === EVERYTHING_ELSE.toLowerCase()) return `“${EVERYTHING_ELSE}” is where sounds in no group go. Pick another name.`;
  const taken = db.prepare('SELECT id FROM sound_groups WHERE guild_id = ? AND lower(name) = lower(?)').get(guildId, name) as { id: number } | undefined;
  return taken && taken.id !== except ? `There’s already a group called ${name}.` : null;
}

/** Makes a group, at the top or after the others. Returns it, or why it couldn't */
export function addGroup(guildId: string, name: string, top = false): { id: number } | { error: string } {
  name = name.trim().replace(/\s+/g, ' ');
  const problem = groupNameProblem(guildId, name);
  if (problem) return { error: problem };
  const ends = db.prepare('SELECT MIN(pos) AS first, MAX(pos) AS last FROM sound_groups WHERE guild_id = ?').get(guildId) as { first: number | null; last: number | null };
  const pos = top ? (ends.first ?? 1) - 1 : (ends.last ?? -1) + 1;
  const { lastInsertRowid } = db.prepare('INSERT INTO sound_groups (guild_id, name, pos) VALUES (?, ?, ?)').run(guildId, name, pos);
  return { id: Number(lastInsertRowid) };
}

/** Renames a group. Returns null, or why it couldn't */
export function renameGroup(guildId: string, id: number, name: string): string | null {
  name = name.trim().replace(/\s+/g, ' ');
  if (!groupOf(guildId, id)) return 'That group is gone.';
  const problem = groupNameProblem(guildId, name, id);
  if (problem) return problem;
  db.prepare('UPDATE sound_groups SET name = ? WHERE id = ?').run(name, id);
  return null;
}

/** Moves a group to a place among the others. Returns whether it's there */
export function moveGroup(guildId: string, id: number, to: number): boolean {
  const ids = (db.prepare('SELECT id FROM sound_groups WHERE guild_id = ? ORDER BY pos, id').all(guildId) as { id: number }[]).map((g) => g.id);
  const from = ids.indexOf(id);
  if (from < 0) return false;
  ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(ids.length, Math.trunc(to))), 0, id);
  const update = db.prepare('UPDATE sound_groups SET pos = ? WHERE id = ?');
  transaction(() => ids.forEach((g, i) => update.run(i, g)));
  return true;
}

/** Deletes a group, its sounds going back among the rest. Returns its name and sounds, to put it back, or null if it's gone */
export function deleteGroup(guildId: string, id: number): SoundGroup | null {
  const group = soundGroups(guildId).find((g) => g.id === id);
  if (!group) return null;
  transaction(() => {
    db.prepare('DELETE FROM sound_places WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM sound_groups WHERE id = ?').run(id);
  });
  return group;
}

/**
 * Puts a sound in a group, before another of its sounds or at the end, or with `groupId` null, back among the sounds in no group.
 * Returns null, or why it couldn't
 */
export function placeSound(guildId: string, name: string, groupId: number | null, before: string | null = null): string | null {
  if (groupId === null) {
    db.prepare('DELETE FROM sound_places WHERE guild_id = ? AND name = ?').run(guildId, name);
    return null;
  }
  if (!groupOf(guildId, groupId)) return 'That group is gone.';
  const others = (db.prepare('SELECT name FROM sound_places WHERE group_id = ? ORDER BY pos, name').all(groupId) as { name: string }[]).map((p) => p.name).filter((n) => n !== name);
  const at = before === null ? -1 : others.indexOf(before);
  others.splice(at < 0 ? others.length : at, 0, name);
  const put = db.prepare('INSERT INTO sound_places (guild_id, name, group_id, pos) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET group_id = excluded.group_id, pos = excluded.pos');
  transaction(() => others.forEach((n, i) => put.run(guildId, n, groupId, i)));
  return null;
}

/** Where a sound is: its group and place in it, or null in none */
function placeOf(guildId: string, name: string) {
  return (db.prepare('SELECT group_id, pos FROM sound_places WHERE guild_id = ? AND name = ?').get(guildId, name) as { group_id: number; pos: number } | undefined) ?? null;
}

/** Puts sounds at the end of a group, in order, leaving out any put in another group since: for undoing a group's deletion */
export function fillGroup(guildId: string, id: number, names: string[]) {
  const free = new Set(listSounds(guildId).map((s) => s.name));
  for (const g of soundGroups(guildId)) for (const name of g.sounds) free.delete(name);
  transaction(() => {
    for (const name of names) if (free.has(name)) placeSound(guildId, name, id);
  });
}

const favouritesGroup = (guildId: string) => db.prepare('SELECT id FROM sound_groups WHERE guild_id = ? AND lower(name) = lower(?)').get(guildId, FAVOURITES) as { id: number } | undefined;

/** The sounds in the Favourites group, which the star on the web UI's soundboard puts sounds in */
export function favourites(guildId: string): Set<string> {
  const group = favouritesGroup(guildId);
  if (!group) return new Set();
  return new Set((db.prepare('SELECT name FROM sound_places WHERE group_id = ?').all(group.id) as { name: string }[]).map((r) => r.name));
}

/** Starring puts a sound at the end of Favourites, made at the top if there isn't one; unstarring takes it out */
export function setFavourite(guildId: string, name: string, on: boolean) {
  const group = favouritesGroup(guildId);
  if (!on) {
    if (group) db.prepare('DELETE FROM sound_places WHERE group_id = ? AND name = ?').run(group.id, name);
    return;
  }
  if (group && placeOf(guildId, name)?.group_id === group.id) return;
  const id = group?.id ?? (addGroup(guildId, FAVOURITES, true) as { id: number }).id;
  placeSound(guildId, name, id);
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
  db.prepare('UPDATE OR REPLACE sound_places SET name = ? WHERE guild_id = ? AND name = ?').run(name, guild.id, sound.name);
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
