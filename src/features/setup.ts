import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type Role,
} from 'discord.js';
import { logActivity } from '../activity.ts';
import { DEFAULT_ENV, DEFAULTS, idSetting, setSetting, setting, storedSetting, type SettingKey } from '../settings.ts';
import type { Feature } from '../types.ts';
import { canGiveRole, isTimeZone, pingWarning } from '../util.ts';
import { effectName, effects, missingVoice, NO_EFFECT, serverVoice, voiceName, voices } from './say.ts';
import { afterSettingsChanged } from './soundboard.ts';
import { BUILT_IN_ID, profileById } from './chatProfiles.ts';
import { nicknameProblem } from './profileNames.ts';
import { photoProblem } from './profilePhotos.ts';
import { cantJoin } from './voiceAudio.ts';
import { findSound } from './soundLibrary.ts';
import { commandMention } from '../commandIds.ts';
import { config } from '../config.ts';
import { SOURCES, type Source } from '../musicSearch.ts';
import { POSTS, postFailures, type Post } from '../postFailures.ts';
import type { HeardAs } from '../talkLevel.ts';
import { voiceProblem } from '../voiceJoin.ts';

const ANNOUNCE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
] as const;

// The choices these settings take, which checkSetting enforces
const PATCH_MODES = { off: 'off', each: 'each one posted', digest: 'weekly digest' };
const READ_WHO = { everyone: 'everyone', voice: 'only people in voice' };
/** What counts as people talking, which music drops under (src/talkLevel.ts) */
const DUCKS_FOR: Record<HeardAs, string> = { any: 'any sound', talking: 'talking, not background noise', loud: 'only clear, loud talking' };
const LONGEST_GREETING = 100;
/** Whether chat answers are said in voice too, or instead of posted */
export const CHAT_VOICE = { off: 'no, text only', also: 'text and voice', only: 'voice only' };
/** The models chat can answer with, by setting value */
export const CHAT_MODELS = { haiku: 'Claude Haiku 5.5', sonnet: 'Claude Sonnet 5.5', opus: 'Claude Opus 5.5' };

export const LIMITS = {
  weeklyPostDay: [0, 6],
  weeklyPostHour: [0, 23],
  salePostHour: [0, 23],
  hopOnMinPeople: [2, 25],
  hopOnCooldownMin: [0, 1440],
  recapMinMinutes: [1, 600],
  sessionGraceMin: [1, 60],
  gameNightReminderMin: [0, 1440],
  joinSoundCooldownMin: [0, 1440],
  joinSoundDelayMs: [0, 10_000],
  freeGamesMinRating: [0, 100],
  saleMinDiscount: [1, 100],
  ttsMaxChars: [20, 6000],
  ttsCooldownSec: [0, 3600],
  ttsSpeed: [50, 150],
  ttsPauseMs: [0, 2000],
  ttsVolume: [10, 200],
  soundVolume: [0, 200],
  loopVolume: [5, 200],
  loopEvery: [0, 60],
  loopTextEvery: [0, 60],
  loopIntroDelayMs: [0, 10_000],
  loopTextVolume: [5, 200],
  loopSoundDelayMs: [0, 60_000],
  loopTextDelayMs: [0, 60_000],
  musicVolume: [0, 200],
  chatDailyLimit: [1, 5000],
} as const;

/** Settings that take fractions, and in what steps. The rest are whole numbers */
export const STEPS: Partial<Record<keyof typeof LIMITS, number>> = { loopEvery: 0.1, loopTextEvery: 0.1 };
/** The longest looping speech, in characters */
export const LOOP_TEXT_MAX = 500;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

