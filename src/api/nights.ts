import { ChannelType, type Client, type Guild, type VoiceChannel } from 'discord.js';
import { type IncomingMessage } from 'node:http';
import { logActivity, webUser } from '../activity.ts';
import { answerFor, cancelNight, editNight, gameNames, planNight, readWhen, stopSeries, upcomingNights, whenText } from '../features/gamenight.ts';
import { friendsCheck, profileUrl, steamLinks } from '../features/steam.ts';
import { checkSetting } from '../features/setup.ts';
import { idSetting, setting } from '../settings.ts';
import { canSee } from '../util.ts';
import { type Ask, Refused, asking, by, memberIn, memberList, nameOf, plain, readJson, textChannels } from './common.ts';
import { needSteam } from './games.ts';

// The management API for game nights

const REPEATS = [7, 14];

export function nightList(guild: Guild) {
  const channelName = (id: string | null) => (id ? (guild.channels.cache.get(id)?.name ?? null) : null);
  const { nights, series } = upcomingNights(guild.id, Date.now());
  return {
    timeZone: setting(guild.id, 'timezone'),
    nights: nights.map((n) => ({
      id: n.id,
      game: n.game,
      details: n.details,
      startsAt: n.starts_at,
      // What the edit form's When starts as, in a form that reads back as the same time
      when: whenText(n.starts_at, setting(guild.id, 'timezone')),
      voiceChannel: channelName(n.voice_channel_id),
      voiceChannelId: n.voice_channel_id,
      hostId: n.created_by,
      host: nameOf(guild, n.created_by),
      in: n.people.in.map((id) => nameOf(guild, id)),
      maybe: n.people.maybe.map((id) => nameOf(guild, id)),
      out: n.people.out.map((id) => nameOf(guild, id)),
      // Who answered what by member id, so the page can show someone their own answer
      answers: Object.fromEntries((['in', 'maybe', 'out'] as const).flatMap((answer) => n.people[answer].map((id) => [id, answer]))),
      repeats: n.repeats,
    })),
    series: series.map((s) => ({ id: s.id, game: s.game, repeats: s.repeats, nextAt: s.next_at, host: nameOf(guild, s.created_by) })),
    // What the form for planning one chooses from
    games: gameNames(guild.id),
    channels: textChannels(guild),
    defaultChannel: idSetting(guild.id, 'announceChannel'),
    voiceChannels: [...guild.channels.cache.values()]
      .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice && canSee(guild, c))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name })),
    members: memberList(guild),
  };
}

/** Plans a night by the same rules as /gamenight plan, except a host has to be picked: the web UI doesn't know who's using it */
export async function planFromWeb(client: Client<true>, guild: Guild, req: IncomingMessage) {
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

/** Pairs going to a game night who aren't Steam friends, with their profiles to fix it from */
export async function nightFriends(guild: Guild, nightId: number) {
  const night = upcomingNights(guild.id, Date.now()).nights.find((n) => n.id === nightId);
  if (!night) throw new Refused(404, 'No such game night.');
  needSteam();
  const links = new Map(steamLinks().map((l) => [l.user_id, l.steam_id]));
  const person = (id: string) => ({ name: nameOf(guild, id), url: profileUrl(links.get(id)!) });
  const pair = ([a, b]: [string, string]) => [person(a), person(b)];
  const { strangers, unknown, unlinked } = await friendsCheck(night.people.in);
  return { strangers: strangers.map(pair), unknown: unknown.map(pair), unlinked: unlinked.map((id) => nameOf(guild, id)) };
}

export async function nightRoutes({ client, guild, req, res, url, section, rest }: Ask) {
  if (section === 'game-nights' && !rest.length && req.method === 'GET') return nightList(guild);
  if (section === 'game-nights' && !rest.length && req.method === 'POST') return planFromWeb(client, guild, req);
  if (section === 'game-nights' && rest.length === 1 && rest[0] === 'when' && req.method === 'GET') {
    return { time: readWhen(guild.id, (url.searchParams.get('text') ?? '').slice(0, 100)) };
  }
  if (section === 'game-nights' && rest.length === 2 && rest[1] === 'friends' && req.method === 'GET') return nightFriends(guild, Number(rest[0]));
  if (section === 'game-nights' && rest.length === 2 && rest[1] === 'rsvp' && req.method === 'POST') {
    const { answer, userId } = await readJson(req);
    // Someone signed in who has said who they are answers for themselves; otherwise the page says who
    const who = asking.getStore();
    const member = memberIn(guild, String((who && webUser(who.email)?.userId) || userId));
    const result = await answerFor(client, guild, Number(rest[0]), member.id, String(answer));
    if (result === undefined) throw new Refused(404, 'No such game night.');
    if (typeof result === 'string') throw new Refused(409, result);
    logActivity(guild.id, by(), `Answered **${result.label}** for ${member.displayName} to **${result.game}** night`);
    return { night: nightList(guild).nights.find((n) => n.id === Number(rest[0])) ?? null };
  }
  if (section === 'game-nights' && rest.length === 1 && req.method === 'PATCH') {
    const { game, when, details, voiceChannelId } = await readJson(req);
    let voice: string | null | undefined;
    if (voiceChannelId === null || voiceChannelId === '') voice = null;
    else if (voiceChannelId !== undefined) {
      const channel = guild.channels.cache.get(String(voiceChannelId));
      if (channel?.type !== ChannelType.GuildVoice) throw new Refused(400, 'Pick a voice channel.');
      voice = channel.id;
    }
    const who = asking.getStore();
    const result = await editNight(client, guild, Number(rest[0]), { game, when, details, voiceChannelId: voice }, (who && webUser(who.email)?.userId) || undefined);
    if (result === undefined) throw new Refused(404, 'No such game night.');
    if (typeof result === 'string') throw new Refused(400, result);
    if (result.changed.length) logActivity(guild.id, by(), `Changed the ${result.changed.join(', ')} of **${result.game}** night`);
    return { changed: result.changed, eventNote: result.eventNote || null, night: nightList(guild).nights.find((n) => n.id === Number(rest[0])) ?? null };
  }
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
  throw new Refused(404, 'Not found.');
}
