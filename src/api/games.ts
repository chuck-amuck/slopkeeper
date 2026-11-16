import { type Guild } from 'discord.js';
import { type IncomingMessage } from 'node:http';
import { logActivity } from '../activity.ts';
import { config } from '../config.ts';
import { reviewGiveaways } from '../features/freegames.ts';
import { achievementProgress } from '../features/achievements.ts';
import { addGameRole, canHandOut, gameRoles, pingableGames, pingChoices, pingMenu, removeGameRole } from '../features/gameroles.ts';
import { addGame, addMemberGame, allGames, familyPlayersOf, gameById, groupMembers, hiddenGames, hideGame, libraryKnown, memberGames, NOBODY_COUNTED, ownersOf, parseSteamAppId, removeGame, setGameDetails, setOwned, setWanted, steamOwnersOf, unhideGame, wantedBy, type GameRow } from '../features/games.ts';
import { dealText, lowestPrice, onSale, saleName, salePrices, saleReasons, storeUrl } from '../features/sales.ts';
import { dealBundles } from '../features/deals.ts';
import { currentPlayers, familyOf, patchNotes, joinFamily, leaveFamily, linkSteam, lobbiesIn, profileUrl, refreshAll, steamLinks, unlinkSteam } from '../features/steam.ts';
import { activityIn, checkpoint, comparison, PERIODS, peopleWithStats, pickFor, playedByKey, playsIn, sessionCount, stats, totalsBy } from '../features/gamestats.ts';
import { postVote } from '../features/gamevote.ts';
import { recapFor } from '../features/recap.ts';
import { countAsGame, gameKey, gameName, gameSpellings, markNotAGame, mergeGames, notGames, separateGame } from '../gameNames.ts';
import { countIn, nightTimes, peopleIn, recordsFrom, sessionTime, soundTimes, spread, stepsOf, voiceFrom, voiceStints, whenOn } from '../features/overview.ts';
import { checkpointVoice, voiceTotals } from '../features/sessions.ts';
import { idSetting, setting } from '../settings.ts';
import { humansIn, pingWarning, zonedParts, zonedTimeToUtc } from '../util.ts';
import { type Ask, Refused, by, cantPost, datesWindow, memberIn, memberList, nameOf, plain, postingChannel, readJson, refuse, textChannels, voiceChannelFor } from './common.ts';
import { voiceList } from './live.ts';

// The management API for games, Steam accounts, picking and voting, stats, sales, free games and game pings

const MAX_RANKED = 15;

export function gamePingList(guild: Guild) {
  const taken = gameRoles(guild.id);
  const used = new Set(taken.map((r) => r.role_id));
  const named = new Set(taken.map((r) => r.name.toLowerCase()));
  return {
    pings: taken.map((r) => {
      const role = guild.roles.cache.get(r.role_id);
      return { id: r.role_id, game: r.name, role: role?.name ?? null, people: role?.members.size ?? 0, made: !!r.created };
    }),
    games: pingableGames(guild.id).filter((name) => !named.has(name.toLowerCase())),
    roles: [...guild.roles.cache.values()]
      .filter((r) => canHandOut(guild, r) && !used.has(r.id))
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name })),
  };
}

export async function addGamePing(guild: Guild, req: IncomingMessage) {
  const { game, roleId } = await readJson(req);
  const name = typeof game === 'string' ? game.trim() : '';
  if (!name || name.length > 100) throw new Refused(400, 'Give a game’s name in 100 characters or fewer.');
  const role = roleId === undefined || roleId === null ? null : guild.roles.cache.get(String(roleId));
  if (role === undefined) throw new Refused(404, 'That role isn’t in this server.');
  const result = await addGameRole(guild, name, role, 'the web UI').catch((err: unknown) => {
    console.error(err);
    throw new Refused(502, 'Discord wouldn’t make the role. Check that the bot has Manage Roles.');
  });
  if (typeof result === 'string') throw new Refused(409, plain(guild, result));
  logActivity(guild.id, by(), `Added game pings for **${name}**`);
  const warning = pingWarning(result.role).trim();
  return { warning: warning ? plain(guild, warning) : null };
}

export async function removeGamePing(guild: Guild, roleId: string) {
  const row = gameRoles(guild.id).find((r) => r.role_id === roleId);
  if (!row) throw new Refused(404, 'That game has no ping role any more.');
  await removeGameRole(guild, row, 'the web UI');
  logActivity(guild.id, by(), `Removed game pings for **${row.name}**`);
  return {};
}