export const LABELS: Record<SettingKey, string> = {
  announceChannel: 'Announce channel',
  hopOnRole: 'Hop-on role',
  timezone: 'Time zone',
  weeklyPostDay: 'Weekly leaderboard day',
  weeklyPostHour: 'Weekly leaderboard hour',
  weeklyLeaderboard: 'Weekly leaderboard',
  hopOnMinPeople: 'Hop-on ping at',
  hopOnCooldownMin: 'Hop-on cooldown',
  sessionRecap: 'Session recaps',
  recapMinMinutes: 'Shortest session counted',
  sessionGraceMin: 'Session ends after empty for',
  steamCountry: 'Steam price region',
  freeGames: 'Free game alerts',
  freeGamesChannel: 'Free games channel',
  freeGamesMinRating: 'Lowest Steam rating',
  freeGamesTaste: 'Only games like what you play',
  freeGamesMultiplayer: 'Only multiplayer games',
  freeGamesUnlisted: 'Games not on Steam',
  saleMinDiscount: 'Smallest sale worth posting',
  salePostHour: 'Sale post time',
  saleSteamWishlists: 'Steam wishlists in sale alerts',
  saleOtherStores: 'Other stores in sale alerts',
  saleMultiplayer: 'Only multiplayer sales',
  bundleAlerts: 'Bundle alerts',
  bundlesLikeWePlay: 'Bundles like what you play',
  steamStatus: 'Games from Steam status',
  patchNotes: 'Patch notes',
  patchNotesChannel: 'Patch notes channel',
  saleChannel: 'Sale alerts channel',
  gameNightReminderMin: 'Game night reminder',
  monthlyRecap: 'Monthly recap',
  evenVolume: 'Even volume',
  joinSounds: 'Join sounds',
  joinSoundCooldownMin: 'Join sound cooldown',
  joinSoundDelayMs: 'Join sound delay',
  soundManagerRole: 'Sound managers',
  tts: 'Text to speech',
  ttsRole: 'Who can use text to speech',
  ttsMaxChars: 'Longest spoken line',
  ttsCooldownSec: 'Wait between spoken lines',
  ttsVoice: 'Default voice',
  ttsEffect: 'Default effect',
  ttsSpeed: 'Speech speed',
  ttsPauseMs: 'Pause between sentences',
  ttsVolume: 'Speech volume',
  soundVolume: 'Soundboard volume',
  loopRoom: 'Looping sound room',
  loopSound: 'Looping sound',
  loopVolume: 'Loop volume',
  loopEvery: 'Loop every',
  loopText: 'Looping speech',
  loopVoice: 'Looping speech voice',
  loopEffect: 'Looping speech effect',
  loopTextEvery: 'Speech every',
  loopIntro: 'Intro sound',
  loopIntroDelayMs: 'Intro delay',
  loopTextVolume: 'Looping speech volume',
  loopSoundDelayMs: 'Sound delay after intro',
  loopTextDelayMs: 'Speech delay after intro',
  ttsChannel: 'Read chat aloud',
  ttsChannelWho: 'Whose messages are read',
  ttsGreet: 'Say who joined',
  ttsGreeting: 'Greeting',
  ttsNightReminders: 'Say game night reminders',
  ttsHopOn: 'Say hop-on pings',
  musicVolume: 'Music volume',
  evenMusic: 'Even music volume',
  musicDucksForPeople: 'Music drops while people talk',
  musicDucksFor: 'What counts as talking',
  musicAutoplay: 'Autoplay',
  musicDjRole: 'Who can control music',
  musicSearch: 'Music search',
  musicSearchFallback: 'Fall back to the other',
  chat: 'Answer in chat',
  chatProfile: 'Profile',
  chatModel: 'Model',
  chatWebSearch: 'Search the web',
  chatActions: 'Take actions',
  chatRoasts: 'Roast rude people',
  chatPostLines: 'Lines on automatic posts',
  chatVoice: 'Answer in voice',
  chatDailyLimit: 'Answers a day',
};

