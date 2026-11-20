import { type Guild } from 'discord.js';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { config } from '../config.ts';
import { db, getKv, setKv } from '../db.ts';
import { activeProfile } from './chatProfiles.ts';

/**
 * Profiles' photos, and the bot taking on its profile's photo in each server. Discord lets a bot have a photo of its own
 * in each server, over its main one, so each server shows its own profile's, and a profile without one shows the bot's
 * own. Kept apart from the profiles' rows, so the Robot butler can have one without counting as changed
 */

db.exec(`
  -- A profile's photo: a 512 px square PNG in DATA_DIR/profile-photos, named after the profile, and a hash of it
  CREATE TABLE IF NOT EXISTS profile_photos (
    profile_id TEXT PRIMARY KEY,
    hash TEXT NOT NULL
  );
`);

/** The most a photo can be as it's sent, which is the web UI's most for any request */
export const MOST_PHOTO_BYTES = 5 * 1024 * 1024;
const SIZE = 512;
const exec = promisify(execFile);
const folder = () => path.join(config.dataDir, 'profile-photos');
export const photoFile = (profileId: string) => path.join(folder(), `${profileId}.png`);

/** The hash of a profile's photo, or '' for none */
export const photoOf = (profileId: string): string =>
  (db.prepare('SELECT hash FROM profile_photos WHERE profile_id = ?').get(profileId) as { hash: string } | undefined)?.hash ?? '';

/** Every profile's photo hash, for listing them */
export const photos = () => new Map((db.prepare('SELECT profile_id, hash FROM profile_photos').all() as { profile_id: string; hash: string }[]).map((r) => [r.profile_id, r.hash]));

/** PNG, JPEG, GIF or WebP, from their first bytes */
function isImage(bytes: Buffer) {
  const starts = (text: string, at = 0) => bytes.subarray(at, at + text.length).toString('latin1') === text;
  return starts('\x89PNG') || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) || starts('GIF8') || (starts('RIFF') && starts('WEBP', 8));
}

/**
 * Makes `bytes` a profile's photo: the middle square, at 512 px, as a PNG. A GIF's first frame. Why not, if it can't be,
 * otherwise null
 */
