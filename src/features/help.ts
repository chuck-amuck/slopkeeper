import { ApplicationCommandOptionType, EmbedBuilder, MessageFlags, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import type { Feature } from '../types.ts';

const GUIDE = 'https://github.com/chuck-amuck/slopkeeper#readme';

/** /help, built from the other features' commands so it never goes stale */
export function help(features: Feature[]): Feature {
  const sections = features
    .filter((f) => f.title && f.commands?.length)
    .map((f) => ({ title: f.title!, commands: f.commands!.map((c) => c.data.toJSON()) }));
  const all = sections.flatMap((s) => s.commands);

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
              .addChoices(...all.map((c) => ({ name: `/${c.name}`, value: c.name }))),
          ),
        async run(i) {
          const ids = new Map(i.guild?.commands.cache.map((c) => [c.name, c.id]) ?? []);
          // Commands someone can't use (like /setup without Manage Server) are left out, as Discord hides them too
          const canUse = (perms: string | null | undefined) => !perms || !i.memberPermissions || i.memberPermissions.has(new PermissionsBitField(BigInt(perms)));
          // A clickable mention when the command's id is known
          const mention = (name: string) => (ids.has(name.split(' ')[0]) ? `</${name}:${ids.get(name.split(' ')[0])}>` : `\`/${name}\``);

          const name = i.options.getString('command');
          if (name) {
            const cmd = all.find((c) => c.name === name)!;
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
            .setDescription(`Pick a command with \`/help command\` for details, or read the [full guide](${GUIDE}).`);
          for (const section of sections) {
            const lines = section.commands
              .filter((c) => canUse(c.default_member_permissions))
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
