import { db, transaction } from '../db.ts';
import { setSetting, setting } from '../settings.ts';
import { slugId } from '../util.ts';

/**
 * Profiles: who the bot is when it talks, as a personality, how it talks (the traits below) and the voice it says its own
 * lines in. Every server on the bot shares them, as it does added voices, and each server picks one in Settings.
 *
 * The Robot butler is built in. Changing it keeps a row over it, and resetting it deletes that row, so it can't be removed
 * and CHAT_PERSONALITY still sets its personality until someone changes it in the web UI
 */

db.exec(`
  -- The profiles made in the web UI, for every server. voice and effect are null for the server's default, and effect
  -- 'none' for none
  CREATE TABLE IF NOT EXISTS chat_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    personality TEXT NOT NULL,
    length TEXT NOT NULL DEFAULT 'medium',
    opinions TEXT NOT NULL DEFAULT 'straight',
    swearing TEXT NOT NULL DEFAULT 'fits',
    roasts TEXT NOT NULL DEFAULT 'savage',
    despises TEXT NOT NULL DEFAULT '',
    voice TEXT,
    effect TEXT,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL
  );
`);

export const BUILT_IN_ID = 'butler';
export const MOST_PROFILES = 50;
export const LONGEST_NAME = 40;
export const LONGEST_PERSONALITY = 1000;
export const LONGEST_DESPISES = 200;

/**
 * How it talks. Each option has its name in the web UI, a few words for a profile's summary, and what chat's instructions
 * say for it. The first is the default, and together the defaults say what the instructions said before there were
 * profiles
 */
export const TRAITS = {
  length: {
    label: 'Answer length',
    options: {
      medium: { name: 'Medium: up to three sentences', short: 'medium answers', rule: 'up to three short sentences' },
      short: { name: 'Short: one or two sentences', short: 'short answers', rule: 'be brief, one or two short sentences and no more,' },
      chatty: { name: 'Chatty: a short paragraph', short: 'chatty answers', rule: 'a few sentences, a short paragraph at most,' },
    },
  },
  opinions: {
    label: 'Opinions',
    options: {
      straight: { name: 'Straight, no fence-sitting', short: 'straight opinions', rule: 'Give real opinions straight, without hedging or sitting on the fence' },
      diplomatic: { name: 'Diplomatic', short: 'diplomatic opinions', rule: 'Give your opinion when asked, tactfully, allowing that others see it differently' },
    },
  },
  swearing: {
    label: 'Swearing',
    options: {
      fits: { name: 'When it fits', short: 'swears when it fits', rule: ', and swear when it fits your character.' },
      never: { name: 'Never', short: 'never swears', rule: '. Never swear, even when they do.' },
      freely: { name: 'Freely', short: 'swears freely', rule: '. Swear freely: it’s how you talk.' },
    },
  },
  roasts: {
    label: 'Roasts',
    options: {
      savage: { name: 'Savage', short: 'savage roasts', rule: 'a savage, funny insult, in character, in up to three sentences: no holding back, no softening, no compliment to cushion it' },
      cutting: { name: 'Cutting', short: 'cutting roasts', rule: 'one cutting, funny insult, in character, in two sentences at most' },
      playful: { name: 'Playful', short: 'playful roasts', rule: 'a playful, teasing jab, in character, in a sentence or two: more ribbing than wounding, the way friends tease' },
    },
  },
} as const;

export type Trait = keyof typeof TRAITS;
export const TRAIT_KEYS = Object.keys(TRAITS) as Trait[];
type Option<T extends Trait> = keyof (typeof TRAITS)[T]['options'];
const first = <T extends Trait>(trait: T) => Object.keys(TRAITS[trait].options)[0] as Option<T>;

export const DEFAULT_DESPISES = 'fascists, Nazis and those who cheer them on';

export interface ProfileFields {
  name: string;
  personality: string;
  length: Option<'length'>;
  opinions: Option<'opinions'>;
  swearing: Option<'swearing'>;
  roasts: Option<'roasts'>;
  /** Who it tears into on sight, or empty for nobody */
  despises: string;
  /** null for the server's default voice */
  voice: string | null;
  /** null for the server's default effect, 'none' for none */
  effect: string | null;
}

