import type Anthropic from '@anthropic-ai/sdk';
import { ChannelType, type Guild, type GuildMember, type GuildTextBasedChannel, PermissionFlagsBits, type VoiceBasedChannel } from 'discord.js';
import { logActivity } from '../activity.ts';
import { plain } from '../api/common.ts';
import { gameKey } from '../gameText.ts';
import { setting } from '../settings.ts';
import { listNames, memberSees, sayableIn } from '../util.ts';
import { nameOf, object, unquoted } from './chatLookups.ts';
import { answerFor, cancelNight, describe, editNight, gameNames, type NightEdit, planNight, readWhen, stopSeries, upcomingNight, upcomingNights } from './gamenight.ts';
import { gamesInVote, postVote } from './gamevote.ts';
import { remind, reminderTools } from './chatReminders.ts';
import { findSound, uploadProblem } from './soundLibrary.ts';
import { downloadLink, linksReady, LONGEST_PART, partProblem, savePart } from './soundLinks.ts';
import { managersOnly, mayChangeSounds, refreshPanels } from './soundPanel.ts';
import * as discordBoard from '../discordSounds.ts';

// What chat can do with the bot's other features for the person asking: plan, change and answer game nights, start a
// vote on what to play, set reminders (chatReminders.ts), and make soundboard sounds from links. Each runs what the slash command, button or web UI runs, with the permission it checks, and
// is in Activity under their name. The server's "Take actions" setting turns them off, leaving the list of game nights

/** Game nights listed at once */
const MOST_NIGHTS = 10;
const LONGEST_DETAILS = 150;
const REPEATS = { no: null, weekly: 7, every_2_weeks: 14 } as const;
const NIGHT_ID = { type: 'integer', description: 'The night’s id from game_nights' };
/** A sound made from a link with no start or end given is the whole of it, up to this long */
const WHOLE_UP_TO = 30;

/** The tools that change something, for chat to log and remember */
export const ACTIONS = new Set(['plan_game_night', 'change_game_night', 'answer_game_night', 'start_vote', 'set_reminder', 'cancel_reminder', 'make_sound']);

export function actionTools(guild: Guild): Anthropic.Tool[] {
  const list: Anthropic.Tool[] = [
    {
      name: 'game_nights',
      description: 'Lists the upcoming game nights: each one’s id, game, time, host, voice channel and details, who’s in, maybe or can’t make it, and whether it repeats.',
      strict: true,
      input_schema: object({}),
    },
  ];
  if (!setting(guild.id, 'chatActions')) return list;
  list.push(
    {
      name: 'plan_game_night',
      description:
        'Plans a game night, as /gamenight plan does: posts its RSVP message here, pinging the game’s role if it has one, with a Discord event, and the person asking in as host. Anyone can plan one.',
      strict: true,
      input_schema: object({
        game: { type: 'string', description: 'What they’re playing' },
        when: { type: 'string', description: 'A day and time like “fri 9pm”, “tomorrow 20:30”, “nov 3 7pm” or “2026-11-21 19:00”' },
        details: { type: 'string', description: 'Anything they said people should know, or empty' },
        voice_channel: { type: 'string', description: 'The voice channel they’ll meet in, by name, or empty' },
        repeat: { type: 'string', enum: ['no', 'weekly', 'every_2_weeks'] },
      }),
    },
    {
      name: 'change_game_night',
      description:
        'Cancels a game night (everyone who’s in is told), stops it repeating, or changes its game, time or details. Only its host or someone with Manage Events can.',
      strict: true,
      input_schema: object({
        night_id: NIGHT_ID,
        action: { type: 'string', enum: ['cancel', 'stop_repeating', 'change'] },
        game: { type: 'string', description: 'For change: the new game, or empty to keep it' },
        when: { type: 'string', description: 'For change: the new day and time, as for plan_game_night, or empty to keep it' },
        details: { type: 'string', description: 'For change: the new details, “none” to take them off, or empty to keep them' },
      }),
    },
    {
      name: 'answer_game_night',
      description: 'Answers a game night for the person asking, as its buttons do: in, maybe, or out (can’t make it). Only for themselves.',
      strict: true,
      input_schema: object({ night_id: NIGHT_ID, answer: { type: 'string', enum: ['in', 'maybe', 'out'] } }),
    },
    {
      name: 'start_vote',
      description:
        'Starts a vote on what to play, as /gamevote does: posts it here, on the games everyone in the asker’s voice channel owns, and they vote with its buttons. It closes by itself.',
      strict: true,
      input_schema: object({
        minutes: { type: 'integer', description: 'How long it stays open, 1 to 10. 1 unless they say' },
        games: { type: 'array', items: { type: 'string' }, description: 'Only these games, if they named some; empty for all of them' },
      }),
    },
    ...reminderTools(),
  );
  if (linksReady()) {
    list.push({
      name: 'make_sound',
      description:
        'Makes a soundboard sound from part of a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track, as the web UI’s Add from a link does: downloads it, cuts it from start to end (3 minutes at most) and adds it to the library. Downloading takes a while, so it answers at once and posts how it went here by itself. Only for people who can change sounds.',
      strict: true,
      input_schema: object({
        link: { type: 'string', description: 'The link, starting https://' },
        name: { type: 'string', description: 'The sound’s name: lowercase letters, numbers, - and _, up to 32. Make one from what they said if they didn’t give one' },
        start: { type: 'string', description: 'Where it starts, like “0:05” or “65”, or empty for the beginning' },
        end: { type: 'string', description: 'Where it ends, like “0:12”, or empty for the end' },
      }),
    });
  }
  return list;
}

