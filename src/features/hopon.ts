import { Events, MessageFlags, SlashCommandBuilder, type Client, type VoiceState } from 'discord.js';
import { config } from '../config.ts';
import { guildSettings, isAllowed } from '../settings.ts';
import type { Feature } from '../types.ts';
import { announceChannel, humansIn, listNames, playingGames } from '../util.ts';

/** Server id → when it was last pinged */
const lastPingAt = new Map<string, number>();

async function onVoiceState(client: Client<true>, oldState: VoiceState, newState: VoiceState) {
  const channel = newState.channel;
  const guildId = newState.guild.id;
  if (!isAllowed(guildId) || newState.member?.user.bot) return;
  if (!channel || channel.id === oldState.channelId || channel.id === newState.guild.afkChannelId) return;

  // Joins add one person at a time, so this fires exactly once as the channel crosses the threshold
  const humans = humansIn(channel);
  if (humans.length !== config.hopOnMinPeople) return;
  if (Date.now() - (lastPingAt.get(guildId) ?? 0) < config.hopOnCooldownMin * 60_000) return;
  const out = await announceChannel(client, guildId);
  if (!out) return;
  lastPingAt.set(guildId, Date.now());

  const games = [...new Set(humans.flatMap(playingGames))];
  let text = `🎮 ${listNames(humans.map((m) => `**${m.displayName}**`))} are in ${channel}`;
  if (games.length) text += `, playing ${listNames(games.map((g) => `**${g}**`))}`;
  text += '. Hop on!';
  const roleId = guildSettings(guildId).hopOnRoleId;
  if (roleId) text = `<@&${roleId}> ${text}`;
  await out.send({ content: text, allowedMentions: { roles: roleId ? [roleId] : [] } });
}

export const hopOn: Feature = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('notify').setDescription('Toggle getting pinged when people hop in voice'),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const roleId = guildSettings(i.guildId).hopOnRoleId;
        if (!roleId) {
          return i.reply({ content: 'This server has no hop-on role. A server admin can set one with `/setup hopon-role`.', flags: MessageFlags.Ephemeral });
        }
        if (i.member.roles.cache.has(roleId)) {
          await i.member.roles.remove(roleId);
          return i.reply({ content: '🔕 You will no longer be pinged when people hop on.', flags: MessageFlags.Ephemeral });
        }
        await i.member.roles.add(roleId);
        return i.reply({ content: '🔔 You will be pinged when people hop on.', flags: MessageFlags.Ephemeral });
      },
    },
  ],
  setup(client) {
    client.on(Events.VoiceStateUpdate, (o, n) => void onVoiceState(client, o, n).catch(console.error));
  },
};
