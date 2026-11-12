import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { feeds } from './changes.ts';
import { db } from './db.ts';

// Discord caps server soundboard sounds at 5.2 s and 512 KB; clips are cut a little short so mp3 padding can't push them over
const MAX_SECONDS = 5.2;
export const CLIP_SECONDS = 5;
const MAX_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const SLOTS_BY_TIER = [8, 24, 36, 48];
const CUSTOM_EMOJI = /^<a?:\w+:(\d+)>$/;

const exec = promisify(execFile);

export interface SyncSound {
  name: string;
  file: string;
  emoji?: string;
}

/** Bot sound name → id of its copy in the server's Discord soundboard */
export function synced(guildId: string): Map<string, string> {
  const rows = db.prepare('SELECT name, sound_id FROM discord_sounds WHERE guild_id = ?').all(guildId) as { name: string; sound_id: string }[];
  return new Map(rows.map((r) => [r.name, r.sound_id]));
}

export async function durationOf(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

/** Whether ffprobe finds audio in a file, so an upload that only has the right extension can be turned down */
export async function hasAudio(file: string): Promise<boolean> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    return stdout.includes('audio');
  } catch {
    return false;
  }
}

/** A file's title, artist and album, from its tags as far as ffprobe reads them, for an upload to be named by */
export async function tagsOf(file: string): Promise<{ title?: string; artist?: string; album?: string }> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', file], { maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout) as { format?: { tags?: Record<string, unknown> }; streams?: { tags?: Record<string, unknown> }[] };
    // MP3s keep them on the file, Ogg and Opus on the stream, in either case
    const sets = [info.format?.tags, ...(info.streams ?? []).map((s) => s.tags)].filter((t): t is Record<string, unknown> => !!t);
    const pick = (key: string) => {
      for (const tags of sets)
        for (const [k, v] of Object.entries(tags)) {
          const text = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '';
          if (k.toLowerCase() === key && text) return text;
        }
      return undefined;
    };
    return { title: pick('title'), artist: pick('artist'), album: pick('album') };
  } catch {
    return {};
  }
}

/** A sound on the server's Discord soundboard, whoever added it */
export interface DiscordSound {
  id: string;
  name: string;
  emoji: string | null;
  volume: number;
  url: string;
  /** Saved in the library under this name, if it is */
  library: string | null;
  removable: boolean;
}

// The gateway keeps discord.js's copy of each server's soundboard current, so it's only fetched again now and then,
// in case an event went missing over a reconnect
const REFETCH_MS = 5 * 60_000;
const fetchedAt = new Map<string, number>();

async function liveSounds(guild: Guild, now = Date.now()) {
  if (now - (fetchedAt.get(guild.id) ?? -Infinity) < REFETCH_MS) return guild.soundboardSounds.cache;
  const live = await guild.soundboardSounds.fetch();
  fetchedAt.set(guild.id, now);
  return live;
}

/** What's on the server's Discord soundboard and how many slots it has */
export async function board(guild: Guild): Promise<{ used: number; total: number; sounds: DiscordSound[] }> {
  const live = await liveSounds(guild);
  const saved = new Map([...synced(guild.id)].map(([name, id]) => [id, name]));
  const canManage = guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions) ?? false;
  const sounds = [...live].map(([id, s]) => ({
    id,
    name: s.name ?? id,
    // Custom emoji can only be shown if they're this server's
    emoji: s.emoji?.id ? (guild.emojis.cache.get(s.emoji.id)?.toString() ?? null) : (s.emoji?.name ?? null),
    volume: s.volume ?? 1,
    url: s.url,
    library: saved.get(id) ?? null,
    // Discord doesn't always say who added a sound, so one with nobody named is worth trying
    removable: canManage || !s.user || s.user.id === guild.client.user.id,
  }));
  return { used: live.size, total: SLOTS_BY_TIER[guild.premiumTier] ?? SLOTS_BY_TIER[0], sounds };
}

