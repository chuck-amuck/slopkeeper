import type { Guild } from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import { logActivity } from '../activity.ts';
import { feeds } from '../changes.ts';
import { plural } from '../features/gamestats.ts';
import {
  activeProfile,
  addProfile,
  BUILT_IN_ID,
  builtIn,
  editProfile,
  fieldsOf,
  freeName,
  LONGEST_DESPISES,
  LONGEST_NAME,
  LONGEST_NICKNAME,
  LONGEST_PERSONALITY,
  MOST_PROFILES,
  type Profile,
  profileById,
  profileFields,
  profiles,
  removeProfile,
  resetBuiltIn,
  sameFields,
  takenProfileNames,
  TRAIT_KEYS,
  TRAITS,
} from '../features/chatProfiles.ts';
import { applyNickname } from '../features/profileNames.ts';
import { copyPhoto, followPhoto, followPhotoSoon, photoFile, photoOf, photos, removePhoto, savePhoto } from '../features/profilePhotos.ts';
import { effects, NO_EFFECT, voices } from '../features/say.ts';
import { servedGuilds } from '../util.ts';
import { type Ask, Refused, by, readBody, readJson } from './common.ts';

// The management API for profiles: who the bot is, how it talks and its voice. Every server on the bot shares them, and
// each picks one with the chatProfile setting

/** A voice or effect a profile can have: one that's offered now */
const KNOWN = {
  voice: (id: string) => voices().some((v) => v.id === id),
  effect: (id: string) => id === NO_EFFECT || effects().some((e) => e.id === id),
};

function list(ask: Ask) {
  const hashes = photos();
  const picked = new Map<string, number>();
  for (const guild of servedGuilds(ask.client)) {
    const id = activeProfile(guild.id).id;
    picked.set(id, (picked.get(id) ?? 0) + 1);
  }
  const active = activeProfile(ask.guild.id).id;
  return {
    profiles: profiles().map((p) => ({ id: p.id, ...fieldsOf(p), photo: hashes.get(p.id) ?? '', builtIn: p.builtIn, changed: p.changed, active: p.id === active, servers: picked.get(p.id) ?? 0 })),
    traits: TRAIT_KEYS.map((key) => ({ key, label: TRAITS[key].label, options: Object.entries(TRAITS[key].options).map(([id, o]) => [id, o.name, o.short]) })),
    most: MOST_PROFILES,
    longest: { name: LONGEST_NAME, personality: LONGEST_PERSONALITY, despises: LONGEST_DESPISES, nickname: LONGEST_NICKNAME },
  };
}

/** The servers using profile `id` */
const using = (ask: Ask, id: string) => servedGuilds(ask.client).filter((g) => activeProfile(g.id).id === id);

/**
 * Renames the bot in `guilds` for a change of their profile's nickname, from `before`'s to `after`'s. Why it couldn't in
 * the server asking, if it couldn't there; elsewhere that's only logged
 */
async function rename(ask: Ask, guilds: Guild[], before: Pick<Profile, 'nickname'>, after: Pick<Profile, 'nickname'>) {
  if (before.nickname === after.nickname) return undefined;
  const whys = await Promise.all(guilds.map((guild) => applyNickname(guild, before, after)));
  guilds.forEach((guild, i) => {
    if (whys[i] && guild.id !== ask.guild.id) console.warn(`Couldn’t rename the bot for its profile in server ${guild.id}: ${whys[i]}`);
  });
  return whys[guilds.findIndex((g) => g.id === ask.guild.id)] ?? undefined;
}

/**
 * Gives the bot its profile's photo in `guilds`, waiting for it only in the server asking, and only so long. Why it
 * couldn't there, if it couldn't; elsewhere that's only logged
 */
function rephoto(ask: Ask, guilds: Guild[]): Promise<string | null> {
  for (const guild of guilds) if (guild.id !== ask.guild.id) void followPhoto(guild);
  return guilds.some((g) => g.id === ask.guild.id) ? followPhotoSoon(ask.guild) : Promise.resolve(null);
}

/** Both warnings, or either */
const warnings = (...whys: (string | null | undefined)[]) => whys.filter(Boolean).join(' ') || undefined;

/** Profiles are every server's, so the header's picker and Settings' Profile in each follow a change */
const changed = (ask: Ask) => {
  for (const guild of servedGuilds(ask.client)) {
    feeds.profile.changed(guild.id);
    feeds.settings.changed(guild.id);
  }
};

