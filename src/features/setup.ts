import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { DEFAULT_ENV, DEFAULTS, setSetting, setting, storedSetting, type SettingKey } from '../settings.ts';
import type { Feature } from '../types.ts';
import { isTimeZone } from '../util.ts';

const ANNOUNCE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
] as const;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIME_ZONES = Intl.supportedValuesOf('timeZone');

const LABELS: Record<SettingKey, string> = {
  announceChannel: 'Announce channel',
  hopOnRole: 'Hop-on role',
  timezone: 'Time zone',
  weeklyPostDay: 'Weekly leaderboard day',
  weeklyPostHour: 'Weekly leaderboard hour',
  hopOnMinPeople: 'Hop-on ping at',
  hopOnCooldownMin: 'Hop-on cooldown',
  recapMinMinutes: 'Shortest recapped session',
  sessionGraceMin: 'Session ends after empty for',
  steamCountry: 'Steam price region',
  freeGames: 'Free game alerts',
  gameNightReminderMin: 'Game night reminder',
};

function show(key: SettingKey, value: unknown): string {
  switch (key) {
    case 'announceChannel':
      return value ? `<#${value}>` : 'not set, so nothing gets posted';
    case 'hopOnRole':
      return value ? `<@&${value}>` : 'none, hop-on pings don’t ping anyone';
    case 'weeklyPostDay':
      return DAYS[value as number];
    case 'weeklyPostHour':
      return `${String(value).padStart(2, '0')}:00`;
    case 'hopOnMinPeople':
      return `${value} people`;
    case 'hopOnCooldownMin':
    case 'recapMinMinutes':
    case 'sessionGraceMin':
      return `${value} min`;
    case 'steamCountry':
      return String(value).toUpperCase();
    case 'freeGames':
      return value ? 'on' : 'off';
    case 'gameNightReminderMin':
      return value ? `${value} min before` : 'off';
    default:
      return String(value);
  }
}

function source(guildId: string, key: SettingKey): string {
  if (storedSetting(guildId, key) !== undefined) return 'set here';
  const env = DEFAULT_ENV[key];
  return env && process.env[env] ? `host default (${env})` : 'default';
}