/** Downloads a sound's audio from Discord, with the extension to save it under */
export async function download(sound: DiscordSound): Promise<{ data: Buffer; ext: string }> {
  const res = await fetch(sound.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Discord wouldn’t hand over ${sound.name}`);
  const type = res.headers.get('content-type') ?? '';
  return { data: Buffer.from(await res.arrayBuffer()), ext: type.includes('ogg') ? '.ogg' : '.mp3' };
}

/** The web UI's Soundboard tab shows which sounds are on Discord, so every change to these links tells it */
const linksChanged = (guildId: string) => feeds.sounds.changed(guildId);

/** Ties a library sound to a copy already on Discord */
export function link(guildId: string, name: string, soundId: string) {
  db.prepare('INSERT OR REPLACE INTO discord_sounds (guild_id, name, sound_id) VALUES (?, ?, ?)').run(guildId, name, soundId);
  linksChanged(guildId);
}

function emojiFields(emoji: string | undefined | null) {
  if (!emoji) return { emojiId: null, emojiName: null };
  const custom = CUSTOM_EMOJI.exec(emoji);
  return custom ? { emojiId: custom[1], emojiName: null } : { emojiId: null, emojiName: emoji };
}

export const FULL = 'Discord’s soundboard is full';
export const NO_PERMISSION = 'the bot’s role needs the Create Expressions permission';
export const NO_MANAGE = 'the bot’s role needs the Manage Expressions permission to change sounds it didn’t add';

export const fits = (seconds: number) => seconds <= MAX_SECONDS;

/** The way to add a long sound from Discord, which the web UI swaps for its own */
export const PICK_A_PART = `use \`/sound discord-add\` with \`start:\` to pick a part`;

/** The same, for changing or removing a sound that's already there, which may be someone else's */
const explainChange = (err: unknown) => {
  const why = explain(err);
  return why === NO_PERMISSION ? NO_MANAGE : why;
};

function explain(err: unknown): string {
  if (err instanceof DiscordAPIError) {
    if (err.code === RESTJSONErrorCodes.MaximumNumberOfSoundboardSoundsReached) return FULL;
    if (err.code === RESTJSONErrorCodes.MissingPermissions) return NO_PERMISSION;
    return err.message;
  }
  // execFile failures carry ffmpeg's stderr; the full dump isn't useful in a Discord reply
  if (err instanceof Error && 'stderr' in err) {
    console.error('ffmpeg/ffprobe failed:', err.message);
    return 'ffmpeg couldn’t read the audio file';
  }
  return err instanceof Error ? err.message : String(err);
}

/** Why a sound can't go on Discord's soundboard as asked, or null if it can */
export async function uploadProblem(sound: SyncSound, start?: number): Promise<string | null> {
  if (sound.name.length < 2) return 'Discord needs names of at least 2 characters';
  try {
    const length = await durationOf(sound.file);
    if (start === undefined && !fits(length)) {
      return `it’s ${length.toFixed(1)} s long and Discord allows ${CLIP_SECONDS} s; ${PICK_A_PART}`;
    }
    return start !== undefined && start >= length ? `it’s only ${length.toFixed(1)} s long` : null;
  } catch (err) {
    return explain(err);
  }
}

/**
 * Copies a sound into the server's Discord soundboard, replacing any earlier copy.
 * Returns null on success or the reason it couldn't be added.
 */
export async function upload(guild: Guild, sound: SyncSound, volume: number, start?: number): Promise<string | null> {
  const problem = await uploadProblem(sound, start);
  if (problem) return problem;
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start ?? 0), '-t', String(CLIP_SECONDS), '-i', sound.file];
    const { stdout: clip } = await exec('ffmpeg', [...args, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], {
      encoding: 'buffer',
      maxBuffer: 4 * MAX_BYTES,
    });
    if (clip.length > MAX_BYTES) return 'the converted clip is over Discord’s 512 KB limit';

    await remove(guild, sound.name);
    const { emojiId, emojiName } = emojiFields(sound.emoji);
    const created = await guild.soundboardSounds.create({
      file: clip,
      contentType: 'audio/mpeg',
      name: sound.name,
      volume,
      emojiId: emojiId ?? undefined,
      emojiName: emojiName ?? undefined,
    });
    link(guild.id, sound.name, created.soundId);
    return null;
  } catch (err) {
    return explain(err);
  }
}

/** Takes a sound out of the Discord soundboard; the bot keeps its own copy */
export async function remove(guild: Guild, name: string) {
  const id = synced(guild.id).get(name);
  if (!id) return;
  try {
    await guild.soundboardSounds.delete(id);
    // Gone now, without waiting for the gateway to say so
    guild.soundboardSounds.cache.delete(id);
  } catch (err) {
    // Someone may have deleted it in Discord already
    if (!(err instanceof DiscordAPIError && err.status === 404)) throw new Error(explainChange(err));
  }
  forget(id);
}

/** Renames a sound's copy on Discord's soundboard, if it has one. Returns null on success or the reason it couldn't */
export async function rename(guild: Guild, name: string, newName: string): Promise<string | null> {
  const id = synced(guild.id).get(name);
  if (!id) return null;
  if (newName.length < 2) return 'Discord needs names of at least 2 characters';
  try {
    await guild.soundboardSounds.edit(id, { name: newName });
  } catch (err) {
    // Someone may have deleted it in Discord already
    if (err instanceof DiscordAPIError && err.status === 404) {
      forget(id);
      return null;
    }
    return explainChange(err);
  }
  db.prepare('UPDATE OR REPLACE discord_sounds SET name = ? WHERE sound_id = ?').run(newName, id);
  linksChanged(guild.id);
  return null;
}

export async function setEmoji(guild: Guild, name: string, emoji: string | null) {
  const id = synced(guild.id).get(name);
  if (id) await guild.soundboardSounds.edit(id, emojiFields(emoji)).catch((err) => console.error(`Soundboard emoji sync for ${name} failed:`, explain(err)));
}

/** Sets the volume of a sound's copy on Discord's soundboard, if it has one, leaving the clip as it is */
export async function setVolume(guild: Guild, name: string, volume: number) {
  const id = synced(guild.id).get(name);
  if (id) await guild.soundboardSounds.edit(id, { volume }).catch((err) => console.error(`Soundboard volume sync for ${name} failed:`, explain(err)));
}

/** Drops the mapping for a Discord sound that no longer exists. Returns whether one was dropped */
export function forget(soundId: string): boolean {
  const gone = db.prepare('DELETE FROM discord_sounds WHERE sound_id = ? RETURNING guild_id').all(soundId) as { guild_id: string }[];
  for (const { guild_id: guildId } of gone) linksChanged(guildId);
  return gone.length > 0;
}

/** Forgets copies deleted from Discord while the bot wasn't watching */
export async function reconcile(guild: Guild) {
  const live = await guild.soundboardSounds.fetch();
  fetchedAt.set(guild.id, Date.now());
  for (const id of synced(guild.id).values()) if (!live.has(id)) forget(id);
}
