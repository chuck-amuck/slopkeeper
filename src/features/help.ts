import { ApplicationCommandOptionType, EmbedBuilder, MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import type { Feature } from '../types.ts';
import { commandMention } from '../commandIds.ts';

const GUIDE = 'https://github.com/chuck-amuck/slopkeeper#readme';

/** /help, built from the other features' commands so it never goes stale */
export function help(features: Feature[]): Feature {
  const sections = features
    .filter((f) => f.title && f.commands?.length)
    .map((f) => ({ title: f.title!, commands: f.commands!.map((c) => c.data.toJSON()) }));
  const all = sections.flatMap((s) => s.commands);
  // Commands someone can't use (like /setup without Manage Server) are left out, as Discord hides them too
  const canUse = (perms: string | null | undefined, member: Readonly<PermissionsBitField> | null) => !perms || !member || member.has(new PermissionsBitField(BigInt(perms)));

  return {
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName('help')
          .setDescription('What Slopkeeper can do')
          .addStringOption((o) =>
            o
              .setName('command')
              .setDescription('Show one command in detail')
              // Not fixed choices: Discord allows only 25, and one command too many would stop every command registering
              .setAutocomplete(true),
          ),
        async autocomplete(i) {
          const typed = i.options.getFocused().toLowerCase().replace(/^\//, '');
          const usable = all.filter((c) => canUse(c.default_member_permissions, i.memberPermissions));
          const starts = usable.filter((c) => c.name.startsWith(typed));
          const rest = usable.filter((c) => !c.name.startsWith(typed) && (c.name.includes(typed) || c.description.toLowerCase().includes(typed)));
          return i.respond([...starts, ...rest].slice(0, 25).map((c) => ({ name: `/${c.name}: ${c.description}`.slice(0, 100), value: c.name })));
        },
        async run(i) {
          const ids = new Map(i.guild?.commands.cache.map((c) => [c.name, c.id]) ?? []);
          // A clickable mention when the command's id is known
          const mention = (name: string) => (ids.has(name.split(' ')[0]) ? `</${name}:${ids.get(name.split(' ')[0])}>` : `\`/${name}\``);

          const name = i.options.getString('command')?.trim().toLowerCase().replace(/^\//, '').split(' ')[0];
          if (name) {
            const cmd = all.find((c) => c.name === name && canUse(c.default_member_permissions, i.memberPermissions));
            if (!cmd) return i.reply({ content: `There’s no /${name}. Pick a command from the list, or use ${commandMention(i.guildId, 'help')} on its own to see them all.`, flags: MessageFlags.Ephemeral });
            const subs = (cmd.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
            const lines = subs.length
              ? subs.map((s) => `${mention(`${cmd.name} ${s.name}`)}\n${s.description}`)
              : [`${mention(cmd.name)}\n${cmd.description}`, ...(cmd.options ?? []).map((o) => `• **${o.name}**: ${o.description}`)];
            return i.reply({
              embeds: [new EmbedBuilder().setTitle(`/${cmd.name}`).setDescription(`${cmd.description}\n\n${lines.join('\n\n')}`).setColor(0x5865f2)],
              flags: MessageFlags.Ephemeral,
            });
          }

          const embed = new EmbedBuilder()
            .setTitle('🧹 Slopkeeper')
            .setColor(0x5865f2)
            .setDescription(`Give ${commandMention(i.guildId, 'help')} a command for its details, or read the [full guide](${GUIDE}).`);
          for (const section of sections) {
            const lines = section.commands
              .filter((c) => canUse(c.default_member_permissions, i.memberPermissions))
              .map((c) => {
                const subs = (c.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand).map((s) => s.name);
                return `**/${c.name}**: ${c.description}${subs.length ? `\n-# ${subs.join(' · ')}` : ''}`;
              });
            if (lines.length) embed.addFields({ name: section.title, value: lines.join('\n').slice(0, 1024) });
          }
          return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        },
      },
    ],
  };
}