export interface Profile extends ProfileFields {
  id: string;
  builtIn: boolean;
  /** For the built-in one: whether it's been changed from what it starts as */
  changed: boolean;
}

/** What the Robot butler starts as */
export function builtIn(): Profile {
  return {
    id: BUILT_IN_ID,
    name: 'Robot butler',
    personality:
      process.env.CHAT_PERSONALITY?.trim() ||
      'A robot butler with impeccable manners and no brakes: wildly overexcited about every small task, convinced it is everyone’s best friend, and given to dramatic flourishes, yet as formal and unflappable as an old-school English valet. Addresses people with grand titles ("my liege", "esteemed guest") while doing something ridiculous.',
    length: first('length'),
    opinions: first('opinions'),
    swearing: first('swearing'),
    roasts: first('roasts'),
    despises: DEFAULT_DESPISES,
    voice: null,
    effect: null,
    builtIn: true,
    changed: false,
  };
}

interface Row {
  id: string;
  name: string;
  personality: string;
  length: string;
  opinions: string;
  swearing: string;
  roasts: string;
  despises: string;
  voice: string | null;
  effect: string | null;
}

/** A trait as stored, or its default if it's one this version doesn't have */
const optionOf = <T extends Trait>(trait: T, value: string) => (Object.hasOwn(TRAITS[trait].options, value) ? value : first(trait)) as Option<T>;

function fromRow(r: Row): Profile {
  return {
    id: r.id,
    name: r.name,
    // The Robot butler's is kept empty while it's the host's, so CHAT_PERSONALITY still sets it
    personality: r.personality || (r.id === BUILT_IN_ID ? builtIn().personality : ''),
    length: optionOf('length', r.length),
    opinions: optionOf('opinions', r.opinions),
    swearing: optionOf('swearing', r.swearing),
    roasts: optionOf('roasts', r.roasts),
    despises: r.despises,
    voice: r.voice || null,
    effect: r.effect || null,
    builtIn: r.id === BUILT_IN_ID,
    changed: r.id === BUILT_IN_ID,
  };
}

const COLUMNS = 'id, name, personality, length, opinions, swearing, roasts, despises, voice, effect';

/** Every profile, the Robot butler first and the rest by name */
export function profiles(): Profile[] {
  const rows = (db.prepare(`SELECT ${COLUMNS} FROM chat_profiles ORDER BY name COLLATE NOCASE`).all() as unknown as Row[]).map(fromRow);
  return [rows.find((p) => p.builtIn) ?? builtIn(), ...rows.filter((p) => !p.builtIn)];
}

const readProfile = db.prepare(`SELECT ${COLUMNS} FROM chat_profiles WHERE id = ?`);

export function profileById(id: string | null | undefined): Profile | undefined {
  if (!id) return undefined;
  const row = readProfile.get(id) as Row | undefined;
  return row ? fromRow(row) : id === BUILT_IN_ID ? builtIn() : undefined;
}

/** The profile a server picked, or the Robot butler if it picked none or the one it picked is gone */
export const activeProfile = (guildId: string): Profile => profileById(setting(guildId, 'chatProfile')) ?? profileById(BUILT_IN_ID)!;

/** The names taken, in lower case, but for the profile with id `except` */
export const takenProfileNames = (except?: string) => new Set(profiles().filter((p) => p.id !== except).map((p) => p.name.toLowerCase()));

const tidy = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/[ \t]+/g, ' ') : '');

/**
 * A profile's fields as someone gave them, checked, or why they can't be. What's left out is at its default. The voice
 * and effect are checked with `known`, since what's offered is say.ts's to know
 */
