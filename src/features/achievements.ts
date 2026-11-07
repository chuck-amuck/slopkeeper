import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type AutocompleteInteraction, type Guild } from 'discord.js';
import { config } from '../config.ts';
import type { Feature } from '../types.ts';
import { humansIn, listNames } from '../util.ts';
import { allGames, memberGames } from './games.ts';
import { achievementList, achievementRarity, linkFor, unlockedBy } from './steam.ts';

const GOALS = 5;

/** How a group is getting on with a game's achievements, and what nobody has yet, easiest first */
export async function achievementProgress(appid: number, userIds: string[]) {
  const [list, rarity] = await Promise.all([achievementList(appid), achievementRarity(appid)]);
  const unlocked = await Promise.all(userIds.map(async (id) => [id, await (linkFor(id) ? unlockedBy(linkFor(id)!.steam_id, appid) : null)] as const));
  const readable = unlocked.filter((entry): entry is readonly [string, Set<string>] => entry[1] !== null);
  const people = readable.map(([id, done]) => ({ id, done: list.filter((a) => done.has(a.name)).length }));
  // Hidden ones are often spoilers, so they count but aren't named
  const left = list.filter((a) => !a.hidden && !readable.some(([, done]) => done.has(a.name)));
  const goals = readable.length ? left.map((a) => ({ name: a.displayName, description: a.description ?? null, percent: rarity.get(a.name) ?? null })).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0)) : [];
  return { total: list.length, people, skipped: unlocked.filter(([, done]) => done === null).map(([id]) => id), goals: goals.slice(0, GOALS) };
}

/** Games with a Steam ID that people here have */
function steamGames(guild: Guild) {
  const library = allGames(guild.id).flatMap((g) => (g.steam_appid === null ? [] : [{ name: g.name, appid: g.steam_appid }]));
  return [...library, ...memberGames(guild).map((g) => ({ name: g.name, appid: g.appid }))];
}

function autocomplete(i: AutocompleteInteraction) {
  if (!i.inCachedGuild()) return i.respond([]);
  const typed = i.options.getFocused().toLowerCase();
  return i.respond(steamGames(i.guild).filter((g) => g.name.toLowerCase().includes(typed)).slice(0, 25).map((g) => ({ name: g.name.slice(0, 100), value: String(g.appid) })));
}

export const achievements: Feature = {
  title: 'Achievements',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('achievements')
        .setDescription('Compare Steam achievements for a game, and find goals nobody has yet')
        .addStringOption((o) => o.setName('game').setDescription('Game').setRequired(true).setAutocomplete(true))
        .addUserOption((o) => o.setName('with').setDescription('Compare with this person (default: everyone in your voice channel)')),
      autocomplete,
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        if (!config.steamApiKey) return i.reply({ content: 'Steam is not configured (STEAM_API_KEY).', flags: MessageFlags.Ephemeral });
        const typed = i.options.getString('game', true);
        const game = steamGames(i.guild).find((g) => String(g.appid) === typed || g.name.toLowerCase() === typed.toLowerCase());
        if (!game) return i.reply({ content: 'Pick a game from the list.', flags: MessageFlags.Ephemeral });
        const other = i.options.getUser('with');
        if (other?.bot) return i.reply({ content: 'Bots don’t have achievements.', flags: MessageFlags.Ephemeral });
        const voice = i.member.voice.channel;
        const people = other ? [...new Set([i.user.id, other.id])] : voice ? humansIn(voice).map((m) => m.id) : [i.user.id];
        await i.deferReply();
        const { total, people: done, skipped, goals } = await achievementProgress(game.appid, people);
        if (!total) return i.editReply(`**${game.name}** has no Steam achievements.`);
        const embed = new EmbedBuilder().setTitle(`🏆 ${game.name} · ${total} achievements`).setColor(0xfee75c);
        const lines = done.toSorted((a, b) => b.done - a.done).map((p) => `<@${p.id}> · ${p.done} of ${total}`);
        if (skipped.length) lines.push(`Can’t see: ${listNames(skipped.map((id) => `<@${id}>`))}. They need Steam linked, public game details and the game.`);
        embed.setDescription(lines.join('\n'));
        if (goals.length) {
          const value = goals.map((g) => `**${g.name}**${g.percent === null ? '' : ` · ${g.percent}% of players`}${g.description ? `\n${g.description}` : ''}`).join('\n').slice(0, 1024);
          embed.addFields({ name: done.length > 1 ? 'Goals: nobody here has these' : 'Next goals', value });
        }
        return i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      },
    },
  ],
};