export function show(key: SettingKey, value: unknown): string {
  switch (key) {
    case 'announceChannel':
      return value ? `<#${value}>` : 'not set, so nothing gets posted';
    case 'hopOnRole':
      return value ? `<@&${value}>` : 'none, hop-on pings don’t ping anyone';
    case 'soundManagerRole':
      return value ? `<@&${value}>` : 'everyone can change sounds';
    case 'ttsRole':
    case 'musicDjRole':
      return value ? `<@&${value}>` : 'everyone';
    case 'ttsChannel':
      return value ? `<#${value}>` : 'off';
    case 'ttsChannelWho':
      return READ_WHO[value as keyof typeof READ_WHO] ?? String(value);
    case 'musicDucksFor':
      return DUCKS_FOR[value as keyof typeof DUCKS_FOR] ?? String(value);
    case 'weeklyPostDay':
      return DAYS[value as number];
    case 'weeklyPostHour':
    case 'salePostHour':
      return `${String(value).padStart(2, '0')}:00`;
    case 'hopOnMinPeople':
      return `${value} people`;
    case 'hopOnCooldownMin':
    case 'recapMinMinutes':
    case 'sessionGraceMin':
    case 'joinSoundCooldownMin':
      return `${value} min`;
    case 'joinSoundDelayMs':
    case 'loopIntroDelayMs':
    case 'ttsPauseMs':
    case 'loopSoundDelayMs':
    case 'loopTextDelayMs':
      return `${value} ms`;
    case 'steamCountry':
      return String(value).toUpperCase();
    case 'freeGames':
    case 'freeGamesTaste':
    case 'freeGamesMultiplayer':
    case 'saleSteamWishlists':
    case 'saleOtherStores':
    case 'saleMultiplayer':
    case 'bundleAlerts':
    case 'bundlesLikeWePlay':
    case 'steamStatus':
    case 'monthlyRecap':
    case 'sessionRecap':
    case 'weeklyLeaderboard':
    case 'evenVolume':
    case 'evenMusic':
    case 'musicDucksForPeople':
    case 'joinSounds':
    case 'tts':
      return value ? 'on' : 'off';
    case 'ttsMaxChars':
      return `${value} characters`;
    case 'ttsSpeed':
    case 'ttsVolume':
    case 'soundVolume':
    case 'loopVolume':
    case 'loopTextVolume':
    case 'musicVolume':
      return `${value}%`;
    case 'loopRoom':
      return value ? `<#${value}>` : 'off';
    case 'loopEvery':
    case 'loopTextEvery':
      return value ? `${value} seconds, layered` : 'without a gap';
    case 'loopText':
      return value ? `“${String(value)}”` : 'off';
    case 'loopVoice':
      return value ? (voiceName(String(value)) ?? String(value)) : 'the default voice';
    case 'loopEffect':
      return value ? (effectName(String(value)) ?? String(value)) : 'the default effect';
    case 'ttsEffect':
      return effectName(String(value)) ?? String(value);
    case 'loopSound':
      return value ? String(value) : 'not set';
    case 'loopIntro':
      return value ? String(value) : 'off';
    case 'ttsCooldownSec':
      return `${value} seconds`;
    case 'ttsVoice':
      return serverVoice('', String(value)).name;
    case 'freeGamesUnlisted':
      return value ? 'shown' : 'hidden';
    case 'freeGamesMinRating':
      return value ? `${value}% positive` : 'off';
    case 'saleMinDiscount':
      return `${value}% off`;
    case 'freeGamesChannel':
    case 'saleChannel':
    case 'patchNotesChannel':
      return value ? `<#${value}>` : 'the announce channel';
    case 'patchNotes':
      return PATCH_MODES[value as keyof typeof PATCH_MODES] ?? String(value);
    case 'gameNightReminderMin':
      return value ? `${value} min before` : 'off';
    case 'chatModel':
      return CHAT_MODELS[value as keyof typeof CHAT_MODELS] ?? String(value);
    case 'chatVoice':
      return CHAT_VOICE[value as keyof typeof CHAT_VOICE] ?? String(value);
    case 'musicSearch':
      return SOURCES[value as Source] ?? String(value);
    case 'chatProfile':
      return (profileById(String(value)) ?? profileById(BUILT_IN_ID)!).name;
    case 'chatDailyLimit':
      return `${value} a day`;
    default:
      // Every other on/off setting, such as Autoplay and Say who joined
      return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
  }
}

/** Why the bot can't post in a channel, or null if it can */
function cantPost(guild: Guild, channel: GuildBasedChannel): string | null {
  const missing = missingToPost(guild, channel);
  return missing ? `I can’t post in ${channel} yet. Give my role **${missing}** there, then run this again.` : null;
}

function greetingProblem(greeting: string) {
  if (!/[\p{L}\p{N}]/u.test(greeting)) return 'Type what it should say, with {name} for the person.';
  return greeting.trim().length > LONGEST_GREETING ? `Keep the greeting to ${LONGEST_GREETING} characters.` : null;
}

/** Reading a channel only takes seeing it */
function cantSee(guild: Guild, channel: GuildBasedChannel): { error: string } | null {
  return channel.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.ViewChannel) ? null : { error: `I can’t see ${channel} yet. Give my role **View Channel** there, then try again.` };
}

/** Why a role can't be the hop-on role, or null if it can */
function cantHandOut(guild: Guild, role: Role): string | null {
  return role.id === guild.id || role.managed ? `${role} can’t be handed out. Make a normal role for hop-on pings.` : null;
}

/**
 * What to know about a hop-on role: who hands it out, and whether pinging it reaches anyone. A server needn't let the
 * bot manage roles; /notify then sends people to an admin, so that isn't a problem, only worth saying when it's picked
 */
function roleWarning(guild: Guild, role: Role): string {
  const admins = canGiveRole(guild, role.id) ? '' : `\nℹ️ I can’t hand out ${role} myself, so ${commandMention(guild.id, 'notify')} will ask people to get it from an admin. To let me, give my role **Manage Roles** and drag it above ${role}.`;
  return `${admins}${pingWarning(role)}`;
}

/**
 * The settings in the groups the web UI shows them in, so both read the same way: related ones together, each group's
 * fine-tuning last
 */
