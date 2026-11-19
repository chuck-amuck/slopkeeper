import Anthropic from '@anthropic-ai/sdk';
import { type Guild, type GuildMember, type GuildTextBasedChannel, MessageType, SnowflakeUtil } from 'discord.js';
import { config } from '../config.ts';
import { setting } from '../settings.ts';
import { answer, claimAnswer, finished, giveBack, readable, sourcesLine, type Heard, type Tried } from './chat.ts';
import { NO_EFFECT, serverEffect, serverVoice } from './say.ts';
import { CHAT_MODELS, CHAT_VOICE } from './setup.ts';

// Chat tried in the web UI: the bot's real answer, with its real instructions, model and lookups, as if someone had
// asked in a channel. Nothing it would do is done, and nothing is posted: the page shows what would have happened, and
// plays what would have been heard

/** What's been said so far in the page, oldest first, for the answer to follow on from */
export interface TryLine {
  from: 'you' | 'bot';
  text: string;
  at: number;
  /** Who asked it, when that was someone other than who's asking now */
  as?: string;
}

/** As many lines as an answer in a channel sees before the message asking */
export const MOST_TRY_LINES = 20;
export const LONGEST_TRY_TEXT = 2000;

/** Why an answer can't be tried now, for the page */
export class CantTry extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * @Names typed as Discord would have made them mentions, picked from its list: a member's display name or username
 * after an @, the longest first so one name that starts another doesn't take its place
 */
export function mentionsIn(guild: Guild): (typed: string) => string {
  // A name two people share goes to the first
  const ids = new Map<string, string>();
  for (const m of guild.members.cache.values()) {
    if (m.user.bot) continue;
    for (const name of [m.displayName, m.user.username]) if (name && !ids.has(name.toLowerCase())) ids.set(name.toLowerCase(), m.id);
  }
  if (!ids.size) return (typed) => typed;
  const names = [...ids.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const at = new RegExp(`(?<![\\p{L}\\p{N}_<])@(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return (typed) => typed.replace(at, (_, name: string) => `<@${ids.get(name.toLowerCase())}>`);
}

/** How an answer goes out in Discord with the server's Answer in voice setting, for the page to say */
export function inDiscord(guildId: string): string {
  if (!config.voiceUrl || !setting(guildId, 'tts')) return 'In Discord it’s posted in the channel. Text to speech is off here, so it isn’t said aloud.';
  switch (setting(guildId, 'chatVoice') as keyof typeof CHAT_VOICE) {
    case 'also':
      return 'In Discord it’s posted, and said aloud too when the one asking is in a voice channel.';
    case 'only':
      return 'In Discord it’s said aloud when the one asking is in a voice channel, and posted when they aren’t or it pings someone.';
    default:
      return 'In Discord it’s posted in the channel. Answer in voice is off, so it isn’t said aloud there.';
  }
}

/**
 * The bot's answer to `typed`, asked by `asker` in `channel` after `history`, with nothing done. Counts toward the
 * server's answers for the day and the month's cost, as the same answer in Discord would. `who` is whoever's trying it,
 * for their cooldown
 */
export async function tryChat(guild: Guild, asker: GuildMember, channel: GuildTextBasedChannel, history: TryLine[], typed: string, who: string) {
  if (!config.anthropicKey) throw new CantTry(409, 'Chat needs an Anthropic API key on the host (ANTHROPIC_API_KEY).');
  const claim = claimAnswer(guild.id, `try:${guild.id}:${who}`);
  if ('refused' in claim) {
    throw new CantTry(429, claim.refused === 'wait' ? 'Wait a few seconds between questions.' : 'That’s all the answers the server has for today. Ask again tomorrow.');
  }
  const bot = guild.members.me;
  const botId = guild.client.user.id;
  const withMentions = mentionsIn(guild);
  const content = withMentions(typed);
  const lines = history.slice(-MOST_TRY_LINES);
  // The page's conversation stands in for the channel's last messages, and has no attachments, embeds or replies
  const stand = (from: TryLine['from'], text: string, at: number, i: number, as?: string) => {
    const person = (as && guild.members.cache.get(as)) || asker;
    return {
      id: `try-${i}`,
      createdTimestamp: at,
      author: from === 'bot' ? guild.client.user : person.user,
      member: from === 'bot' ? bot : person,
      content: from === 'you' ? withMentions(text) : text,
      attachments: new Map(),
      embeds: [],
      type: from === 'bot' ? MessageType.Reply : MessageType.Default,
    };
  };
  const earlier = new Map(lines.map((l, i) => stand(l.from, l.text, l.at, i, l.as)).reverse().map((m) => [m.id, m]));
  const page = {
    // Its own, so nothing said or done in the page goes in among what's remembered for a real channel
    id: `try:${guild.id}:${who}`,
    name: channel.name,
    guild,
    isThread: () => false,
    isTextBased: () => true,
    permissionsFor: channel.permissionsFor.bind(channel),
    messages: { fetch: async () => earlier },
  };
  const message = { ...stand('you', typed, Date.now(), lines.length), id: SnowflakeUtil.generate().toString(), content, guild, channel: page, channelId: page.id, inGuild: () => true };

  const tried: Tried = { would: [], heard: [], looked: [], cost: 0, names: new Map() };
  const started = performance.now();
  let made: Awaited<ReturnType<typeof answer>>;
  try {
    made = await answer(message as never, asker, botId, null, { tried, channel });
  } catch (err) {
    giveBack(guild.id, claim.model);
    console.error('Couldn’t try an answer in the web UI:', err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
    throw new CantTry(502, err instanceof Anthropic.APIError && err.status === 429 ? 'The model is busy. Try again in a moment.' : 'The bot couldn’t answer. Try again in a moment.');
  }
  const seconds = (performance.now() - started) / 1000;
  const done = made.text ? finished(guild.id, made.text, made.people, sourcesLine(made.sources)) : null;
  // Said aloud as it would be in voice, unless it already said something there, or it's past the longest line
  let aloud: Heard | null = null;
  let quiet: string | null = null;
  if (done && config.voiceUrl && setting(guild.id, 'tts')) {
    const text = readable(guild, done.reply);
    if (made.spoke) quiet = 'It already said something aloud, so the answer isn’t said too.';
    else if (text.length > setting(guild.id, 'ttsMaxChars')) quiet = 'It’s longer than the longest line, so it wouldn’t be said aloud.';
    else aloud = { kind: 'speech', text, voice: serverVoice(guild.id).id, effect: serverEffect(guild.id)?.id ?? NO_EFFECT };
  }
  return {
    // As it would be posted, with its mentions, for the page to show by name
    answer: done?.post ?? null,
    pings: (done?.users ?? []).map((id) => ({ id, name: guild.members.cache.get(id)?.displayName ?? 'someone' })),
    asked: content,
    aloud,
    quiet,
    heard: tried.heard,
    would: tried.would,
    looked: tried.looked,
    model: CHAT_MODELS[claim.model],
    seconds: Math.round(seconds * 10) / 10,
    cost: tried.cost,
  };
}