/** Does what an action tool asks, as the person asking, in the channel they asked in. Null if it isn't one of these */
export async function act(member: GuildMember, name: string, input: Record<string, unknown>, where: GuildTextBasedChannel | null): Promise<string | null> {
  const text = (key: string) => unquoted(String(input[key] ?? ''));
  // Offered only with the setting on, in case the model asks anyway
  if (ACTIONS.has(name) && !setting(member.guild.id, 'chatActions')) return 'Taking actions in chat is turned off on this server. Point them to the command, if there is one.';
  switch (name) {
    case 'game_nights':
      return nightsList(member, where);
    case 'plan_game_night':
      return plan(member, text('game'), text('when'), text('details'), text('voice_channel'), REPEATS[text('repeat') as keyof typeof REPEATS] ?? null, where);
    case 'change_game_night':
      return change(member, Number(input.night_id), text('action'), { game: text('game'), when: text('when'), details: text('details') });
    case 'answer_game_night': {
      if (!seenNight(member, Number(input.night_id))) return 'There’s no game night with that id. game_nights lists them.';
      const result = await answerFor(member.client, member.guild, Number(input.night_id), member.id, text('answer'));
      if (result === undefined) return 'There’s no game night with that id. game_nights lists them.';
      if (typeof result === 'string') return result;
      logActivity(member.guild.id, member.id, `Answered **${result.label}** for ${member.displayName} to **${result.game}** night`);
      return `Marked ${member.displayName} “${result.label}” for ${result.game} night.`;
    }
    case 'start_vote':
      return vote(member, Number(input.minutes), Array.isArray(input.games) ? input.games.map((g) => unquoted(String(g))).filter(Boolean) : [], where);
    case 'make_sound':
      return makeSound(member, text('link'), text('name').toLowerCase(), text('start'), text('end'), where);
    default:
      return remind(member, name, input, where, text);
  }
}

/** A night coming up whose card the asker can see, as its buttons need */
function seenNight(member: GuildMember, id: number) {
  const night = upcomingNight(member.guild.id, id, Date.now());
  return night && memberSees(member, night.channel_id) ? night : undefined;
}
/** The game as the library names it, so its role is pinged, or as they said it */
const libraryName = (guild: Guild, said: string) => gameNames(guild.id).find((n) => gameKey(n) === gameKey(said)) ?? said;

/**
 * The nights coming up whose cards the asker can see. Those posted where not everyone here can see, only as
 * /gamenight list shows them, since the answer is public
 */