export const GROUPS: [string, SettingKey[]][] = [
  ['Posting', ['announceChannel', 'timezone']],
  ['Who can use what', ['soundManagerRole', 'musicDjRole', 'ttsRole']],
  ['Hop-on pings', ['hopOnRole', 'hopOnMinPeople', 'hopOnCooldownMin', 'ttsHopOn']],
  ['Voice sessions', ['sessionRecap', 'recapMinMinutes', 'sessionGraceMin']],
  ['Leaderboard and recap', ['weeklyLeaderboard', 'weeklyPostDay', 'weeklyPostHour', 'monthlyRecap']],
  ['Game nights', ['gameNightReminderMin', 'ttsNightReminders']],
  ['Steam', ['steamCountry', 'steamStatus']],
  ['Patch notes', ['patchNotes', 'patchNotesChannel']],
  ['Sale alerts', ['saleMinDiscount', 'salePostHour', 'saleSteamWishlists', 'saleOtherStores', 'saleMultiplayer', 'saleChannel']],
  ['Bundles', ['bundleAlerts', 'bundlesLikeWePlay']],
  ['Free games', ['freeGames', 'freeGamesChannel', 'freeGamesMinRating', 'freeGamesTaste', 'freeGamesMultiplayer', 'freeGamesUnlisted']],
  ['Sounds', ['soundVolume', 'evenVolume']],
  ['Join sounds', ['joinSounds', 'ttsGreet', 'ttsGreeting', 'joinSoundDelayMs', 'joinSoundCooldownMin']],
  ['Music', ['musicVolume', 'musicDucksForPeople', 'musicDucksFor', 'musicAutoplay', 'evenMusic']],
  ['Music search', ['musicSearch', 'musicSearchFallback']],
  ['Text to speech', ['tts', 'ttsVoice', 'ttsEffect', 'ttsVolume', 'ttsSpeed', 'ttsPauseMs', 'ttsMaxChars', 'ttsCooldownSec']],
  ['Read chat aloud', ['ttsChannel', 'ttsChannelWho']],
  ['Chat', ['chat', 'chatModel', 'chatVoice', 'chatWebSearch', 'chatActions', 'chatRoasts', 'chatPostLines', 'chatDailyLimit']],
  ['Profile', ['chatProfile']],
  ['Looping room', ['loopRoom', 'loopSound', 'loopVolume', 'loopEvery', 'loopIntro', 'loopIntroDelayMs', 'loopSoundDelayMs']],
  ['Looping speech', ['loopText', 'loopVoice', 'loopEffect', 'loopTextVolume', 'loopTextEvery', 'loopTextDelayMs']],
];

/** The web UI's Settings sections, one shown at a time, each with the groups above that it holds, in order */
export const SECTIONS: { id: string; title: string; about: string; groups: string[] }[] = [
  { id: 'basics', title: 'Basics', about: 'Where posts go, the time zone, and who can use what', groups: ['Posting', 'Who can use what'] },
  { id: 'pings', title: 'Voice and pings', about: 'Hop-on and game pings, session recaps and the leaderboard', groups: ['Hop-on pings', 'Voice sessions', 'Leaderboard and recap'] },
  { id: 'games', title: 'Games', about: 'Game night reminders, Steam and patch notes', groups: ['Game nights', 'Steam', 'Patch notes'] },
  { id: 'deals', title: 'Deals', about: 'Sale, bundle and free game alerts', groups: ['Sale alerts', 'Bundles', 'Free games'] },
  { id: 'soundboard', title: 'Soundboard', about: 'How loud sounds play, and join sounds', groups: ['Sounds', 'Join sounds'] },
  { id: 'music', title: 'Music', about: 'How loud it plays, autoplay, and where songs are found', groups: ['Music', 'Music search'] },
  { id: 'speech', title: 'Speech', about: 'Text to speech, its voices, and reading chat aloud', groups: ['Text to speech', 'Read chat aloud'] },
  { id: 'chat', title: 'Chat', about: 'Answers in chat, who the bot is, and what it remembers', groups: ['Chat', 'Profile'] },
  { id: 'loop', title: 'Looping room', about: 'A channel where a sound and speech play nonstop', groups: ['Looping room', 'Looping speech'] },
];

/** Something that stops the bot doing what its settings ask, and the setting to change, if one will fix it */
export interface SettingProblem {
  key: SettingKey | null;
  text: string;
  /** When it happened, for a post that couldn't go out */
  at?: number;
}

// Posts that go to their own channel if one's set, or else the announce channel, and whether they're on
const POST_CHANNELS: [SettingKey, string, (guildId: string) => boolean][] = [
  ['saleChannel', 'Sale alerts', () => true],
  ['freeGamesChannel', 'Free games', (id) => setting(id, 'freeGames')],
  ['patchNotesChannel', 'Patch notes', (id) => setting(id, 'patchNotes') !== 'off'],
];
/** The channel settings the bot posts in, so the web UI can say which channels it can't */
export const POSTING_CHANNELS: SettingKey[] = ['announceChannel', ...POST_CHANNELS.map(([key]) => key)];
/** Each of the bot's own posts: the setting for its own channel, if it has one, and whether it's on */
const POSTED: Record<Post, [SettingKey | null, (guildId: string) => boolean]> = {
  hopOn: [null, () => true],
  sessionRecap: [null, (id) => setting(id, 'sessionRecap')],
  weekly: [null, (id) => setting(id, 'weeklyLeaderboard')],
  recap: [null, (id) => setting(id, 'monthlyRecap')],
  sales: ['saleChannel', () => true],
  bundles: ['saleChannel', (id) => setting(id, 'bundleAlerts')],
  freeGames: ['freeGamesChannel', (id) => setting(id, 'freeGames')],
  patchNotes: ['patchNotesChannel', (id) => setting(id, 'patchNotes') !== 'off'],
};
// A refusal older than this has most likely been put right, as the bot can't see a channel's permissions change
const FAILURE_SHOWN_MS = 2 * 86_400_000;
const ROLE_GATES: [SettingKey, string][] = [
  ['soundManagerRole', 'Managing sounds'],
  ['ttsRole', 'Text to speech'],
  ['musicDjRole', 'Controlling music'],
];

