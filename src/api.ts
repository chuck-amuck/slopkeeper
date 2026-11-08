import { ChannelType, type Client, type Guild, type GuildTextBasedChannel, type VoiceBasedChannel, type VoiceChannel } from 'discord.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { FROM_WEB, fromWebUser, linkWebUser, logActivity, recentActivity, seeWebUser, webUser, webUserFor } from './activity.ts';
import { config } from './config.ts';
import * as discordBoard from './discordSounds.ts';
import { cancelNight, gameNames, planNight, readWhen, stopSeries, upcomingNights } from './features/gamenight.ts';
import { reviewGiveaways } from './features/freegames.ts';
import { achievementProgress } from './features/achievements.ts';
import { addGameRole, canHandOut, gameRoles, pingableGames, pingChoices, pingMenu, removeGameRole } from './features/gameroles.ts';
import { addGame, addMemberGame, allGames, familyPlayersOf, gameById, groupMembers, hiddenGames, hideGame, memberGames, NOBODY_COUNTED, ownersOf, parseSteamAppId, removeGame, setGameDetails, setOwned, setWanted, steamOwnersOf, unhideGame, wantedBy, type GameRow } from './features/games.ts';
import { onSale, saleName, salePrices, saleReasons, storeUrl } from './features/sales.ts';
import { currentPlayers, familyOf, patchNotes, friendsCheck, joinFamily, leaveFamily, linkSteam, lobbiesIn, profileUrl, refreshAll, steamLinks, unlinkSteam } from './features/steam.ts';
import { activity, checkpoint, comparison, PERIODS, pickFor, sessionCount, stats } from './features/gamestats.ts';
import { postVote } from './features/gamevote.ts';
import { recapFor } from './features/recap.ts';
import { gameName, gameSpellings, mergeGames, separateGame } from './gameNames.ts';
import { addTracks, clearQueue, fileProblem, fileUploadPath, MOST_FILE_BYTES, moveTrack, musicChannelFor, musicState, pauseMusic, playFile, queueFrom, queueOf, removeTrack, seekFile, seekMusic, skipMusic, startMusic, stopFile, stopMusic } from './features/music.ts';
import { phrases, removePhrase, savePhrase, say, VOICES } from './features/say.ts';
import { voiceTotals } from './features/sessions.ts';
import { checkSetting, LABELS, LIMITS, show, source, STEPS } from './features/setup.ts';
import { addSound, addToDiscord, applyLevels, applyMusicVolume, applySoundVolume, BIN_DAYS, changeEmoji, deletedSounds, discordVolume, eraseDeleted, expiresAt, favourites, findSound, isTrimmed, joinSounds, listSounds, parseEmoji, playCounts, playDiscordSound, playFromWeb, postPanel, refreshLoopRoom, refreshPanels, removeSound, renameSound, restoreDeleted, restoreSound, saveFromDiscord, setFavourite, setJoinSound, setSoundVolume, type Sound, soundLevels, stopPlayback, swapOnDiscord, syncToDiscord, takeOffDiscord, trimProblem, trimSound, uploadProblem, voiceVolume, volumeProblem } from './features/soundboard.ts';
import { DEFAULTS, idSetting, isAllowed, setSetting, setting, type SettingKey } from './settings.ts';
import { myPlaylists, playlistsReady, search, SpotifyError, type Track } from './spotify.ts';
import type { Feature } from './types.ts';
import { humansIn, pingWarning, servedGuilds } from './util.ts';

// A little over the largest sound, which is the largest thing anything sends
const MAX_BODY = 5 * 1024 * 1024 + 1024;
const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};
const TIME_ZONES = Intl.supportedValuesOf('timeZone');
const MAX_RANKED = 15;
const ACTIVITY_PAGE = 50;
const REPEATS = [7, 14];