function nightsList(member: GuildMember, where: GuildTextBasedChannel | null): string {
  const { guild } = member;
  const nights = upcomingNights(guild.id, Date.now()).nights.filter((n) => memberSees(member, n.channel_id));
  if (!nights.length) return 'No game nights are planned.';
  const timeZone = setting(guild.id, 'timezone');
  const who = (ids: string[]) => listNames(ids.map((id) => nameOf(guild, id)));
  const lines = nights.slice(0, MOST_NIGHTS).map((n) => {
    const started = n.starts_at < Date.now() ? ' (started)' : '';
    if (!sayableIn(guild, n.channel_id, where)) {
      return `night ${n.id}: ${n.game}, ${describe(n.starts_at, timeZone)}${started}; ${n.people.in.length} in; posted where not everyone here can see, so its details and who’s in aren’t said here`;
    }
    const voice = n.voice_channel_id ? guild.channels.cache.get(n.voice_channel_id)?.name : null;
    const details = n.details && (n.details.length > LONGEST_DETAILS ? `${n.details.slice(0, LONGEST_DETAILS)}…` : n.details);
    return [
      `night ${n.id}: ${n.game}, ${describe(n.starts_at, timeZone)}${started}`,
      `hosted by ${nameOf(guild, n.created_by)}`,
      voice ? `in ${voice}` : null,
      details ? `details: ${details.replace(/\s+/g, ' ')}` : null,
      n.people.in.length ? `in: ${who(n.people.in)}` : 'nobody in yet',
      n.people.maybe.length ? `maybe: ${who(n.people.maybe)}` : null,
      n.people.out.length ? `can’t: ${who(n.people.out)}` : null,
      n.repeats ? `repeats ${n.repeats.toLowerCase()}` : null,
    ]
      .filter(Boolean)
      .join('; ');
  });
  return [...lines, nights.length > MOST_NIGHTS ? `and ${nights.length - MOST_NIGHTS} more` : ''].filter(Boolean).join('\n');
}

/** A voice channel the asker can see, by its name or the only one with it in its name */
function voiceNamed(member: GuildMember, said: string): VoiceBasedChannel | string {
  const voices = [...member.guild.channels.cache.values()].filter(
    (c): c is VoiceBasedChannel => c.type === ChannelType.GuildVoice && !!c.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel),
  );
  const key = said.toLowerCase().replace(/^#/, '');
  const exact = voices.filter((c) => c.name.toLowerCase() === key);
  const close = exact.length ? exact : voices.filter((c) => c.name.toLowerCase().includes(key));
  if (close.length === 1) return close[0]!;
  return close.length ? `More than one voice channel matches “${said}”: ${listNames(close.map((c) => c.name))}. Ask which.` : `There’s no voice channel called “${said}”. They are: ${listNames(voices.map((c) => c.name)) || 'none'}.`;
}

async function plan(member: GuildMember, said: string, when: string, details: string, voiceName: string, everyDays: number | null, where: GuildTextBasedChannel | null): Promise<string> {
  const { guild } = member;
  if (!where) return 'There’s nowhere here to post it.';
  if (!said || said.length > 90) return 'Ask what they’re playing: a game’s name, in 90 characters or fewer.';
  const game = libraryName(guild, said);
  if (!when) return 'They didn’t say when: ask them.';
  const time = readWhen(guild.id, when.slice(0, 100));
  if (!time) return `“${when}” isn’t a time it can read. Give it like “fri 9pm”, “tomorrow 20:30” or “nov 3 7pm”, or ask them when.`;
  if (time.passed) return `${time.label} has already passed.`;
  if (details.length > 1000) return 'The details have to fit in 1000 characters.';
  const voice = voiceName ? voiceNamed(member, voiceName) : null;
  if (typeof voice === 'string') return voice;
  // Asked again, or after an answer that didn't arrive, it isn't posted twice
  const same = upcomingNights(guild.id, Date.now()).nights.find((n) => gameKey(n.game) === gameKey(game) && n.starts_at === time.at);
  if (same) return `There’s already a ${same.game} night then, hosted by ${nameOf(guild, same.created_by)} (night ${same.id}).`;
  let note: string;
  try {
    note = await planNight(member.client, guild, { channel_id: where.id, game, details: details || null, voice_channel_id: voice?.id ?? null, starts_at: time.at, created_by: member.id }, everyDays);
  } catch (err) {
    console.error('Chat couldn’t post a game night:', err);
    return 'It couldn’t be posted in this channel, so it isn’t planned. Ask them to try /gamenight plan, or another channel.';
  }
  logActivity(guild.id, member.id, `Planned **${game}** night for ${time.label}`);
  const repeats = everyDays ? `, repeating every ${everyDays === 7 ? 'week' : '2 weeks'}` : '';
  return `Planned ${game} night for ${time.label}${repeats}${voice ? ` in ${voice.name}` : ''}. Its RSVP message is posted here, with ${member.displayName} in as host. ${note ? plain(guild, note) : 'It’s a Discord event too.'}`;
}

