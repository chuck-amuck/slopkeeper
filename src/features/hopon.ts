import { DiscordAPIError, Events, MessageFlags, RESTJSONErrorCodes, SlashCommandBuilder, type Client, type VoiceState } from 'discord.js';
import { idSetting, isAllowed, setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { gameName } from '../gameNames.ts';
import { announceChannel, humansIn, listNames, playingGames } from '../util.ts';
import { rolesForGames } from './gameroles.ts';
import { announceAloud } from './say.ts';
import { checkSteamStatusOf } from './steam.ts';
import { commandMention } from '../commandIds.ts';
import { getKv, setKv } from '../db.ts';

/** When a server was last pinged, kept in the database so a restart doesn't ping again */
const lastPingAt = (guildId: string) => Number(getKv(`hopOnPingAt:${guildId}`) ?? 0);

async function onVoiceState(client: Client<true>, oldState: VoiceState, newState: VoiceState) {
  const channel = newState.channel;
  const guildId = newState.guild.id;
  if (!isAllowed(guildId) || newState.member?.user.bot) return;
  if (!channel || channel.id === oldState.channelId || channel.id === newState.guild.afkChannelId) return;

  // Joins add one person at a time, so this fires exactly once as the channel crosses the threshold
  const humans = humansIn(channel);
  if (humans.length !== setting(guildId, 'hopOnMinPeople')) return;
  if (Date.now() - lastPingAt(guildId) < setting(guildId, 'hopOnCooldownMin') * 60_000) return;
  const out = await announceChannel(client, guildId);
  if (!out) return;
  setKv(`hopOnPingAt:${guildId}`, String(Date.now()));

  await checkSteamStatusOf(guildId, humans.map((m) => m.id));
  const games = [...new Set(humans.flatMap(playingGames).map((game) => gameName(guildId, game)))];
  let text = `🎮 ${listNames(humans.map((m) => `**${m.displayName}**`))} are in ${channel}`;
  if (games.length) text += `, playing ${listNames(games.map((g) => `**${g}**`))}`;
  text += '. Hop on!';
  // The hop-on role plus the ping role of each game being played
  const hopOnRole = idSetting(guildId, 'hopOnRole');
  const roles = [...new Set([...(hopOnRole ? [hopOnRole] : []), ...rolesForGames(guildId, games)])];
  if (roles.length) text = `${roles.map((id) => `<@&${id}>`).join(' ')} ${text}`;
  await out.send({ content: text, allowedMentions: { roles } });
  const doing = games.length ? `playing ${listNames(games)}` : 'in voice';
  void announceAloud(channel, `${listNames(humans.map((m) => m.displayName))} ${humans.length === 1 ? 'is' : 'are'} ${doing}, hop on`, 'ttsHopOn').catch(console.error);
}

export const hopOn: Feature = {
  title: 'Hop-on pings',
  commands: [
    {
      data: new SlashCommandBuilder().setName('notify').setDescription('Toggle getting pinged when people hop in voice'),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        const roleId = idSetting(i.guildId, 'hopOnRole');
        if (!roleId) {
          return i.reply({ content: `This server has no hop-on role. A server admin can set one with ${commandMention(i.guildId, 'setup hopon-role')}.`, flags: MessageFlags.Ephemeral });
        }
        // Changing roles can take longer than the 3 s Discord waits for an answer when it's busy
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const more = `-# More pings, like for each game: ${commandMention(i.guildId, 'pings')}`;
        try {
          if (i.member.roles.cache.has(roleId)) {
            await i.member.roles.remove(roleId);
            return await i.editReply(`🔕 You will no longer be pinged when people hop on.\n${more}`);
          }
          await i.member.roles.add(roleId);
          return await i.editReply(`🔔 You will be pinged when people hop on.\n${more}`);
        } catch (err) {
          if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.MissingPermissions)) throw err;
          return i.editReply(`I couldn’t change your roles. My role needs **Manage Roles** and has to be above <@&${roleId}>.`);
        }
      },
    },
  ],
  setup(client) {
    client.on(Events.VoiceStateUpdate, (o, n) => void onVoiceState(client, o, n).catch(console.error));
  },
};
