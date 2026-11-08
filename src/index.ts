import { Events, MessageFlags, type Guild, type Interaction } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { webApi } from './api.ts';
import { backups } from './backup.ts';
import { client } from './client.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { freeGames } from './features/freegames.ts';
import { gameNights } from './features/gamenight.ts';
import { gamePings } from './features/gameroles.ts';
import { games } from './features/games.ts';
import { gameStats } from './features/gamestats.ts';
import { achievements } from './features/achievements.ts';
import { gameVotes } from './features/gamevote.ts';
import { help } from './features/help.ts';
import { hopOn } from './features/hopon.ts';
import { music } from './features/music.ts';
import { patchNotes } from './features/patchnotes.ts';
import { recap } from './features/recap.ts';
import { sales } from './features/sales.ts';
import { sessions } from './features/sessions.ts';
import { setup } from './features/setup.ts';
import { speak } from './features/say.ts';
import { soundboard } from './features/soundboard.ts';
import { steam } from './features/steam.ts';
import { idSetting, isAllowed } from './settings.ts';
import type { Feature } from './types.ts';
import { servedGuilds } from './util.ts';

// In /help order
const features: Feature[] = [hopOn, gamePings, gameNights, sessions, gameStats, recap, games, gameVotes, steam, achievements, patchNotes, freeGames, sales, soundboard, music, setup, backups, webApi, speak];
features.unshift(help(features));
const commands = new Map(features.flatMap((f) => f.commands ?? []).map((c) => [c.data.name, c]));

/** Registers the commands in a server, or leaves it if it isn't allowed */
async function join(guild: Guild, isNew: boolean) {
  if (!isAllowed(guild.id)) {
    console.log(`Leaving ${guild.name} (${guild.id}): not in ALLOWED_GUILD_IDS`);
    return guild.leave();
  }
  await guild.members.fetch();
  // Guild-scoped commands update instantly, unlike global ones
  await guild.commands.set([...commands.values()].map((cmd) => cmd.data.toJSON()));
  console.log(`${commands.size} commands registered in ${guild.name} (${guild.id})`);
  if (idSetting(guild.id, 'announceChannel')) return;
  console.log(`${guild.name} has no announce channel yet; a server admin needs to run /setup announce-channel`);
  // Nothing gets announced until an admin picks a channel, so tell a newly joined server where it'll see it
  if (isNew) {
    await guild.systemChannel
      ?.send('👋 Slopkeeper is here. A server admin needs to run `/setup announce-channel` to finish setting up, and then `/setup show` lists everything else. `/help` shows what the bot does.')
      .catch(() => {});
  }
}

client.once(Events.ClientReady, async (c) => {
  for (const guild of c.guilds.cache.values()) await join(guild, false).catch(console.error);
  for (const feature of features) await feature.setup?.(c);
  const count = servedGuilds(c).length;
  console.log(`Logged in as ${c.user.tag} in ${count} server${count === 1 ? '' : 's'}`);
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`Added to ${guild.name} (${guild.id})`);
  void join(guild, true).catch(console.error);
});

client.on(Events.GuildDelete, (guild) => console.log(`No longer in ${guild.name} (${guild.id})`));

/** Who did what where, for the log */
function describe(i: Interaction): string {
  const where = i.guild ? `${i.guild.name} (${i.guildId})` : (i.guildId ?? 'a DM');
  let what = 'Interaction';
  if (i.isChatInputCommand() || i.isAutocomplete()) {
    what = [`/${i.commandName}`, i.options.getSubcommand(false)].filter(Boolean).join(' ');
    if (i.isAutocomplete()) what += ' autocomplete';
  } else if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) what = `Component ${i.customId}`;
  return `${what} by ${i.user.tag} in ${where}`;
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await commands.get(i.commandName)?.run(i);
    else if (i.isAutocomplete()) await commands.get(i.commandName)?.autocomplete?.(i);
    else if (i.isButton() || i.isStringSelectMenu()) {
      const feature = features.find((f) => f.componentPrefix === i.customId.split(':')[0]);
      await (i.isButton() ? feature?.onButton?.(i) : feature?.onSelect?.(i));
    } else if (i.isModalSubmit()) await features.find((f) => f.componentPrefix === i.customId.split(':')[0])?.onModal?.(i);
  } catch (err) {
    console.error(`${describe(i)} failed:`, err);
    if (!i.isRepliable()) return;
    const msg = { content: 'Something broke. Check the bot logs.', flags: MessageFlags.Ephemeral } as const;
    await (i.replied || i.deferred ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const feature of features) feature.shutdown?.();
    // Leaving voice is queued on the gateway connection, so it needs a moment before that closes
    await sleep(250);
    await client.destroy();
    db.close();
    process.exit(0);
  });
}

await client.login(config.token);