export async function handleHidden(guild: Guild, req: IncomingMessage, id: string) {
  const appid = /^\d+$/.test(id) ? Number(id) : undefined;
  if (req.method === 'PUT') {
    // Suggestions also come from members' Steam libraries, so a game needn't be in this server's library
    const { name } = await readJson(req);
    const given = typeof name === 'string' && name.length <= 100 ? name.trim() : '';
    const title = allGames(guild.id).find((g) => g.steam_appid === appid)?.name ?? given;
    if (!appid || !title) throw new Refused(404, 'Only a game with a Steam link can be hidden.');
    hideGame(guild.id, appid, title, by());
    logActivity(guild.id, by(), `Hid **${title}** from suggestions`);
    return {};
  }
  if (req.method === 'DELETE') {
    const game = hiddenGames(guild.id).find((g) => g.appid === appid);
    if (!game) throw new Refused(404, 'That game isn’t hidden.');
    unhideGame(guild.id, game.appid);
    logActivity(guild.id, by(), `Let **${game.name}** be suggested again`);
    return {};
  }
  throw new Refused(405, 'Not here.');
}

/** Where someone ranks among a game's players */
function placeOf(guild: Guild, user: string, game: string, since: number, until: number) {
  const players = stats(guild.id, since, 'game', 'user_id', undefined, game, until).filter((r) => guild.members.cache.has(r.key));
  const idx = players.findIndex((r) => r.key === user);
  return idx < 0 ? null : { rank: idx + 1, of: players.length, sessions: sessionCount(guild.id, user, game, since, until) };
}

/** Ranges the web UI offers besides /stats' periods, from the start of a day in the server's time zone */
const WEB_PERIODS: Record<string, (now: number, timeZone: string) => number> = {
  today: (now, tz) => {
    const { year, month, day } = zonedParts(now, tz);
    return zonedTimeToUtc(year, month, day, 0, 0, tz);
  },
  quarter: (now, tz) => {
    const { year, month, day } = zonedParts(now, tz);
    return zonedTimeToUtc(year, month, day - 89, 0, 0, tz);
  },
  thisYear: (now, tz) => zonedTimeToUtc(zonedParts(now, tz).year, 1, 1, 0, 0, tz),
};

/** Where the stretch before starts for a period that starts on the calendar: yesterday's or last year's start */
const CALENDAR_BEFORE: Record<string, (since: number, timeZone: string) => number> = {
  today: (since, tz) => {
    const { year, month, day } = zonedParts(since, tz);
    return zonedTimeToUtc(year, month, day - 1, 0, 0, tz);
  },
  thisYear: (since, tz) => zonedTimeToUtc(zonedParts(since, tz).year - 1, 1, 1, 0, 0, tz),
};

/**
 * Where a stats request starts and ends: whole days (`fromDate` and `toDate`), `from` and `to` in ms, or a `period`
 * up to now. `before` is where the stretch to compare with starts: today is compared with yesterday up to the same
 * time, this year with last year up to the same day, and anything else with the same length just before
 */
export function statsWindow(url: URL, timeZone: string, now = Date.now()) {
  const days = datesWindow(url, timeZone);
  if (days) return { since: days.since, until: Math.min(days.until, now) };
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from !== null || to !== null) {
    const since = Number(from ?? 0);
    const until = Math.min(Number(to ?? now), now);
    if (!Number.isSafeInteger(since) || !Number.isFinite(until) || since < 0 || since >= until) throw new Refused(400, 'Pick a start before the end.');
    return { since, until };
  }
  const period = url.searchParams.get('period') ?? 'month';
  if (Object.hasOwn(WEB_PERIODS, period)) {
    const since = WEB_PERIODS[period](now, timeZone);
    return { since, until: now, ...(Object.hasOwn(CALENDAR_BEFORE, period) && { before: CALENDAR_BEFORE[period](since, timeZone) }) };
  }
  if (!Object.hasOwn(PERIODS, period)) throw new Refused(400, 'No such period.');
  const { ms } = PERIODS[period as keyof typeof PERIODS];
  return { since: Number.isFinite(ms) ? now - ms : 0, until: now };
}

/** The same numbers as /gamestats and /stats, for the web UI's charts */
/** Trending shows for periods between a week and a quarter, and a change of less than this isn't one */
const TRENDING_DAYS = [7, 92];
const TRENDING_LEAST_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/** Game, voice, sound and game night totals for a period, as the Overview's tiles show them */
function totalsIn(guild: Guild, since: number, until: number, user?: string, game?: string) {
  const isMember = (id: string) => guild.members.cache.has(id);
  const plays = playsIn(guild.id, since, until, user, game);
  const games = totalsBy(plays, 'game');
  const players = totalsBy(plays, 'user_id').filter((r) => isMember(r.key));
  // Voice time and sounds aren't per game, so they only apply when no game is picked
  const voice = game ? [] : voiceTotals(guild.id, since, until).filter((p) => isMember(p.userId) && (!user || p.userId === user));
  const sounds = game ? null : soundTimes(guild.id, since, until, user);
  const nights = nightTimes(guild.id, since, until, user, game);
  return {
    plays,
    games,
    players,
    voice,
    sounds,
    nights,
    totals: {
      gameMs: games.reduce((sum, g) => sum + g.ms, 0),
      playerMs: players.reduce((sum, p) => sum + p.ms, 0),
      games: games.length,
      people: players.length,
      voiceMs: voice.reduce((sum, p) => sum + p.secs * 1000, 0),
      sounds: sounds?.length ?? null,
      nights: nights.length,
    },
  };
}