/** What's missing for the bot to post in a channel, or null if nothing is, or it can't tell yet */
export function missingToPost(guild: Guild, channel: GuildBasedChannel): string | null {
  // Its own member isn't known for a moment after it joins
  if (!guild.members.me) return null;
  const perms = channel.permissionsFor(guild.members.me);
  const missing = ANNOUNCE_PERMISSIONS.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
  return missing.length ? missing.join('**, **') : null;
}

/**
 * Everything that stops the bot doing what its settings ask, for the top of /setup show and the web UI's Settings:
 * channels and roles that are gone or the bot can't use, and posts that couldn't go out, until one of them does
 */
export function settingProblems(guild: Guild): SettingProblem[] {
  const problems: SettingProblem[] = [];
  const name = (c: GuildBasedChannel) => `#${c.name}`;
  const channelOf = (key: SettingKey) => {
    const id = idSetting(guild.id, key as Parameters<typeof idSetting>[1]);
    return { id, channel: id ? guild.channels.cache.get(id) : undefined };
  };
  const postsIn = (key: SettingKey, what: string) => {
    const { id, channel } = channelOf(key);
    if (!id) return;
    if (!channel) return problems.push({ key, text: `${what}: the channel is gone. Pick another one.` });
    const missing = missingToPost(guild, channel);
    if (missing) problems.push({ key, text: `${what}: I can’t post in ${name(channel)}. Give my role **${missing}** there.` });
  };

  if (!idSetting(guild.id, 'announceChannel')) problems.push({ key: 'announceChannel', text: 'Nothing gets posted until an announce channel is set.' });
  else postsIn('announceChannel', 'Announcements');
  for (const [key, what, on] of POST_CHANNELS) if (on(guild.id)) postsIn(key, what);

  if (setting(guild.id, 'tts')) {
    const { id, channel } = channelOf('ttsChannel');
    if (id && !channel) problems.push({ key: 'ttsChannel', text: 'Text to speech: the channel it reads is gone. Pick another one.' });
    else if (channel && !channel.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.ViewChannel)) {
      problems.push({ key: 'ttsChannel', text: `Text to speech: I can’t see ${name(channel)}. Give my role **View Channel** there.` });
    }
  }

  // A voice that's gone or still downloading speaks as another, which Settings would otherwise hide
  for (const [key, what] of [
    ['ttsVoice', 'The default voice'],
    ['loopVoice', 'The looping speech’s voice'],
  ] as const) {
    const why = missingVoice(String(setting(guild.id, key) ?? ''));
    const instead = key === 'ttsVoice' ? serverVoice(guild.id) : serverVoice(guild.id, null);
    if (why) problems.push({ key, text: `${what}: ${why}, so it’s **${instead.name}** for now.${why.endsWith('downloading') ? '' : ' Pick another.'}` });
  }

  const renamed = nicknameProblem(guild);
  if (renamed) problems.push({ key: 'chatProfile', text: renamed });
  const photo = photoProblem(guild.id);
  if (photo) problems.push({ key: 'chatProfile', text: photo });

  const { id: loopId, channel: loopChannel } = channelOf('loopRoom');
  if (loopId && !loopChannel) problems.push({ key: 'loopRoom', text: 'The looping room’s channel is gone. Pick another one.' });
  // The loop bot has its own permissions, and its own note in the room's settings
  else if (loopChannel?.isVoiceBased() && !config.loopBotUrl) {
    const problem = voiceProblem(loopChannel);
    if (problem === 'full') problems.push({ key: 'loopRoom', text: `The looping room, ${name(loopChannel)}, is full, so I can’t join it.` });
    else if (problem) problems.push({ key: 'loopRoom', text: `The looping room: I can’t play in ${name(loopChannel)}. Give my role **${problem.missing.join('**, **')}** there.` });
  }

  const hopOnRole = idSetting(guild.id, 'hopOnRole');
  const role = hopOnRole ? guild.roles.cache.get(hopOnRole) : undefined;
  if (hopOnRole && !role) problems.push({ key: 'hopOnRole', text: 'The hop-on role is gone, so hop-on pings ping nobody.' });
  // Only a role that pings nobody is a problem
  const unpingable = role && pingWarning(role).trim();
  if (unpingable) problems.push({ key: 'hopOnRole', text: unpingable.replace(/^⚠️ /, '') });
  for (const [key, what] of ROLE_GATES) {
    const id = idSetting(guild.id, key as Parameters<typeof idSetting>[1]);
    if (id && !guild.roles.cache.has(id)) problems.push({ key, text: `${what}: the role it needs is gone, so only people who can manage the server can. Pick another, or none.` });
  }

  // Posts Discord refused where nothing above says why: the channel they'd go to now, while they're on and it's recent.
  // A channel already listed above says it all, and a moved post's next try is the test
  const said = new Set(problems.map((p) => p.key));
  const refused = new Map<SettingKey, { posts: string[]; at: number; error: string; channel: GuildBasedChannel | undefined }>();
  for (const failure of postFailures(guild.id)) {
    const [own, on] = POSTED[failure.post];
    const key = own && idSetting(guild.id, own as Parameters<typeof idSetting>[1]) ? own : 'announceChannel';
    if (!on(guild.id) || idSetting(guild.id, key as Parameters<typeof idSetting>[1]) !== failure.channelId || said.has(key) || Date.now() - failure.at > FAILURE_SHOWN_MS) continue;
    const entry = refused.get(key) ?? { posts: [], at: failure.at, error: failure.error, channel: guild.channels.cache.get(failure.channelId) };
    entry.posts.push(POSTS[failure.post].toLowerCase());
    refused.set(key, entry);
  }
  for (const [key, { posts, at, error, channel }] of refused) {
    const what = posts.length === 1 ? `the last ${posts[0]}` : `the last ${posts.slice(0, -1).join(', ')} and ${posts.at(-1)}`;
    problems.push({ key, at, text: `Discord refused ${what}${channel ? ` in ${name(channel)}` : ''}: “${error}”.` });
  }
  return problems;
}

