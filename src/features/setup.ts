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
import { isTimeZone, pingWarning } from '../util.ts';
import { serverVoice, VOICES } from './say.ts';
import { afterSettingsChanged } from './soundboard.ts';
import { cantJoin } from './voiceAudio.ts';
import { findSound, listSounds } from './soundLibrary.ts';
import { loopSpeechProblem } from './loopRoom.ts';
import { commandMention } from '../commandIds.ts';

const ANNOUNCE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
] as const;

// Discord enforces these on the /setup options; checkSetting does for anything else
const PATCH_MODES = { off: 'off', each: 'each one posted', digest: 'weekly digest' };
const READ_WHO = { everyone: 'everyone', voice: 'only people in voice' };
const LONGEST_GREETING = 100;

export const LIMITS = {
  weeklyPostDay: [0, 6],
  weeklyPostHour: [0, 23],
  hopOnMinPeople: [2, 25],
  hopOnCooldownMin: [0, 1440],
  recapMinMinutes: [1, 600],
  sessionGraceMin: [1, 60],
  gameNightReminderMin: [0, 1440],
  joinSoundCooldownMin: [0, 1440],
  joinSoundDelayMs: [0, 10_000],
  freeGamesMinRating: [0, 100],
  saleMinDiscount: [1, 100],
  ttsMaxChars: [20, 500],
  ttsCooldownSec: [0, 3600],
  ttsSpeed: [50, 150],
  ttsVolume: [25, 200],
  soundVolume: [0, 200],
  loopVolume: [5, 200],
  loopEvery: [0, 60],
  loopTextEvery: [0, 60],
  loopIntroDelayMs: [0, 10_000],
  loopTextVolume: [5, 200],
  loopSoundDelayMs: [0, 60_000],
  loopTextDelayMs: [0, 60_000],
  musicVolume: [0, 200],
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
  saleSteamWishlists: 'Steam wishlists in sale alerts',
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
  ttsSpeed: 'Speech speed',
  ttsVolume: 'Speech volume',
  soundVolume: 'Soundboard volume',
  loopRoom: 'Looping sound room',
  loopSound: 'Looping sound',
  loopVolume: 'Loop volume',
  loopEvery: 'Loop every',
  loopText: 'Looping speech',
  loopVoice: 'Looping speech voice',
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
  musicDjRole: 'Who can control music',
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
    case 'weeklyPostDay':
      return DAYS[value as number];
    case 'weeklyPostHour':
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
    case 'loopSoundDelayMs':
    case 'loopTextDelayMs':
      return `${value} ms`;
    case 'steamCountry':
      return String(value).toUpperCase();
    case 'freeGames':
    case 'freeGamesTaste':
    case 'freeGamesMultiplayer':
    case 'saleSteamWishlists':
    case 'steamStatus':
    case 'monthlyRecap':
    case 'sessionRecap':
    case 'weeklyLeaderboard':
    case 'evenVolume':
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
      return VOICES.find((v) => v.id === value)?.name ?? 'the default voice';
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
    default:
      return String(value);
  }
}

/** Why the bot can't post in a channel, or null if it can */
function cantPost(guild: Guild, channel: GuildBasedChannel): string | null {
  const perms = channel.permissionsFor(guild.members.me!);
  const missing = ANNOUNCE_PERMISSIONS.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
  return missing.length ? `I can’t post in ${channel} yet. Give my role **${missing.join('**, **')}** there, then run this again.` : null;
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

/** What has to change before people can opt in to a role */
function roleWarning(guild: Guild, role: Role): string {
  // Discord only lets a bot give out roles below its own highest role
  const me = guild.members.me!;
  const problems: string[] = [];
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) problems.push('my role needs the **Manage Roles** permission');
  if (role.position >= me.roles.highest.position) {
    problems.push(`drag my role (**${me.roles.highest.name}**) above ${role} in Server Settings → Roles`);
  }
  return `${problems.length ? `\n⚠️ Before /notify works: ${problems.join(', and ')}.` : ''}${pingWarning(role)}`;
}