/** The games whose time rose or fell most against the stretch before, three each way */
function trendingOf(now: { key: string; ms: number }[], before: { key: string; ms: number }[]) {
  const was = new Map(before.map((g) => [g.key, g.ms]));
  const is = new Map(now.map((g) => [g.key, g.ms]));
  const changes = [...new Set([...is.keys(), ...was.keys()])]
    .map((name) => ({ name, ms: is.get(name) ?? 0, previousMs: was.get(name) ?? 0 }))
    .map((g) => ({ ...g, change: g.ms - g.previousMs }))
    .filter((g) => Math.abs(g.change) >= TRENDING_LEAST_MS);
  return {
    up: changes.filter((g) => g.change > 0).sort((a, b) => b.change - a.change).slice(0, 3),
    down: changes.filter((g) => g.change < 0).sort((a, b) => a.change - b.change).slice(0, 3),
  };
}

export function statsFor(guild: Guild, url: URL) {
  const user = url.searchParams.get('user') || undefined;
  const game = url.searchParams.get('game') || undefined;
  const timeZone = setting(guild.id, 'timezone');
  const { since, until: now, before: startBefore } = statsWindow(url, timeZone);
  const isMember = (id: string) => guild.members.cache.has(id);

  checkpoint();
  checkpointVoice();
  // One read of each kind of record serves every total and chart
  const here = totalsIn(guild, since, now, user, game);
  const from = recordsFrom(guild.id);
  // Charts start at the first record, so weeks before the bot was noting anything don't show as empty or thin the
  // averages of when people are on
  const first = from === null ? since || now : Math.max(since, Math.min(from, now));
  const steps = stepsOf(first, now, timeZone);
  const stints = game ? [] : voiceStints(guild.id, first, now, user).filter((s) => isMember(s.userId));

  // The stretch just before, as long as this one, once there are records from its start
  const start = startBefore ?? since - (now - since);
  const end = Math.min(since, start + (now - since));
  const before = since > 0 && from !== null && from <= start ? totalsIn(guild, start, end, user, game) : null;
  const earlier = (rows: { key: string; ms: number }[]) => new Map(rows.map((r) => [r.key, r.ms]));
  const gamesBefore = before && earlier(before.games);
  const playersBefore = before && earlier(before.players);
  const voiceBefore = before && new Map(before.voice.map((p) => [p.userId, p.secs * 1000]));
  const days = (now - since) / DAY_MS;

  return {
    timeZone,
    user: user ? { id: user, name: nameOf(guild, user) } : null,
    game: game ?? null,
    spellings: game ? (gameSpellings(guild.id).get(gameName(guild.id, game)) ?? []).filter((raw) => raw !== gameName(guild.id, game)) : [],
    totals: here.totals,
    place: user && game ? placeOf(guild, user, game, since, now) : null,
    since,
    until: now,
    recordsFrom: from,
    // Before this, when people are on counts only people playing a game Discord shows
    voiceFrom: voiceFrom(guild.id),
    previous: before && { since: start, until: end, totals: before.totals },
    games: here.games.slice(0, MAX_RANKED).map((g) => ({ name: g.key, ms: g.ms, people: g.n, last: g.last, previousMs: gamesBefore?.get(g.key) ?? (before ? 0 : null) })),
    players: here.players.slice(0, MAX_RANKED).map((p) => ({ id: p.key, name: nameOf(guild, p.key), ms: p.ms, games: p.n, last: p.last, previousMs: playersBefore?.get(p.key) ?? (before ? 0 : null) })),
    voice: here.voice.slice(0, MAX_RANKED).map((p) => ({ id: p.userId, name: nameOf(guild, p.userId), ms: p.secs * 1000, nights: p.nights, previousMs: voiceBefore?.get(p.userId) ?? (before ? 0 : null) })),
    activity: activityIn(here.plays, steps, game ? [] : here.games.slice(0, 5).map((g) => g.key)),
    // A small line under each tile, in the same steps as the activity chart
    series: {
      people: peopleIn(here.plays.filter((p) => isMember(p.userId)), steps),
      voiceMs: spread(game ? [] : sessionTime(guild.id, first, now, user).filter((s) => isMember(s.userId)), steps).map(Math.round),
      sounds: here.sounds && countIn(here.sounds, steps),
    },
    // When people are on, once a period has a week of them
    when: now - first >= 7 * DAY_MS ? whenOn([...here.plays.filter((p) => isMember(p.userId)), ...stints], first, now, timeZone) : null,
    trending: before && !game && days >= TRENDING_DAYS[0] - 0.5 && days <= TRENDING_DAYS[1] ? trendingOf(here.games, before.games) : null,
  };
}

