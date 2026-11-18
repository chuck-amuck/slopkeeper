import type Anthropic from '@anthropic-ai/sdk';
import type { Guild, GuildMember } from 'discord.js';
import { plain, Refused } from '../api/common.ts';
import { compareFromWeb, gameList, pickFromWeb, steamDown } from '../api/games.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { gameKey, gameName } from '../gameNames.ts';
import { setting } from '../settings.ts';
import { formatDuration, humansIn, listNames } from '../util.ts';
import { achievementProgress } from './achievements.ts';
import { dealBundles } from './deals.ts';
import { reviewGiveaways } from './freegames.ts';
import { searchSteam } from './gamefacts.ts';
import { allGames, choose, memberGames, ownersOfApp } from './games.ts';
import { checkpoint, PERIODS, playsIn, plural, sessionCount, stats, totalsBy } from './gamestats.ts';
import { AUTOPLAY } from './music.ts';
import { dealText, lowestPrice, money, onSale, priceCheck, saleName, saleReasons, salePrices } from './sales.ts';
import { checkpointVoice, voiceTotals } from './sessions.ts';
import { DECK_PLAYABLE, DECK_VERIFIED, linkFor, ownedSteamGames, patchNotesAtLength } from './steam.ts';

// What chat can look up for anyone in the server, read-only, from the same functions as the slash commands and the web
// UI, so it gives the same answers: games to play, a game's owners, play stats, deals, music played before, patch notes
// and achievements, and what's known about one person's gaming. Results name people and games, never their IDs

/** Rows in one answer, so a big server's lists don't fill the model's context */
const MOST_ROWS = 25;
const MOST_ALMOST = 8;
/** People or games listed when a name matches more than one */
const MOST_CHOICES = 8;
/** People whose last random pick it remembers, so “reroll” picks another */
const MOST_PICKS_KEPT = 500;
/** Someone's most played games listed, on Steam and here */
const TOP_GAMES = 3;
/** Each patch note, so three of them are about a thousand tokens */
const LONGEST_NOTE = 1500;

/** A tool's input: every property required and nothing else, as strict tools need */
export const object = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false });
const PEOPLE = {
  type: 'array',
  items: { type: 'string' },
  description: 'People by display name, or “me” for the person asking. Empty for everyone in their voice channel',
};
const GAME = { type: 'string', description: 'The game’s name as they said it' };

/** The lookup tools: achievements only with a Steam key, and songs played before only with music */
export function lookupTools(): Anthropic.Tool[] {
  return [
    {
      name: 'games_for',
      description:
        'Which multiplayer games a group can play together, as /whatdoweplay picks from: what they all own (on Steam, marked in the library, or through family sharing), co-op or PvP, Steam Deck support, time played here and on Steam, and games one purchase away. For “what should we play?” or “what do Sam and I both have?”.',
      strict: true,
      input_schema: object({
        people: PEOPLE,
        kind: { type: 'string', enum: ['any', 'coop', 'pvp'], description: 'any, unless they asked for co-op or PvP games' },
        steam_deck: { type: 'string', enum: ['any', 'playable', 'verified'], description: 'any, unless they asked for games that work on Steam Deck' },
      }),
    },
    {
      name: 'pick_game',
      description:
        'Picks one game at random from what a group can all play, as /whatdoweplay does, for “just pick one”, “choose for us” or “reroll”. Asked again by the same person, it picks a different one when it can.',
      strict: true,
      input_schema: object({
        people: PEOPLE,
        kind: { type: 'string', enum: ['any', 'coop', 'pvp'], description: 'any, unless they asked for co-op or PvP games' },
        steam_deck: { type: 'string', enum: ['any', 'playable', 'verified'], description: 'any, unless they asked for games that work on Steam Deck' },
      }),
    },
    {
      name: 'game_info',
      description:
        'One game people here have or play: who owns it (and through family sharing), who still needs it or wants it, its player limit, whether it’s on sale, and how long it’s been played here and by whom.',
      strict: true,
      input_schema: object({ game: GAME }),
    },
    {
      name: 'play_stats',
      description:
        'Games played in voice here and time in voice, as /gamestats and /compare show: the server’s most played games and biggest players, one person’s games, one game’s players, one person and one game, or two people compared (over all time).',
      strict: true,
      input_schema: object({
        period: { type: 'string', enum: ['week', 'month', 'year', 'all'], description: 'The past week, month or year, or all time. A month unless they say' },
        person: { type: 'string', description: 'One person, or “me”. Empty for the whole server' },
        game: { type: 'string', description: 'One game. Empty for every game' },
        compare_with: { type: 'string', description: 'A second person to compare the first with (or with the person asking). Empty otherwise' },
      }),
    },
    {
      name: 'about_person',
      description:
        'What the bot knows about someone’s gaming, for “what do you know about me?” or to roast them: their most played games on Steam and in voice here, with hours, and how many games they own and have never played.',
      strict: true,
      input_schema: object({ person: { type: 'string', description: 'Who, by display name, or “me” for the person asking' } }),
    },
    {
      name: 'deals',
      description:
        'Game deals: what the server plays or wants that’s on sale (as /sales), bundles with games for the server, free games worth grabbing, or the price of any game on Steam with the cheapest official store selling its key and its lowest price ever.',
      strict: true,
      input_schema: object({
        kind: { type: 'string', enum: ['sales', 'bundles', 'free_games', 'price'] },
        game: { type: 'string', description: 'For a price, the game. Empty otherwise' },
        person: { type: 'string', description: 'For sales, only what this person wants or has on their Steam wishlist, or “me”. Empty for everyone' },
      }),
    },
    ...(config.musicUrl
      ? [
          {
            name: 'music_history',
            description:
              'Songs played here before, newest first, with who added each and when, or the most played. Each has a ref queue_music takes, to play it again.',
            strict: true,
            input_schema: object({
              search: { type: 'string', description: 'Words in the song’s title or artist. Empty for any' },
              person: { type: 'string', description: 'Only songs this person added, or “me”. Empty for anyone' },
              most_played: { type: 'boolean', description: 'True for the most played songs rather than the latest' },
            }),
          },
        ]
      : []),
    {
      name: 'patch_notes',
      description: 'A game’s latest patch notes from Steam, newest first, to sum up what changed. For what’s in a game’s latest patch or update, use this before searching the web.',
      strict: true,
      input_schema: object({ game: GAME }),
    },
    ...(config.steamApiKey
      ? [
          {
            name: 'achievements',
            description:
              'How people are getting on with a Steam game’s achievements: how many each has, and the easiest ones none of them has yet. Needs linked Steam accounts with public game details.',
            strict: true,
            input_schema: object({ game: GAME, people: { ...PEOPLE, description: `${PEOPLE.description}, or just them when they aren’t in one` } }),
          },
        ]
      : []),
  ];
}