export async function savePhoto(profileId: string, bytes: Buffer): Promise<string | null> {
  if (bytes.length > MOST_PHOTO_BYTES) return 'Pick an image of up to 5 MB.';
  if (!isImage(bytes)) return 'Pick a PNG, JPEG, GIF or WebP image.';
  mkdirSync(folder(), { recursive: true });
  // Apart from another upload to the same profile at the same time
  const stem = path.join(folder(), `.${profileId}.${randomBytes(6).toString('hex')}`);
  const given = `${stem}.given`;
  const made = `${stem}.png`;
  try {
    writeFileSync(given, bytes);
    await exec(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', given, '-frames:v', '1', '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${SIZE}:${SIZE}:flags=lanczos`, '-c:v', 'png', '-f', 'image2', made],
      { timeout: 20_000 },
    );
    const hash = createHash('sha256').update(readFileSync(made)).digest('hex').slice(0, 16);
    renameSync(made, photoFile(profileId));
    db.prepare('INSERT INTO profile_photos (profile_id, hash) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET hash = excluded.hash').run(profileId, hash);
    return null;
  } catch (err) {
    console.warn(`Couldn’t make a profile photo from an upload: ${(err as Error).message.split('\n').at(-2) ?? err}`);
    return 'That image couldn’t be read. Try another, or save it as a PNG or JPEG first.';
  } finally {
    rmSync(given, { force: true });
    rmSync(made, { force: true });
  }
}

/** Takes a profile's photo away. Whether it had one */
export function removePhoto(profileId: string): boolean {
  rmSync(photoFile(profileId), { force: true });
  return db.prepare('DELETE FROM profile_photos WHERE profile_id = ?').run(profileId).changes > 0;
}

/** Gives a copy of a profile the same photo */
export function copyPhoto(from: string, to: string) {
  const hash = photoOf(from);
  if (!hash || !existsSync(photoFile(from))) return;
  copyFileSync(photoFile(from), photoFile(to));
  db.prepare('INSERT INTO profile_photos (profile_id, hash) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET hash = excluded.hash').run(to, hash);
}

// ---------- the bot's photo in each server ----------

const putUpKey = (guildId: string) => `profile photo:${guildId}`;
/** Why the photo couldn't be changed, for Settings, by server, until it can */
const problems = new Map<string, string>();
/**
 * Whether the bot has a photo of its own in each server, as it last set it. discord.js leaves the bot's member as it was
 * after the bot changes itself, until Discord says so, so a quick second change would go by what's out of date
 */
const hasPhoto = new Map<string, boolean>();
/** Each server's changes, one at a time: the last one started, and one waiting to start, which any more join */
const chains = new Map<string, { last: Promise<unknown>; next?: Promise<string | null> }>();

/** How long a change from the web UI waits for Discord before answering anyway. For tests to shorten */
export const photoTiming = { waitMs: 10_000 };
export const PHOTO_WAITING = 'Discord is making the bot wait to change its photo here. It changes by itself in a moment.';

/**
 * Gives the bot its profile's photo in `guild`, or its own photo for a profile without one. Changes for one server run one
 * at a time, each putting up the photo wanted when it starts, so the last one picked wins. Null once it's done or there
 * was nothing to do; otherwise why it couldn't, which never stops the change of profile itself
 */
export function followPhoto(guild: Guild): Promise<string | null> {
  let chain = chains.get(guild.id);
  if (!chain) chains.set(guild.id, (chain = { last: Promise.resolve() }));
  if (chain.next) return chain.next;
  const own = chain;
  const next = own.last.then(() => {
    own.next = undefined;
    return putUp(guild);
  });
  own.next = next;
  own.last = next;
  return next;
}

/** followPhoto for an answer to the web UI, which says Discord is making it wait rather than waiting with it */
export const followPhotoSoon = (guild: Guild) =>
  Promise.race([followPhoto(guild), sleep(photoTiming.waitMs, PHOTO_WAITING, { ref: false })]);

/** Never throws, so one change going wrong leaves the server's later ones to go */
async function putUp(guild: Guild): Promise<string | null> {
  /** Why, for whoever changed it, and for Settings until it's put right */
  const failed = (text: string, forSettings = text) => {
    problems.set(guild.id, forSettings);
    return text;
  };
  try {
    const me = guild.members.me;
    if (!me) return null;
    const profile = activeProfile(guild.id);
    const wanted = photoOf(profile.id);
    const has = hasPhoto.get(guild.id) ?? !!me.avatar;
    // The bot's photo here is only ever one it put up, so one without a profile photo goes. One whose record says it's up
    // but has none, as after a database restored from before, goes up again
    if (wanted ? getKv(putUpKey(guild.id)) === wanted && has : !has) {
      problems.delete(guild.id);
      return null;
    }
    let photo: Buffer | null = null;
    if (wanted) {
      if (!existsSync(photoFile(profile.id))) return failed(`${profile.name}’s photo is missing from the bot’s data folder. Choose it again in Settings → Profiles.`);
      photo = readFileSync(photoFile(profile.id));
    }
    try {
      const after = await guild.members.editMe({ avatar: photo, reason: 'Chat profile' });
      hasPhoto.set(guild.id, !!after.avatar);
    } catch (err) {
      const why = (err as Error).message;
      console.warn(`Couldn’t change the bot’s photo in server ${guild.id}: ${why}`);
      const text = `Discord didn’t let me change my photo here: ${why.replace(/\.$/, '')}`;
      return failed(text, `${text}. It’s tried again when the bot restarts or the profile changes.`);
    }
    setKv(putUpKey(guild.id), wanted);
    problems.delete(guild.id);
    return null;
  } catch (err) {
    console.error(`Couldn’t work out the bot’s photo in server ${guild.id}:`, err);
    return failed('Something went wrong changing my photo here. It’s tried again when the bot restarts or the profile changes.');
  }
}

/** A problem for Settings: the profile's photo couldn't be put up here */
export const photoProblem = (guildId: string) => {
  const why = problems.get(guildId);
  return why ? `Profile: ${why}` : null;
};

/** For tests: forgets the changes under way and the problems */
export function resetPhotos() {
  chains.clear();
  problems.clear();
  hasPhoto.clear();
}
