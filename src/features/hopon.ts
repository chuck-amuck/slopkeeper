import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  Events,
  MessageFlags,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
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
  await out.send({ content: text, allowedMentions: { roles }, components: [buttons(channel)] });
  const doing = games.length ? `playing ${listNames(games)}` : 'in voice';
  void announceAloud(channel, `${listNames(humans.map((m) => m.displayName))} ${humans.length === 1 ? 'is' : 'are'} ${doing}, hop on`, 'ttsHopOn').catch(console.error);
}

/** A link straight into the channel, and a way to say you're coming */
function buttons(channel: VoiceBasedChannel) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${channel.guild.id}/${channel.id}`).setLabel(`Join ${channel.name}`.slice(0, 80)),
    new ButtonBuilder().setCustomId(`hop:omw:${channel.id}`).setStyle(ButtonStyle.Secondary).setEmoji('🏃').setLabel('On my way'),
  );
}

const ON_THE_WAY = '-# 🏃 On the way: ';

/** Adds or takes off someone's name on the post's "On the way" line, which is kept in the post itself so it survives restarts */
export function onTheWay(content: string, userId: string): string {
  const lines = content.split('\n');
  const at = lines.findIndex((line) => line.startsWith(ON_THE_WAY));
  const ids = at < 0 ? [] : [...lines[at].matchAll(/<@(\d+)>/g)].map((m) => m[1]);
  const now = ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId];
  const line = now.length ? `${ON_THE_WAY}${now.map((id) => `<@${id}>`).join(', ')}` : null;
  if (at < 0) return line ? [...lines, line].join('\n') : content;
  return (line ? lines.with(at, line) : lines.toSpliced(at, 1)).join('\n');
}

async function onButton(i: ButtonInteraction) {
  if (!i.inCachedGuild()) return;
  const [, action, channelId] = i.customId.split(':');
  if (action !== 'omw') return;
  if (i.member.voice.channelId === channelId) return i.reply({ content: `You’re already in <#${channelId}>.`, flags: MessageFlags.Ephemeral });
  // Editing doesn't ping anyone again
  return i.update({ content: onTheWay(i.message.content, i.user.id), allowedMentions: { parse: [] } });
}

export const hopOn: Feature = {
  title: 'Hop-on pings',
  componentPrefix: 'hop',
  onButton,
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