const LOOKUPS = new Set(['games_for', 'pick_game', 'game_info', 'play_stats', 'about_person', 'deals', 'music_history', 'patch_notes', 'achievements']);

/** What a lookup found, as the model is told it, or null if `name` isn't one */
export async function lookUp(member: GuildMember, name: string, input: Record<string, unknown>): Promise<string | null> {
  if (!LOOKUPS.has(name)) return null;
  // Those offered only with what they need, in case the model asks for one anyway
  if (name === 'achievements' && !config.steamApiKey) return 'Steam isn’t set up on this bot, so achievements can’t be looked up.';
  if (name === 'music_history' && !config.musicUrl) return 'Music isn’t set up on this bot.';
  const { guild } = member;
  const text = (key: string) => unquoted(String(input[key] ?? ''));
  try {
    switch (name) {
      case 'games_for':
        return await gamesFor(member, input.people, text('kind'), text('steam_deck'));
      case 'pick_game':
        return await pickGame(member, input.people, text('kind'), text('steam_deck'));
      case 'game_info':
        return await gameInfo(guild, text('game'));
      case 'play_stats':
        return await playStats(member, text('period'), text('person'), text('game'), text('compare_with'));
      case 'about_person':
        return aboutPerson(member, text('person'));
      case 'deals':
        return await deals(member, text('kind'), text('game'), text('person'));
      case 'music_history':
        return musicHistory(member, text('search'), text('person'), input.most_played === true);
      case 'patch_notes':
        return await patchNotes(guild, text('game'));
      case 'achievements':
        return await achievements(member, text('game'), input.people);
      default:
        return null;
    }
  } catch (err) {
    // The web UI's refusals say what's wrong in words, like Steam being down
    if (err instanceof Refused) return plain(guild, err.message);
    throw err;
  }
}