class Refused extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The bot's messages are written for Discord; the web UI shows plain text */
function plain(guild: Guild, text: string): string {
  return text
    .replace(discordBoard.PICK_A_PART, 'turn on its Discord switch to pick a part')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replace(/<#(\d+)>/g, (_, id: string) => `#${guild.channels.cache.get(id)?.name ?? 'unknown channel'}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${guild.roles.cache.get(id)?.name ?? 'unknown role'}`)
    .replace(/<@!?(\d+)>/g, (_, id: string) => nameOf(guild, id))
    .replace(/<t:(\d+)(:\w)?>/g, (_, secs: string) => new Date(Number(secs) * 1000).toLocaleDateString('en-US', { timeZone: setting(guild.id, 'timezone'), dateStyle: 'medium' }));
}

const hash = (text: string) => createHash('sha256').update(text).digest();

interface SignedIn {
  email: string;
  name: string;
}

/** Who the web UI says is asking: someone Pangolin signed in, or nobody for the home network */
const asking = new AsyncLocalStorage<SignedIn | undefined>();

/** Who to credit a change from the web UI to */
const by = () => {
  const who = asking.getStore();
  return who ? fromWebUser(who.email) : FROM_WEB;
};

/** The web UI sends these URL-encoded, and only with the token */
function signedIn(req: IncomingMessage): SignedIn | undefined {
  const read = (name: string, max: number) => {
    const value = req.headers[name];
    if (typeof value !== 'string') return undefined;
    try {
      return decodeURIComponent(value).trim().slice(0, max) || undefined;
    } catch {
      return undefined;
    }
  };
  const email = read('x-slopkeeper-email', 254);
  return email ? { email, name: read('x-slopkeeper-name', 100) ?? email } : undefined;
}

function authorized(req: IncomingMessage, token: string): boolean {
  return timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${token}`));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Refused(413, 'File is over 5 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Writes a large upload straight to a file, refusing it once it's over `max` bytes */
async function saveBody(req: IncomingMessage, file: string, max: number) {
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (size > max) throw new Refused(413, `That file is over ${max / 1024 / 1024} MB.`);
          yield chunk;
        }
      },
      createWriteStream(file),
    );
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const body = JSON.parse((await readBody(req)).toString() || '{}') as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Refused) throw err;
  }
  throw new Refused(400, 'That isn’t valid JSON.');
}

// ffprobe per sound is slow, and a sound only changes by being replaced
const durations = new Map<string, { mtimeMs: number; seconds: number | null }>();

async function durationOf(file: string, mtimeMs: number): Promise<number | null> {
  const known = durations.get(file);
  if (known?.mtimeMs === mtimeMs) return known.seconds;
  const seconds = await discordBoard.durationOf(file).catch(() => null);
  durations.set(file, { mtimeMs, seconds });
  return seconds;
}

async function soundList(guild: Guild) {
  const sounds = [];
  const onDiscord = await discordBoard.board(guild).catch(() => null);
  const starred = favourites(guild.id);
  const plays = playCounts(guild.id);
  const levels = soundLevels(guild.id);
  for (const sound of listSounds(guild.id)) {
    const { size, mtimeMs } = statSync(sound.file);
    const seconds = await durationOf(sound.file, mtimeMs);
    sounds.push({
      name: sound.name,
      emoji: sound.emoji ?? null,
      onDiscord: sound.onDiscord,
      bytes: size,
      seconds,
      fitsDiscord: seconds !== null && discordBoard.fits(seconds),
      favourite: starred.has(sound.name),
      plays: plays.get(sound.name) ?? 0,
      gainDb: levels.get(sound.name)?.gainDb ?? null,
      percent: levels.get(sound.name)?.percent ?? 100,
      volume: discordVolume(guild.id, sound.name),
      loudness: voiceVolume(guild.id, sound.name),
      trimmed: isTrimmed(guild.id, sound.name),
    });
  }
  return {
    sounds,
    evenVolume: setting(guild.id, 'evenVolume'),
    slots: onDiscord && { used: onDiscord.used, total: onDiscord.total },
    discordSounds: onDiscord?.sounds.map(({ url: _, ...sound }) => sound) ?? [],
    emojis: guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: e.animated, code: e.toString() })),
    clipSeconds: discordBoard.CLIP_SECONDS,
  };
}

const textChannels = (guild: Guild) =>
  [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name, category: c.parent?.name ?? null }));

function settingList(guild: Guild) {
  const keys = Object.keys(DEFAULTS) as SettingKey[];
  return {
    settings: keys.map((key) => ({
      key,
      label: LABELS[key],
      value: setting(guild.id, key),
      default: DEFAULTS[key],
      source: source(guild.id, key),
      limits: LIMITS[key as keyof typeof LIMITS] ?? null,
      step: STEPS[key as keyof typeof LIMITS] ?? 1,
    })),
    channels: textChannels(guild),
    voiceChannels: [...guild.channels.cache.values()]
      .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice && c.id !== guild.afkChannelId)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name })),
    sounds: listSounds(guild.id).map((s) => s.name),
    roles: [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name })),
    timeZones: TIME_ZONES,
  };
}

/** Channels with people in them, busiest first */
function voiceList(guild: Guild) {
  const channels = [...guild.channels.cache.values()].filter((c): c is VoiceBasedChannel => c.isVoiceBased() && c.id !== guild.afkChannelId && humansIn(c).length > 0);
  return {
    channels: channels
      .map((c) => ({ id: c.id, name: c.name, people: humansIn(c).map((m) => m.displayName) }))
      .sort((a, b) => b.people.length - a.people.length),
  };
}

const nameOf = (guild: Guild, id: string) => guild.members.cache.get(id)?.displayName ?? 'Someone who left';

const memberList = (guild: Guild) =>
  [...guild.members.cache.values()]
    .filter((m) => !m.user.bot)
    .map((m) => ({ id: m.id, name: m.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));

function nightList(guild: Guild) {
  const channelName = (id: string | null) => (id ? (guild.channels.cache.get(id)?.name ?? null) : null);
  const { nights, series } = upcomingNights(guild.id, Date.now());
  return {
    timeZone: setting(guild.id, 'timezone'),
    nights: nights.map((n) => ({
      id: n.id,
      game: n.game,
      details: n.details,
      startsAt: n.starts_at,
      voiceChannel: channelName(n.voice_channel_id),
      host: nameOf(guild, n.created_by),
      in: n.people.in.map((id) => nameOf(guild, id)),
      maybe: n.people.maybe.map((id) => nameOf(guild, id)),
      out: n.people.out.map((id) => nameOf(guild, id)),
      repeats: n.repeats,
    })),
    series: series.map((s) => ({ id: s.id, game: s.game, repeats: s.repeats, nextAt: s.next_at, host: nameOf(guild, s.created_by) })),
    // What the form for planning one chooses from
    games: gameNames(guild.id),
    channels: textChannels(guild),
    defaultChannel: idSetting(guild.id, 'announceChannel'),
    voiceChannels: [...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildVoice)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name })),
    members: memberList(guild),
  };
}

/** Plans a night by the same rules as /gamenight plan, except a host has to be picked: the web UI doesn't know who's using it */
async function planFromWeb(client: Client<true>, guild: Guild, req: IncomingMessage) {
  const { game, when, channelId, voiceChannelId, details, hostId, repeat } = await readJson(req);
  const name = typeof game === 'string' ? game.trim() : '';
  if (!name || name.length > 90) throw new Refused(400, 'Say what you’re playing, in 90 characters or fewer.');
  const text = typeof when === 'string' ? when.trim().slice(0, 100) : '';
  const time = readWhen(guild.id, text);
  if (!time) throw new Refused(400, `I couldn’t tell when ${text || 'that'} is. Try something like fri 8pm, tomorrow 20:30 or nov 3 7pm.`);
  if (time.passed) throw new Refused(400, `${time.label} has already passed.`);
  const about = typeof details === 'string' ? details.trim() : '';
  if (about.length > 1000) throw new Refused(400, 'Details have to fit in 1000 characters.');
  const host = guild.members.cache.get(String(hostId));
  if (!host || host.user.bot) throw new Refused(400, 'Pick a host.');
  const channel = checkSetting(guild, 'announceChannel', channelId);
  if ('error' in channel) throw new Refused(400, plain(guild, channel.error));
  const voice = voiceChannelId ? guild.channels.cache.get(String(voiceChannelId)) : null;
  if (voice && voice.type !== ChannelType.GuildVoice) throw new Refused(400, 'Pick a voice channel.');
  if (repeat !== null && repeat !== undefined && !REPEATS.includes(repeat as number)) throw new Refused(400, 'Nights repeat every 1 or 2 weeks.');

  const note = await planNight(
    client,
    guild,
    { channel_id: String(channel.value), game: name, details: about || null, voice_channel_id: voice?.id ?? null, starts_at: time.at, created_by: host.id },
    (repeat as number | null | undefined) ?? null,
  );
  logActivity(guild.id, by(), `Planned **${name}** night for ${time.label}`);
  return { eventNote: note && plain(guild, note) };
}

/** Someone signed in through Pangolin shows as the Discord member they said they are, or their sign-in name if they haven't */
function whoDid(guild: Guild, actor: string) {
  if (actor === FROM_WEB) return 'Web UI';
  if (!actor.startsWith(fromWebUser(''))) return nameOf(guild, actor);
  const user = webUser(actor.slice(fromWebUser('').length));
  if (user?.userId && guild.members.cache.has(user.userId)) return nameOf(guild, user.userId);
  return user?.name ?? 'Someone on the web UI';
}

/** Who's signed in, and which Discord member they said they are. Links aren't per server, since Discord ids aren't */
async function handleMe(guild: Guild, req: IncomingMessage) {
  const who = asking.getStore();
  if (req.method === 'GET') {
    const user = who && webUser(who.email);
    return { me: who ? { name: who.name, userId: user?.userId && guild.members.cache.has(user.userId) ? user.userId : null } : null };
  }
  if (!who) throw new Refused(403, 'Only people signed in through Pangolin can say who they are.');
  const linked = webUser(who.email)?.userId;
  if (req.method === 'PUT') {
    const member = memberIn(guild, String((await readJson(req)).userId));
    const other = webUserFor(member.id);
    if (other && other.email !== who.email) throw new Refused(409, `Someone else has already said they’re ${member.displayName}.`);
    linkWebUser(who.email, member.id);
    if (linked !== member.id) logActivity(guild.id, by(), `Linked the web sign-in for ${who.name} to ${member.displayName}`);
    return { me: { name: who.name, userId: member.id } };
  }
  if (req.method === 'DELETE') {
    linkWebUser(who.email, null);
    if (linked) logActivity(guild.id, by(), `Unlinked the web sign-in for ${who.name} from ${nameOf(guild, linked)}`);
    return { me: { name: who.name, userId: null } };
  }
  throw new Refused(405, 'Not here.');
}

function activityList(guild: Guild, url: URL) {
  const before = Number(url.searchParams.get('before')) || undefined;
  const rows = recentActivity(guild.id, ACTIVITY_PAGE + 1, before);
  return {
    timeZone: setting(guild.id, 'timezone'),
    entries: rows.slice(0, ACTIVITY_PAGE).map((r) => ({ id: r.id, at: r.at, who: whoDid(guild, r.actor), action: plain(guild, r.action) })),
    more: rows.length > ACTIVITY_PAGE,
  };
}

function joinSoundList(guild: Guild) {
  return {
    joinSounds: joinSounds(guild.id).map((r) => ({ id: r.user_id, who: nameOf(guild, r.user_id), name: r.name })),
    members: memberList(guild),
    sounds: listSounds(guild.id).map((s) => s.name),
  };
}

async function setJoinSoundFromWeb(guild: Guild, req: IncomingMessage, userId: string) {
  const person = guild.members.cache.get(userId);
  if (!person || person.user.bot) throw new Refused(404, 'They aren’t in this server.');
  const { name } = await readJson(req);
  const sound = typeof name === 'string' ? findSound(guild.id, name) : undefined;
  if (!sound) throw new Refused(404, 'No sound by that name.');
  setJoinSound(guild.id, userId, sound.name);
  logActivity(guild.id, by(), `Set ${person.displayName}’s join sound to **${sound.name}**`);
  return { warning: setting(guild.id, 'joinSounds') ? null : 'Join sounds are turned off in this server for now, so it won’t play until they’re turned back on.' };
}

function gamePingList(guild: Guild) {
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

async function addGamePing(guild: Guild, req: IncomingMessage) {
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

async function removeGamePing(guild: Guild, roleId: string) {
  const row = gameRoles(guild.id).find((r) => r.role_id === roleId);
  if (!row) throw new Refused(404, 'That game has no ping role any more.');
  await removeGameRole(guild, row, 'the web UI');
  logActivity(guild.id, by(), `Removed game pings for **${row.name}**`);
  return {};
}

async function handleHidden(guild: Guild, req: IncomingMessage, id: string) {
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
function placeOf(guild: Guild, user: string, game: string, since: number) {
  const players = stats(guild.id, since, 'game', 'user_id', undefined, game).filter((r) => guild.members.cache.has(r.key));
  const idx = players.findIndex((r) => r.key === user);
  return idx < 0 ? null : { rank: idx + 1, of: players.length, sessions: sessionCount(guild.id, user, game, since) };
}

/** The same numbers as /gamestats and /stats, for the web UI's charts */
function statsFor(guild: Guild, url: URL) {
  const period = url.searchParams.get('period') ?? 'month';
  if (!Object.hasOwn(PERIODS, period)) throw new Refused(400, 'No such period.');
  const user = url.searchParams.get('user') || undefined;
  const game = url.searchParams.get('game') || undefined;
  const now = Date.now();
  const { ms } = PERIODS[period as keyof typeof PERIODS];
  const since = Number.isFinite(ms) ? now - ms : 0;
  const isMember = (id: string) => guild.members.cache.has(id);
  const filter = user && game ? 'both' : user ? 'user' : game ? 'game' : 'none';

  checkpoint();
  const games = stats(guild.id, since, filter, 'game', user, game);
  const players = stats(guild.id, since, filter, 'user_id', user, game).filter((r) => isMember(r.key));
  // Voice time isn't per game, so it only applies when no game is picked
  const voice = game ? [] : voiceTotals(guild.id, since).filter((p) => isMember(p.userId) && (!user || p.userId === user));
  return {
    timeZone: setting(guild.id, 'timezone'),
    user: user ? { id: user, name: nameOf(guild, user) } : null,
    game: game ?? null,
    spellings: game ? (gameSpellings(guild.id).get(gameName(guild.id, game)) ?? []).filter((raw) => raw !== gameName(guild.id, game)) : [],
    totals: {
      gameMs: games.reduce((sum, g) => sum + g.ms, 0),
      playerMs: players.reduce((sum, p) => sum + p.ms, 0),
      games: games.length,
      people: players.length,
      voiceMs: voice.reduce((sum, p) => sum + p.secs * 1000, 0),
    },
    place: user && game ? placeOf(guild, user, game, since) : null,
    games: games.slice(0, MAX_RANKED).map((g) => ({ name: g.key, ms: g.ms, people: g.n, last: g.last })),
    players: players.slice(0, MAX_RANKED).map((p) => ({ id: p.key, name: nameOf(guild, p.key), ms: p.ms, games: p.n, last: p.last })),
    voice: voice.slice(0, MAX_RANKED).map((p) => ({ id: p.userId, name: nameOf(guild, p.userId), ms: p.secs * 1000, nights: p.nights })),
    activity: activity(guild.id, since, now, setting(guild.id, 'timezone'), user, game),
  };
}

/** Every game with time on record, longest first, and what else it's been called */
async function saleList(guild: Guild) {
  const games = await onSale(guild);
  return {
    games: games.map((g) => ({
      name: saleName(g),
      url: storeUrl(g.appid),
      discount: g.discount,
      was: g.was,
      price: g.price,
      why: saleReasons(g, (id) => nameOf(guild, id)),
    })),
  };
}

function gameNameList(guild: Guild) {
  const spellings = gameSpellings(guild.id);
  return { games: stats(guild.id, 0, 'none', 'game').map((g) => ({ name: g.key, ms: g.ms, spellings: (spellings.get(g.key) ?? []).filter((raw) => raw !== g.key) })) };
}

async function changeGameNames(guild: Guild, req: IncomingMessage, action: string) {
  const body = await readJson(req);
  if (action === 'merge') {
    const { names, into } = body;
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string') || typeof into !== 'string') throw new Refused(400, 'Pick the games to merge and the name to keep.');
    refuse(guild, mergeGames(guild.id, names as string[], into));
    logActivity(guild.id, by(), `Merged ${(names as string[]).map((n) => `**${n}**`).join(', ')} into **${into}**`);
    return {};
  }
  if (typeof body.name !== 'string') throw new Refused(400, 'Pick a spelling to separate.');
  refuse(guild, separateGame(guild.id, body.name));
  logActivity(guild.id, by(), `Separated **${body.name}**`);
  return {};
}

const soundOf = (guild: Guild, name: string): Sound => {
  const sound = findSound(guild.id, name);
  if (!sound) throw new Refused(404, 'No sound by that name.');
  return sound;
};

const refuse = (guild: Guild, problem: string | null) => {
  if (problem) throw new Refused(400, plain(guild, problem));
};

/** Turns a failed Discord step into a message for the page */
const cantDo = (err: Error): never => {
  throw new Refused(400, err.message);
};

function voiceChannelFor(guild: Guild, id: unknown) {
  const channel = guild.channels.cache.get(String(id));
  if (!channel?.isVoiceBased()) throw new Refused(400, 'Pick a voice channel.');
  // With nobody there, the bot would leave as soon as it joined
  if (!humansIn(channel).length) throw new Refused(400, `Nobody’s in ${channel.name} any more.`);
  return channel;
}

/** The sound with this id on this server's soundboard, so no other address can be asked for */
async function discordSoundOf(guild: Guild, id: unknown) {
  const sound = (await discordBoard.board(guild)).sounds.find((s) => s.id === id);
  if (!sound) throw new Refused(404, 'That sound isn’t on Discord’s soundboard any more.');
  return sound;
}

async function handleDiscordSound(client: Client<true>, guild: Guild, req: IncomingMessage, res: ServerResponse, id: string, part?: string) {
  const sound = await discordSoundOf(guild, id);
  const key = `${req.method} ${part ?? ''}`;
  if (key === 'GET audio') {
    const { data, ext } = await discordBoard.download(sound);
    res.writeHead(200, { 'content-type': AUDIO_TYPES[ext], 'content-length': data.length, 'cache-control': 'no-store' });
    res.end(data);
    return null;
  }
  if (key === 'POST play') {
    refuse(guild, await playDiscordSound(voiceChannelFor(guild, (await readJson(req)).channelId), sound));
    return {};
  }
  if (key === 'POST save') {
    const name = await saveFromDiscord(guild, sound).catch(cantDo);
    if (!sound.library) logActivity(guild.id, by(), `Saved **${sound.name}** from Discord’s soundboard as **${name}**`);
    await refreshPanels(client, guild.id);
    return { name };
  }
  if (key === 'DELETE ') {
    await takeOffDiscord(guild, sound).catch(cantDo);
    logActivity(guild.id, by(), `Took **${sound.name}** off Discord’s soundboard`);
    await refreshPanels(client, guild.id);
    return {};
  }
  throw new Refused(404, 'Not found.');
}

async function handleSounds(client: Client<true>, guild: Guild, req: IncomingMessage, res: ServerResponse, url: URL, name?: string, part?: string) {
  const method = req.method!;
  // Everything but reading changes what the posted panels show
  const refresh = () => refreshPanels(client, guild.id);
  const note = (action: string) => logActivity(guild.id, by(), action);

  if (name === undefined) {
    if (method === 'GET') return soundList(guild);
    throw new Refused(405, 'Not here.');
  }

  if (part === 'audio' && method === 'GET') {
    const { file } = soundOf(guild, name);
    res.writeHead(200, {
      'content-type': AUDIO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
    return null;
  }

  if (part === 'play' && method === 'POST') {
    const sound = soundOf(guild, name);
    refuse(guild, await playFromWeb(voiceChannelFor(guild, (await readJson(req)).channelId), sound));
    return {};
  }

  if (part === 'trim' && method === 'POST') {
    const sound = soundOf(guild, name);
    const { start, end } = await readJson(req);
    refuse(guild, trimProblem(start, end, await discordBoard.durationOf(sound.file).catch(() => NaN)));
    const [from, to] = [start as number, end as number];
    if (!(await trimSound(guild, sound, from, to))) throw new Refused(400, 'That sound couldn’t be cut, so it wasn’t changed.');
    note(`Trimmed **${sound.name}** to ${(to - from).toFixed(1)} s`);
    return {};
  }

  if (part === 'restore' && method === 'POST') {
    const sound = soundOf(guild, name);
    if (!(await restoreSound(guild, sound))) throw new Refused(400, 'That sound hasn’t been trimmed.');
    note(`Restored the original **${sound.name}**`);
    return {};
  }

  if (part === 'discord') {
    const sound = soundOf(guild, name);
    if (method === 'PUT') {
      const { start, replacing } = await readJson(req);
      if (start !== undefined && (typeof start !== 'number' || !(start >= 0))) throw new Refused(400, 'Start has to be a number of seconds.');
      if (replacing !== undefined) {
        const outgoing = await discordSoundOf(guild, replacing);
        refuse(guild, await swapOnDiscord(guild, outgoing, sound, start).catch(cantDo));
        note(`Swapped **${outgoing.name}** for **${sound.name}** on Discord’s soundboard`);
      } else {
        refuse(guild, await addToDiscord(guild, sound, start));
        note(`Added **${sound.name}** to Discord’s soundboard`);
      }
    } else if (method === 'DELETE') {
      await discordBoard.remove(guild, sound.name);
      note(`Took **${sound.name}** off Discord’s soundboard`);
    } else throw new Refused(405, 'Not here.');
    await refresh();
    return {};
  }
  if (part !== undefined) throw new Refused(404, 'Not found.');

  if (method === 'PUT') {
    const ext = path.extname(url.searchParams.get('file') ?? '').toLowerCase();
    refuse(guild, uploadProblem(name, ext, Number(req.headers['content-length'] ?? 0)));
    const data = await readBody(req);
    const added = await addSound(guild, name, ext, data, undefined, url.searchParams.get('discord') !== '0');
    if (!added) throw new Refused(400, 'That file doesn’t have any audio the bot can read, so it wasn’t saved.');
    note(`${added.replaced ? 'Replaced' : 'Added'} sound **${name}**`);
    await refresh();
    return { replaced: added.replaced, discordProblem: added.problem && plain(guild, added.problem) };
  }

  if (method === 'PATCH') {
    const sound = soundOf(guild, name);
    const body = await readJson(req);
    if ('emoji' in body) {
      if (body.emoji !== null && typeof body.emoji !== 'string') throw new Refused(400, 'Emoji has to be text.');
      const emoji = body.emoji ? await parseEmoji(guild, body.emoji) : null;
      if (emoji && 'error' in emoji) throw new Refused(400, emoji.error);
      await changeEmoji(guild, sound.name, emoji?.emoji ?? null);
      note(emoji ? `Set the emoji on **${sound.name}**` : `Cleared the emoji on **${sound.name}**`);
    }
    if ('favourite' in body) setFavourite(guild.id, sound.name, body.favourite === true);
    if ('volume' in body) {
      refuse(guild, volumeProblem(body.volume));
      await setSoundVolume(guild, sound.name, body.volume as number);
      note(`Set the volume of **${sound.name}** to ${body.volume as number}%`);
    }
    if ('name' in body) {
      refuse(guild, await renameSound(guild, sound, String(body.name)));
      note(`Renamed **${sound.name}** to **${String(body.name)}**`);
    }
    await refresh();
    return {};
  }

  if (method === 'DELETE') {
    const problem = await removeSound(guild, soundOf(guild, name));
    note(`Removed sound **${name}**`);
    await refresh();
    return { discordProblem: problem };
  }
  throw new Refused(405, 'Not here.');
}

function deletedList(guild: Guild) {
  return { days: BIN_DAYS, sounds: deletedSounds(guild.id).map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, deletedAt: s.deleted_at, expiresAt: expiresAt(s) })) };
}

async function handleDeleted(client: Client<true>, guild: Guild, req: IncomingMessage, id: string, action?: string) {
  const sound = deletedSounds(guild.id).find((s) => String(s.id) === id);
  if (!sound) throw new Refused(404, 'That sound isn’t in the bin any more.');
  if (action === 'restore' && req.method === 'POST') {
    const name = restoreDeleted(guild.id, sound.id);
    if (!name) throw new Refused(404, 'That sound isn’t in the bin any more.');
    logActivity(guild.id, by(), `Restored sound **${name}**`);
    await refreshPanels(client, guild.id);
    return { name };
  }
  if (action === undefined && req.method === 'DELETE') {
    eraseDeleted(guild.id, sound.id);
    logActivity(guild.id, by(), `Erased deleted sound **${sound.name}**`);
    return {};
  }
  throw new Refused(405, 'Not here.');
}

function gameList(guild: Guild) {
  const group = groupMembers(guild);
  const prices = salePrices(guild.id);
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
        sale: sale ? { discount: sale.discount, price: sale.price, was: sale.was } : null,
      };
    }),
    members: memberList(guild),
  };
}

async function addGameFromWeb(guild: Guild, req: IncomingMessage) {
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

async function handleGame(guild: Guild, req: IncomingMessage, id: string, member?: string, userId?: string) {
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

/** Pairs going to a game night who aren't Steam friends, with their profiles to fix it from */
async function nightFriends(guild: Guild, nightId: number) {
  const night = upcomingNights(guild.id, Date.now()).nights.find((n) => n.id === nightId);
  if (!night) throw new Refused(404, 'No such game night.');
  needSteam();
  const links = new Map(steamLinks().map((l) => [l.user_id, l.steam_id]));
  const person = (id: string) => ({ name: nameOf(guild, id), url: profileUrl(links.get(id)!) });
  const pair = ([a, b]: [string, string]) => [person(a), person(b)];
  const { strangers, unknown, unlinked } = await friendsCheck(night.people.in);
  return { strangers: strangers.map(pair), unknown: unknown.map(pair), unlinked: unlinked.map((id) => nameOf(guild, id)) };
}

async function lobbyList(guild: Guild) {
  if (!config.steamApiKey) return { lobbies: [] };
  const lobbies = await lobbiesIn(guild).catch(steamDown);
  return { lobbies: lobbies.map((l) => ({ name: nameOf(guild, l.userId), game: l.game, join: l.join })) };
}

function steamAccountList(guild: Guild) {
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

function needSteam() {
  if (!config.steamApiKey) throw new Refused(409, 'Steam isn’t set up on the bot: it needs a STEAM_API_KEY.');
}

const steamDown = (err: unknown) => {
  console.error(err);
  throw new Refused(502, 'Steam couldn’t be reached just now. Try again in a bit.');
};

/** A text channel the bot can post in, from what the page sent */
function postingChannel(guild: Guild, id: unknown) {
  const checked = checkSetting(guild, 'announceChannel', id);
  if ('error' in checked) throw new Refused(400, plain(guild, checked.error));
  return guild.channels.cache.get(String(checked.value)) as GuildTextBasedChannel;
}

const cantPost = (err: unknown) => {
  console.error(err);
  throw new Refused(502, 'Discord wouldn’t take the message. Try again in a bit.');
};

function memberIn(guild: Guild, id: string) {
  const member = guild.members.cache.get(id);
  if (!member || member.user.bot) throw new Refused(404, 'They aren’t in this server.');
  return member;
}

/** What the page needs to choose people and channels */
function pickOptions(guild: Guild) {
  return { members: memberList(guild), voice: voiceList(guild).channels, channels: textChannels(guild), announceChannel: idSetting(guild.id, 'announceChannel') };
}

async function pickFromWeb(guild: Guild, url: URL) {
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

async function voteFromWeb(guild: Guild, req: IncomingMessage) {
  const { voiceChannelId, channelId, minutes } = await readJson(req);
  const length = minutes ?? 1;
  if (!Number.isInteger(length) || (length as number) < 1 || (length as number) > 10) throw new Refused(400, 'A vote lasts from 1 to 10 minutes.');
  const voice = voiceChannelFor(guild, voiceChannelId);
  const channel = postingChannel(guild, channelId);
  refuse(guild, await postVote(channel, voice, length as number).catch(cantPost));
  logActivity(guild.id, by(), `Started a game vote for <#${voice.id}> in <#${channel.id}>`);
  return {};
}

function compareFromWeb(guild: Guild, url: URL) {
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

async function achievementsFromWeb(guild: Guild, url: URL) {
  const appid = Number(url.searchParams.get('appid'));
  if (!Number.isInteger(appid) || appid < 1) throw new Refused(400, 'Pick a game.');
  const users = [...new Set((url.searchParams.get('users') ?? '').split(',').filter(Boolean))];
  if (!users.length) throw new Refused(400, 'Pick at least one person.');
  for (const id of users) memberIn(guild, id);
  needSteam();
  const { total, people, skipped, goals } = await achievementProgress(appid, users).catch(steamDown);
  return { total, goals, people: people.map((p) => ({ name: nameOf(guild, p.id), done: p.done })), skipped: skipped.map((id) => nameOf(guild, id)) };
}

function recapFromWeb(guild: Guild, url: URL) {
  const month = url.searchParams.get('month') ?? 'last';
  if (month !== 'last' && month !== 'this') throw new Refused(400, 'No such month.');
  const recap = recapFor(guild, month === 'this')?.toJSON();
  if (!recap) return { recap: null };
  return { recap: { title: recap.title, description: recap.description ? plain(guild, recap.description) : null, fields: (recap.fields ?? []).map((f) => ({ name: f.name, value: plain(guild, f.value) })) } };
}

async function handlePings(guild: Guild, req: IncomingMessage, userId: string) {
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

async function handleSteamAccount(guild: Guild, req: IncomingMessage, userId: string) {
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

async function handleFamily(guild: Guild, req: IncomingMessage, userId: string) {
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

function musicList(guild: Guild) {
  const state = musicState(guild.id);
  const channel = state.channelId ? guild.channels.cache.get(state.channelId) : undefined;
  return {
    ...state,
    channelName: channel?.name ?? null,
    defaultChannelId: musicChannelFor(guild.id),
    volume: setting(guild.id, 'musicVolume'),
    queue: queueOf(guild.id).map((r) => ({
      id: r.id,
      uri: r.uri,
      title: r.title,
      artist: r.artist,
      album: r.album,
      cover: r.cover,
      durationMs: r.duration_ms,
      addedBy: whoDid(guild, r.added_by),
    })),
  };
}

/** Spotify's messages are for whoever searched; anything else is the bot's fault */
const spotifyRefused = (err: unknown): never => {
  if (err instanceof SpotifyError) throw new Refused(502, err.message.replaceAll('**', ''));
  throw err;
};

async function handleMusic(guild: Guild, req: IncomingMessage, url: URL, rest: string[]) {
  const key = `${req.method} ${rest.join('/')}`;
  if (key === 'GET ') return musicList(guild);
  if (key === 'GET search') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const tracks: Track[] = await search(q).catch(spotifyRefused);
    return { tracks };
  }
  if (key === 'GET playlists') {
    if (!playlistsReady()) return { playlists: [], problem: 'Playlists need the bot signed in to Spotify once, with SPOTIFY_REFRESH_TOKEN. See the README’s music container section.' };
    return { playlists: await myPlaylists().catch(spotifyRefused), problem: null };
  }
  if (key === 'POST queue') {
    const { query, track, next, shuffle } = await readJson(req);
    if (track && typeof track === 'object') {
      // A search result picked on the page, sent back as it came
      const t = track as Record<string, unknown>;
      if (typeof t.uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) || typeof t.title !== 'string' || typeof t.durationMs !== 'number') throw new Refused(400, 'That isn’t a song.');
      const picked: Track = { uri: t.uri, title: t.title.slice(0, 300), artist: String(t.artist ?? '').slice(0, 300), album: String(t.album ?? '').slice(0, 300), cover: typeof t.cover === 'string' && t.cover.startsWith('https://i.scdn.co/') ? t.cover : null, durationMs: t.durationMs };
      if (!addTracks(guild.id, [picked], by(), next === true)) throw new Refused(409, 'The queue is full.');
      logActivity(guild.id, by(), `Added **${picked.title}** to the music queue${next === true ? ' to play next' : ''}`);
      return musicList(guild);
    }
    if (typeof query !== 'string' || !query.trim()) throw new Refused(400, 'Search for a song, or paste a Spotify link.');
    const message = await queueFrom(guild.id, query, by(), next === true, shuffle === true).catch(spotifyRefused);
    return { ...musicList(guild), message: plain(guild, message) };
  }
  if (key === 'DELETE queue') {
    clearQueue(guild.id, by());
    return musicList(guild);
  }
  if (rest[0] === 'queue' && rest.length >= 2) {
    const id = Number(rest[1]);
    if (key === `DELETE queue/${rest[1]}`) {
      if (!(await removeTrack(guild.id, id, by()))) throw new Refused(404, 'That song isn’t in the queue any more.');
      return musicList(guild);
    }
    if (key === `POST queue/${rest[1]}/move`) {
      const { to } = await readJson(req);
      if (!Number.isInteger(to)) throw new Refused(400, 'Say where to move it.');
      if (!moveTrack(guild.id, id, to as number)) throw new Refused(409, 'That song can’t move: it’s playing, or gone.');
      return musicList(guild);
    }
  }
  if (key === 'POST file') {
    // Sent as the file itself, so what it is and where to play it come in the address
    const name = (url.searchParams.get('name') ?? '').trim().slice(0, 200);
    const ext = path.extname(name).toLowerCase();
    refuse(guild, fileProblem(ext, Number(req.headers['content-length'] ?? 0)));
    const channel = voiceChannelFor(guild, url.searchParams.get('channelId'));
    const file = fileUploadPath(ext);
    await saveBody(req, file, MOST_FILE_BYTES);
    refuse(guild, await playFile(guild, channel, file, path.basename(name, path.extname(name)) || 'a file', by()));
    return musicList(guild);
  }
  if (key === 'POST file/seek') {
    const { positionMs } = await readJson(req);
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) throw new Refused(400, 'positionMs must be a number.');
    const problem = await seekFile(guild.id, positionMs);
    if (problem === 'No file is playing.') throw new Refused(409, problem);
    refuse(guild, problem);
    return musicList(guild);
  }
  if (key === 'POST file/stop') {
    if (!stopFile(guild.id)) throw new Refused(409, 'No file is playing.');
    return musicList(guild);
  }
  if (key === 'POST play') {
    const { channelId } = await readJson(req);
    refuse(guild, await startMusic(guild, voiceChannelFor(guild, channelId)));
    return musicList(guild);
  }
  if (key === 'POST pause') {
    refuse(guild, pauseMusic(guild.id));
    return musicList(guild);
  }
  if (key === 'POST seek') {
    const { positionMs } = await readJson(req);
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) throw new Refused(400, 'positionMs must be a number.');
    refuse(guild, await seekMusic(guild.id, positionMs));
    return musicList(guild);
  }
  if (key === 'POST skip') {
    refuse(guild, await skipMusic(guild.id, by()));
    return musicList(guild);
  }
  if (key === 'POST stop') {
    stopMusic(guild.id, by());
    return musicList(guild);
  }
  throw new Refused(404, 'Not found.');
}

async function handleSettings(guild: Guild, req: IncomingMessage, key?: string) {
  if (key === undefined) {
    if (req.method === 'GET') return settingList(guild);
    throw new Refused(405, 'Not here.');
  }
  if (!Object.hasOwn(DEFAULTS, key)) throw new Refused(404, 'No such setting.');
  const settingKey = key as SettingKey;
  // Discord's copies have their own volume, so they don't follow this by themselves
  const settled = async () => {
    if (settingKey === 'evenVolume') await applyLevels(guild);
    if (settingKey === 'soundVolume') applySoundVolume(guild.id);
    if (settingKey === 'musicVolume') applyMusicVolume(guild.id);
    if (settingKey.startsWith('loop')) await refreshLoopRoom(guild);
  };
  if (req.method === 'DELETE') {
    setSetting(guild.id, settingKey, undefined);
    logActivity(guild.id, by(), `Put ${LABELS[settingKey]} back to the default`);
    await settled();
    return {};
  }
  if (req.method !== 'PUT') throw new Refused(405, 'Not here.');
  const checked = checkSetting(guild, settingKey, (await readJson(req)).value);
  if ('error' in checked) throw new Refused(400, plain(guild, checked.error));
  setSetting(guild.id, settingKey, checked.value);
  logActivity(guild.id, by(), `Set ${LABELS[settingKey]} to ${show(settingKey, setting(guild.id, settingKey))}`);
  await settled();
  return { warning: checked.warning && plain(guild, checked.warning) };
}

async function handle(client: Client<true>, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://api');
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Refused(400, 'Bad path.');
  }
  const [root, guildId, section, ...rest] = segments;
  if (root !== 'guilds') throw new Refused(404, 'Not found.');
  if (guildId === undefined) {
    if (req.method !== 'GET') throw new Refused(405, 'Not here.');
    return { guilds: servedGuilds(client).map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) })) };
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild || !isAllowed(guild.id)) throw new Refused(404, 'The bot isn’t in that server.');

  if (section === 'sounds' && rest.length <= 2) return handleSounds(client, guild, req, res, url, rest[0], rest[1]);
  if (section === 'deleted-sounds' && !rest.length && req.method === 'GET') return deletedList(guild);
  if (section === 'deleted-sounds' && (rest.length === 1 || rest.length === 2)) return handleDeleted(client, guild, req, rest[0], rest[1]);
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
  if (section === 'achievements' && !rest.length && req.method === 'GET') return achievementsFromWeb(guild, url);
  if (section === 'recap' && !rest.length && req.method === 'GET') return recapFromWeb(guild, url);
  if (section === 'members' && rest.length === 2 && rest[1] === 'pings') return handlePings(guild, req, rest[0]);
  if (section === 'sound-panels' && !rest.length && req.method === 'POST') {
    const channel = postingChannel(guild, (await readJson(req)).channelId);
    await postPanel(channel).catch(cantPost);
    logActivity(guild.id, by(), `Posted a soundboard panel in <#${channel.id}>`);
    return {};
  }
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
  if (section === 'discord-sounds' && (rest.length === 1 || rest.length === 2)) return handleDiscordSound(client, guild, req, res, rest[0], rest[1]);
  if (section === 'settings' && rest.length <= 1) return handleSettings(guild, req, rest[0]);
  if (section === 'voice' && !rest.length && req.method === 'GET') return { ...voiceList(guild), soundVolume: setting(guild.id, 'soundVolume') };
  if (section === 'stats' && !rest.length && req.method === 'GET') return statsFor(guild, url);
  if (section === 'activity' && !rest.length && req.method === 'GET') return activityList(guild, url);
  if (section === 'me' && !rest.length) return handleMe(guild, req);
  if (section === 'free-games' && !rest.length && req.method === 'GET') {
    const games = await reviewGiveaways(guild).catch(() => {
      throw new Refused(502, 'The free game list couldn’t be read just now.');
    });
    return { games: games.map(({ title, url: link, worth, platforms, show, reason }) => ({ title, url: link, worth, platforms, show, reason })) };
  }
  if (section === 'sales' && !rest.length && req.method === 'GET') return saleList(guild);
  if (section === 'game-names' && !rest.length && req.method === 'GET') return gameNameList(guild);
  if (section === 'game-names' && rest.length === 1 && (rest[0] === 'merge' || rest[0] === 'separate') && req.method === 'POST') return changeGameNames(guild, req, rest[0]);
  if (section === 'join-sounds' && !rest.length && req.method === 'GET') return joinSoundList(guild);
  if (section === 'join-sounds' && rest.length === 1 && req.method === 'PUT') return setJoinSoundFromWeb(guild, req, rest[0]);
  if (section === 'join-sounds' && rest.length === 1 && req.method === 'DELETE') {
    const who = joinSounds(guild.id).find((r) => r.user_id === rest[0]);
    if (!who) throw new Refused(404, 'They don’t have a join sound.');
    setJoinSound(guild.id, who.user_id, null);
    logActivity(guild.id, by(), `Removed ${nameOf(guild, who.user_id)}’s join sound`);
    return {};
  }
  if (section === 'game-nights' && !rest.length && req.method === 'GET') return nightList(guild);
  if (section === 'game-nights' && !rest.length && req.method === 'POST') return planFromWeb(client, guild, req);
  if (section === 'game-nights' && rest.length === 1 && rest[0] === 'when' && req.method === 'GET') {
    return { time: readWhen(guild.id, (url.searchParams.get('text') ?? '').slice(0, 100)) };
  }
  if (section === 'game-nights' && rest.length === 2 && rest[1] === 'friends' && req.method === 'GET') return nightFriends(guild, Number(rest[0]));
  if (section === 'lobbies' && !rest.length && req.method === 'GET') return lobbyList(guild);
  if (section === 'game-nights' && rest.length === 2 && rest[1] === 'cancel' && req.method === 'POST') {
    const game = await cancelNight(client, guild, Number(rest[0]));
    if (!game) throw new Refused(404, 'No such game night.');
    logActivity(guild.id, by(), `Cancelled **${game}** night`);
    return {};
  }
  if (section === 'game-night-series' && rest.length === 1 && req.method === 'DELETE') {
    const game = await stopSeries(client, guild, Number(rest[0]));
    if (!game) throw new Refused(404, 'No such repeating night.');
    logActivity(guild.id, by(), `Stopped **${game}** night repeating`);
    return {};
  }
  if (section === 'say' && !rest.length && req.method === 'GET') {
    return { on: Boolean(config.voiceUrl) && setting(guild.id, 'tts'), voices: VOICES.map(({ id, name }) => ({ id, name })), voice: setting(guild.id, 'ttsVoice'), longest: setting(guild.id, 'ttsMaxChars'), phrases: phrases(guild.id) };
  }
  if (section === 'say' && !rest.length && req.method === 'POST') {
    const { channelId, text, voice } = await readJson(req);
    if (typeof text !== 'string') throw new Refused(400, 'Type something to say.');
    refuse(guild, await say(voiceChannelFor(guild, channelId), text, typeof voice === 'string' ? voice : undefined, by()));
    return {};
  }
  if (section === 'phrases' && !rest.length && req.method === 'POST') {
    const { text, voice } = await readJson(req);
    if (typeof text !== 'string') throw new Refused(400, 'Type something to save.');
    const known = phrases(guild.id).length;
    refuse(guild, savePhrase(guild, text, String(voice)));
    const saved = phrases(guild.id);
    if (saved.length > known) logActivity(guild.id, by(), `Saved the line “${saved.at(-1)!.text}”`);
    return { phrases: saved };
  }
  if (section === 'phrases' && rest.length === 1 && req.method === 'DELETE') {
    const phrase = phrases(guild.id).find((p) => p.id === Number(rest[0]));
    if (!phrase) throw new Refused(404, 'That saved line is gone.');
    removePhrase(guild.id, phrase.id);
    logActivity(guild.id, by(), `Removed the saved line “${phrase.text}”`);
    return { phrases: phrases(guild.id) };
  }
  if (section === 'music') return handleMusic(guild, req, url, rest);
  if (section === 'stop' && !rest.length && req.method === 'POST') {
    stopPlayback(guild.id);
    return {};
  }
  if (section === 'discord-sync' && !rest.length && req.method === 'POST') {
    const result = await syncToDiscord(guild);
    await refreshPanels(client, guild.id);
    if (result.added.length) logActivity(guild.id, by(), `Copied ${result.added.length} sound${result.added.length === 1 ? '' : 's'} to Discord’s soundboard`);
    return { ...result, failed: result.failed.map((f) => plain(guild, f)), blocker: result.blocker && plain(guild, result.blocker) };
  }
  throw new Refused(404, 'Not found.');
}