/** The settings in the groups the web UI shows them in, so both read the same way */
export const GROUPS: [string, SettingKey[]][] = [
  ['Posting', ['announceChannel', 'timezone']],
  ['Hop-on pings', ['hopOnRole', 'hopOnMinPeople', 'hopOnCooldownMin']],
  ['Voice sessions', ['sessionRecap', 'recapMinMinutes', 'sessionGraceMin']],
  ['Leaderboard and recap', ['weeklyLeaderboard', 'weeklyPostDay', 'weeklyPostHour', 'monthlyRecap']],
  ['Games', ['steamCountry', 'steamStatus', 'gameNightReminderMin']],
  ['Sale alerts', ['saleMinDiscount', 'saleSteamWishlists', 'saleChannel']],
  ['Patch notes', ['patchNotes', 'patchNotesChannel']],
  ['Free games', ['freeGames', 'freeGamesChannel', 'freeGamesMinRating', 'freeGamesTaste', 'freeGamesMultiplayer', 'freeGamesUnlisted']],
  ['Soundboard', ['soundVolume', 'evenVolume', 'joinSounds', 'joinSoundDelayMs', 'joinSoundCooldownMin', 'soundManagerRole']],
  ['Music', ['musicVolume', 'musicDjRole']],
  ['Looping sound room', ['loopRoom', 'loopSound', 'loopVolume', 'loopEvery', 'loopText', 'loopVoice', 'loopTextVolume', 'loopTextEvery', 'loopIntro', 'loopIntroDelayMs', 'loopSoundDelayMs', 'loopTextDelayMs']],
  ['Text to speech', ['tts', 'ttsVoice', 'ttsSpeed', 'ttsVolume', 'ttsChannel', 'ttsChannelWho', 'ttsGreet', 'ttsGreeting', 'ttsNightReminders', 'ttsHopOn', 'ttsRole', 'ttsMaxChars', 'ttsCooldownSec']],
];

/** What stops the bot doing what its settings ask, for the top of /setup show */
function settingProblems(guild: Guild): string[] {
  const problems: string[] = [];
  const announce = idSetting(guild.id, 'announceChannel');
  const channel = announce ? guild.channels.cache.get(announce) : undefined;
  if (!announce) problems.push(`Nothing gets posted until an announce channel is set with ${commandMention(guild.id, 'setup announce-channel')}.`);
  else if (!channel) problems.push('The announce channel is gone. Pick another one.');
  else {
    const problem = cantPost(guild, channel);
    if (problem) problems.push(problem);
  }
  const hopOnRole = idSetting(guild.id, 'hopOnRole');
  const role = hopOnRole ? guild.roles.cache.get(hopOnRole) : undefined;
  if (hopOnRole && !role) problems.push('The hop-on role is gone, so hop-on pings ping nobody.');
  if (role) {
    const warning = roleWarning(guild, role).trim();
    if (warning) problems.push(warning.replace(/^⚠️ /, ''));
  }
  const loopRoom = idSetting(guild.id, 'loopRoom');
  if (loopRoom && !guild.channels.cache.get(loopRoom)) problems.push('The looping room’s channel is gone.');
  return problems;
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
    .setFooter({ text: 'Change one with its /setup command, or put it back with /setup reset. The web UI has every setting too.' });
  if (problems.length) embed.setDescription(problems.map((p) => `⚠️ ${p}`).join('\n').slice(0, 4096));
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
      return VOICES.some((v) => v.id === value) ? { value: String(value) } : { error: 'Pick a voice from the list.' };
    case 'loopText': {
      const text = String(value).trim();
      if (!text) return { error: 'Type something to say.' };
      return text.length > LOOP_TEXT_MAX ? { error: `Looping speech can be up to ${LOOP_TEXT_MAX} characters.` } : { value: text };
    }
    case 'ttsChannelWho':
      return Object.hasOwn(READ_WHO, String(value)) ? { value: String(value) } : { error: 'Read everyone, or only people in voice.' };
    case 'ttsGreeting':
      return greetingProblem(String(value)) ? { error: greetingProblem(String(value))! } : { value: String(value).trim() };
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
  await afterSettingsChanged(i.guild, given.map(([key]) => key));
}

