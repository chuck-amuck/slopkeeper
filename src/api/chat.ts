import { type Guild, type GuildTextBasedChannel } from 'discord.js';
import { webUser } from '../activity.ts';
import { config } from '../config.ts';
import { setting } from '../settings.ts';
import { chatNote } from '../features/chat.ts';
import { CantTry, inDiscord, LONGEST_TRY_TEXT, MOST_TRY_LINES, tryChat, type TryLine } from '../features/chatTry.ts';
import { previewSpeech, TooSoon } from '../features/say.ts';
import { canSee, sayableIn } from '../util.ts';
import { type Ask, Refused, asking, memberIn, memberList, readJson, textChannels } from './common.ts';

// The management API for chat tried in the web UI: real answers, with nothing done and nothing posted

/** The page's conversation, as sent, checked */
function historyFrom(sent: unknown): TryLine[] {
  if (sent === undefined) return [];
  if (!Array.isArray(sent) || sent.length > MOST_TRY_LINES * 4) throw new Refused(400, 'The conversation isn’t in a form the bot can read.');
  return sent.map((l: unknown) => {
    const { from, text, at, as } = (l ?? {}) as Record<string, unknown>;
    if ((from !== 'you' && from !== 'bot') || typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) throw new Refused(400, 'The conversation isn’t in a form the bot can read.');
    return { from, text: text.slice(0, LONGEST_TRY_TEXT), at, ...(typeof as === 'string' && { as }) };
  });
}

/**
 * The text channels an answer can be tried in: those everyone in the server can see, as the bot can, so asking as
 * someone else doesn't show what's in a private one, as “what did I miss” would
 */
const tryChannels = (guild: Guild) => textChannels(guild).filter((c) => sayableIn(guild, c.id, null) && canSee(guild, guild.channels.cache.get(c.id)!));

export async function chatRoutes({ guild, req, res, section, rest }: Ask) {
  if (section !== 'chat-try') throw new Refused(404, 'Not found.');
  // What the page needs to start: whether it can answer, who can ask, and where
  if (!rest.length && req.method === 'GET') {
    const who = asking.getStore();
    const me = who && webUser(who.email)?.userId;
    const { ok, note } = chatNote(guild.id);
    return {
      ready: ok,
      note,
      chatOn: setting(guild.id, 'chat'),
      // With the names Discord's @ list matches on, and their picture where they've set one
      members: memberList(guild).map((m) => {
        const member = guild.members.cache.get(m.id)!;
        const pictured = member.avatar || member.user.avatar;
        return { ...m, username: member.user.username ?? null, globalName: member.user.globalName ?? null, avatar: pictured ? member.displayAvatarURL({ size: 64 }) : null };
      }),
      channels: tryChannels(guild),
      me: me && guild.members.cache.has(me) ? me : null,
      botName: guild.members.me?.displayName ?? 'The bot',
      speech: Boolean(config.voiceUrl) && setting(guild.id, 'tts'),
      inDiscord: inDiscord(guild.id),
    };
  }
  if (!rest.length && req.method === 'POST') {
    const body = await readJson(req);
    const typed = typeof body.text === 'string' ? body.text.trim() : '';
    if (!typed) throw new Refused(400, 'Type something to ask.');
    if (typed.length > LONGEST_TRY_TEXT) throw new Refused(400, `That’s past ${LONGEST_TRY_TEXT} characters, more than Discord takes.`);
    const asker = memberIn(guild, String(body.as ?? ''));
    // One the page offers
    const channelId = String(body.channelId ?? '');
    const channel = tryChannels(guild).some((c) => c.id === channelId) ? guild.channels.cache.get(channelId) : undefined;
    if (!channel) throw new Refused(404, 'Pick a text channel everyone here can see.');
    const who = asking.getStore()?.email ?? 'password';
    try {
      return await tryChat(guild, asker, channel as GuildTextBasedChannel, historyFrom(body.history), typed, who);
    } catch (err) {
      if (err instanceof CantTry) throw new Refused(err.status, err.message);
      throw err;
    }
  }
  // An answer, or a line it would have said, heard in the browser as it would be in voice
  if (rest.length === 1 && rest[0] === 'speech' && req.method === 'POST') {
    if (!config.voiceUrl || !setting(guild.id, 'tts')) throw new Refused(409, 'Text to speech is off for this server.');
    const { text, voice, effect } = await readJson(req);
    if (typeof text !== 'string' || !text.trim()) throw new Refused(400, 'There’s nothing in that to say.');
    const audio = await previewSpeech(guild, text.slice(0, LONGEST_TRY_TEXT), String(voice ?? ''), effect === undefined ? undefined : String(effect), true).catch((err: unknown) => {
      if (err instanceof TooSoon) throw new Refused(429, err.message);
      if (err instanceof Error && err.message.startsWith('There’s nothing')) throw new Refused(400, err.message);
      console.error(`Web UI: saying a tried chat answer in ${guild.name} failed:`, err);
      throw new Refused(502, 'The voice container isn’t answering. Try again in a moment.');
    });
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' });
    res.end(audio);
    return null;
  }
  throw new Refused(405, 'Not here.');
}