/** What's on sale that the server plays or wants, most wanted first */
export async function saleList(guild: Guild) {
  const games = await onSale(guild);
  return {
    games: games.map((g) => ({
      name: saleName(g),
      url: storeUrl(g.appid),
      discount: g.discount,
      was: g.was,
      price: g.price,
      store: g.store && { price: g.store.price, off: g.store.off, url: g.store.url, shop: g.store.shop },
      keyshop: g.keyshop && { price: g.keyshop.price, url: g.keyshop.url },
      deal: dealText(g),
      why: saleReasons(g, (id) => nameOf(guild, id)),
    })),
  };
}

/**
 * The Deals tab: what's on sale that the server plays or wants, and bundles with games for it, all as of the bot's
 * last checks. `people` is who each is for, so the page can show just what's for whoever's looking
 */
export async function dealList(guild: Guild) {
  const show = (id: string) => nameOf(guild, id);
  // As /sales mine: who asked for it or has it on their Steam wishlist
  const forWhom = (g: { wanted: string[]; wishlisted: string[] }) => [...new Set([...g.wanted, ...g.wishlisted])];
  const sales = await onSale(guild);
  const kept = dealBundles(guild.id);
  return {
    sales: sales.map((g) => ({
      appid: g.appid,
      name: saleName(g),
      url: storeUrl(g.appid),
      discount: g.discount,
      was: g.was,
      price: g.price,
      store: g.store && { price: g.store.price, off: g.store.off, url: g.store.url, shop: g.store.shop },
      keyshop: g.keyshop && { price: g.keyshop.price, url: g.keyshop.url },
      lowest: lowestPrice(g, g.lowest),
      why: saleReasons(g, show),
      people: forWhom(g),
    })),
    // Why there are none to show: no IsThereAnyDeal key to look them up with, the server turned them off, or not looked through yet
    bundlesOff: !config.itadKey ? 'no-key' : !setting(guild.id, 'bundleAlerts') ? 'off' : null,
    bundles: config.itadKey && setting(guild.id, 'bundleAlerts')
      ? (kept?.bundles.map((b) => ({
          id: b.id,
          title: b.title,
          site: b.site,
          url: b.url,
          expiry: b.expiry,
          from: b.from,
          games: b.games.map((m) => ({ title: m.title, url: storeUrl(m.appid), where: m.where, why: m.wanted ? saleReasons(m.wanted, show) : m.like, people: m.wanted ? forWhom(m.wanted) : [] })),
        })) ?? null)
      : null,
    bundlesAt: (config.itadKey && setting(guild.id, 'bundleAlerts') && kept?.at) || null,
  };
}

export function gameNameList(guild: Guild) {
  const spellings = gameSpellings(guild.id);
  return {
    games: stats(guild.id, 0, 'none', 'game').map((g) => ({ name: g.key, ms: g.ms, spellings: (spellings.get(g.key) ?? []).filter((raw) => raw !== g.key) })),
    // Marked as not a game, so left out of everything above
    notGames: notGames(guild.id),
  };
}

export async function changeGameNames(guild: Guild, req: IncomingMessage, action: string) {
  const body = await readJson(req);
  if (action === 'merge') {
    const { names, into } = body;
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string') || typeof into !== 'string') throw new Refused(400, 'Pick the games to merge and the name to keep.');
    refuse(guild, mergeGames(guild.id, names as string[], into));
    logActivity(guild.id, by(), `Merged ${(names as string[]).map((n) => `**${n}**`).join(', ')} into **${into}**`);
    return {};
  }
  if (typeof body.name !== 'string') throw new Refused(400, action === 'separate' ? 'Pick a spelling to separate.' : 'Pick a game.');
  if (action === 'not-a-game') {
    refuse(guild, markNotAGame(guild.id, body.name));
    logActivity(guild.id, by(), `Marked **${body.name}** as not a game`);
    return {};
  }
  if (action === 'a-game') {
    refuse(guild, countAsGame(guild.id, body.name));
    logActivity(guild.id, by(), `Counted **${body.name}** as a game again`);
    return {};
  }
  refuse(guild, separateGame(guild.id, body.name));
  logActivity(guild.id, by(), `Separated **${body.name}**`);
  return {};
}