/** Applies the given settings and replies with what changed; options left out stay as they are */
function apply(i: ChatInputCommandInteraction<'cached'>, changes: [SettingKey, string | number | boolean | null][]) {
  const given = changes.filter(([, value]) => value !== null);
  if (!given.length) return i.reply({ content: 'Nothing to change. Pick at least one option.', flags: MessageFlags.Ephemeral });
  for (const [key, value] of given) setSetting(i.guildId, key, value);
  return i.reply({
    content: given.map(([key]) => `✅ ${LABELS[key]}: ${show(key, setting(i.guildId, key))}`).join('\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
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
            .setDescription('Where hop-on pings, recaps, leaderboards, sale and free game alerts are posted')
            .addChannelOption((o) =>
              o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('hopon-role')
            .setDescription('Role pinged when people hop in voice; /notify toggles it')
            .addRoleOption((o) => o.setName('role').setDescription('Leave empty to turn hop-on role pings off')),
        )
        .addSubcommand((s) =>
          s
            .setName('hopon')
            .setDescription('When hop-on pings go out')
            .addIntegerOption((o) => o.setName('min_people').setDescription('People in a voice channel before pinging').setMinValue(2).setMaxValue(25))
            .addIntegerOption((o) => o.setName('cooldown_minutes').setDescription('Minutes between pings').setMinValue(0).setMaxValue(1440)),
        )
        .addSubcommand((s) =>
          s
            .setName('sessions')
            .setDescription('Voice session recaps')
            .addIntegerOption((o) => o.setName('recap_min_minutes').setDescription('Shortest session that gets a recap').setMinValue(1).setMaxValue(600))
            .addIntegerOption((o) =>
              o.setName('grace_minutes').setDescription('Minutes a channel stays empty before its session ends').setMinValue(1).setMaxValue(60),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('leaderboard')
            .setDescription('When the weekly voice leaderboard is posted')
            .addIntegerOption((o) =>
              o
                .setName('day')
                .setDescription('Day of the week')
                .addChoices(...DAYS.map((name, value) => ({ name, value }))),
            )
            .addIntegerOption((o) => o.setName('hour').setDescription('Hour, 0–23, in the server’s time zone').setMinValue(0).setMaxValue(23)),
        )
        .addSubcommand((s) =>
          s
            .setName('timezone')
            .setDescription('Time zone for the weekly post, leaderboards and game nights')
            .addStringOption((o) => o.setName('zone').setDescription('e.g. America/Chicago or Europe/London').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('steam-region')
            .setDescription('Steam store region for sale prices')
            .addStringOption((o) => o.setName('country').setDescription('Two-letter country code, e.g. us, gb, de').setRequired(true).setMinLength(2).setMaxLength(2)),
        )
        .addSubcommand((s) =>
          s
            .setName('free-games')
            .setDescription('Post free-to-keep games on Steam, Epic and GOG')
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('gamenight-reminder')
            .setDescription('How long before a game night to ping the people who are in')
            .addIntegerOption((o) => o.setName('minutes').setDescription('0 turns reminders off').setRequired(true).setMinValue(0).setMaxValue(1440)),
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
                .addChoices(...(Object.keys(LABELS) as SettingKey[]).map((key) => ({ name: LABELS[key], value: key }))),
            ),
        ),
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
        const me = i.guild.members.me!;

        if (sub === 'announce-channel') {
          const channel = i.options.getChannel('channel', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
          const perms = channel.permissionsFor(me);
          const missing = ANNOUNCE_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, name]) => name);
          if (missing.length) {
            return i.reply({
              content: `I can’t post in ${channel} yet. Give my role **${missing.join('**, **')}** there, then run this again.`,
              flags: MessageFlags.Ephemeral,
            });
          }
          return apply(i, [['announceChannel', channel.id]]);
        }

        if (sub === 'hopon-role') {
          const role = i.options.getRole('role');
          if (!role) return apply(i, [['hopOnRole', '']]);
          if (role.id === i.guildId || role.managed) {
            return i.reply({ content: `${role} can’t be handed out. Make a normal role for hop-on pings.`, flags: MessageFlags.Ephemeral });
          }
          // Discord only lets a bot give out roles below its own highest role
          const problems: string[] = [];
          if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) problems.push('my role needs the **Manage Roles** permission');
          if (role.position >= me.roles.highest.position) {
            problems.push(`drag my role (**${me.roles.highest.name}**) above ${role} in Server Settings → Roles`);
          }
          setSetting(i.guildId, 'hopOnRole', role.id);
          return i.reply({
            content: `✅ Hop-on pings now ping ${role}; people opt in with \`/notify\`.${problems.length ? `\n⚠️ Before /notify works: ${problems.join(', and ')}.` : ''}`,
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
            ['recapMinMinutes', i.options.getInteger('recap_min_minutes')],
            ['sessionGraceMin', i.options.getInteger('grace_minutes')],
          ]);
        }
        if (sub === 'leaderboard') {
          return apply(i, [
            ['weeklyPostDay', i.options.getInteger('day')],
            ['weeklyPostHour', i.options.getInteger('hour')],
          ]);
        }
        if (sub === 'timezone') {
          const zone = i.options.getString('zone', true).trim();
          if (!isTimeZone(zone)) {
            return i.reply({ content: `**${zone}** isn’t a time zone I know. Pick one from the list, e.g. America/Chicago.`, flags: MessageFlags.Ephemeral });
          }
          return apply(i, [['timezone', zone]]);
        }
        if (sub === 'steam-region') {
          const country = i.options.getString('country', true).toLowerCase();
          if (!/^[a-z]{2}$/.test(country)) return i.reply({ content: 'Use a two-letter country code, like us or gb.', flags: MessageFlags.Ephemeral });
          return apply(i, [['steamCountry', country]]);
        }
        if (sub === 'free-games') return apply(i, [['freeGames', i.options.getBoolean('enabled', true)]]);
        if (sub === 'gamenight-reminder') return apply(i, [['gameNightReminderMin', i.options.getInteger('minutes', true)]]);

        if (sub === 'reset') {
          const key = i.options.getString('setting', true) as SettingKey;
          setSetting(i.guildId, key, undefined);
          return i.reply({
            content: `↩️ ${LABELS[key]} is back to the default: ${show(key, setting(i.guildId, key))}.`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        }

        const embed = new EmbedBuilder()
          .setTitle('⚙️ Slopkeeper settings')
          .setColor(0x5865f2)
          .setDescription(
            (Object.keys(DEFAULTS) as SettingKey[])
              .map((key) => {
                const value = key === 'announceChannel' || key === 'hopOnRole' ? setting(i.guildId, key) || null : setting(i.guildId, key);
                return `**${LABELS[key]}:** ${show(key, value)} · -# ${source(i.guildId, key)}`;
              })
              .join('\n'),
          )
          .setFooter({ text: 'Change one with its /setup command, or put it back with /setup reset' });
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
