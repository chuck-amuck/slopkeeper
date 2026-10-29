import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type GuildMember,
} from 'discord.js';
import { db } from '../db.ts';
import { isAllowed } from '../settings.ts';
import type { Feature } from '../types.ts';
import { listNames } from '../util.ts';
import { allGames } from './games.ts';

interface GameRole {
  role_id: string;
  name: string;
  created: number;
}

function gameRoles(guildId: string): GameRole[] {
  return db.prepare('SELECT role_id, name, created FROM game_roles WHERE guild_id = ? ORDER BY name').all(guildId) as unknown as GameRole[];
}

/** Ping roles for the games named, matched without caring about case */
export function rolesForGames(guildId: string, games: string[]): string[] {
  const find = db.prepare('SELECT role_id FROM game_roles WHERE guild_id = ? AND name = ?');
  return games.flatMap((game) => (find.get(guildId, game) as { role_id: string } | undefined)?.role_id ?? []);
}

/** Up to five select menus of 25 games each, with the member's current pings ticked */
function pickers(member: GuildMember) {
  const roles = gameRoles(member.guild.id).filter((r) => member.guild.roles.cache.has(r.role_id));
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let n = 0; n * 25 < roles.length && n < 5; n++) {
    const chunk = roles.slice(n * 25, n * 25 + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gr:pick:${n}`)
      .setPlaceholder(roles.length > 25 ? `Games ${n * 25 + 1}–${n * 25 + chunk.length}` : 'Games you want pings for')
      .setMinValues(0)
      .setMaxValues(chunk.length)
      .addOptions(chunk.map((r) => ({ label: r.name.slice(0, 100), value: r.role_id, default: member.roles.cache.has(r.role_id) })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  return rows;
}

function pingSummary(member: GuildMember): string {
  const mine = gameRoles(member.guild.id).filter((r) => member.roles.cache.has(r.role_id));
  return mine.length ? `🔔 You get pings for ${listNames(mine.map((r) => `**${r.name}**`))}.` : '🔕 You don’t get any game pings.';
}

function pickerReply(member: GuildMember) {
  const components = pickers(member);
  if (!components.length) return { content: 'This server has no game pings yet. A server admin can add some with `/gamerole add`.' };
  return { content: `${pingSummary(member)}\nPick the games you want to be pinged for:`, components };
}

export const gamePings: Feature = {
  title: 'Game pings',
  componentPrefix: 'gr',
  commands: [
    {
      data: new SlashCommandBuilder().setName('pings').setDescription('Choose which games you get pinged for'),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        return i.reply({ ...pickerReply(i.member), flags: MessageFlags.Ephemeral });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('gamerole')
        .setDescription('Set up per-game ping roles')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Make a ping role for a game (hop-on pings and game nights for it mention the role)')
            .addStringOption((o) => o.setName('game').setDescription('Game name, as Discord shows it when people play').setRequired(true).setAutocomplete(true))
            .addRoleOption((o) => o.setName('role').setDescription('Use an existing role instead of making one')),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Stop offering pings for a game (deletes the role if the bot made it)')
            .addStringOption((o) => o.setName('game').setDescription('Game').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('menu').setDescription('Post a button here that lets anyone pick their game pings')),
      async autocomplete(i) {
        if (!i.inGuild()) return i.respond([]);
        const query = i.options.getFocused().toLowerCase();
        const names =
          i.options.getSubcommand() === 'remove'
            ? gameRoles(i.guildId).map((r) => r.name)
            : [
                ...new Set([
                  ...allGames(i.guildId).map((g) => g.name),
                  ...(db.prepare('SELECT DISTINCT game FROM game_plays WHERE guild_id = ?').all(i.guildId) as { game: string }[]).map((r) => r.game),
                ]),
              ].sort();
        return i.respond(
          names
            .filter((n) => n.toLowerCase().includes(query))
            .slice(0, 25)
            .map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })),
        );
      },
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const sub = i.options.getSubcommand();

        if (sub === 'menu') {
          await i.channel?.send({
            content: '🔔 **Game pings.** Pick the games you want to be pinged for when people play them or plan a game night.',
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('gr:open').setLabel('Choose games').setEmoji('🎮').setStyle(ButtonStyle.Primary),
              ),
            ],
          });
          return i.reply({ content: 'Posted.', flags: MessageFlags.Ephemeral });
        }

        const game = i.options.getString('game', true).trim();
        if (sub === 'remove') {
          const row = db.prepare('SELECT role_id, name, created FROM game_roles WHERE guild_id = ? AND name = ?').get(i.guildId, game) as GameRole | undefined;
          if (!row) return i.reply({ content: `**${game}** has no ping role.`, flags: MessageFlags.Ephemeral });
          db.prepare('DELETE FROM game_roles WHERE role_id = ?').run(row.role_id);
          if (row.created) await i.guild.roles.delete(row.role_id, `/gamerole remove by ${i.user.tag}`).catch(() => {});
          return i.reply({ content: `🗑️ Removed pings for **${row.name}**.`, flags: MessageFlags.Ephemeral });
        }

        const me = i.guild.members.me!;
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          return i.reply({ content: 'My role needs the **Manage Roles** permission to hand out game roles.', flags: MessageFlags.Ephemeral });
        }
        const existing = db.prepare('SELECT role_id FROM game_roles WHERE guild_id = ? AND name = ?').get(i.guildId, game) as { role_id: string } | undefined;
        if (existing) return i.reply({ content: `**${game}** already pings <@&${existing.role_id}>.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

        let role = i.options.getRole('role');
        if (role && (role.id === i.guildId || role.managed || role.position >= me.roles.highest.position)) {
          return i.reply({
            content: `I can’t hand out ${role}. Pick a normal role below my role (**${me.roles.highest.name}**), or leave the role out and I’ll make one.`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        }
        const created = !role;
        role ??= await i.guild.roles.create({ name: game.slice(0, 100), mentionable: true, reason: `/gamerole add by ${i.user.tag}` });
        db.prepare('INSERT INTO game_roles (role_id, guild_id, name, created) VALUES (?, ?, ?, ?)').run(role.id, i.guildId, game, created ? 1 : 0);
        return i.reply({
          content: `✅ ${created ? 'Made' : 'Using'} ${role} for **${game}**. People pick it with \`/pings\`.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      },
    },
  ],
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    return i.reply({ ...pickerReply(i.member), flags: MessageFlags.Ephemeral });
  },
  async onSelect(i) {
    if (!i.inCachedGuild()) return;
    // Each menu only covers its own games, so only those are added or removed
    const offered = i.component.options.map((o) => o.value);
    const chosen = new Set(i.values);
    const add = offered.filter((id) => chosen.has(id) && !i.member.roles.cache.has(id));
    const remove = offered.filter((id) => !chosen.has(id) && i.member.roles.cache.has(id));
    try {
      if (add.length) await i.member.roles.add(add, 'Picked with /pings');
      if (remove.length) await i.member.roles.remove(remove, 'Picked with /pings');
    } catch {
      return i.update({ content: 'I couldn’t change your roles. A server admin needs to move my role above the game roles.', components: [] });
    }
    return i.update(pickerReply(i.member));
  },
  setup(client) {
    client.on(Events.GuildRoleDelete, (role) => {
      if (isAllowed(role.guild.id)) db.prepare('DELETE FROM game_roles WHERE role_id = ?').run(role.id);
    });
  },
};
