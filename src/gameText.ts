// Game names as text, with nothing stored, so anything can use them without opening the game names' tables

const NUMERALS: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9 };
// Capitals and on its own at the end, so a word like "Vi" stays a word. X is left out, as it's as often just a letter
const LAST_NUMERAL = /(?<=[^\p{L}\p{N}])(II|III|IV|V|VI|VII|VIII|IX)\s*$/u;

/**
 * A game's name as Discord sent it, made fit to show: escape codes and control characters out, spaces trimmed. Text
 * switched into another character set by an escape code goes with it, as it's a symbol like ™ that came out garbled
 */
export const cleanGameName = (name: string) =>
  name
    // ESC $ ... switches to a multibyte set until ESC ( B switches back; ESC [ ... is a terminal command; any other ESC with its next character
    .replace(/\x1b\$[\s\S]*?(\x1b\([\x20-\x7e]|$)/g, '')
    .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, '')
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]?/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Programs Discord shows as playing that aren't games: launchers, helpers, and Moonlight streaming whatever's on the PC */
const NOT_GAMES = new Set(['launcher', 'crashpad_handler', 'steamwebhelper', 'moonlight']);
export const isProgramNotGame = (name: string) => NOT_GAMES.has(name.toLowerCase());

// What Discord on Linux shows when it knows only the program: one word, all lowercase, or with a file ending or an underscore
const FILE_ENDING = /\.(exe|x86_64|x86|x64|sh|bin|appimage)$/i;
export const isProgramName = (name: string) => !/\s/.test(name) && (!/\p{Lu}/u.test(name) || FILE_ENDING.test(name) || name.includes('_'));
/**
 * A program file's name without the platform it was built for: streetsofroguelinux.x86_64 is Streets of Rogue. Only
 * for a name that looks like a file, so a lowercase title ending in one of those words keeps it
 */
const PLATFORM = /[-_]?(linux|win64|win32|x64|shipping)$/i;
const looksLikeFile = (name: string) => !/\s/.test(name) && (FILE_ENDING.test(name) || /[_-]/.test(name));
const programBase = (name: string) => name.replace(FILE_ENDING, '').replace(PLATFORM, '');

/**
 * What's left of a name once case, spaces and punctuation are gone, with a sequel's Roman numeral as a digit and a
 * program's platform left off. A name with nothing left only matches itself
 */
export const gameKey = (name: string) =>
  (looksLikeFile(name) ? programBase(name) : name)
    .replace(LAST_NUMERAL, (numeral) => String(NUMERALS[numeral.trim()]))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '') || name;

/** A Steam title as a name to show: Steam marks many with ™ and ®, which Discord mostly leaves off */
export const steamName = (title: string) => cleanGameName(title.replace(/[™®©]/g, ''));