/**
 * Where a setting /setup doesn't have is changed, for a message in `guildId`: linked, on that server, when the host
 * gave the web UI's address
 */
export function settingPlace(guildId: string, key: SettingKey): string {
  const link = `${config.webAddress}/?guild=${guildId}#settings?key=${key}`;
  const settings = config.webAddress ? `[the web UI’s Settings](<${link}>)` : 'the web UI’s Settings';
  return `**${LABELS[key]}** in ${settings}`;
}

/** /setup show: each group of settings, with where a changed one came from, after anything that needs fixing */
export function settingsEmbed(guild: Guild) {
  const line = (key: SettingKey) => {
    const where = source(guild.id, key);
    const value = show(key, IDS.has(key) ? setting(guild.id, key) || null : setting(guild.id, key));
    return `**${LABELS[key]}:** ${value.length > 120 ? `${value.slice(0, 119)}…` : value}${where === 'default' ? '' : ` · *${where}*`}`;
  };
  const problems = settingProblems(guild);
  // The web UI does the same, so a setting left out of GROUPS still shows somewhere
  const grouped = new Set(GROUPS.flatMap(([, keys]) => keys));
  const others = (Object.keys(DEFAULTS) as SettingKey[]).filter((key) => !grouped.has(key));
  const groups = others.length ? [...GROUPS, ['Other', others] as [string, SettingKey[]]] : GROUPS;
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Slopkeeper settings')
    .setColor(problems.length ? 0xfee75c : 0x5865f2)
    .addFields(groups.map(([name, keys]) => ({ name, value: keys.map(line).join('\n').slice(0, 1024) })))
    .setFooter({ text: 'The basics change here with /setup. Every setting is in the web UI’s Settings.' });
  // In Discord, the one that needs a command says which
  const text = (p: SettingProblem) => (p.key === 'announceChannel' && !idSetting(guild.id, 'announceChannel') ? p.text.replace(/\.$/, ` with ${commandMention(guild.id, 'setup announce-channel')}.`) : p.text);
  if (problems.length) embed.setDescription(problems.map((p) => `⚠️ ${text(p)}${p.at ? ` (<t:${Math.floor(p.at / 1000)}:R>)` : ''}`).join('\n').slice(0, 4096));
  return embed;
}

/** Channel and role settings, which store '' for "deliberately none" */
const IDS = new Set<SettingKey>(['announceChannel', 'hopOnRole', 'freeGamesChannel', 'saleChannel', 'patchNotesChannel', 'soundManagerRole', 'musicDjRole', 'ttsRole', 'ttsChannel', 'loopRoom']);

type Checked = { value: string | number | boolean; warning?: string } | { error: string };

