import { ActivityType, DiscordAPIError, type Message, MessageType, PermissionFlagsBits, RESTJSONErrorCodes, type Client, type Guild, type GuildBasedChannel, type GuildMember, type Role, type SendableChannels, type VoiceBasedChannel } from 'discord.js';
import { idSetting, isAllowed, setting, type IdSettingKey } from './settings.ts';
import { cleanGameName, isProgramNotGame } from './gameText.ts';
import { steamGame } from './steamStatus.ts';

/** For outside services, so a stalled one can't hold a command or a scheduled job for minutes */
export const requestTimeout = () => AbortSignal.timeout(30_000);

/** Whether the bot can see a channel. Discord hides the names of the ones it can't, and it couldn't use them anyway */
export function canSee(guild: Guild, channel: GuildBasedChannel): boolean {
  const me = guild.members.me;
  return !me || channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) !== false;
}

/** Whether a member can see a channel. One that isn't cached, as it's gone, hides nothing */
export function memberSees(member: GuildMember, channelId: string): boolean {
  const channel = member.guild.channels.cache.get(channelId);
  return !channel || channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) !== false;
}

/**
 * Whether what was posted or set in one channel can be repeated in another, `where`, that others may be reading: it's
 * the same channel, or everyone in the server can see it
 */
export function sayableIn(guild: Guild, channelId: string, where: { id: string } | null): boolean {
  if (channelId === where?.id) return true;
  const channel = guild.channels.cache.get(channelId);
  return !channel || channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) !== false;
}

export function humansIn(channel: VoiceBasedChannel): GuildMember[] {
  return [...channel.members.values()].filter((m) => !m.user.bot);
}

export function playingGames(member: GuildMember): string[] {
  // Cleaned of escape codes, and without programs that aren't games, like launchers
  const games = (member.presence?.activities ?? [])
    .filter((a) => a.type === ActivityType.Playing)
    .map((a) => cleanGameName(a.name))
    .filter((name) => name && !isProgramNotGame(name));
  // Only when Discord shows nothing, so a game can't count twice under two names
  const steam = games.length ? undefined : steamGame(member.id);
  return steam && setting(member.guild.id, 'steamStatus') ? [cleanGameName(steam.name)] : games;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Splits lines into pages that each fit in `maxChars` once joined with newlines */
export function paginate(lines: string[], maxChars: number): string[][] {
  const pages: string[][] = [];
  let size = 0;
  for (const line of lines) {
    if (!pages.length || size + line.length + 1 > maxChars) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1)!.push(line);
    size += line.length + 1;
  }
  return pages;
}

/**
 * Whether the bot can give people a role: Discord needs Manage Roles, and the bot's own role above it. While its own
 * member isn't known yet, just after it joins, it may try, and Discord says
 */
export function canGiveRole(guild: Guild, roleId: string): boolean {
  const me = guild.members.me;
  const role = guild.roles.cache.get(roleId);
  if (!role || role.managed) return false;
  return !me || (me.permissions.has(PermissionFlagsBits.ManageRoles) && role.position < me.roles.highest.position);
}

/** Whether Discord refused a role change because the bot isn't allowed to make it, rather than being down */
export const notAllowed = (err: unknown) => err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.MissingPermissions || err.code === RESTJSONErrorCodes.MissingAccess);

/**
 * What to tell someone when the bot can't change their roles. It's fine for a server not to let it, so this points
 * them to an admin rather than at the bot's permissions. `what` is the change: "give you @Gamers"
 */
export const askAnAdmin = (what: string) => `I can’t hand out roles in this server, so a server admin will have to ${what} (Server Settings → Members).`;

/** A warning to add to a reply when mentioning a role won't notify anyone; bots need the role to allow it or Mention Everyone */
export function pingWarning(role: Role): string {
  if (role.mentionable || role.guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone)) return '';
  return `\n⚠️ Pings for ${role} won’t notify anyone yet. Turn on **Allow anyone to @mention this role** in Server Settings → Roles.`;
}

/** How long after the bot logs in the containers beside it may still be starting */
const STARTING_MS = 60_000;
/** How soon to try a container again while it may still be starting */
export const STARTING_RETRY_MS = 5_000;
let startedAt = 0;
/** The bot logged in: for the next minute, a container not answering is most likely one still starting */
export function markStarted(at = Date.now()) {
  startedAt = at;
}
/** Within a minute of logging in, when not reaching a container beside the bot is tried again quietly, not warned about */
export const stillStarting = () => Date.now() - startedAt < STARTING_MS;

/** Servers the bot works in: every one it's in, minus any it's leaving for not being allowed */
export function servedGuilds(client: Client<true>): Guild[] {
  return [...client.guilds.cache.values()].filter((g) => isAllowed(g.id));
}

/** Runs a scheduled job for every server; one server failing doesn't stop the rest */
export async function eachGuild(client: Client<true>, job: string, run: (guild: Guild) => Promise<unknown>) {
  for (const guild of servedGuilds(client)) {
    await run(guild).catch((err) => console.error(`${job} failed in ${guild.name} (${guild.id}):`, err));
  }
}

/** The server's announce channel (or another channel setting), or null if /setup hasn't picked one (or it's gone) */
export async function announceChannel(
  client: Client<true>,
  guildId: string,
  key: Exclude<IdSettingKey, 'hopOnRole'> = 'announceChannel',
): Promise<SendableChannels | null> {
  const id = idSetting(guildId, key);
  if (!id) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  if (channel?.isSendable()) return channel;
  console.error(`Channel ${id} (${key}) in server ${guildId} is gone or the bot can't post there; pick another with /setup`);
  return null;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One formatter per time zone: making one is far slower than using it, and stats call this for every hour */
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock date and time of an instant in a time zone */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    zoneFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** The instant a wall-clock time happens in a time zone (month is 1-based; day may overflow into the next month) */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (ms: number) => {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  // Second pass corrects for a DST change between the guess and the answer
  const guess = asUtc - offset(asUtc);
  return asUtc - offset(guess);
}

/** YYYY-MM-DD of an instant in a time zone */
export function zonedDate(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether a message might ask the bot something: 'mention' when it @mentions the bot in what it says, or 'reply' when it
 * replies to one of the bot's messages, which only counts if that was an answer (see isAnswer). Discord also counts a
 * reply as mentioning whoever it replies to, so mentions are read from the text
 */
export function asksBot(message: Message, botId: string): 'mention' | 'reply' | null {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return null;
  if (new RegExp(`<@!?${botId}>`).test(message.content)) return 'mention';
  // Discord's @ list also offers the bot's own role, named after it
  const role = message.guild.members.me?.roles.botRole?.id;
  if (role && message.content.includes(`<@&${role}>`)) return 'mention';
  return message.mentions.repliedUser?.id === botId ? 'reply' : null;
}

/**
 * Whether a message of the bot's is one of its answers here, which are replies. People reply to its hop-on pings, recaps
 * and alerts to talk to each other, and those aren't asking it anything
 */
export const isAnswer = (m: Message, botId: string) => m.author.id === botId && m.type === MessageType.Reply;

/** Whether a message asks the bot something, as chat answers: an @mention, or a reply to one of its answers */
export async function talksToBot(message: Message): Promise<boolean> {
  const how = asksBot(message, message.client.user.id);
  if (how !== 'reply') return how === 'mention';
  const to = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  return !!to && isAnswer(to, message.client.user.id);
}
