import { type Guild, PermissionFlagsBits } from 'discord.js';
import { activeProfile, type Profile, type ProfileFields, profiles } from './chatProfiles.ts';

// The bot's name in a server, as its profile has it. A profile with a nickname renames the bot there. One without leaves
// the name alone, unless the bot has a profile's nickname, which goes; so a nickname an admin gave the bot by hand stays
// until a profile with one is picked

export const CANT_RENAME = 'I can’t change my nickname here: give my role **Change Nickname**.';

/** The profile whose nickname the bot has in `guild`, if it has one */
function namedFor(guild: Guild): Profile | null {
  const nickname = guild.members.me?.nickname;
  return (nickname && profiles().find((p) => p.nickname === nickname)) || null;
}

/**
 * What the bot would be called in `guild` with each profile, once it's picked: for the one in use, what it's called now,
 * so chat goes by the name people see even when the bot couldn't take its profile's
 */
export function namesIn(guild: Guild): (profile: Profile) => string {
  const me = guild.members.me;
  const now = me?.displayName ?? 'the bot';
  const active = activeProfile(guild.id).id;
  let named: Profile | null | undefined;
  return (profile) => {
    if (profile.id === active) return now;
    if (profile.nickname) return profile.nickname;
    named ??= namedFor(guild);
    return named ? (me?.user.displayName ?? now) : now;
  };
}

export const nameAs = (guild: Guild, profile: Profile) => namesIn(guild)(profile);

/**
 * Renames the bot in `guild` for a change from `before` to `after`: of the profile it uses, or of that profile's nickname.
 * A nickname that isn't `before`'s, given by hand, is only replaced by another, never cleared. Null once it's done or
 * there was nothing to do; otherwise why it couldn't, which never stops the change itself
 */
export async function applyNickname(guild: Guild, before: Pick<ProfileFields, 'nickname'> | null, after: Pick<ProfileFields, 'nickname'>): Promise<string | null> {
  const me = guild.members.me;
  if (!me) return null;
  const now = me.nickname ?? null;
  const wanted = after.nickname || null;
  if (now === wanted || (!wanted && (!before?.nickname || now !== before.nickname))) return null;
  if (!me.permissions.has(PermissionFlagsBits.ChangeNickname)) return CANT_RENAME;
  try {
    await me.setNickname(wanted, 'Chat profile');
    return null;
  } catch (err) {
    const why = (err as Error).message;
    console.warn(`Couldn’t change the bot’s nickname in server ${guild.id}: ${why}`);
    return `Discord didn’t let me change my nickname here: ${why}`;
  }
}

/** Renames the bot in `guild` for the profile it now uses, from whichever profile's nickname it has */
export const followProfile = (guild: Guild) => applyNickname(guild, namedFor(guild), activeProfile(guild.id));

/** A problem for Settings: the profile has a nickname the bot can't take */
export function nicknameProblem(guild: Guild): string | null {
  const { nickname } = activeProfile(guild.id);
  const me = guild.members.me;
  if (!nickname || !me || me.nickname === nickname || me.permissions.has(PermissionFlagsBits.ChangeNickname)) return null;
  return `Profile: it’s called **${nickname}**, but I can’t change my nickname here. Give my role **Change Nickname**.`;
}