/** What the model gave, without the quotes it sometimes puts round a name, or sends for nothing: "", `` or a lone ` */
export const unquoted = (said: string) => {
  const text = said.trim();
  if (/^[\s"'`“”‘’]*$/.test(text)) return '';
  return text.replace(/^(["'`“”‘’])(.+)(["'`“”‘’])$/s, '$2').trim();
};

const SELF = new Set(['me', 'i', 'myself', 'my', 'mine']);
const humans = (guild: Guild) => [...guild.members.cache.values()].filter((m) => !m.user?.bot);
const namesOf = (m: GuildMember) => [m.displayName, m.user?.globalName, m.user?.username].flatMap((n) => (n ? [n.toLowerCase()] : []));

/** Someone by what they're called here, a mention, or “me”: exactly, or the only one whose name has it in it */
function personNamed(asker: GuildMember, said: string): GuildMember | string {
  const { guild } = asker;
  const mention = /^<@!?(\d+)>$/.exec(said.trim());
  if (mention) {
    const found = guild.members.cache.get(mention[1]!);
    return found && !found.user?.bot ? found : 'They aren’t in this server.';
  }
  const name = said.trim().replace(/^@/, '').toLowerCase();
  if (!name) return 'Say who.';
  if (SELF.has(name)) return asker;
  const exact = humans(guild).filter((m) => namesOf(m).includes(name));
  const close = exact.length ? exact : humans(guild).filter((m) => namesOf(m).some((n) => n.includes(name)));
  if (close.length === 1) return close[0]!;
  if (!close.length) return `Nobody here is called “${said.trim()}”.`;
  return `More than one person here matches “${said.trim()}”: ${listNames(close.slice(0, MOST_CHOICES).map((m) => m.displayName))}. Ask which one.`;
}

/** The people named, without repeats, or null when none were: the caller says who it's for then */
export function peopleNamed(asker: GuildMember, said: unknown): GuildMember[] | string | null {
  const names = Array.isArray(said) ? said.map((n) => unquoted(String(n))).filter(Boolean) : [];
  if (!names.length) return null;
  const found = new Map<string, GuildMember>();
  for (const name of names) {
    const person = personNamed(asker, name);
    if (typeof person === 'string') return person;
    found.set(person.id, person);
  }
  return [...found.values()];
}

const inVoiceWith = (member: GuildMember) => (member.voice?.channel ? humansIn(member.voice.channel) : []);

interface GameHit {
  name: string;
  appid: number | null;
  /** Steam's closest match, as nothing here or on Steam has the name asked for */
  closest?: boolean;
}

/** Every game people here have or have played, the library's first, then Steam libraries, then games only played */
function knownGames(guild: Guild): GameHit[] {
  checkpoint();
  const found = new Map<string, GameHit>();
  const add = (name: string, appid: number | null) => {
    const key = gameKey(name);
    const had = found.get(key);
    if (!had) found.set(key, { name, appid });
    else had.appid ??= appid;
  };
  for (const g of allGames(guild.id)) add(g.name, g.steam_appid);
  for (const g of memberGames(guild)) add(g.name, g.appid);
  for (const g of stats(guild.id, 0, 'none', 'game')) add(g.key, null);
  return [...found.values()];
}

/**
 * A game by name: one people here have or play, exactly or the only one with the name in it. With `anywhere`, one
 * nobody here has is looked up on Steam too
 */
async function gameNamed(guild: Guild, said: string, anywhere: boolean): Promise<GameHit | string> {
  if (!said) return 'Say which game.';
  const key = gameKey(said);
  const games = knownGames(guild);
  const exact = games.find((g) => gameKey(g.name) === key);
  if (exact && (exact.appid !== null || !anywhere)) return exact;
  // Steam's game of that very name comes before one here with the name in it, so “Portal” isn't taken for Portal 2.
  // With Steam down, a game here can still be found, and its kept patch notes read
  let down: unknown = null;
  const search = async (name: string) => (anywhere ? await searchSteam(name).catch((err) => ((down = err), [])) : []);
  const onSteam = await search(said);
  const steamExact = onSteam.find((item) => gameKey(item.name) === key);
  if (steamExact) return { name: steamExact.name, appid: steamExact.id };
  const close = exact ? [exact] : games.filter((g) => gameKey(g.name).includes(key));
  if (close.length > 1) return `More than one game here matches “${said}”: ${listNames(close.slice(0, MOST_CHOICES).map((g) => g.name))}. Ask which one.`;
  const [game] = close;
  if (game) {
    if (game.appid !== null || !anywhere) return game;
    // Known here only from play, so it has no Steam app yet, which a price, patch notes or achievements need
    const named = gameKey(game.name) === key ? onSteam : await search(game.name);
    const found = named.find((item) => gameKey(item.name) === gameKey(game.name));
    if (found) return { name: found.name, appid: found.id };
    // Not “it isn't on Steam” when Steam just didn't answer
    return down ? steamDown(down) : game;
  }
  if (!anywhere) return `Nobody here has or has played a game called “${said}”.`;
  if (down) steamDown(down);
  return onSteam[0] ? { name: onSteam[0].name, appid: onSteam[0].id, closest: true } : `Steam has no game called “${said}”.`;
}

/** Every name Stats has a game's plays under, which may not be how the library writes it, most played first */
function statsNames(guild: Guild, name: string): string[] {
  const keys = new Set([gameKey(name), gameKey(gameName(guild.id, name))]);
  const names = db.prepare('SELECT game, COUNT(*) AS n FROM named_plays WHERE guild_id = ? AND channel_id IS NOT NULL GROUP BY game ORDER BY n DESC').all(guild.id) as { game: string }[];
  // Once each regardless of case, as Stats matches a name that way
  const seen = new Set<string>();
  return names.map((r) => r.game).filter((g) => keys.has(gameKey(g)) && !seen.has(g.toLowerCase()) && seen.add(g.toLowerCase()));
}

/** Says when a game is only Steam's closest match, so the answer doesn't pass it off as the one asked for */
const closestNote = (hit: GameHit, said: string) => (hit.closest ? `Steam has no game called exactly “${said}”. Its closest match is ${hit.name}:\n` : '');

/** How long ago, in words, as the model is better at reading that than at working it out */
export function ago(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.round(days / 365)} years ago`;
}

const dateOf = (guild: Guild, at: number) => new Date(at).toLocaleDateString('en-US', { timeZone: setting(guild.id, 'timezone'), month: 'long', day: 'numeric', year: 'numeric' });
/** Someone by name for the model, or Autoplay for what it added */
export const nameOf = (guild: Guild, id: string) => (id === AUTOPLAY ? 'Autoplay' : (guild.members.cache.get(id)?.displayName ?? 'someone who left'));
const more = (rows: unknown[], shown: number) => (rows.length > shown ? `…and ${rows.length - shown} more.` : '');
/** A name as a sentence, without a second stop after “RV There Yet?” */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
/** Names with times, like “Valheim (3h), Deep Rock Galactic (1h)”, as a number after a name can read as part of it */
const timed = (rows: { name: string; ms: number }[]) => rows.map((r) => `${r.name} (${formatDuration(r.ms)})`).join(', ');

/**
 * What's known about one person's gaming: their most played games here and on Steam, and the games they own and never
 * played. Never what chat remembers about them, which stays with their own questions. Their achievements are the
 * achievements lookup's, so a roast reaches for them only when it has nothing better
 */
function aboutPerson(asker: GuildMember, said: string): string {
  const { guild } = asker;
  const person = personNamed(asker, said || 'me');
  if (typeof person === 'string') return person;
  checkpoint();
  checkpointVoice();
  const games = stats(guild.id, 0, 'user', 'game', person.id);
  const voice = voiceTotals(guild.id, 0).find((v) => v.userId === person.id);
  const lines = [
    `${person.displayName}:`,
    games.length ? `Most played in voice here: ${timed(games.slice(0, TOP_GAMES).map((g) => ({ name: g.key, ms: g.ms })))}.` : 'No games played in voice here.',
    voice ? `In voice here for ${formatDuration(voice.secs * 1000)} on ${plural(voice.nights, 'day')}.` : '',
    ...onSteam(person),
  ];
  return lines.filter(Boolean).join('\n');
}

function onSteam(person: GuildMember): string[] {
  const link = linkFor(person.id);
  if (!link) return ['No Steam account linked.'];
  if (link.private) return ['Their Steam game details are private.'];
  const owned = [...ownedSteamGames(person.id)].map(([appid, g]) => ({ appid, name: g.name, minutes: g.playtime }));
  if (!owned.length) return ['Their Steam games haven’t been read yet.'];
  const top = owned.filter((g) => g.minutes > 0 && g.name).sort((a, b) => b.minutes - a.minutes);
  const never = owned.filter((g) => g.minutes === 0).length;
  return [
    `Owns ${plural(owned.length, 'game')} on Steam, ${never} never played.`,
    top.length ? `Most played on Steam: ${timed(top.slice(0, TOP_GAMES).map((g) => ({ name: g.name!, ms: g.minutes * 60_000 })))}.` : '',
  ];
}

type GroupGame = Awaited<ReturnType<typeof pickFromWeb>>['ready'][number];

/** A game a group could play, with what's worth knowing about it, as a line of a list */
function groupLine(r: GroupGame) {
  const facts = [
    r.coop && r.pvp ? 'co-op and PvP' : r.coop ? 'co-op' : r.pvp ? 'PvP' : null,
    r.deck >= DECK_VERIFIED ? 'Steam Deck verified' : r.deck >= DECK_PLAYABLE ? 'playable on Steam Deck' : null,
    r.playedMs ? `${formatDuration(r.playedMs)} played here between them${r.last ? `, last ${ago(r.last)}` : ''}` : 'not played here yet',
    r.steamMinutes ? `${formatDuration(r.steamMinutes * 60_000)} on Steam between them` : null,
    r.borrowed.length ? `${listNames(r.borrowed)} through family sharing` : null,
    r.missing.length ? `${listNames(r.missing)} doesn’t have it` : null,
  ];
  return `- ${r.name}: ${facts.filter(Boolean).join('; ')}`;
}

/** What the people named, or those in voice with the asker, could play together, most played first, or what's wrong */
async function groupGames(asker: GuildMember, said: unknown, kind: string, deck: string) {
  const { guild } = asker;
  const named = peopleNamed(asker, said);
  if (typeof named === 'string') return named;
  const people = named ?? inVoiceWith(asker);
  if (!people.length) return 'They aren’t in a voice channel and didn’t say who’s playing, so ask who it’s for.';
  const url = new URL('http://chat/');
  url.searchParams.set('users', people.map((m) => m.id).join(','));
  const picked = await pickFromWeb(guild, url);
  const fits = (r: GroupGame) => (kind !== 'coop' || r.coop) && (kind !== 'pvp' || r.pvp) && r.deck >= (deck === 'verified' ? DECK_VERIFIED : deck === 'playable' ? DECK_PLAYABLE : 0);
  // What they've played most together first, then what they've put most time into on Steam
  const byPlayed = (a: GroupGame, b: GroupGame) => b.playedMs - a.playedMs || b.steamMinutes - a.steamMinutes;
  const almost = picked.almost.filter(fits).sort(byPlayed);
  const filtered = kind !== 'any' || deck !== 'any' ? ' like that' : '';
  const all = picked.counted === 2 ? 'both' : 'all';
  return {
    people,
    picked,
    ready: picked.ready.filter(fits).sort(byPlayed),
    /** "One purchase away:" and those games, or nothing */
    oneAway: almost.length ? ['One purchase away:', ...almost.slice(0, MOST_ALMOST).map(groupLine)] : [],
    filtered,
    all,
    none: `No multiplayer game${filtered} is owned by ${all} of them and fits ${people.length} players.`,
  };
}

async function gamesFor(asker: GuildMember, said: unknown, kind: string, deck: string) {
  const found = await groupGames(asker, said, kind, deck);
  if (typeof found === 'string') return found;
  const { people, picked, ready, oneAway, filtered, all, none } = found;
  return [
    `For ${listNames(people.map((m) => m.displayName))}: ${picked.counted} of ${picked.people} have games the bot knows about.`,
    ...picked.notes,
    ready.length ? `Games they ${all} have${filtered}, most played here first:` : none,
    ...ready.slice(0, MOST_ROWS).map(groupLine),
    more(ready, MOST_ROWS),
    ...oneAway,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The game picked last for each person, by server */
const lastPicks = new Map<string, string>();

/** One game at random from what they could all play, as /whatdoweplay picks, other than the last one picked for them */
async function pickGame(asker: GuildMember, said: unknown, kind: string, deck: string) {
  const found = await groupGames(asker, said, kind, deck);
  if (typeof found === 'string') return found;
  const { people, picked, ready, oneAway, filtered, all, none } = found;
  const who = `For ${listNames(people.map((m) => m.displayName))}`;
  if (!ready.length) return [`${who}: ${none}`, ...picked.notes, ...oneAway].join('\n');
  const key = `${asker.guild.id}:${asker.id}`;
  const pick = choose(ready, lastPicks.get(key));
  lastPicks.delete(key);
  lastPicks.set(key, pick.name);
  if (lastPicks.size > MOST_PICKS_KEPT) lastPicks.delete(lastPicks.keys().next().value!);
  const how = ready.length === 1 ? `${pick.name} is the only game they ${all} have${filtered}:` : `picked at random from the ${ready.length} games they ${all} have${filtered}:`;
  return [`${who}, ${how}`, groupLine(pick), ...picked.notes].join('\n');
}

async function gameInfo(guild: Guild, said: string) {
  const hit = await gameNamed(guild, said, false);
  if (typeof hit === 'string') return hit;
  const listed = gameList(guild).games.find((g) => gameKey(g.name) === gameKey(hit.name) || (hit.appid !== null && g.appid === hit.appid));
  const names = (people: { name: string }[]) => listNames(people.map((p) => p.name));
  const owners = listed ? listed.owners : hit.appid === null ? [] : [...ownersOfApp(guild, hit.appid)].map((id) => ({ name: nameOf(guild, id) }));
  const sale = hit.appid === null ? undefined : salePrices(guild.id).get(hit.appid);
  // Under every name it was played as, as one game. The total and the players come from the same plays, so they agree
  const plays = statsNames(guild, hit.name).flatMap((name) => playsIn(guild.id, 0, Date.now(), undefined, name).map((p) => ({ ...p, game: hit.name })));
  const played = totalsBy(plays, 'game')[0];
  const players = totalsBy(plays, 'user_id').filter((p) => guild.members.cache.has(p.key));
  const low = sale && lowestPrice(sale, sale.lowest);
  return [
    `${sentence(`${hit.name}${listed?.maxPlayers ? `, for up to ${listed.maxPlayers} players` : ''}`)} ${listed ? 'It’s in the server’s game library.' : 'It isn’t in the server’s game library.'}`,
    owners.length ? `Owned by ${names(owners)}.` : 'Nobody here owns it, that the bot knows of.',
    listed?.family.length ? `Can play it through family sharing: ${names(listed.family)}.` : '',
    listed ? (listed.needs.length ? `Still needs it: ${names(listed.needs)}.` : 'Everyone in the group has it.') : '',
    listed?.wanted.length ? `Wanted by ${names(listed.wanted)}.` : '',
    sale ? `On sale: ${dealText(sale)}${low ? ` ${low.text}.` : ''}` : 'Not on sale at the last price check.',
    played ? `Played in voice here for ${formatDuration(played.ms)} in all, last ${ago(played.last)}.` : 'Not played in voice here yet.',
    players.length ? `Most played by: ${timed(players.slice(0, 5).map((p) => ({ name: nameOf(guild, p.key), ms: p.ms })))}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function playStats(asker: GuildMember, periodName: string, personSaid: string, gameSaid: string, otherSaid: string) {
  const { guild } = asker;
  const period = PERIODS[(Object.hasOwn(PERIODS, periodName) ? periodName : 'month') as keyof typeof PERIODS];
  const since = Number.isFinite(period.ms) ? Date.now() - period.ms : 0;
  const person = personSaid ? personNamed(asker, personSaid) : null;
  if (typeof person === 'string') return person;
  const other = otherSaid ? personNamed(asker, otherSaid) : null;
  if (typeof other === 'string') return other;
  checkpoint();
  checkpointVoice();
  const isMember = (id: string) => guild.members.cache.has(id);
  const time = (rows: { key: string; ms: number }[], label: (key: string) => string) => timed(rows.slice(0, MOST_ROWS).map((r) => ({ name: label(r.key), ms: r.ms })));
  const who = (id: string) => nameOf(guild, id);

  if (other) {
    const first = person ?? asker;
    if (first.id === other.id) return 'Pick two different people.';
    const url = new URL('http://chat/');
    url.searchParams.set('a', first.id);
    url.searchParams.set('b', other.id);
    const c = compareFromWeb(guild, url);
    return [
      `${first.displayName} and ${other.displayName}, over all time:`,
      `Games played together in voice: ${formatDuration(c.togetherMs)}${c.games.length ? `: ${timed(c.games)}` : ''}.`,
      `In voice together ${plural(c.voice.sessions, 'time')}, for ${formatDuration(c.voice.ms)}.`,
      `Games played in voice in all: ${timed(c.people)}.`,
      c.shared.length
        ? `Games they both own (${c.shared.length}): ${c.shared.slice(0, MOST_ROWS).join(', ')}${c.shared.length > MOST_ROWS ? ', and more' : ''}.`
        : 'They don’t both own any game the bot knows of.',
    ].join('\n');
  }

  let game: string | null = null;
  if (gameSaid) {
    const hit = await gameNamed(guild, gameSaid, false);
    if (typeof hit === 'string') return hit;
    game = statsNames(guild, hit.name)[0] ?? hit.name;
  }
  const label = `(${period.label}, games played in voice)`;

  if (person && game) {
    const players = stats(guild.id, since, 'game', 'user_id', undefined, game).filter((r) => isMember(r.key));
    const place = players.findIndex((r) => r.key === person.id);
    if (place < 0) return `${person.displayName} hasn’t played ${game} in voice ${period.ms === Infinity ? 'here' : `in the ${period.label}`}.`;
    const mine = players[place]!;
    return `${person.displayName} played ${game} for ${formatDuration(mine.ms)} over ${plural(sessionCount(guild.id, person.id, game, since), 'session')}, last ${ago(mine.last)}: number ${place + 1} of ${players.length} players here ${label}.`;
  }
  if (person) {
    const games = stats(guild.id, since, 'user', 'game', person.id);
    const voice = voiceTotals(guild.id, since).find((v) => v.userId === person.id);
    return [
      `${person.displayName} ${label}:`,
      voice ? `In voice for ${formatDuration(voice.secs * 1000)} on ${voice.nights} days.` : 'Not in voice.',
      games.length ? `Games: ${time(games, (key) => key)}.` : 'No games played in voice.',
    ].join('\n');
  }
  if (game) {
    const players = stats(guild.id, since, 'game', 'user_id', undefined, game).filter((r) => isMember(r.key));
    if (!players.length) return `Nobody played ${game} in voice ${label}.`;
    const total = stats(guild.id, since, 'game', 'game', undefined, game).reduce((sum, g) => sum + g.ms, 0);
    return `${game} ${label}: played for ${formatDuration(total)} by ${players.length === 1 ? '1 person' : `${players.length} people`}: ${time(players, who)}.`;
  }
  const games = stats(guild.id, since, 'none', 'game');
  const players = stats(guild.id, since, 'none', 'user_id').filter((r) => isMember(r.key));
  const voice = voiceTotals(guild.id, since).filter((v) => isMember(v.userId));
  if (!games.length && !voice.length) return `Nothing played in voice ${label}.`;
  return [
    `The server ${label}: ${formatDuration(games.reduce((sum, g) => sum + g.ms, 0))} across ${plural(games.length, 'game')} by ${players.length === 1 ? '1 person' : `${players.length} people`}.`,
    games.length ? `Most played games: ${time(games, (key) => key)}.` : '',
    players.length ? `Biggest players: ${time(players, who)}.` : '',
    voice.length ? `Most time in voice: ${timed(voice.slice(0, MOST_ROWS).map((v) => ({ name: who(v.userId), ms: v.secs * 1000 })))}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function deals(asker: GuildMember, kind: string, gameSaid: string, personSaid: string) {
  const { guild } = asker;
  const who = (id: string) => nameOf(guild, id);
  if (kind === 'price') {
    const hit = await gameNamed(guild, gameSaid, true);
    if (typeof hit === 'string') return hit;
    if (hit.appid === null) return `${hit.name} isn’t on Steam, so its price can’t be checked.`;
    const { steam, store } = await priceCheck(hit.appid, setting(guild.id, 'steamCountry')).catch(steamDown);
    const owners = [...ownersOfApp(guild, hit.appid)].map(who);
    const steamLine = !steam
      ? `${hit.name} isn’t sold on Steam right now, or it’s free.`
      : steam.discount_percent
        ? `${hit.name} on Steam: ${steam.discount_percent}% off, ${steam.final_formatted}, normally ${steam.initial_formatted}.`
        : `${hit.name} on Steam: ${steam.final_formatted}, not on sale.`;
    const lines = [
      steamLine,
      store?.now != null && store.shop ? `Cheapest official store selling it as a Steam key: ${store.shop}, ${money(store.now, store.currency)}.` : '',
      store?.lowest != null ? `Lowest price a Steam key has ever had: ${money(store.lowest, store.currency)}.` : '',
      owners.length ? `Owned here by ${listNames(owners)}.` : 'Nobody here owns it, that the bot knows of.',
    ];
    return closestNote(hit, gameSaid) + lines.filter(Boolean).join('\n');
  }
  if (kind === 'bundles') {
    if (!config.itadKey) return 'Bundles need an IsThereAnyDeal key on the bot.';
    if (!setting(guild.id, 'bundleAlerts')) return 'Bundles are turned off for this server.';
    const kept = dealBundles(guild.id);
    if (!kept) return 'The bundles haven’t been looked through yet.';
    if (!kept.bundles.length) return 'No running bundle has games for this server.';
    return kept.bundles
      .slice(0, MOST_ROWS)
      .map((b) => {
        const games = b.games.map((m) => `${m.title} ${m.where}${m.wanted ? ` (${saleReasons(m.wanted, who)})` : m.like ? ` (${m.like})` : ''}`);
        return `- ${b.title} on ${b.site}${b.from ? `, from ${b.from}` : ''}${b.expiry ? `, until ${dateOf(guild, Date.parse(b.expiry))}` : ''}: ${games.join('; ')}`;
      })
      .join('\n');
  }
  if (kind === 'free_games') {
    const all = await reviewGiveaways(guild).catch((err) => {
      console.error(err);
      throw new Refused(502, 'The free game list couldn’t be read just now.');
    });
    const shown = all.filter((g) => g.show);
    const left = all.length - shown.length;
    if (!shown.length) return left ? `${left === 1 ? 'The 1 free game going now doesn’t' : `The ${left} free games going now don’t`} fit this server’s free game settings.` : 'No games are free to keep right now.';
    const skipped = left ? `${left} more didn’t fit this server’s free game settings.` : '';
    return [
      'Free to keep now:',
      ...shown.slice(0, MOST_ROWS).map((g) => `- ${g.title} on ${g.platforms}${g.worth ? `, normally ${g.worth}` : ''}${g.reason ? `: ${g.reason}` : ''}`),
      skipped,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const person = personSaid ? personNamed(asker, personSaid) : null;
  if (typeof person === 'string') return person;
  const games = (await onSale(guild)).filter((g) => !person || g.wanted.includes(person.id) || g.wishlisted.includes(person.id));
  if (!games.length) return person ? `Nothing ${person.displayName} wants or has on their Steam wishlist is on sale, as of the last price check.` : 'Nothing the server plays or wants is on sale, as of the last price check.';
  return [
    `On sale at the last price check${person ? `, that ${person.displayName} wants` : ''}, most wanted first:`,
    ...games.slice(0, MOST_ROWS).map((g) => {
      const low = lowestPrice(g, g.lowest);
      return `- ${saleName(g)}: ${dealText(g)}${low ? ` ${low.text}.` : ''} ${saleReasons(g, who)}`.trim();
    }),
    more(games, MOST_ROWS),
  ]
    .filter(Boolean)
    .join('\n');
}

function musicHistory(asker: GuildMember, search: string, personSaid: string, most: boolean) {
  const { guild } = asker;
  const person = personSaid ? personNamed(asker, personSaid) : null;
  if (typeof person === 'string') return person;
  // Each word in the title or the artist, so “killers brightside” finds Mr. Brightside by The Killers
  const likes = search
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const where = `guild_id = ?${likes.map(() => " AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')").join('')}${person ? ' AND added_by = ?' : ''}`;
  const args = [guild.id, ...likes.flatMap((like) => [like, like]), ...(person ? [person.id] : [])];
  // A link or Spotify song can go back in the queue; an uploaded file may be gone
  const ref = (uri: string) => (/^(spotify:track:|https?:\/\/)/.test(uri) ? ` (ref ${uri})` : '');
  if (most) {
    const rows = db
      .prepare(`SELECT title, artist, MAX(uri) AS uri, COUNT(*) AS n, MAX(at) AS last FROM music_plays WHERE ${where} GROUP BY lower(title), lower(artist) ORDER BY n DESC, last DESC LIMIT ${MOST_ROWS}`)
      .all(...args) as { title: string; artist: string; uri: string; n: number; last: number }[];
    if (!rows.length) return 'Nothing like that has been played here.';
    return ['Most played here:', ...rows.map((r) => `- “${r.title}” by ${r.artist}: ${r.n} ${r.n === 1 ? 'time' : 'times'}, last ${ago(r.last)}${ref(r.uri)}`)].join('\n');
  }
  const rows = db
    .prepare(`SELECT title, artist, uri, added_by AS addedBy, at, skipped FROM music_plays WHERE ${where} ORDER BY at DESC LIMIT ${MOST_ROWS}`)
    .all(...args) as { title: string; artist: string; uri: string; addedBy: string; at: number; skipped: number }[];
  if (!rows.length) return 'Nothing like that has been played here.';
  return ['Played here, newest first:', ...rows.map((r) => `- “${r.title}” by ${r.artist}, added by ${nameOf(guild, r.addedBy)}, ${ago(r.at)}${r.skipped ? ', skipped' : ''}${ref(r.uri)}`)].join('\n');
}

async function patchNotes(guild: Guild, said: string) {
  const hit = await gameNamed(guild, said, true);
  if (typeof hit === 'string') return hit;
  if (hit.appid === null) return `${hit.name} isn’t on Steam, so there are no patch notes to read.`;
  // Steam's, as what the patch notes feature kept stops when a game is no longer played. Those stand in if Steam is down
  const fromSteam = await patchNotesAtLength(hit.appid).catch((err) => (console.error(err), null));
  const notes = (
    fromSteam ??
    (db.prepare('SELECT title, url, date, text FROM patch_posts WHERE guild_id = ? AND appid = ? ORDER BY date DESC LIMIT 3').all(guild.id, hit.appid) as {
      title: string;
      url: string;
      date: number;
      text: string;
    }[])
  ).slice(0, 3);
  if (!notes.length) return fromSteam ? `Steam has no recent patch notes for ${hit.name}.` : 'Steam couldn’t be reached just now. Try again in a bit.';
  // A line a paragraph, under its note
  const short = (text: string) => (text.length > LONGEST_NOTE ? `${text.slice(0, LONGEST_NOTE - 1)}…` : text).replace(/\n/g, '\n  ');
  return (
    closestNote(hit, said) +
    [`${hit.name}’s latest patch notes, newest first:`, ...notes.map((n) => `- “${n.title}”, ${dateOf(guild, n.date)} (${n.url}): ${short(n.text)}`)].join('\n')
  );
}

async function achievements(asker: GuildMember, said: string, peopleSaid: unknown) {
  const { guild } = asker;
  const hit = await gameNamed(guild, said, true);
  if (typeof hit === 'string') return hit;
  if (hit.appid === null) return `${hit.name} isn’t on Steam, so it has no achievements to check.`;
  const named = peopleNamed(asker, peopleSaid);
  if (typeof named === 'string') return named;
  const voice = inVoiceWith(asker);
  const people = named ?? (voice.length ? voice : [asker]);
  const { total, people: done, skipped, goals } = await achievementProgress(hit.appid, people.map((m) => m.id)).catch(steamDown);
  if (!total) return `${hit.name} has no achievements on Steam.`;
  const who = (id: string) => nameOf(guild, id);
  const lines = [
    `${hit.name} has ${total} achievements.`,
    done.length ? `Unlocked: ${done.map((p) => `${who(p.id)} ${p.done}`).join(', ')}.` : '',
    skipped.length ? `Can’t see ${listNames(skipped.map(who))}: no linked Steam account, or their game details are private.` : '',
    goals.length
      ? `None of them has these yet, most common first: ${goals.map((g) => `${g.name}${g.description ? ` (${g.description})` : ''}${g.percent !== null ? `, ${g.percent}% of players` : ''}`).join('; ')}.`
      : '',
  ];
  return closestNote(hit, said) + lines.filter(Boolean).join('\n');
}