/** Checks a setting's value by the same rules as /setup. Returns what to store, or why it can't be */
export function checkSetting(guild: Guild, key: SettingKey, value: unknown): Checked {
  if (key in LIMITS) {
    const [min, max] = LIMITS[key as keyof typeof LIMITS];
    const step = STEPS[key as keyof typeof LIMITS] ?? 1;
    const steps = typeof value === 'number' ? value / step : NaN;
    // Allowing for 0.1 + 0.2 not quite being 0.3
    const onStep = Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) < 1e-6;
    if (!onStep || (value as number) < min || (value as number) > max) {
      return { error: step === 1 ? `${LABELS[key]} has to be a whole number from ${min} to ${max}.` : `${LABELS[key]} has to be from ${min} to ${max}, in steps of ${step}.` };
    }
    return { value: Number((Math.round(steps) * step).toFixed(6)) };
  }
  switch (key) {
    case 'announceChannel':
    case 'freeGamesChannel':
    case 'saleChannel':
    case 'patchNotesChannel': {
      const channel = guild.channels.cache.get(String(value));
      if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) return { error: 'Pick a text channel.' };
      const problem = cantPost(guild, channel);
      return problem ? { error: problem } : { value: channel.id };
    }
    case 'loopRoom': {
      const channel = guild.channels.cache.get(String(value));
      if (channel?.type !== ChannelType.GuildVoice || channel.id === guild.afkChannelId) return { error: 'Pick a voice channel.' };
      const problem = cantJoin(channel);
      return problem ? { error: problem } : { value: channel.id };
    }
    case 'loopSound':
    case 'loopIntro':
      return findSound(guild.id, String(value)) ? { value: String(value) } : { error: 'Pick a sound from the library.' };
    case 'ttsChannel': {
      const channel = guild.channels.cache.get(String(value));
      if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) return { error: 'Pick a text channel.' };
      return cantSee(guild, channel) ?? { value: channel.id };
    }
    case 'hopOnRole': {
      const role = guild.roles.cache.get(String(value));
      if (!role) return { error: 'Pick a role.' };
      const problem = cantHandOut(guild, role);
      return problem ? { error: problem } : { value: role.id, warning: roleWarning(guild, role).trim() || undefined };
    }
    case 'soundManagerRole':
    case 'ttsRole':
    case 'musicDjRole': {
      const role = guild.roles.cache.get(String(value));
      return role ? { value: role.id } : { error: 'Pick a role.' };
    }
    case 'timezone': {
      const zone = String(value).trim();
      return isTimeZone(zone) ? { value: zone } : { error: `**${zone}** isn’t a time zone I know. Pick one from the list, e.g. America/Chicago.` };
    }
    case 'patchNotes':
      return Object.hasOwn(PATCH_MODES, String(value)) ? { value: String(value) } : { error: 'Patch notes are off, each one posted, or a weekly digest.' };
    case 'ttsVoice':
    case 'loopVoice':
      return voices().some((v) => v.id === value) ? { value: String(value) } : { error: 'Pick a voice from the list.' };
    case 'ttsEffect':
    case 'loopEffect':
      return value === NO_EFFECT || effects().some((e) => e.id === value) ? { value: String(value) } : { error: 'Pick an effect from the list.' };
    case 'loopText': {
      const text = String(value).trim();
      if (!text) return { error: 'Type something to say.' };
      return text.length > LOOP_TEXT_MAX ? { error: `Looping speech can be up to ${LOOP_TEXT_MAX} characters.` } : { value: text };
    }
    case 'ttsChannelWho':
      return Object.hasOwn(READ_WHO, String(value)) ? { value: String(value) } : { error: 'Read everyone, or only people in voice.' };
    case 'musicDucksFor':
      return Object.hasOwn(DUCKS_FOR, String(value)) ? { value: String(value) } : { error: 'Pick any sound, talking, or only loud talking.' };
    case 'ttsGreeting':
      return greetingProblem(String(value)) ? { error: greetingProblem(String(value))! } : { value: String(value).trim() };
    case 'chatProfile':
      return profileById(String(value)) ? { value: String(value) } : { error: 'Pick a profile from the list.' };
    case 'chatModel':
      return Object.hasOwn(CHAT_MODELS, String(value)) ? { value: String(value) } : { error: 'Pick Claude Haiku 5.5, Claude Sonnet 5.5 or Claude Opus 5.5.' };
    case 'chatVoice':
      return Object.hasOwn(CHAT_VOICE, String(value)) ? { value: String(value) } : { error: 'Pick text only, text and voice, or voice only.' };
    case 'musicSearch':
      return Object.hasOwn(SOURCES, String(value)) ? { value: String(value) } : { error: 'Pick Spotify or YouTube Music.' };
    case 'steamCountry': {
      const country = String(value).toLowerCase();
      return /^[a-z]{2}$/.test(country) ? { value: country } : { error: 'Use a two-letter country code, like us or gb.' };
    }
    default:
      return typeof value === 'boolean' ? { value } : { error: `${LABELS[key]} is either on or off.` };
  }
}

