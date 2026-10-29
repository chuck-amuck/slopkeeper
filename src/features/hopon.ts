import { Events, MessageFlags, SlashCommandBuilder, type Client, type VoiceState } from 'discord.js';
import { config } from '../config.ts';
import type { Feature } from '../types.ts';
import { announceChannel, humansIn, listNames, playingGames } from '../util.ts';

let lastPingAt = 0;

async function onVoiceState(client: Client<true>, oldState: VoiceState, newState: VoiceState) {
  const channel = newState.channel;
  if (newState.guild.id !== config.guildId || newState.member?.user.bot) return;
  if (!channel || channel.id === oldState.channelId || channel.id === newState.guild.afkChannelId) return;

  // Joins add one person at a time, so this fires exactly once as the channel crosses the threshold
  const humans = humansIn(channel);
  if (humans.length !== config.hopOnMinPeople) return;
  if (Date.now() - lastPingAt < config.hopOnCooldownMin * 60_000) return;
  lastPingAt = Date.now();

  const games = [...new Set(humans.flatMap(playingGames))];
  let text = `🎮 ${listNames(humans.map((m) => `**${m.displayName}**`))} are in ${channel}`;
  if (games.length) text += `, playing ${listNames(games.map((g) => `**${g}**`))}`;
  text += '. Hop on!';
  if (config.hopOnRoleId) text = `<@&${config.hopOnRoleId}> ${text}`;

  const out = await announceChannel(client);
  await out.send({ content: text, allowedMentions: { roles: config.hopOnRoleId ? [config.hopOnRoleId] : [] } });
}

export const hopOn: Feature = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('notify').setDescription('Toggle getting pinged when people hop in voice'),
      async run(i) {
        const roleId = config.hopOnRoleId;
        if (!roleId || !i.inCachedGuild()) {
          return i.reply({ content: 'Hop-on role is not configured (HOPON_ROLE_ID).', flags: MessageFlags.Ephemeral });
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