/** The management API behind the web UI. Every sound and setting rule lives in the bot, so it's the only thing that applies them */
export function createApi(client: Client<true>, token: string): Server {
  return createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      // A refused upload may not have been read to the end, so the connection can't be reused
      res.writeHead(status, { 'content-type': 'application/json', ...(status >= 400 && { connection: 'close' }) }).end(JSON.stringify(body));
    };
    if (!authorized(req, token)) return reply(401, { error: 'Unauthorized.' });
    const who = signedIn(req);
    if (who) seeWebUser(who.email, who.name);
    if (req.method !== 'GET') console.log(`Web UI: ${req.method} ${req.url}${who ? ` (${who.email})` : ''}`);
    asking.run(who, () => handle(client, req, res)).then(
      (body) => body && reply(200, body),
      (err: unknown) => {
        if (err instanceof Refused) return reply(err.status, { error: err.message });
        console.error(`Web UI: ${req.method} ${req.url} failed:`, err);
        if (res.headersSent) res.destroy();
        else reply(500, { error: 'Something broke. Check the bot logs.' });
      },
    );
  });
}

let server: Server | undefined;

export const webApi: Feature = {
  setup(client) {
    if (!config.apiToken) return;
    server = createApi(client, config.apiToken).listen(config.apiPort, () => console.log(`Management API listening on port ${config.apiPort}`));
    server.on('error', (err) => console.error('Management API failed:', err.message));
  },
  shutdown() {
    server?.close();
    server?.closeAllConnections();
  },
};