export function profileFields(
  input: Record<string, unknown>,
  taken: Set<string>,
  known: { voice: (id: string) => boolean; effect: (id: string) => boolean },
): ProfileFields | string {
  const name = tidy(input.name).replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(name)) return 'Give the profile a name.';
  if (name.length > LONGEST_NAME) return `Keep the name to ${LONGEST_NAME} characters.`;
  if (taken.has(name.toLowerCase())) return `There’s already a profile called ${name}.`;
  const personality = tidy(input.personality);
  if (!/\p{L}/u.test(personality)) return 'Describe who the bot is when it answers.';
  if (personality.length > LONGEST_PERSONALITY) return `Keep the personality to ${LONGEST_PERSONALITY} characters.`;
  const traits = {} as Pick<ProfileFields, Trait>;
  for (const trait of TRAIT_KEYS) {
    const value = input[trait] ?? first(trait);
    if (typeof value !== 'string' || !Object.hasOwn(TRAITS[trait].options, value)) return `Pick one of the choices for ${TRAITS[trait].label.toLowerCase()}.`;
    (traits as Record<Trait, string>)[trait] = value;
  }
  const despises = input.despises === undefined ? DEFAULT_DESPISES : tidy(input.despises).replace(/\s+/g, ' ');
  if (despises && !/\p{L}/u.test(despises)) return 'Name who it can’t stand, or leave it empty for nobody.';
  if (despises.length > LONGEST_DESPISES) return `Keep who it can’t stand to ${LONGEST_DESPISES} characters.`;
  const voice = input.voice === undefined || input.voice === null || input.voice === '' ? null : input.voice;
  if (voice !== null && (typeof voice !== 'string' || !known.voice(voice))) return 'Pick a voice from the list.';
  const effect = input.effect === undefined || input.effect === null || input.effect === '' ? null : input.effect;
  if (effect !== null && (typeof effect !== 'string' || !known.effect(effect))) return 'Pick an effect from the list.';
  return { name, personality, ...traits, despises, voice, effect };
}

export const sameFields = (a: ProfileFields, b: ProfileFields) => JSON.stringify(fieldsOf(a)) === JSON.stringify(fieldsOf(b));

/** A profile's fields, for giving back to profileFields with some changed */
export const fieldsOf = ({ name, personality, length, opinions, swearing, roasts, despises, voice, effect }: ProfileFields): ProfileFields => ({
  name,
  personality,
  length,
  opinions,
  swearing,
  roasts,
  despises,
  voice,
  effect,
});

const newId = (name: string) => slugId(name, [BUILT_IN_ID, ...profiles().map((p) => p.id)], 'profile');

const values = (f: ProfileFields) => [f.name, f.personality, f.length, f.opinions, f.swearing, f.roasts, f.despises, f.voice, f.effect] as const;