export function gameList(guild: Guild) {
  const group = groupMembers(guild);
  const prices = salePrices(guild.id);
  const played = playedByKey(guild.id);
  const person = (id: string) => ({ id, name: nameOf(guild, id) });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    games: allGames(guild.id).map((g) => {
      const owners = ownersOf(g, guild);
      const family = familyPlayersOf(g, guild, owners);
      const onSteam = steamOwnersOf(g);
      const sale = g.steam_appid === null ? undefined : prices.get(g.steam_appid);
      return {
        id: g.id,
        name: g.name,
        appid: g.steam_appid,
        url: g.steam_appid === null ? null : storeUrl(g.steam_appid),
        maxPlayers: g.max_players,
        owners: [...owners].map((id) => ({ ...person(id), steam: onSteam.has(id) })).sort(byName),
        family: [...family].map(person).sort(byName),
        needs: group.filter((id) => !owners.has(id) && !family.has(id)).map(person).sort(byName),
        wanted: wantedBy(g, guild).map(person).sort(byName),
        sale: sale
          ? {
              discount: sale.discount,
              price: sale.price,
              was: sale.was,
              store: sale.store && { price: sale.store.price, off: sale.store.off, url: sale.store.url, shop: sale.store.shop },
              keyshop: sale.keyshop && { price: sale.keyshop.price, url: sale.keyshop.url },
            }
          : null,
        // Time in voice, as Stats counts it, for sorting by what's played
        played: played.get(gameKey(gameName(guild.id, g.name))) ?? null,
      };
    }),
    members: memberList(guild),
  };
}

export async function addGameFromWeb(guild: Guild, req: IncomingMessage) {
  const { name, appid } = await readJson(req);
  if (appid !== undefined) {
    const owned = Number.isInteger(appid) ? addMemberGame(guild, appid as number, by()) : null;
    if (!owned) throw new Refused(404, 'That game isn’t on the list any more.');
    if (owned.added) logActivity(guild.id, by(), `Added **${owned.name}** to the game library`);
    return owned;
  }
  const input = typeof name === 'string' ? name.trim() : '';
  if (!input || input.length > (input.includes('/') ? 200 : 100)) throw new Refused(400, 'Give a game’s name in 100 characters or fewer, or its Steam store link.');
  const result = await addGame(guild.id, input, by()).catch((err: unknown) => {
    console.error(err);
    throw new Refused(502, 'Steam couldn’t be reached just now. Try again in a bit.');
  });
  if (!result) throw new Refused(404, 'Steam doesn’t know that link.');
  if (result.added) logActivity(guild.id, by(), `Added **${result.game.name}** to the game library`);
  return { name: result.game.name, added: result.added };
}

async function changeGame(guild: Guild, game: GameRow, req: IncomingMessage) {
  const body = await readJson(req);
  const limit = 'maxPlayers' in body ? body.maxPlayers : game.max_players;
  if (limit !== null && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100)) throw new Refused(400, 'The player limit has to be from 1 to 100.');
  let appid = game.steam_appid;
  if ('steam' in body) {
    const link = typeof body.steam === 'string' ? body.steam.trim() : '';
    appid = link ? parseSteamAppId(link) : null;
    if (link && appid === null) throw new Refused(400, 'Couldn’t find a Steam app ID in that. Paste the store link or the number.');
    const other = appid !== null && allGames(guild.id).find((g) => g.steam_appid === appid && g.id !== game.id);
    if (other) throw new Refused(409, `${other.name} already has that Steam link.`);
  }
  setGameDetails(game, limit as number | null, appid);
  logActivity(guild.id, by(), `Changed the details of **${game.name}**`);
  return {};
}

async function markGame(guild: Guild, game: GameRow, userId: string, req: IncomingMessage) {
  if (!guild.members.cache.has(userId)) throw new Refused(404, 'They aren’t in this server.');
  const { owns, wants } = await readJson(req);
  if (typeof owns !== 'boolean' && typeof wants !== 'boolean') throw new Refused(400, 'Say whether they own it or want it.');
  const who = nameOf(guild, userId);
  if (typeof owns === 'boolean') {
    if (steamOwnersOf(game).has(userId)) throw new Refused(409, `${who} owns it on Steam, so it can’t be changed here.`);
    setOwned(game, userId, owns);
    logActivity(guild.id, by(), `Marked ${who} as ${owns ? 'owning' : 'not owning'} **${game.name}**`);
  }
  if (typeof wants === 'boolean') {
    if (wants && game.steam_appid === null) throw new Refused(409, `${game.name} needs a Steam link first, as sale alerts come from Steam.`);
    if (wants && ownersOf(game, guild).has(userId)) throw new Refused(409, `${who} already owns ${game.name}.`);
    setWanted(game, userId, wants);
    logActivity(guild.id, by(), `Marked ${who} as ${wants ? 'wanting' : 'not wanting'} **${game.name}**`);
  }
  return {};
}