export function source(guildId: string, key: SettingKey): string {
  if (storedSetting(guildId, key) !== undefined) return 'set here';
  const env = DEFAULT_ENV[key];
  return env && process.env[env] ? `host default (${env})` : 'default';
}

/**
 * Applies the given settings and replies with what changed; options left out stay as they are. Given no options, it
 * shows what those settings are now
 */
async function apply(i: ChatInputCommandInteraction<'cached'>, changes: [SettingKey, string | number | boolean | null][]) {
  const given = changes.filter(([, value]) => value !== null);
  if (!given.length) {
    return i.reply({
      content: [...changes.map(([key]) => `**${LABELS[key]}:** ${show(key, setting(i.guildId, key))}`), '-# Give an option to change one.'].join('\n'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }
  for (const [key, value] of given) {
    setSetting(i.guildId, key, value);
    logActivity(i.guildId, i.user.id, `Set ${LABELS[key]} to ${show(key, value === '' ? null : setting(i.guildId, key))}`);
  }
  await i.reply({
    content: given.map(([key]) => `✅ ${LABELS[key]}: ${show(key, setting(i.guildId, key))}`).join('\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  const renamed = await afterSettingsChanged(i.guild, given.map(([key]) => key));
  if (renamed) await i.followUp({ content: `⚠️ ${renamed}`, flags: MessageFlags.Ephemeral });
}

/** Who can use what, as /setup sets it: the subcommand, the setting, what it's about, and what a role limits */
const GATES = [
  ['sound-managers', 'soundManagerRole', 'Limit changing sounds to a role, plus people with Manage Server', 'change sounds'],
  ['music-role', 'musicDjRole', 'Limit controlling music to a role, plus people with Manage Server', 'control music'],
  ['speech-role', 'ttsRole', 'Limit /say to a role, plus people with Manage Server', 'use /say'],
] as const;

/**
 * /setup: the basics a server needs to get going, the web UI's Basics section, behind Discord's own Manage Server
 * permission. Every other setting is set in the web UI
 */
const command = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Slopkeeper’s basic server settings. Every other setting is in the web UI')
  // Hidden from everyone without Manage Server; admins can widen this under Server Settings → Integrations
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('show').setDescription('Show this server’s settings and where each comes from'))
  .addSubcommand((s) =>
    s
      .setName('announce-channel')
      .setDescription('Where hop-on pings, recaps, leaderboards and sale alerts are posted')
      .addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  )
  .addSubcommand((s) =>
    s
      .setName('timezone')
      .setDescription('Time zone for the weekly post, leaderboards and game nights')
      .addStringOption((o) => o.setName('zone').setDescription('e.g. America/Chicago or Europe/London').setAutocomplete(true)),
  );
for (const [name, , about, what] of GATES) {
  command.addSubcommand((s) =>
    s
      .setName(name)
      .setDescription(about)
      .addRoleOption((o) => o.setName('role').setDescription(`Only this role, plus people with Manage Server, can ${what}`))
      .addBooleanOption((o) => o.setName('everyone').setDescription(`Let everyone ${what} again`)),
  );
}

export const setup: Feature = {
  title: 'Server settings',
  commands: [
    {
      data: command,
      // The time zone, the one option that searches: there are hundreds, and Discord allows 25 fixed choices
      async autocomplete(i) {
        const query = i.options.getFocused().toLowerCase().replaceAll(' ', '_');
        return i.respond(
          TIME_ZONES.filter((zone) => zone.toLowerCase().includes(query))
            .slice(0, 25)
            .map((zone) => ({ name: zone, value: zone })),
        );
      },
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const sub = i.options.getSubcommand();

        if (sub === 'announce-channel') {
          const channel = i.options.getChannel('channel', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
          const problem = cantPost(i.guild, channel);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          return apply(i, [['announceChannel', channel.id]]);
        }

        if (sub === 'timezone') {
          const typed = i.options.getString('zone');
          if (typed === null) return apply(i, [['timezone', null]]);
          const zone = checkSetting(i.guild, 'timezone', typed);
          return 'error' in zone ? i.reply({ content: zone.error, flags: MessageFlags.Ephemeral }) : apply(i, [['timezone', zone.value]]);
        }

        // A role, or everyone again; nothing given only shows it
        const gate = GATES.find(([name]) => name === sub);
        if (gate) {
          const role = i.options.getRole('role');
          const everyone = i.options.getBoolean('everyone');
          if (role && everyone) return i.reply({ content: 'Give a role, or `everyone:True` for everyone, not both.', flags: MessageFlags.Ephemeral });
          return apply(i, [[gate[1], role?.id ?? (everyone ? '' : null)]]);
        }

        if (sub === 'show') return i.reply({ embeds: [settingsEmbed(i.guild)], flags: MessageFlags.Ephemeral });
        // Discord can offer an option that's gone until it catches up with the commands
        return i.reply({ content: 'That setting is in the web UI’s Settings now.', flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