export const setup: Feature = {
  title: 'Server settings',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Server settings for Slopkeeper')
        // Hidden from everyone without Manage Server; admins can widen this under Server Settings → Integrations
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName('show').setDescription('Show this server’s settings and where each comes from'))
        .addSubcommand((s) =>
          s
            .setName('announce-channel')
            .setDescription('Where hop-on pings, recaps, leaderboards and sale alerts are posted')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('hopon-role')
            .setDescription('Role pinged when people hop in voice; /notify toggles it. Give nothing to see it')
            .addRoleOption((o) => o.setName('role').setDescription('The role to ping'))
            .addBooleanOption((o) => o.setName('off').setDescription('Turn hop-on role pings off')),
        )
        .addSubcommand((s) =>
          s
            .setName('hopon')
            .setDescription('When hop-on pings go out')
            .addIntegerOption((o) => o.setName('min_people').setDescription('People in a voice channel before pinging').setMinValue(LIMITS.hopOnMinPeople[0]).setMaxValue(LIMITS.hopOnMinPeople[1]))
            .addIntegerOption((o) => o.setName('cooldown_minutes').setDescription('Minutes between pings').setMinValue(LIMITS.hopOnCooldownMin[0]).setMaxValue(LIMITS.hopOnCooldownMin[1])),
        )
        .addSubcommand((s) =>
          s
            .setName('sessions')
            .setDescription('Voice session recaps')
            .addBooleanOption((o) => o.setName('recaps').setDescription('Post a recap when a session ends. Off still counts sessions in stats'))
            .addIntegerOption((o) => o.setName('recap_min_minutes').setDescription('Shorter sessions get no recap and don’t count in stats').setMinValue(LIMITS.recapMinMinutes[0]).setMaxValue(LIMITS.recapMinMinutes[1]))
            .addIntegerOption((o) =>
              o.setName('grace_minutes').setDescription('Minutes a channel stays empty before its session ends').setMinValue(LIMITS.sessionGraceMin[0]).setMaxValue(LIMITS.sessionGraceMin[1]),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('leaderboard')
            .setDescription('Whether and when the weekly voice leaderboard is posted')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Post the leaderboard each week'))
            .addIntegerOption((o) =>
              o
                .setName('day')
                .setDescription('Day of the week')
                .addChoices(...DAYS.map((name, value) => ({ name, value }))),
            )
            .addIntegerOption((o) => o.setName('hour').setDescription('Hour, 0–23, in the server’s time zone').setMinValue(LIMITS.weeklyPostHour[0]).setMaxValue(LIMITS.weeklyPostHour[1])),
        )
        .addSubcommand((s) =>
          s
            .setName('timezone')
            .setDescription('Time zone for the weekly post, leaderboards and game nights')
            .addStringOption((o) => o.setName('zone').setDescription('e.g. America/Chicago or Europe/London').setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('steam-region')
            .setDescription('Steam store region for sale prices')
            .addStringOption((o) => o.setName('country').setDescription('Two-letter country code, e.g. us, gb, de').setMinLength(2).setMaxLength(2)),
        )
        .addSubcommand((s) =>
          s
            .setName('free-games')
            .setDescription('Post free-to-keep games on Steam, Epic and GOG (off by default)')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off'))
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Post them here instead of the announce channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('free-game-filters')
            .setDescription('Choose which free games are worth posting')
            .addIntegerOption((o) =>
              o.setName('min_rating').setDescription('Lowest share of positive Steam reviews, in percent. 0 turns it off').setMinValue(LIMITS.freeGamesMinRating[0]).setMaxValue(LIMITS.freeGamesMinRating[1]),
            )
            .addBooleanOption((o) => o.setName('like_what_we_play').setDescription('Only games like the ones this server plays most'))
            .addBooleanOption((o) => o.setName('multiplayer_only').setDescription('Only games with multiplayer or co-op'))
            .addBooleanOption((o) => o.setName('not_on_steam').setDescription('Show games with no Steam page, which can’t be rated')),
        )
        .addSubcommand((s) =>
          s
            .setName('sale-alerts')
            .setDescription('Choose which Steam sales are worth posting, and where')
            .addIntegerOption((o) =>
              o.setName('min_discount').setDescription('Smallest discount to post, in percent').setMinValue(LIMITS.saleMinDiscount[0]).setMaxValue(LIMITS.saleMinDiscount[1]),
            )
            .addBooleanOption((o) => o.setName('steam_wishlists').setDescription('Include games on members’ public Steam wishlists'))
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Post them here instead of the announce channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('gamenight-reminder')
            .setDescription('How long before a game night to ping the people who are in')
            .addIntegerOption((o) => o.setName('minutes').setDescription('0 turns reminders off').setMinValue(LIMITS.gameNightReminderMin[0]).setMaxValue(LIMITS.gameNightReminderMin[1])),
        )
        .addSubcommand((s) =>
          s
            .setName('monthly-recap')
            .setDescription('Post a recap of the month on the 1st (on by default)')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off')),
        )
        .addSubcommand((s) =>
          s
            .setName('patch-notes')
            .setDescription('Post patch notes for games played here lately (off by default)')
            .addStringOption((o) =>
              o
                .setName('mode')
                .setDescription('How to post them')
                .addChoices(...Object.entries(PATCH_MODES).map(([value, name]) => ({ name, value }))),
            )
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Post them here instead of the announce channel')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('steam-status')
            .setDescription('Use what linked members in voice are playing on Steam if Discord doesn’t show it (on by default)')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off')),
        )
        .addSubcommand((s) =>
          s
            .setName('sounds')
            .setDescription('How the soundboard behaves')
            .addBooleanOption((o) => o.setName('even_volume').setDescription('Level sounds so they play about as loud as each other (on by default)'))
            .addBooleanOption((o) => o.setName('join_sounds').setDescription('Let people pick a sound for joining voice with /sound join (on by default)'))
            .addIntegerOption((o) =>
              o.setName('join_cooldown_minutes').setDescription('Shortest time between one person’s join sounds').setMinValue(LIMITS.joinSoundCooldownMin[0]).setMaxValue(LIMITS.joinSoundCooldownMin[1]),
            )
            .addIntegerOption((o) =>
              o.setName('join_delay_ms').setDescription('How long the bot waits after connecting before a join sound, 500 is half a second').setMinValue(LIMITS.joinSoundDelayMs[0]).setMaxValue(LIMITS.joinSoundDelayMs[1]),
            )
            .addIntegerOption((o) => o.setName('volume').setDescription('How loud every sound plays, as a percentage (100 by default)').setMinValue(LIMITS.soundVolume[0]).setMaxValue(LIMITS.soundVolume[1])),
        )
        .addSubcommand((s) =>
          s
            .setName('loop-room')
            .setDescription('Play a sound nonstop while anyone’s in a voice channel. Give nothing to see how it’s set')
            .addChannelOption((o) => o.setName('channel').setDescription('The voice channel').addChannelTypes(ChannelType.GuildVoice))
            .addBooleanOption((o) => o.setName('off').setDescription('Turn the looping room off, keeping its other settings'))
            .addStringOption((o) => o.setName('sound').setDescription('The sound to loop').setAutocomplete(true))
            .addIntegerOption((o) => o.setName('volume').setDescription('How loud the sound is, as a percentage (50 by default)').setMinValue(LIMITS.loopVolume[0]).setMaxValue(LIMITS.loopVolume[1]))
            .addNumberOption((o) =>
              o.setName('every').setDescription('Seconds between fresh copies, layered on top of each other, like 0.5. 0 loops it without a gap').setMinValue(LIMITS.loopEvery[0]).setMaxValue(LIMITS.loopEvery[1]),
            )
            .addStringOption((o) => o.setName('speech').setDescription('Words to say over and over as well as the sound').setMaxLength(LOOP_TEXT_MAX))
            .addNumberOption((o) =>
              o.setName('speech_every').setDescription('Seconds between fresh copies of the speech, layered. 0 says it again straight away').setMinValue(LIMITS.loopTextEvery[0]).setMaxValue(LIMITS.loopTextEvery[1]),
            )
            .addBooleanOption((o) => o.setName('no_speech').setDescription('Stop saying the looping speech'))
            .addStringOption((o) => o.setName('intro').setDescription('A sound played before the loop starts, and again whenever someone comes in').setAutocomplete(true))
            .addIntegerOption((o) =>
              o.setName('intro_delay_ms').setDescription('How long after someone comes in the intro plays, 250 is a quarter of a second').setMinValue(LIMITS.loopIntroDelayMs[0]).setMaxValue(LIMITS.loopIntroDelayMs[1]),
            )
            .addBooleanOption((o) => o.setName('no_intro').setDescription('Go straight to the loop, with no intro'))
            .addIntegerOption((o) => o.setName('speech_volume').setDescription('How loud the speech is, as a percentage (50 by default)').setMinValue(LIMITS.loopTextVolume[0]).setMaxValue(LIMITS.loopTextVolume[1]))
            .addIntegerOption((o) =>
              o.setName('sound_delay_ms').setDescription('How long the sound waits after the intro, 1000 is a second').setMinValue(LIMITS.loopSoundDelayMs[0]).setMaxValue(LIMITS.loopSoundDelayMs[1]),
            )
            .addIntegerOption((o) =>
              o.setName('speech_delay_ms').setDescription('How long the speech waits after the intro, 1000 is a second').setMinValue(LIMITS.loopTextDelayMs[0]).setMaxValue(LIMITS.loopTextDelayMs[1]),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('music')
            .setDescription('Spotify in voice: how loud it plays, and who can control it')
            .addIntegerOption((o) => o.setName('volume').setDescription('How loud music plays, as a percentage (40 by default)').setMinValue(LIMITS.musicVolume[0]).setMaxValue(LIMITS.musicVolume[1]))
            .addRoleOption((o) => o.setName('dj_role').setDescription('Only this role, plus people with Manage Server, can control music'))
            .addBooleanOption((o) => o.setName('everyone').setDescription('Let everyone control music again')),
        )
        .addSubcommand((s) =>
          s
            .setName('sound-managers')
            .setDescription('Limit changing sounds to a role, plus people with Manage Server')
            .addRoleOption((o) => o.setName('role').setDescription('Only this role, plus people with Manage Server, can change sounds'))
            .addBooleanOption((o) => o.setName('everyone').setDescription('Let everyone change sounds again')),
        )
        .addSubcommand((s) =>
          s
            .setName('speech')
            .setDescription('Text to speech: on or off, and the limits on /say. Pick the default voice in the web UI')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Whether /say works here'))
            .addIntegerOption((o) => o.setName('speed').setDescription('How fast it talks, as a percentage of the voice’s natural speed').setMinValue(LIMITS.ttsSpeed[0]).setMaxValue(LIMITS.ttsSpeed[1]))
            .addIntegerOption((o) => o.setName('volume').setDescription('How loud it talks. 100 is about as loud as a sound').setMinValue(LIMITS.ttsVolume[0]).setMaxValue(LIMITS.ttsVolume[1]))
            .addIntegerOption((o) => o.setName('max_characters').setDescription('Longest line').setMinValue(LIMITS.ttsMaxChars[0]).setMaxValue(LIMITS.ttsMaxChars[1]))
            .addIntegerOption((o) => o.setName('wait_seconds').setDescription('Wait between one person’s lines').setMinValue(LIMITS.ttsCooldownSec[0]).setMaxValue(LIMITS.ttsCooldownSec[1]))
            .addBooleanOption((o) => o.setName('greet').setDescription('Say who joined voice, for people with no join sound'))
            .addStringOption((o) => o.setName('greeting').setDescription('What to say, with {name} for the person').setMaxLength(LONGEST_GREETING))
            .addBooleanOption((o) => o.setName('night_reminders').setDescription('Say game night reminders in the night’s voice channel'))
            .addBooleanOption((o) => o.setName('hop_on').setDescription('Say hop-on pings in voice')),
        )
        .addSubcommand((s) =>
          s
            .setName('speech-channel')
            .setDescription('Have the bot read out what people type in a channel. Give nothing to see how it’s set')
            .addChannelOption((o) => o.setName('channel').setDescription('The channel to read').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
            .addBooleanOption((o) => o.setName('off').setDescription('Stop reading the channel out'))
            .addStringOption((o) =>
              o
                .setName('who')
                .setDescription('Whose messages to read')
                .addChoices(...Object.entries(READ_WHO).map(([value, name]) => ({ name, value }))),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('speech-role')
            .setDescription('Limit /say to a role, plus people with Manage Server')
            .addRoleOption((o) => o.setName('role').setDescription('Only this role, plus people with Manage Server, can use /say'))
            .addBooleanOption((o) => o.setName('everyone').setDescription('Let everyone use /say again')),
        )
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Put a setting back to its default')
            .addStringOption((o) =>
              o
                .setName('setting')
                .setDescription('Setting')
                .setRequired(true)
                .setAutocomplete(true),
            ),
        ),
      async autocomplete(i) {
        // Discord allows 25 fixed choices, and there are more settings than that
        if (i.options.getSubcommand() === 'reset') {
          const typed = i.options.getFocused().toLowerCase();
          return i.respond(
            (Object.keys(LABELS) as SettingKey[])
              .filter((key) => LABELS[key].toLowerCase().includes(typed))
              .slice(0, 25)
              .map((key) => ({ name: LABELS[key], value: key })),
          );
        }
        if (i.options.getSubcommand() === 'loop-room') {
          const typed = i.options.getFocused().toLowerCase();
          const sounds = i.guildId ? listSounds(i.guildId) : [];
          return i.respond(
            sounds
              .filter((s) => s.name.includes(typed))
              .slice(0, 25)
              .map((s) => ({ name: s.name, value: s.name })),
          );
        }
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

        if (sub === 'hopon-role') {
          const role = i.options.getRole('role');
          if (role && i.options.getBoolean('off')) return i.reply({ content: 'Give a role, or `off:True` for no role, not both.', flags: MessageFlags.Ephemeral });
          if (!role) return apply(i, [['hopOnRole', i.options.getBoolean('off') ? '' : null]]);
          const problem = cantHandOut(i.guild, role as Role);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          setSetting(i.guildId, 'hopOnRole', role.id);
          logActivity(i.guildId, i.user.id, `Set ${LABELS.hopOnRole} to ${role}`);
          return i.reply({
            content: `✅ Hop-on pings now ping ${role}; people opt in with ${commandMention(i.guildId, 'notify')}.${roleWarning(i.guild, role as Role)}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        }

        if (sub === 'hopon') {
          return apply(i, [
            ['hopOnMinPeople', i.options.getInteger('min_people')],
            ['hopOnCooldownMin', i.options.getInteger('cooldown_minutes')],
          ]);
        }
        if (sub === 'sessions') {
          return apply(i, [
            ['sessionRecap', i.options.getBoolean('recaps')],
            ['recapMinMinutes', i.options.getInteger('recap_min_minutes')],
            ['sessionGraceMin', i.options.getInteger('grace_minutes')],
          ]);
        }
        if (sub === 'leaderboard') {
          return apply(i, [
            ['weeklyLeaderboard', i.options.getBoolean('enabled')],
            ['weeklyPostDay', i.options.getInteger('day')],
            ['weeklyPostHour', i.options.getInteger('hour')],
          ]);
        }
        if (sub === 'timezone') {
          const typed = i.options.getString('zone');
          if (typed === null) return apply(i, [['timezone', null]]);
          const zone = checkSetting(i.guild, 'timezone', typed);
          return 'error' in zone ? i.reply({ content: zone.error, flags: MessageFlags.Ephemeral }) : apply(i, [['timezone', zone.value]]);
        }
        if (sub === 'steam-region') {
          const typed = i.options.getString('country');
          if (typed === null) return apply(i, [['steamCountry', null]]);
          const country = checkSetting(i.guild, 'steamCountry', typed);
          return 'error' in country ? i.reply({ content: country.error, flags: MessageFlags.Ephemeral }) : apply(i, [['steamCountry', country.value]]);
        }
        if (sub === 'free-games') {
          const channel = i.options.getChannel('channel', false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
          const problem = channel && cantPost(i.guild, channel);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          return apply(i, [
            ['freeGames', i.options.getBoolean('enabled')],
            ['freeGamesChannel', channel?.id ?? null],
          ]);
        }
        if (sub === 'free-game-filters') {
          return apply(i, [
            ['freeGamesMinRating', i.options.getInteger('min_rating')],
            ['freeGamesTaste', i.options.getBoolean('like_what_we_play')],
            ['freeGamesMultiplayer', i.options.getBoolean('multiplayer_only')],
            ['freeGamesUnlisted', i.options.getBoolean('not_on_steam')],
          ]);
        }
        if (sub === 'sale-alerts') {
          const channel = i.options.getChannel('channel', false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
          const problem = channel && cantPost(i.guild, channel);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          return apply(i, [
            ['saleMinDiscount', i.options.getInteger('min_discount')],
            ['saleSteamWishlists', i.options.getBoolean('steam_wishlists')],
            ['saleChannel', channel?.id ?? null],
          ]);
        }
        if (sub === 'gamenight-reminder') return apply(i, [['gameNightReminderMin', i.options.getInteger('minutes')]]);
        if (sub === 'monthly-recap') return apply(i, [['monthlyRecap', i.options.getBoolean('enabled')]]);
        if (sub === 'patch-notes') {
          const channel = i.options.getChannel('channel', false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
          const problem = channel && cantPost(i.guild, channel);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          return apply(i, [
            ['patchNotes', i.options.getString('mode')],
            ['patchNotesChannel', channel?.id ?? null],
          ]);
        }
        if (sub === 'steam-status') return apply(i, [['steamStatus', i.options.getBoolean('enabled')]]);
        if (sub === 'sounds') {
          return apply(i, [
            ['evenVolume', i.options.getBoolean('even_volume')],
            ['soundVolume', i.options.getInteger('volume')],
            ['joinSounds', i.options.getBoolean('join_sounds')],
            ['joinSoundCooldownMin', i.options.getInteger('join_cooldown_minutes')],
            ['joinSoundDelayMs', i.options.getInteger('join_delay_ms')],
          ]);
        }

        if (sub === 'loop-room') {
          const channel = i.options.getChannel('channel', false, [ChannelType.GuildVoice]);
          const sound = i.options.getString('sound');
          const volume = i.options.getInteger('volume');
          const every = i.options.getNumber('every');
          const intro = i.options.getString('intro');
          const introDelay = i.options.getInteger('intro_delay_ms');
          const noIntro = i.options.getBoolean('no_intro');
          const speechVolume = i.options.getInteger('speech_volume');
          const soundDelay = i.options.getInteger('sound_delay_ms');
          const speechDelay = i.options.getInteger('speech_delay_ms');
          for (const [key, value] of [['loopRoom', channel?.id], ['loopSound', sound], ['loopIntro', intro]] as const) {
            const checked = value ? checkSetting(i.guild, key, value) : null;
            if (checked && 'error' in checked) return i.reply({ content: checked.error, flags: MessageFlags.Ephemeral });
          }
          const speech = i.options.getString('speech');
          const speechEvery = i.options.getNumber('speech_every');
          const noSpeech = i.options.getBoolean('no_speech');
          const checked: Partial<Record<SettingKey, string | number>> = {};
          for (const [key, value] of [['loopEvery', every], ['loopText', speech], ['loopTextEvery', speechEvery]] as const) {
            if (value === null) continue;
            const result = checkSetting(i.guild, key, value);
            if ('error' in result) return i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
            checked[key] = result.value as string | number;
          }
          await apply(i, [
            ['loopRoom', i.options.getBoolean('off') ? '' : (channel?.id ?? null)],
            ['loopSound', sound],
            ['loopVolume', volume],
            ['loopEvery', checked.loopEvery ?? null],
            ['loopText', noSpeech ? '' : (checked.loopText ?? null)],
            ['loopTextEvery', checked.loopTextEvery ?? null],
            ['loopIntro', noIntro ? '' : intro],
            ['loopIntroDelayMs', introDelay],
            ['loopTextVolume', speechVolume],
            ['loopSoundDelayMs', soundDelay],
            ['loopTextDelayMs', speechDelay],
          ]);
          const speechProblem = checked.loopText ? await loopSpeechProblem(i.guild) : null;
          if (speechProblem) await i.followUp({ content: `⚠️ ${speechProblem}`, flags: MessageFlags.Ephemeral });
          return;
        }

        // A role, or everyone again; nothing given only shows it
        const roleOrEveryone = (option: string) => i.options.getRole(option)?.id ?? (i.options.getBoolean('everyone') ? '' : null);
        if ((sub === 'music' || sub === 'sound-managers' || sub === 'speech-role') && i.options.getRole(sub === 'music' ? 'dj_role' : 'role') && i.options.getBoolean('everyone')) {
          return i.reply({ content: 'Give a role, or `everyone:True` for everyone, not both.', flags: MessageFlags.Ephemeral });
        }
        if (sub === 'music') {
          return apply(i, [
            ['musicVolume', i.options.getInteger('volume')],
            ['musicDjRole', roleOrEveryone('dj_role')],
          ]);
        }
        if (sub === 'sound-managers') return apply(i, [['soundManagerRole', roleOrEveryone('role')]]);
        if (sub === 'speech-role') return apply(i, [['ttsRole', roleOrEveryone('role')]]);
        if (sub === 'speech-channel') {
          const channel = i.options.getChannel('channel', false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
          const problem = channel && cantSee(i.guild, channel);
          if (problem) return i.reply({ content: problem.error, flags: MessageFlags.Ephemeral });
          return apply(i, [
            ['ttsChannel', i.options.getBoolean('off') ? '' : (channel?.id ?? null)],
            ['ttsChannelWho', i.options.getString('who')],
          ]);
        }
        if (sub === 'speech') {
          const greeting = i.options.getString('greeting');
          const problem = greeting && greetingProblem(greeting);
          if (problem) return i.reply({ content: problem, flags: MessageFlags.Ephemeral });
          return apply(i, [
            ['ttsGreet', i.options.getBoolean('greet')],
            ['ttsGreeting', greeting && greeting.trim()],
            ['ttsNightReminders', i.options.getBoolean('night_reminders')],
            ['ttsHopOn', i.options.getBoolean('hop_on')],
            ['tts', i.options.getBoolean('enabled')],
            ['ttsSpeed', i.options.getInteger('speed')],
            ['ttsVolume', i.options.getInteger('volume')],
            ['ttsMaxChars', i.options.getInteger('max_characters')],
            ['ttsCooldownSec', i.options.getInteger('wait_seconds')],
          ]);
        }

        if (sub === 'reset') {
          const key = i.options.getString('setting', true) as SettingKey;
          if (!Object.hasOwn(LABELS, key)) return i.reply({ content: 'Pick a setting from the list.', flags: MessageFlags.Ephemeral });
          setSetting(i.guildId, key, undefined);
          logActivity(i.guildId, i.user.id, `Put ${LABELS[key]} back to the default`);
          await i.reply({
            content: `↩️ ${LABELS[key]} is back to the default: ${show(key, setting(i.guildId, key))}.`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
          return afterSettingsChanged(i.guild, [key]);
        }

        return i.reply({ embeds: [settingsEmbed(i.guild)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