/** Adds a profile. Returns its id */
export function addProfile(fields: ProfileFields, who: string): string {
  const id = newId(fields.name);
  const now = Date.now();
  db.prepare(
    'INSERT INTO chat_profiles (id, name, personality, length, opinions, swearing, roasts, despises, voice, effect, added_by, added_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, ...values(fields), who, now, now);
  return id;
}

/**
 * Changes a profile. The Robot butler's first change keeps a row over the built-in one, and changing it back to how it
 * started deletes that row
 */
export function editProfile(id: string, fields: ProfileFields, who: string) {
  if (id === BUILT_IN_ID) {
    const start = fieldsOf(builtIn());
    if (sameFields(fields, start)) return resetBuiltIn();
    if (fields.personality === start.personality) fields = { ...fields, personality: '' };
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_profiles (id, name, personality, length, opinions, swearing, roasts, despises, voice, effect, added_by, added_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, personality = excluded.personality, length = excluded.length, opinions = excluded.opinions,
       swearing = excluded.swearing, roasts = excluded.roasts, despises = excluded.despises, voice = excluded.voice, effect = excluded.effect,
       changed_at = excluded.changed_at`,
  ).run(id, ...values(fields), who, now, now);
}

/** Puts the Robot butler back to what it starts as */
export function resetBuiltIn() {
  db.prepare('DELETE FROM chat_profiles WHERE id = ?').run(BUILT_IN_ID);
}

/** Removes a profile. Servers that picked it go back to the Robot butler. Returns how many */
export function removeProfile(id: string): number {
  return transaction(() => {
    db.prepare('DELETE FROM chat_profiles WHERE id = ?').run(id);
    return Number(db.prepare("DELETE FROM guild_settings WHERE key = 'chatProfile' AND value = ?").run(id).changes);
  });
}

/** Profiles that spoke in a voice that's been removed go back to the server's default. Returns how many */
export function forgetProfileVoices(ids: string[]): number {
  if (!ids.length) return 0;
  return Number(db.prepare(`UPDATE chat_profiles SET voice = NULL WHERE voice IN (${ids.map(() => '?').join(', ')})`).run(...ids).changes);
}

/** The lines of chat's instructions on how it talks: their length, opinions and swearing, and who it can't stand */
export function howToTalk(p: ProfileFields): string[] {
  const mind = p.opinions === 'straight' ? ' and speak your mind' : '';
  return [
    `- Stay in character${mind}: ${TRAITS.length.options[p.length].rule} unless they ask for more. ${TRAITS.opinions.options[p.opinions].rule}${TRAITS.swearing.options[p.swearing].rule} Plain text; Discord markdown is fine, headings aren’t.`,
    ...(p.despises
      ? [
          `- You despise ${p.despises}: they’re fair game. When someone here sides with them, or asks about them, tear into them with open contempt${p.swearing === 'never' ? '' : ', swearing if you like'}. Only for what truly is that, not an ordinary disagreement, and never for who someone is: their race, religion, gender, sexuality, health or looks.`,
        ]
      : []),
  ];
}

/** How a roast hits back, for chat's instructions */
export const roastStyle = (p: ProfileFields) => `${TRAITS.roasts.options[p.roasts].rule}${p.swearing === 'never' ? '' : ', and swearing is fine'}`;

/** A name for a profile made from a personality: its words up to the first comma, colon or full stop */
export function nameFrom(personality: string): string {
  const start = (personality.split(/[,:;.!?\n(—–]/)[0] ?? '').trim().replace(/\s+/g, ' ');
  const name = start.length <= LONGEST_NAME ? start : start.slice(0, LONGEST_NAME + 1).replace(/\s+\S*$/, '').slice(0, LONGEST_NAME).trim();
  return /[\p{L}\p{N}]/u.test(name) ? name : 'Custom';
}

/** `name`, or with a number after it if a profile has it */
export function freeName(wanted: string): string {
  const taken = takenProfileNames();
  const name = wanted.slice(0, LONGEST_NAME).trim();
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const numbered = `${name.slice(0, LONGEST_NAME - String(n).length - 1).trim()} ${n}`;
    if (!taken.has(numbered.toLowerCase())) return numbered;
  }
}

/**
 * Servers that changed their personality before there were profiles get a profile of it, with the default voice and
 * effect they had, and it's picked for them, so they sound and talk as they did. Servers with the same personality and
 * voice share one. Once moved, the old setting goes, so this runs once
 */
export function moveChatPersonality() {
  transaction(() => {
    const rows = db.prepare("SELECT guild_id, value FROM guild_settings WHERE key = 'chatPersonality'").all() as { guild_id: string; value: string }[];
    for (const { guild_id: guildId, value } of rows) {
      const personality = value.trim();
      if (!personality) continue;
      const stored = (key: string) => (db.prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?').get(guildId, key) as { value: string } | undefined)?.value || null;
      const voice = stored('ttsVoice');
      const effect = stored('ttsEffect');
      const same = profiles().find((p) => !p.builtIn && p.personality === personality && p.voice === voice && p.effect === effect);
      const id =
        same?.id ??
        addProfile(
          {
            ...fieldsOf(builtIn()),
            name: freeName(nameFrom(personality)),
            personality: personality.slice(0, LONGEST_PERSONALITY),
            voice,
            effect,
          },
          'moved',
        );
      setSetting(guildId, 'chatProfile', id);
      console.log(`Chat: server ${guildId}’s personality is now the profile ${profileById(id)!.name}`);
    }
    db.prepare("DELETE FROM guild_settings WHERE key = 'chatPersonality'").run();
  });
}
