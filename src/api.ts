import { ChannelType, type Client, type Guild, type VoiceBasedChannel } from 'discord.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { FROM_WEB, logActivity, recentActivity } from './activity.ts';
import { config } from './config.ts';
import * as discordBoard from './discordSounds.ts';
import { cancelNight, gameNames, planNight, readWhen, stopSeries, upcomingNights } from './features/gamenight.ts';
import { activity, checkpoint, PERIODS, stats } from './features/gamestats.ts';
import { gameName, gameSpellings, mergeGames, separateGame } from './gameNames.ts';
import { voiceTotals } from './features/sessions.ts';
import { checkSetting, LABELS, LIMITS, show, source } from './features/setup.ts';
import {
  addSound,
  addToDiscord,
  applyLevels,
  changeEmoji,
  discordVolume,
  favourites,
  findSound,
  isTrimmed,
  joinSounds,
  listSounds,
  parseEmoji,
  playCounts,
  playFromWeb,
  refreshPanels,
  removeSound,
  renameSound,
  restoreSound,
  setFavourite,
  setJoinSound,
  setSoundVolume,
  soundLevels,
  stopPlayback,
  syncToDiscord,
  trimProblem,
  trimSound,
  uploadProblem,
  voiceVolume,
  volumeProblem,
  type Sound,
} from './features/soundboard.ts';
import { DEFAULTS, idSetting, isAllowed, setSetting, setting, type SettingKey } from './settings.ts';
import type { Feature } from './types.ts';
import { humansIn, servedGuilds } from './util.ts';

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
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${guild.roles.cache.get(id)?.name ?? 'unknown role'}`);
}

const hash = (text: string) => createHash('sha256').update(text).digest();

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
    slots: await discordBoard.slots(guild).catch(() => null),
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
    })),
    channels: textChannels(guild),
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
    members: [...guild.members.cache.values()]
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, name: m.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
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
  logActivity(guild.id, FROM_WEB, `Planned **${name}** night for ${time.label}`);
  return { eventNote: note && plain(guild, note) };
}

function activityList(guild: Guild, url: URL) {
  const before = Number(url.searchParams.get('before')) || undefined;
  const rows = recentActivity(guild.id, ACTIVITY_PAGE + 1, before);
  return {
    timeZone: setting(guild.id, 'timezone'),
    entries: rows.slice(0, ACTIVITY_PAGE).map((r) => ({ id: r.id, at: r.at, who: r.actor === FROM_WEB ? 'Web UI' : nameOf(guild, r.actor), action: plain(guild, r.action) })),
    more: rows.length > ACTIVITY_PAGE,
  };
}

function joinSoundList(guild: Guild) {
  return { joinSounds: joinSounds(guild.id).map((r) => ({ id: r.user_id, who: nameOf(guild, r.user_id), name: r.name })) };
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
    games: games.slice(0, MAX_RANKED).map((g) => ({ name: g.key, ms: g.ms, people: g.n })),
    players: players.slice(0, MAX_RANKED).map((p) => ({ id: p.key, name: nameOf(guild, p.key), ms: p.ms, games: p.n })),
    voice: voice.slice(0, MAX_RANKED).map((p) => ({ id: p.userId, name: nameOf(guild, p.userId), ms: p.secs * 1000, nights: p.nights })),
    activity: activity(guild.id, since, now, setting(guild.id, 'timezone'), user, game),
  };
}

/** Every game with time on record, longest first, and what else it's been called */
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
    logActivity(guild.id, FROM_WEB, `Merged ${(names as string[]).map((n) => `**${n}**`).join(', ')} into **${into}**`);
    return {};
  }
  if (typeof body.name !== 'string') throw new Refused(400, 'Pick a spelling to separate.');
  refuse(guild, separateGame(guild.id, body.name));
  logActivity(guild.id, FROM_WEB, `Separated **${body.name}**`);
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

async function handleSounds(client: Client<true>, guild: Guild, req: IncomingMessage, res: ServerResponse, url: URL, name?: string, part?: string) {
  const method = req.method!;
  // Everything but reading changes what the posted panels show
  const refresh = () => refreshPanels(client, guild.id);
  const note = (action: string) => logActivity(guild.id, FROM_WEB, action);

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
    const channel = guild.channels.cache.get(String((await readJson(req)).channelId));
    if (!channel?.isVoiceBased()) throw new Refused(400, 'Pick a voice channel.');
    // With nobody there, the bot would leave as soon as it joined
    if (!humansIn(channel).length) throw new Refused(400, `Nobody’s in ${channel.name} any more.`);
    refuse(guild, await playFromWeb(channel, sound));
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
      const { start } = await readJson(req);
      if (start !== undefined && (typeof start !== 'number' || !(start >= 0))) throw new Refused(400, 'Start has to be a number of seconds.');
      refuse(guild, await addToDiscord(guild, sound, start));
      note(`Added **${sound.name}** to Discord’s soundboard`);
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

async function handleSettings(guild: Guild, req: IncomingMessage, key?: string) {
  if (key === undefined) {
    if (req.method === 'GET') return settingList(guild);
    throw new Refused(405, 'Not here.');
  }
  if (!Object.hasOwn(DEFAULTS, key)) throw new Refused(404, 'No such setting.');
  const settingKey = key as SettingKey;
  // Discord's copies have their own volume, so they don't follow this by themselves
  const settled = () => (settingKey === 'evenVolume' ? applyLevels(guild) : undefined);
  if (req.method === 'DELETE') {
    setSetting(guild.id, settingKey, undefined);
    logActivity(guild.id, FROM_WEB, `Put ${LABELS[settingKey]} back to the default`);
    await settled();
    return {};
  }
  if (req.method !== 'PUT') throw new Refused(405, 'Not here.');
  const checked = checkSetting(guild, settingKey, (await readJson(req)).value);
  if ('error' in checked) throw new Refused(400, plain(guild, checked.error));
  setSetting(guild.id, settingKey, checked.value);
  logActivity(guild.id, FROM_WEB, `Set ${LABELS[settingKey]} to ${show(settingKey, setting(guild.id, settingKey))}`);
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
  if (section === 'settings' && rest.length <= 1) return handleSettings(guild, req, rest[0]);
  if (section === 'voice' && !rest.length && req.method === 'GET') return voiceList(guild);
  if (section === 'stats' && !rest.length && req.method === 'GET') return statsFor(guild, url);
  if (section === 'activity' && !rest.length && req.method === 'GET') return activityList(guild, url);
  if (section === 'game-names' && !rest.length && req.method === 'GET') return gameNameList(guild);
  if (section === 'game-names' && rest.length === 1 && (rest[0] === 'merge' || rest[0] === 'separate') && req.method === 'POST') return changeGameNames(guild, req, rest[0]);
  if (section === 'join-sounds' && !rest.length && req.method === 'GET') return joinSoundList(guild);
  if (section === 'join-sounds' && rest.length === 1 && req.method === 'DELETE') {
    const who = joinSounds(guild.id).find((r) => r.user_id === rest[0]);
    if (!who) throw new Refused(404, 'They don’t have a join sound.');
    setJoinSound(guild.id, who.user_id, null);
    logActivity(guild.id, FROM_WEB, `Removed ${nameOf(guild, who.user_id)}’s join sound`);
    return {};
  }
  if (section === 'game-nights' && !rest.length && req.method === 'GET') return nightList(guild);
  if (section === 'game-nights' && !rest.length && req.method === 'POST') return planFromWeb(client, guild, req);
  if (section === 'game-nights' && rest.length === 1 && rest[0] === 'when' && req.method === 'GET') {
    return { time: readWhen(guild.id, (url.searchParams.get('text') ?? '').slice(0, 100)) };
  }
  if (section === 'game-nights' && rest.length === 2 && rest[1] === 'cancel' && req.method === 'POST') {
    const game = await cancelNight(client, guild, Number(rest[0]));
    if (!game) throw new Refused(404, 'No such game night.');
    logActivity(guild.id, FROM_WEB, `Cancelled **${game}** night`);
    return {};
  }
  if (section === 'game-night-series' && rest.length === 1 && req.method === 'DELETE') {
    const game = await stopSeries(client, guild, Number(rest[0]));
    if (!game) throw new Refused(404, 'No such repeating night.');
    logActivity(guild.id, FROM_WEB, `Stopped **${game}** night repeating`);
    return {};
  }
  if (section === 'stop' && !rest.length && req.method === 'POST') {
    stopPlayback(guild.id);
    return {};
  }
  if (section === 'discord-sync' && !rest.length && req.method === 'POST') {
    const result = await syncToDiscord(guild);
    await refreshPanels(client, guild.id);
    if (result.added.length) logActivity(guild.id, FROM_WEB, `Copied ${result.added.length} sound${result.added.length === 1 ? '' : 's'} to Discord’s soundboard`);
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
    if (req.method !== 'GET') console.log(`Web UI: ${req.method} ${req.url}`);
    handle(client, req, res).then(
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