export async function handleGame(guild: Guild, req: IncomingMessage, id: string, member?: string, userId?: string) {
  const game = gameById(guild.id, Number(id));
  if (!game) throw new Refused(404, 'No such game.');
  if (member === 'members' && userId !== undefined && req.method === 'PATCH') return markGame(guild, game, userId, req);
  if (member === undefined && req.method === 'PATCH') return changeGame(guild, game, req);
  if (member === undefined && req.method === 'DELETE') {
    removeGame(game);
    logActivity(guild.id, by(), `Removed **${game.name}** from the game library`);
    return {};
  }
  throw new Refused(405, 'Not here.');
}

export async function lobbyList(guild: Guild) {
  if (!config.steamApiKey) return { lobbies: [] };
  const lobbies = await lobbiesIn(guild).catch(steamDown);
  return { lobbies: lobbies.map((l) => ({ name: nameOf(guild, l.userId), game: l.game, join: l.join })) };
}

export function steamAccountList(guild: Guild) {
  const links = new Map(steamLinks().map((l) => [l.user_id, l]));
  const account = (id: string) => {
    const link = links.get(id);
    return link ? { url: profileUrl(link.steam_id), private: link.private === 1, games: link.games } : null;
  };
  return {
    configured: !!config.steamApiKey,
    members: memberList(guild)
      .map((m) => ({ ...m, steam: account(m.id), family: familyOf(m.id).filter((id) => id !== m.id).map((id) => nameOf(guild, id)) }))
      .sort((a, b) => Number(!a.steam) - Number(!b.steam)),
  };
}

export function needSteam() {
  if (!config.steamApiKey) throw new Refused(409, 'Steam isn’t set up on the bot: it needs a STEAM_API_KEY.');
}

export const steamDown = (err: unknown) => {
  console.error(err);
  throw new Refused(502, 'Steam couldn’t be reached just now. Try again in a bit.');
};

/** What the page needs to choose people and channels */
export function pickOptions(guild: Guild) {
  const members = memberList(guild);
  const known = libraryKnown(guild.id);
  return {
    members,
    // Who a pick can count, so choosing people by hand offers only them
    pickable: members.filter((m) => known.has(m.id)).map((m) => m.id),
    voice: voiceList(guild).channels,
    channels: textChannels(guild),
    announceChannel: idSetting(guild.id, 'announceChannel'),
  };
}

export async function pickFromWeb(guild: Guild, url: URL) {
  const channelId = url.searchParams.get('channel');
  const channel = channelId ? voiceChannelFor(guild, channelId) : null;
  const users = channel ? humansIn(channel).map((m) => m.id) : [...new Set((url.searchParams.get('users') ?? '').split(',').filter(Boolean))];
  if (!users.length) throw new Refused(400, 'Pick at least one person.');
  for (const id of users) memberIn(guild, id);
  const picked = await pickFor(guild, users).catch(steamDown);
  const person = <T extends { missing: string[]; borrowed: string[]; players: { id: string }[]; appid: number | null }>(row: T) => ({
    ...row,
    url: row.appid === null ? null : storeUrl(row.appid),
    missing: row.missing.map((id) => nameOf(guild, id)),
    borrowed: row.borrowed.map((id) => nameOf(guild, id)),
    players: row.players.map((p) => ({ ...p, name: nameOf(guild, p.id) })),
  });
  if (!picked) return { people: users.length, counted: 0, notes: [plain(guild, NOBODY_COUNTED)], ready: [], almost: [] };
  return { people: users.length, counted: picked.counted.length, notes: picked.notes.map((n) => plain(guild, n)), ready: picked.ready.map(person), almost: picked.almost.map(person) };
}

/** More than any server's game list, so a filtered list always fits */
const MAX_VOTE_NAMES = 2000;

export async function voteFromWeb(guild: Guild, req: IncomingMessage) {
  const { voiceChannelId, channelId, minutes, games } = await readJson(req);
  const length = minutes ?? 1;
  if (!Number.isInteger(length) || (length as number) < 1 || (length as number) > 10) throw new Refused(400, 'A vote lasts from 1 to 10 minutes.');
  if (games !== undefined && !(Array.isArray(games) && games.length <= MAX_VOTE_NAMES && games.every((g) => typeof g === 'string'))) {
    throw new Refused(400, `games has to be a list of up to ${MAX_VOTE_NAMES} game names.`);
  }
  const voice = voiceChannelFor(guild, voiceChannelId);
  const channel = postingChannel(guild, channelId);
  refuse(guild, await postVote(channel, voice, length as number, games as string[] | undefined).catch(cantPost));
  logActivity(guild.id, by(), `Started a game vote for <#${voice.id}> in <#${channel.id}>`);
  return {};
}

/** Who Compare offers: people still here whom Stats has something on */
export function comparePeople(guild: Guild) {
  const known = peopleWithStats(guild.id);
  return { people: memberList(guild).filter((m) => known.has(m.id)) };
}