async function change(member: GuildMember, id: number, action: string, edit: { game: string; when: string; details: string }): Promise<string> {
  const { guild, client } = member;
  const night = seenNight(member, id);
  if (!night) return 'There’s no upcoming game night with that id. game_nights lists them.';
  // In the night's channel, as its buttons are
  const card = guild.channels.cache.get(night.channel_id);
  if (member.id !== night.created_by && !(card ? member.permissionsIn(card) : member.permissions).has(PermissionFlagsBits.ManageEvents)) {
    return `Only its host, ${nameOf(guild, night.created_by)}, or someone with Manage Events can change or cancel it.`;
  }
  switch (action) {
    case 'cancel': {
      const game = await cancelNight(client, guild, night.id);
      if (!game) return 'That game night is gone.';
      logActivity(guild.id, member.id, `Cancelled **${game}** night`);
      // cancelNight tells those who are in, if it hasn't started
      const told = night.starts_at > Date.now() && night.people.in.length ? ` ${listNames(night.people.in.map((p) => nameOf(guild, p)))} ${night.people.in.length === 1 ? 'is' : 'are'} told it’s off.` : '';
      return `Cancelled ${game} night.${told}`;
    }
    case 'stop_repeating': {
      if (night.series_id === null || !night.repeats) return 'It doesn’t repeat.';
      const game = await stopSeries(client, guild, night.series_id);
      if (!game) return 'It doesn’t repeat.';
      logActivity(guild.id, member.id, `Stopped **${game}** night repeating`);
      return `${game} night won’t repeat. This one stays on.`;
    }
    case 'change': {
      const changes: NightEdit = {};
      if (edit.game) changes.game = libraryName(guild, edit.game);
      if (edit.when) changes.when = edit.when;
      if (edit.details) changes.details = /^(none|nothing|clear|remove)$/i.test(edit.details) ? null : edit.details;
      if (!Object.keys(changes).length) return 'Ask what to change: the game, the time or the details.';
      const result = await editNight(client, guild, night.id, changes, member.id);
      if (result === undefined) return 'That game night is gone.';
      if (typeof result === 'string') return result;
      if (!result.changed.length) return 'Nothing changed: it’s already that.';
      logActivity(guild.id, member.id, `Changed the ${result.changed.join(', ')} of **${result.game}** night`);
      const moved = upcomingNight(guild.id, night.id, Date.now());
      const at = moved ? ` It’s ${result.game} night, ${describe(moved.starts_at, setting(guild.id, 'timezone'))}.` : '';
      return `Changed the ${listNames(result.changed)}.${at}${result.eventNote ? ` ${plain(guild, result.eventNote)}` : ''}`;
    }
    default:
      return 'Cancel, stop repeating, or change.';
  }
}

/** Seconds from “65”, “65s”, “1:05”, “1:05.5” or “1:01:05”; null for empty, undefined if it isn't one */
export function readSeconds(said: string): number | null | undefined {
  const text = said.trim().toLowerCase();
  if (!text) return null;
  const plain = /^(\d+(?:\.\d+)?)\s*s?$/.exec(text);
  if (plain) return Number(plain[1]);
  const clock = /^(?:(\d+):)?(\d+):(\d{2}(?:\.\d+)?)$/.exec(text);
  return clock ? Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : undefined;
}

const clockOf = (seconds: number) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** Sounds being made, by server and name, for a second ask not to start another, and for tests to wait on */
const making = new Map<string, Promise<unknown>>();
export const soundsMade = () => Promise.all(making.values());

