import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { guildSettings, setGuildSetting } from '../settings.ts';
import type { Feature } from '../types.ts';

const ANNOUNCE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
] as const;

export const setup: Feature = {
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Server settings for Slopkeeper')
        // Hidden from everyone without Manage Server; admins can widen this under Server Settings → Integrations
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName('show').setDescription('Show this server’s settings'))
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
            .setDescription('Role pinged when people hop in voice; /notify toggles it')
            .addRoleOption((o) => o.setName('role').setDescription('Leave empty to turn hop-on role pings off')),
        ),
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
          setGuildSetting(i.guildId, 'announce_channel_id', channel.id);
          return i.reply({ content: `📣 Announcements now go to ${channel}.`, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'hopon-role') {
          const role = i.options.getRole('role');
          if (!role) {
            setGuildSetting(i.guildId, 'hopon_role_id', null);
            return i.reply({ content: '🔕 Hop-on pings no longer ping a role. They’re still posted.', flags: MessageFlags.Ephemeral });
          }
          if (role.id === i.guildId || role.managed) {
            return i.reply({ content: `${role} can’t be handed out. Make a normal role for hop-on pings.`, flags: MessageFlags.Ephemeral });
          }
          // Discord only lets a bot give out roles below its own highest role
          const problems: string[] = [];
          if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) problems.push('my role needs the **Manage Roles** permission');
          if (role.position >= me.roles.highest.position) {
            problems.push(`drag my role (**${me.roles.highest.name}**) above ${role} in Server Settings → Roles`);
          }
          setGuildSetting(i.guildId, 'hopon_role_id', role.id);
          return i.reply({
            content: `🔔 Hop-on pings now ping ${role}; people opt in with \`/notify\`.${problems.length ? `\n⚠️ Before /notify works: ${problems.join(', and ')}.` : ''}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        }

        const settings = guildSettings(i.guildId);
        const embed = new EmbedBuilder()
          .setTitle('⚙️ Slopkeeper settings')
          .setColor(0x5865f2)
          .addFields(
            {
              name: 'Announce channel',
              value: settings.announceChannelId ? `<#${settings.announceChannelId}>` : 'Not set. Nothing gets posted until you run `/setup announce-channel`.',
            },
            { name: 'Hop-on role', value: settings.hopOnRoleId ? `<@&${settings.hopOnRoleId}>` : 'None. Hop-on pings are posted without pinging anyone.' },
          );
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      },
    },
  ],
};
