import { DiscordAPIError, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db.ts';

// Discord caps server soundboard sounds at 5.2 s and 512 KB; clips are cut a little short so mp3 padding can't push them over
const MAX_SECONDS = 5.2;
export const CLIP_SECONDS = 5;
const MAX_BYTES = 512 * 1024;
const SLOTS_BY_TIER = [8, 24, 36, 48];
const CUSTOM_EMOJI = /^<a?:\w+:(\d+)>$/;

const exec = promisify(execFile);

export interface SyncSound {
  name: string;
  file: string;
  emoji?: string;
}

/** Bot sound name → id of its copy in the server's Discord soundboard */
export function synced(): Map<string, string> {
  const rows = db.prepare('SELECT name, sound_id FROM discord_sounds').all() as { name: string; sound_id: string }[];
  return new Map(rows.map((r) => [r.name, r.sound_id]));
}

export async function durationOf(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

export async function slots(guild: Guild): Promise<{ used: number; total: number }> {
  const sounds = await guild.soundboardSounds.fetch();
  return { used: sounds.size, total: SLOTS_BY_TIER[guild.premiumTier] ?? SLOTS_BY_TIER[0] };
}

function emojiFields(emoji: string | undefined | null) {
  if (!emoji) return { emojiId: null, emojiName: null };
  const custom = CUSTOM_EMOJI.exec(emoji);
  return custom ? { emojiId: custom[1], emojiName: null } : { emojiId: null, emojiName: emoji };
}

export const FULL = 'Discord’s soundboard is full';
export const NO_PERMISSION = 'the bot’s role needs the Create Expressions permission';

export const fits = (seconds: number) => seconds <= MAX_SECONDS;

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

/**
 * Copies a sound into the server's Discord soundboard, replacing any earlier copy.
 * Returns null on success or the reason it couldn't be added.
 */
export async function upload(guild: Guild, sound: SyncSound, volume: number, start?: number): Promise<string | null> {
  if (sound.name.length < 2) return 'Discord needs names of at least 2 characters';
  try {
    const length = await durationOf(sound.file);
    if (start === undefined && !fits(length)) {
      return `it’s ${length.toFixed(1)} s long and Discord allows ${CLIP_SECONDS} s; use \`/sound discord-add\` with \`start:\` to pick a part`;
    }
    if (start !== undefined && start >= length) return `it’s only ${length.toFixed(1)} s long`;

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
    db.prepare('INSERT INTO discord_sounds (name, sound_id) VALUES (?, ?)').run(sound.name, created.soundId);
    return null;
  } catch (err) {
    return explain(err);
  }
}

/** Takes a sound out of the Discord soundboard; the bot keeps its own copy */
export async function remove(guild: Guild, name: string) {
  const id = synced().get(name);
  if (!id) return;
  try {
    await guild.soundboardSounds.delete(id);
  } catch (err) {
    // Someone may have deleted it in Discord already
    if (!(err instanceof DiscordAPIError && err.status === 404)) throw new Error(explain(err));
  }
  forget(id);
}

export async function setEmoji(guild: Guild, name: string, emoji: string | null) {
  const id = synced().get(name);
  if (id) await guild.soundboardSounds.edit(id, emojiFields(emoji)).catch((err) => console.error(`Soundboard emoji sync for ${name} failed:`, explain(err)));
}

/** Drops the mapping for a Discord sound that no longer exists. Returns whether one was dropped */
export function forget(soundId: string): boolean {
  return db.prepare('DELETE FROM discord_sounds WHERE sound_id = ?').run(soundId).changes > 0;
}

/** Forgets copies deleted from Discord while the bot wasn't watching */
export async function reconcile(guild: Guild) {
  const live = await guild.soundboardSounds.fetch();
  for (const id of synced().values()) if (!live.has(id)) forget(id);
}