export function compareFromWeb(guild: Guild, url: URL) {
  const [a, b] = ['a', 'b'].map((key) => memberIn(guild, url.searchParams.get(key) ?? ''));
  if (a.id === b.id) throw new Refused(400, 'Pick two different people.');
  const { games, voice, shared, totals } = comparison(guild.id, a.id, b.id);
  return {
    people: [a, b].map((m, idx) => ({ id: m.id, name: m.displayName, ms: totals[idx] })),
    togetherMs: games.reduce((sum, g) => sum + g.ms, 0),
    games: games.slice(0, MAX_RANKED).map((g) => ({ name: g.game, ms: g.ms })),
    voice: { sessions: voice.n, ms: voice.seconds * 1000 },
    shared: shared.map((g) => g.name),
    steamGames: shared.flatMap((g) => (g.appid === null ? [] : [{ name: g.name, appid: g.appid }])),
  };
}

export async function achievementsFromWeb(guild: Guild, url: URL) {
  const appid = Number(url.searchParams.get('appid'));
  if (!Number.isInteger(appid) || appid < 1) throw new Refused(400, 'Pick a game.');
  const users = [...new Set((url.searchParams.get('users') ?? '').split(',').filter(Boolean))];
  if (!users.length) throw new Refused(400, 'Pick at least one person.');
  for (const id of users) memberIn(guild, id);
  needSteam();
  const { total, people, skipped, goals } = await achievementProgress(appid, users).catch(steamDown);
  return { total, goals, people: people.map((p) => ({ name: nameOf(guild, p.id), done: p.done })), skipped: skipped.map((id) => nameOf(guild, id)) };
}

export function recapFromWeb(guild: Guild, url: URL) {
  const month = url.searchParams.get('month') ?? 'last';
  if (month !== 'last' && month !== 'this') throw new Refused(400, 'No such month.');
  const recap = recapFor(guild, month === 'this')?.toJSON();
  if (!recap) return { recap: null };
  return { recap: { title: recap.title, description: recap.description ? plain(guild, recap.description) : null, fields: (recap.fields ?? []).map((f) => ({ name: f.name, value: plain(guild, f.value) })) } };
}

export async function handlePings(guild: Guild, req: IncomingMessage, userId: string) {
  memberIn(guild, userId);
  // The cached member lags behind role changes
  const member = await guild.members.fetch({ user: userId, force: true });
  const choices = pingChoices(guild);
  if (req.method === 'GET') return { pings: choices.map((c) => ({ ...c, on: member.roles.cache.has(c.id) })) };
  if (req.method !== 'PUT') throw new Refused(405, 'Not here.');
  const { roleId, on } = await readJson(req);
  const choice = choices.find((c) => c.id === roleId);
  if (!choice || typeof on !== 'boolean') throw new Refused(400, 'Pick a ping to change.');
  await (on ? member.roles.add(choice.id, 'Set on the web UI') : member.roles.remove(choice.id, 'Set on the web UI')).catch(() => {
    throw new Refused(409, `I couldn’t change their roles. My role needs Manage Roles and has to be above @${guild.roles.cache.get(choice.id)?.name}.`);
  });
  logActivity(guild.id, by(), `Turned ${choice.label} ${on ? 'on' : 'off'} for ${member.displayName}`);
  return {};
}

export async function handleSteamAccount(guild: Guild, req: IncomingMessage, userId: string) {
  if (!guild.members.cache.has(userId)) throw new Refused(404, 'They aren’t in this server.');
  needSteam();
  const who = nameOf(guild, userId);
  if (req.method === 'PUT') {
    const { profile } = await readJson(req);
    const text = typeof profile === 'string' ? profile.trim() : '';
    if (!text || text.length > 200) throw new Refused(400, 'Paste their Steam profile link.');
    const linked = await linkSteam(userId, text).catch(steamDown);
    if (!linked) throw new Refused(400, 'Couldn’t find that Steam profile. Paste the full profile link.');
    logActivity(guild.id, by(), `Linked ${who}’s Steam account`);
    return { games: linked.games };
  }
  if (req.method === 'DELETE') {
    if (!unlinkSteam(userId)) throw new Refused(404, 'They don’t have a linked Steam account.');
    logActivity(guild.id, by(), `Unlinked ${who}’s Steam account`);
    return {};
  }
  throw new Refused(405, 'Not here.');
}

export async function handleFamily(guild: Guild, req: IncomingMessage, userId: string) {
  const who = memberIn(guild, userId).displayName;
  if (req.method === 'PUT') {
    const other = memberIn(guild, String((await readJson(req)).with));
    refuse(guild, joinFamily(userId, other.id));
    logActivity(guild.id, by(), `Put ${who} in a Steam family with ${other.displayName}`);
    return {};
  }
  if (req.method === 'DELETE') {
    if (!leaveFamily(userId)) throw new Refused(404, 'They aren’t in a Steam family.');
    logActivity(guild.id, by(), `Took ${who} out of their Steam family`);
    return {};
  }
  throw new Refused(405, 'Not here.');
}

