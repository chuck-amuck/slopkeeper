import { ChannelType, type Guild, type VoiceChannel } from 'discord.js';
import { type IncomingMessage } from 'node:http';
import { linkWebUser, logActivity, recentActivity, webUser, webUserFor } from '../activity.ts';
import { VOICES } from '../features/say.ts';
import { checkSetting, GROUPS, LABELS, LIMITS, show, source, STEPS } from '../features/setup.ts';
import { afterSettingsChanged, listSounds, loopBotStatus, loopSpeechProblem } from '../features/soundboard.ts';
import { DEFAULTS, setSetting, setting, type SettingKey } from '../settings.ts';
import { type Ask, Refused, asking, by, channelName, listed, memberIn, nameOf, plain, readJson, textChannels, whoDid } from './common.ts';

// The management API for settings, who’s signed in, and the activity history

const TIME_ZONES = Intl.supportedValuesOf('timeZone');

const ACTIVITY_PAGE = 50;

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
    groups: GROUPS,
    channels: textChannels(guild),
    voiceChannels: [...guild.channels.cache.values()]
      .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice && c.id !== guild.afkChannelId && listed(guild)(c))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: channelName(guild, c) })),
    sounds: listSounds(guild.id).map((s) => s.name),
    roles: [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name })),
    timeZones: TIME_ZONES,
    voices: VOICES.map(({ id, name }) => ({ id, name })),
  };
}

/** Who's signed in, and which Discord member they said they are. Links aren't per server, since Discord ids aren't */
export async function handleMe(guild: Guild, req: IncomingMessage) {
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

export function activityList(guild: Guild, url: URL) {
  const before = Number(url.searchParams.get('before')) || undefined;
  const rows = recentActivity(guild.id, ACTIVITY_PAGE + 1, before);
  return {
    timeZone: setting(guild.id, 'timezone'),
    entries: rows.slice(0, ACTIVITY_PAGE).map((r) => ({ id: r.id, at: r.at, who: whoDid(guild, r.actor), action: plain(guild, r.action) })),
    more: rows.length > ACTIVITY_PAGE,
  };
}

export async function handleSettings(guild: Guild, req: IncomingMessage, key?: string) {
  if (key === undefined) {
    if (req.method === 'GET') return { ...settingList(guild), loopBot: await loopBotStatus(guild.id) };
    throw new Refused(405, 'Not here.');
  }
  if (!Object.hasOwn(DEFAULTS, key)) throw new Refused(404, 'No such setting.');
  const settingKey = key as SettingKey;
  const settled = () => afterSettingsChanged(guild, [settingKey]);
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
  // The speech is made now, so a voice container that's down shows here rather than as silence in the room
  const speechProblem = settingKey === 'loopText' || settingKey === 'loopVoice' ? await loopSpeechProblem(guild) : null;
  return { warning: (checked.warning && plain(guild, checked.warning)) || speechProblem || undefined };
}

export async function serverRoutes({ client, guild, req, res, url, section, rest }: Ask) {
  if (section === 'settings' && rest.length <= 1) return handleSettings(guild, req, rest[0]);
  if (section === 'activity' && !rest.length && req.method === 'GET') return activityList(guild, url);
  if (section === 'me' && !rest.length) return handleMe(guild, req);
  throw new Refused(404, 'Not found.');
}
