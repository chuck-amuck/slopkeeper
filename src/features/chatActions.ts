import type Anthropic from '@anthropic-ai/sdk';
import { ChannelType, type Guild, type GuildMember, type GuildTextBasedChannel, PermissionFlagsBits, type VoiceBasedChannel } from 'discord.js';
import { logActivity } from '../activity.ts';
import { plain } from '../api/common.ts';
import { gameKey } from '../gameText.ts';
import { setting } from '../settings.ts';
import { listNames } from '../util.ts';
import { nameOf, object, unquoted } from './chatLookups.ts';
import { answerFor, cancelNight, describe, editNight, gameNames, type NightEdit, planNight, readWhen, stopSeries, upcomingNight, upcomingNights } from './gamenight.ts';
import { gamesInVote, postVote } from './gamevote.ts';
import { remind, reminderTools } from './chatReminders.ts';

// What chat can do with the bot's other features for the person asking: plan, change and answer game nights, start a
// vote on what to play, and set reminders (chatReminders.ts). Each runs what the slash command, button or web UI runs, with the permission it checks, and
// is in Activity under their name. The server's "Take actions" setting turns them off, leaving the list of game nights

/** Game nights listed at once */
const MOST_NIGHTS = 10;
const LONGEST_DETAILS = 150;
const REPEATS = { no: null, weekly: 7, every_2_weeks: 14 } as const;
const NIGHT_ID = { type: 'integer', description: 'The night’s id from game_nights' };

/** The tools that change something, for chat to log and remember */
export const ACTIONS = new Set(['plan_game_night', 'change_game_night', 'answer_game_night', 'start_vote', 'set_reminder', 'cancel_reminder']);

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
        details: { type: 'string', description: 'For change: the new details, or empty to keep them' },
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
  return list;
}

/** Does what an action tool asks, as the person asking, in the channel they asked in. Null if it isn't one of these */
export async function act(member: GuildMember, name: string, input: Record<string, unknown>, where: GuildTextBasedChannel | null): Promise<string | null> {
  const text = (key: string) => unquoted(String(input[key] ?? ''));
  switch (name) {
    case 'game_nights':
      return nightsList(member.guild);
    case 'plan_game_night':
      return plan(member, text('game'), text('when'), text('details'), text('voice_channel'), REPEATS[text('repeat') as keyof typeof REPEATS] ?? null, where);
    case 'change_game_night':
      return change(member, Number(input.night_id), text('action'), { game: text('game'), when: text('when'), details: text('details') });
    case 'answer_game_night': {
      const result = await answerFor(member.client, member.guild, Number(input.night_id), member.id, text('answer'));
      if (result === undefined) return 'There’s no game night with that id. game_nights lists them.';
      if (typeof result === 'string') return result;
      logActivity(member.guild.id, member.id, `Answered **${result.label}** for ${member.displayName} to **${result.game}** night`);
      return `Marked ${member.displayName} “${result.label}” for ${result.game} night.`;
    }
    case 'start_vote':
      return vote(member, Number(input.minutes), Array.isArray(input.games) ? input.games.map((g) => unquoted(String(g))).filter(Boolean) : [], where);
    default:
      // Offered only with the rest, in case the model asks anyway
      return setting(member.guild.id, 'chatActions') ? remind(member, name, input, where, text) : null;
  }
}

const upcoming = (guild: Guild) => upcomingNights(guild.id, Date.now()).nights;
/** The game as the library names it, so its role is pinged, or as they said it */
const libraryName = (guild: Guild, said: string) => gameNames(guild.id).find((n) => gameKey(n) === gameKey(said)) ?? said;

function nightsList(guild: Guild): string {
  const nights = upcoming(guild);
  if (!nights.length) return 'No game nights are planned.';
  const timeZone = setting(guild.id, 'timezone');
  const who = (ids: string[]) => listNames(ids.map((id) => nameOf(guild, id)));
  const lines = nights.slice(0, MOST_NIGHTS).map((n) => {
    const voice = n.voice_channel_id ? guild.channels.cache.get(n.voice_channel_id)?.name : null;
    const details = n.details && (n.details.length > LONGEST_DETAILS ? `${n.details.slice(0, LONGEST_DETAILS)}…` : n.details);
    return [
      `night ${n.id}: ${n.game}, ${describe(n.starts_at, timeZone)}${n.starts_at < Date.now() ? ' (started)' : ''}`,
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
  const same = upcoming(guild).find((n) => gameKey(n.game) === gameKey(game) && n.starts_at === time.at);
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
  const night = upcomingNight(guild.id, id, Date.now());
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
      if (edit.details) changes.details = edit.details;
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