export async function gameRoutes({ client, guild, req, res, url, section, rest }: Ask) {
  if (section === 'games' && !rest.length && req.method === 'GET') return gameList(guild);
  if (section === 'games' && !rest.length && req.method === 'POST') return addGameFromWeb(guild, req);
  if (section === 'games' && rest.length === 1 && rest[0] === 'owned' && req.method === 'GET') {
    return { games: memberGames(guild).map((g) => ({ appid: g.appid, name: g.name, owners: g.owners.map((id) => nameOf(guild, id)).sort((a, b) => a.localeCompare(b)) })) };
  }
  if (section === 'games' && rest.length >= 1 && rest.length <= 3) return handleGame(guild, req, rest[0], rest[1], rest[2]);
  if (section === 'pick' && !rest.length && req.method === 'GET') return pickFromWeb(guild, url);
  if (section === 'pick' && rest.length === 1 && rest[0] === 'options' && req.method === 'GET') return pickOptions(guild);
  if (section === 'votes' && !rest.length && req.method === 'POST') return voteFromWeb(guild, req);
  if (section === 'compare' && !rest.length && req.method === 'GET') return compareFromWeb(guild, url);
  if (section === 'compare' && rest.length === 1 && rest[0] === 'people' && req.method === 'GET') return comparePeople(guild);
  if (section === 'achievements' && !rest.length && req.method === 'GET') return achievementsFromWeb(guild, url);
  if (section === 'recap' && !rest.length && req.method === 'GET') return recapFromWeb(guild, url);
  if (section === 'members' && rest.length === 2 && rest[1] === 'pings') return handlePings(guild, req, rest[0]);
  if (section === 'game-pings' && rest.length === 1 && rest[0] === 'menu' && req.method === 'POST') {
    const channel = postingChannel(guild, (await readJson(req)).channelId);
    await channel.send(pingMenu()).catch(cantPost);
    logActivity(guild.id, by(), `Posted the game pings button in <#${channel.id}>`);
    return {};
  }
  if (section === 'hidden-games' && !rest.length && req.method === 'GET') return { games: hiddenGames(guild.id) };
  if (section === 'hidden-games' && rest.length === 1) return handleHidden(guild, req, rest[0]);
  if (section === 'game-pings' && !rest.length && req.method === 'GET') return gamePingList(guild);
  if (section === 'game-pings' && !rest.length && req.method === 'POST') return addGamePing(guild, req);
  if (section === 'game-pings' && rest.length === 1 && req.method === 'DELETE') return removeGamePing(guild, rest[0]);
  if (section === 'steam-links' && !rest.length && req.method === 'GET') return steamAccountList(guild);
  if (section === 'steam-links' && rest.length === 1) return handleSteamAccount(guild, req, rest[0]);
  if (section === 'steam-links' && rest.length === 2 && rest[1] === 'family') return handleFamily(guild, req, rest[0]);
  if (section === 'steam-apps' && rest.length === 1 && req.method === 'GET') {
    const appid = /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
    if (appid === undefined) throw new Refused(404, 'No such game.');
    const [players, notes] = await Promise.all([currentPlayers(appid), patchNotes(appid).catch((err) => (console.error(err), []))]);
    const latest = notes.at(0);
    return { players, patch: latest ? { title: latest.title, url: latest.url, date: latest.date } : null };
  }
  if (section === 'steam-refresh' && !rest.length && req.method === 'POST') {
    needSteam();
    await refreshAll().catch(steamDown);
    logActivity(guild.id, by(), 'Refreshed Steam libraries');
    return {};
  }
  if (section === 'stats' && !rest.length && req.method === 'GET') return statsFor(guild, url);
  if (section === 'free-games' && !rest.length && req.method === 'GET') {
    const games = await reviewGiveaways(guild).catch(() => {
      throw new Refused(502, 'The free game list couldn’t be read just now.');
    });
    return { games: games.map(({ title, url: link, worth, platforms, show, reason }) => ({ title, url: link, worth, platforms, show, reason })) };
  }
  if (section === 'sales' && !rest.length && req.method === 'GET') return saleList(guild);
  if (section === 'deals' && !rest.length && req.method === 'GET') return dealList(guild);
  if (section === 'game-names' && !rest.length && req.method === 'GET') return gameNameList(guild);
  if (section === 'game-names' && rest.length === 1 && ['merge', 'separate', 'not-a-game', 'a-game'].includes(rest[0]) && req.method === 'POST') return changeGameNames(guild, req, rest[0]);
  if (section === 'lobbies' && !rest.length && req.method === 'GET') return lobbyList(guild);
  throw new Refused(404, 'Not found.');
}