/** A profile's photo: shown, changed or taken away */
async function photoRoute(ask: Ask, id: string) {
  const { guild, req, res, url } = ask;
  const profile = find(id);
  if (req.method === 'GET') {
    const hash = photoOf(id);
    if (!hash || !existsSync(photoFile(id))) throw new Refused(404, `${profile.name} has no photo.`);
    const data = readFileSync(photoFile(id));
    // Asked for by its hash, it never changes
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': url.searchParams.get('v') === hash ? 'private, max-age=31536000, immutable' : 'no-cache' });
    res.end(data);
    return null;
  }
  if (req.method === 'PUT') {
    const why = await savePhoto(id, await readBody(req));
    if (why) throw new Refused(400, why);
    logActivity(guild.id, by(), `Changed the photo of the profile ${profile.name}`);
  } else if (req.method === 'DELETE') {
    if (!removePhoto(id)) throw new Refused(404, `${profile.name} has no photo.`);
    logActivity(guild.id, by(), `Removed the photo of the profile ${profile.name}`);
  } else throw new Refused(405, 'Not here.');
  changed(ask);
  return { ...list(ask), warning: warnings(await rephoto(ask, using(ask, id))) };
}

const find = (id: string): Profile => {
  const profile = profileById(id);
  if (!profile) throw new Refused(404, 'That profile isn’t there any more.');
  return profile;
};

/**
 * Checked fields, or a 400 with why not. A profile being changed keeps the voice and effect it has, even one that's
 * downloading again or gone, so its other settings can still be saved
 */
function checked(input: Record<string, unknown>, before?: Profile) {
  const known = {
    voice: (id: string) => id === before?.voice || KNOWN.voice(id),
    effect: (id: string) => id === before?.effect || KNOWN.effect(id),
  };
  const fields = profileFields(input, takenProfileNames(before?.id), known);
  if (typeof fields === 'string') throw new Refused(400, fields);
  return fields;
}

export async function profileRoutes(ask: Ask) {
  const { guild, req, rest } = ask;
  const [id, more, extra] = rest;
  if (id !== undefined && more === 'photo' && extra === undefined) return photoRoute(ask, id);
  if (more !== undefined) throw new Refused(404, 'Not found.');

  if (id === undefined && req.method === 'GET') return list(ask);

  if (id === undefined && req.method === 'POST') {
    if (profiles().length >= MOST_PROFILES) throw new Refused(409, `There are already ${MOST_PROFILES} profiles, the most there can be. Delete one first.`);
    const body = await readJson(req);
    // A copy is made from the profile as it's saved, under a name of its own
    const fields = typeof body.copyOf === 'string' ? { ...fieldsOf(find(body.copyOf)), name: freeName(`${find(body.copyOf).name} copy`) } : checked(body);
    const newId = addProfile(fields, by());
    if (typeof body.copyOf === 'string') copyPhoto(body.copyOf, newId);
    logActivity(guild.id, by(), `Added the profile ${fields.name}`);
    changed(ask);
    return { ...list(ask), id: newId };
  }

  if (id !== undefined && req.method === 'PUT') {
    const profile = find(id);
    const fields = checked({ ...fieldsOf(profile), ...(await readJson(req)) }, profile);
    // Saving without a change changes nothing, so the Robot butler isn't kept apart from the host's personality for it
    if (sameFields(fields, profile)) return list(ask);
    editProfile(id, fields, by());
    logActivity(guild.id, by(), fields.name === profile.name ? `Changed the profile ${profile.name}` : `Changed the profile ${profile.name}, now called ${fields.name}`);
    changed(ask);
    return { ...list(ask), warning: await rename(ask, using(ask, id), profile, fields) };
  }

  if (id !== undefined && req.method === 'DELETE') {
    const profile = find(id);
    if (id === BUILT_IN_ID) {
      if (!profile.changed) throw new Refused(409, `${profile.name} is built in, and hasn’t been changed.`);
      const name = builtIn().name;
      if (takenProfileNames(BUILT_IN_ID).has(name.toLowerCase())) throw new Refused(409, `Another profile is called ${name}. Rename it first.`);
      resetBuiltIn();
      // It starts without a photo
      removePhoto(id);
      logActivity(guild.id, by(), `Put the profile ${profile.name} back to how it started`);
      changed(ask);
      const users = using(ask, id);
      return { ...list(ask), servers: 0, warning: warnings(await rename(ask, users, profile, builtIn()), await rephoto(ask, users)) };
    }
    // Those using it go back to the Robot butler, and to its name
    const moved = using(ask, id);
    const servers = removeProfile(id);
    removePhoto(id);
    changed(ask);
    const warning = warnings(await rename(ask, moved, profile, profileById(BUILT_IN_ID)!), await rephoto(ask, moved));
    logActivity(guild.id, by(), `Deleted the profile ${profile.name}${servers ? `, and ${servers === 1 ? '1 server’s pick' : `${plural(servers, 'server')}’ picks`} of it` : ''}`);
    return { ...list(ask), servers, warning };
  }

  throw new Refused(405, 'Not here.');
}
