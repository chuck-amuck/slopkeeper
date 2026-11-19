import { logActivity } from '../activity.ts';
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
import { effects, NO_EFFECT, voices } from '../features/say.ts';
import { servedGuilds } from '../util.ts';
import { type Ask, Refused, by, readJson } from './common.ts';

// The management API for profiles: who the bot is, how it talks and its voice. Every server on the bot shares them, and
// each picks one with the chatProfile setting

/** A voice or effect a profile can have: one that's offered now */
const KNOWN = {
  voice: (id: string) => voices().some((v) => v.id === id),
  effect: (id: string) => id === NO_EFFECT || effects().some((e) => e.id === id),
};

function list(ask: Ask) {
  const picked = new Map<string, number>();
  for (const guild of servedGuilds(ask.client)) {
    const id = activeProfile(guild.id).id;
    picked.set(id, (picked.get(id) ?? 0) + 1);
  }
  const active = activeProfile(ask.guild.id).id;
  return {
    profiles: profiles().map((p) => ({ id: p.id, ...fieldsOf(p), builtIn: p.builtIn, changed: p.changed, active: p.id === active, servers: picked.get(p.id) ?? 0 })),
    traits: TRAIT_KEYS.map((key) => ({ key, label: TRAITS[key].label, options: Object.entries(TRAITS[key].options).map(([id, o]) => [id, o.name, o.short]) })),
    most: MOST_PROFILES,
    longest: { name: LONGEST_NAME, personality: LONGEST_PERSONALITY, despises: LONGEST_DESPISES },
  };
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
  const [id, more] = rest;
  if (more !== undefined) throw new Refused(404, 'Not found.');

  if (id === undefined && req.method === 'GET') return list(ask);

  if (id === undefined && req.method === 'POST') {
    if (profiles().length >= MOST_PROFILES) throw new Refused(409, `There are already ${MOST_PROFILES} profiles, the most there can be. Delete one first.`);
    const body = await readJson(req);
    // A copy is made from the profile as it's saved, under a name of its own
    const fields = typeof body.copyOf === 'string' ? { ...fieldsOf(find(body.copyOf)), name: freeName(`${find(body.copyOf).name} copy`) } : checked(body);
    const newId = addProfile(fields, by());
    logActivity(guild.id, by(), `Added the profile ${fields.name}`);
    return { ...list(ask), id: newId };
  }

  if (id !== undefined && req.method === 'PUT') {
    const profile = find(id);
    const fields = checked({ ...fieldsOf(profile), ...(await readJson(req)) }, profile);
    // Saving without a change changes nothing, so the Robot butler isn't kept apart from the host's personality for it
    if (sameFields(fields, profile)) return list(ask);
    editProfile(id, fields, by());
    logActivity(guild.id, by(), fields.name === profile.name ? `Changed the profile ${profile.name}` : `Changed the profile ${profile.name}, now called ${fields.name}`);
    return list(ask);
  }

  if (id !== undefined && req.method === 'DELETE') {
    const profile = find(id);
    if (id === BUILT_IN_ID) {
      if (!profile.changed) throw new Refused(409, `${profile.name} is built in, and hasn’t been changed.`);
      const name = builtIn().name;
      if (takenProfileNames(BUILT_IN_ID).has(name.toLowerCase())) throw new Refused(409, `Another profile is called ${name}. Rename it first.`);
      resetBuiltIn();
      logActivity(guild.id, by(), `Put the profile ${profile.name} back to how it started`);
      return { ...list(ask), servers: 0 };
    }
    const servers = removeProfile(id);
    logActivity(guild.id, by(), `Deleted the profile ${profile.name}${servers ? `, and ${servers === 1 ? '1 server’s pick' : `${plural(servers, 'server')}’ picks`} of it` : ''}`);
    return { ...list(ask), servers };
  }

  throw new Refused(405, 'Not here.');
}
