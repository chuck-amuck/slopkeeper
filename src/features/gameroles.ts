import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';
import { db } from '../db.ts';
import { gameKey, gameName } from '../gameNames.ts';
import { idSetting, isAllowed } from '../settings.ts';
import type { Feature } from '../types.ts';
import { listNames, pingWarning } from '../util.ts';
import { allGames } from './games.ts';

interface GameRole {
  role_id: string;
  name: string;
  created: number;
}

export function gameRoles(guildId: string): GameRole[] {
  return db.prepare('SELECT role_id, name, created FROM game_roles WHERE guild_id = ? ORDER BY name').all(guildId) as unknown as GameRole[];
}

/** What a ping role can be for: the library, plus anything people have played */
export function pingableGames(guildId: string): string[] {
  return [
    ...new Set([
      ...allGames(guildId).map((g) => g.name),
      ...(db.prepare('SELECT DISTINCT game FROM named_plays WHERE guild_id = ?').all(guildId) as { game: string }[]).map((r) => r.game),
    ]),
  ].sort();
}

/** Normal roles below the bot's own: the only ones it can give to people */
export function canHandOut(guild: Guild, role: Role): boolean {
  return role.id !== guild.id && !role.managed && role.position < guild.members.me!.roles.highest.position;
}

/** Makes a role for a game, or uses `role` if given. Returns why it can't, in place of the role */
export async function addGameRole(guild: Guild, game: string, role: Role | null, by: string): Promise<{ role: Role; created: boolean } | string> {
  const me = guild.members.me!;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'My role needs the **Manage Roles** permission to hand out game roles.';
  const existing = db.prepare('SELECT role_id FROM game_roles WHERE guild_id = ? AND name = ?').get(guild.id, game) as { role_id: string } | undefined;
  if (existing) return `**${game}** already pings <@&${existing.role_id}>.`;
  if (role && !canHandOut(guild, role)) return `I can’t hand out ${role}. Pick a normal role below my role (**${me.roles.highest.name}**), or leave the role out and I’ll make one.`;
  const taken = role && gameRoles(guild.id).find((r) => r.role_id === role.id);
  if (taken) return `${role} already pings for **${taken.name}**.`;
  const made = role ?? (await guild.roles.create({ name: game.slice(0, 100), mentionable: true, reason: `/gamerole add by ${by}` }));
  db.prepare('INSERT INTO game_roles (role_id, guild_id, name, created) VALUES (?, ?, ?, ?)').run(made.id, guild.id, game, role ? 0 : 1);
  return { role: made, created: !role };
}

/** Stops offering pings for a game, and deletes the role if the bot made it */
export async function removeGameRole(guild: Guild, row: GameRole, by: string) {
  db.prepare('DELETE FROM game_roles WHERE role_id = ?').run(row.role_id);
  if (row.created) await guild.roles.delete(row.role_id, `/gamerole remove by ${by}`).catch(() => {});
}

/** Ping roles for the games named, matched by the name each game goes by, however either is spelled */
export function rolesForGames(guildId: string, games: string[]): string[] {
  const keyOf = (name: string) => gameKey(gameName(guildId, name));
  const wanted = new Set(games.map(keyOf));
  return gameRoles(guildId)
    .filter((r) => wanted.has(keyOf(r.name)))
    .map((r) => r.role_id);
}

/** The message with the Choose games button, which anyone can use */
export const pingMenu = () => ({
  content: '🔔 **Game pings.** Pick the games you want to be pinged for when people play them or plan a game night.',
  components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('gr:open').setLabel('Choose games').setEmoji('🎮').setStyle(ButtonStyle.Primary))],
});

/** The roles people can opt in to or out of: the hop-on role, and each game's */
export function pingChoices(guild: Guild) {
  const hopOn = idSetting(guild.id, 'hopOnRole');
  const games = gameRoles(guild.id).filter((r) => r.role_id !== hopOn).map((r) => ({ id: r.role_id, label: r.name }));
  return [...(hopOn ? [{ id: hopOn, label: 'Hop-on pings' }] : []), ...games].filter((r) => guild.roles.cache.has(r.id));
}

const heldBy = (member: GuildMember) => new Set(member.roles.cache.keys());