async function makeSound(member: GuildMember, link: string, name: string, startText: string, endText: string, where: GuildTextBasedChannel | null): Promise<string> {
  const { guild } = member;
  if (!linksReady()) return 'Sounds from links need the music container, which this bot doesn’t have.';
  if (!mayChangeSounds(member)) return plain(guild, managersOnly(guild.id));
  if (!where) return 'There’s nowhere here to post how it went.';
  if (link.length > 2000 || !/^https:\/\/\S+$/.test(link)) return 'Ask them for the link, starting https://.';
  const named = uploadProblem(name, '.mp3', 0);
  if (named) return named;
  if (findSound(guild.id, name)) return `There’s already a sound called ${name}. Ask for another name; replacing a sound is in the web UI.`;
  const start = readSeconds(startText);
  const end = readSeconds(endText);
  if (start === undefined || end === undefined) return 'Give the start and end like “0:05” or “65”.';
  if (start !== null && end !== null && end <= start) return 'The end has to come after the start.';
  if (end !== null && end - (start ?? 0) > LONGEST_PART) return `A sound can be ${LONGEST_PART / 60} minutes at most.`;
  const key = `${guild.id}:${name}`;
  if (making.has(key)) return `${name} is being made already.`;
  making.set(
    key,
    finishSound(member, where, link, name, start, end)
      .catch((err: unknown) => console.error(`Chat couldn’t make the sound ${name} in server ${guild.id}:`, err))
      .finally(() => making.delete(key)),
  );
  return `Started making ${name}. Downloading takes a moment, and how it went is posted here by itself, pinging ${member.displayName}.`;
}

async function finishSound(member: GuildMember, where: GuildTextBasedChannel, link: string, name: string, start: number | null, end: number | null) {
  const { guild } = member;
  const tell = (text: string) => where.send({ content: `<@${member.id}> ${text}`, allowedMentions: { users: [member.id] } });
  const got = await downloadLink(guild.id, link);
  if (got.error !== undefined) return tell(`I couldn’t make **${name}**: ${got.error}`);
  const from = start ?? 0;
  if (end === null && got.seconds - from > WHOLE_UP_TO) {
    return tell(`“${got.title}” is ${clockOf(got.seconds)} long, so say which part to make **${name}** from, like “0:05 to 0:12”.`);
  }
  if (from >= got.seconds) return tell(`I couldn’t make **${name}**: “${got.title}” is ${clockOf(got.seconds)} long.`);
  // An end past the end is the end
  const to = Math.min(end ?? got.seconds, got.seconds);
  const problem = partProblem(from, to, got.seconds);
  if (problem) return tell(`I couldn’t make **${name}**: ${problem}`);
  // Someone may have added one by that name while it downloaded
  if (findSound(guild.id, name)) return tell(`A sound called **${name}** was added meanwhile, so I didn’t make another.`);
  // On Discord's own soundboard too, when it's short enough for it
  const added = await savePart(guild, got.id, name, from, to, discordBoard.fits(to - from));
  if (typeof added === 'string') return tell(`I couldn’t make **${name}**: ${added}`);
  logActivity(guild.id, member.id, `Added sound **${name}** from ${(to - from).toFixed(1)} s of “${got.title}”`);
  await refreshPanels(member.client, guild.id);
  const discord = !discordBoard.fits(to - from) ? ' It’s too long for Discord’s own soundboard, so it’s only on this one.' : added.problem ? ` It isn’t on Discord’s own soundboard: ${plain(guild, added.problem)}.` : '';
  return tell(`Added the sound **${name}**: ${clockOf(from)} to ${clockOf(to)} of “${got.title}”.${discord}`);
}

async function vote(member: GuildMember, minutes: number, games: string[], where: GuildTextBasedChannel | null): Promise<string> {
  const voice = member.voice.channel;
  if (!voice) return 'They aren’t in a voice channel. A vote is for the people in theirs, so they need to join one first.';
  if (!where) return 'There’s nowhere here to post it.';
  const length = Number.isInteger(minutes) ? Math.min(10, Math.max(1, minutes)) : 1;
  let problem: string | null;
  try {
    problem = await postVote(where, voice, length, games.length ? games : undefined);
  } catch (err) {
    console.error('Chat couldn’t post a game vote:', err);
    return 'It couldn’t be posted in this channel. Ask them to try /gamevote.';
  }
  if (problem) return plain(member.guild, problem);
  logActivity(member.guild.id, member.id, `Started a game vote for <#${voice.id}> in <#${where.id}>`);
  // What's on it, as only games they all own are
  const on = gamesInVote(voice);
  return `Started a vote here on what to play, for the people in ${voice.name}, closing in ${length} minute${length === 1 ? '' : 's'}. They vote with its buttons. On it: ${listNames(on)}.`;
}