/** Up to five select menus of 25 games each, with the roles in `held` ticked */
function pickers(guild: Guild, held: Set<string>) {
  const roles = gameRoles(guild.id).filter((r) => guild.roles.cache.has(r.role_id));
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let n = 0; n * 25 < roles.length && n < 5; n++) {
    const chunk = roles.slice(n * 25, n * 25 + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gr:pick:${n}`)
      .setPlaceholder(roles.length > 25 ? `Games ${n * 25 + 1}–${n * 25 + chunk.length}` : 'Games you want pings for')
      .setMinValues(0)
      .setMaxValues(chunk.length)
      .addOptions(chunk.map((r) => ({ label: r.name.slice(0, 100), value: r.role_id, default: held.has(r.role_id) })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  return rows;
}

function pingSummary(guild: Guild, held: Set<string>): string {
  const mine = gameRoles(guild.id).filter((r) => held.has(r.role_id));
  return mine.length ? `🔔 You get pings for ${listNames(mine.map((r) => `**${r.name}**`))}.` : '🔕 You don’t get any game pings.';
}

function pickerReply(guild: Guild, held: Set<string>) {
  const components = pickers(guild, held);
  if (!components.length) return { content: 'This server has no game pings yet. A server admin can add some with `/gamerole add`.' };
  return { content: `${pingSummary(guild, held)}\nPick the games you want to be pinged for:`, components };
}

export const gamePings: Feature = {
  title: 'Game pings',
  componentPrefix: 'gr',
  commands: [
    {
      data: new SlashCommandBuilder().setName('pings').setDescription('Choose which games you get pinged for'),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        return i.reply({ ...pickerReply(i.guild, heldBy(i.member)), flags: MessageFlags.Ephemeral });
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
        const names = i.options.getSubcommand() === 'remove' ? gameRoles(i.guildId).map((r) => r.name) : pingableGames(i.guildId);
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
          await i.channel?.send(pingMenu());
          return i.reply({ content: 'Posted.', flags: MessageFlags.Ephemeral });
        }

        const game = i.options.getString('game', true).trim();
        if (sub === 'remove') {
          const row = db.prepare('SELECT role_id, name, created FROM game_roles WHERE guild_id = ? AND name = ?').get(i.guildId, game) as GameRole | undefined;
          if (!row) return i.reply({ content: `**${game}** has no ping role.`, flags: MessageFlags.Ephemeral });
          await removeGameRole(i.guild, row, i.user.tag);
          return i.reply({ content: `🗑️ Removed pings for **${row.name}**.`, flags: MessageFlags.Ephemeral });
        }

        const result = await addGameRole(i.guild, game, i.options.getRole('role'), i.user.tag);
        if (typeof result === 'string') return i.reply({ content: result, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return i.reply({
          content: `✅ ${result.created ? 'Made' : 'Using'} ${result.role} for **${game}**. People pick it with \`/pings\`.${pingWarning(result.role)}`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      },
    },
  ],
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    return i.reply({ ...pickerReply(i.guild, heldBy(i.member)), flags: MessageFlags.Ephemeral });
  },
  async onSelect(i) {
    if (!i.inCachedGuild()) return;
    await i.deferUpdate();
    // The cached member lags behind role changes, so a quick second pick would otherwise work from old roles
    const member = await i.guild.members.fetch({ user: i.user.id, force: true });
    // Each menu only covers its own games, so only those are added or removed
    const offered = i.component.options.map((o) => o.value);
    const chosen = new Set(i.values);
    const held = heldBy(member);
    const add = offered.filter((id) => chosen.has(id) && !held.has(id));
    const remove = offered.filter((id) => !chosen.has(id) && held.has(id));
    try {
      // One role at a time: passing a list makes discord.js send the member's whole role list, built from that lagging cache
      for (const id of add) {
        await member.roles.add(id, 'Picked with /pings');
        held.add(id);
      }
      for (const id of remove) {
        await member.roles.remove(id, 'Picked with /pings');
        held.delete(id);
      }
    } catch {
      return i.editReply({ content: 'I couldn’t change your roles. My role needs **Manage Roles** and has to be above the game roles.', components: [] });
    }
    return i.editReply(pickerReply(i.guild, held));
  },
  setup(client) {
    client.on(Events.GuildRoleDelete, (role) => {
      if (isAllowed(role.guild.id)) db.prepare('DELETE FROM game_roles WHERE role_id = ?').run(role.id);
    });
  },
};
