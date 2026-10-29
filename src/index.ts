import { Client, Events, GatewayIntentBits, MessageFlags, type Guild } from 'discord.js';
import { config } from './config.ts';
import { db } from './db.ts';
import { games } from './features/games.ts';
import { hopOn } from './features/hopon.ts';
import { sales } from './features/sales.ts';
import { sessions } from './features/sessions.ts';
import { setup } from './features/setup.ts';
import { soundboard } from './features/soundboard.ts';
import { steam } from './features/steam.ts';
import { guildSettings, isAllowed } from './settings.ts';
import type { Feature } from './types.ts';
import { servedGuilds } from './util.ts';

const features: Feature[] = [setup, hopOn, sessions, steam, games, sales, soundboard];
const commands = new Map(features.flatMap((f) => f.commands ?? []).map((c) => [c.data.name, c]));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildExpressions, // soundboard sound create/delete events
    GatewayIntentBits.GuildMembers, // privileged: enable "Server Members Intent" in the developer portal
    GatewayIntentBits.GuildPresences, // privileged: enable "Presence Intent" (used to see what game people are playing)
  ],
});

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
  if (guildSettings(guild.id).announceChannelId) return;
  console.log(`${guild.name} has no announce channel yet; a server admin needs to run /setup announce-channel`);
  // Nothing gets announced until an admin picks a channel, so tell a newly joined server where it'll see it
  if (isNew) {
    await guild.systemChannel
      ?.send('👋 Slopkeeper is here. A server admin needs to run `/setup announce-channel` to finish setting up, and optionally `/setup hopon-role`.')
      .catch(() => {});
  }
}

client.once(Events.ClientReady, async (c) => {
  for (const guild of c.guilds.cache.values()) await join(guild, false).catch(console.error);
  for (const feature of features) await feature.setup?.(c);
  const count = servedGuilds(c).length;
  console.log(`Logged in as ${c.user.tag} in ${count} server${count === 1 ? '' : 's'}`);
});

client.on(Events.GuildCreate, (guild) => void join(guild, true).catch(console.error));

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await commands.get(i.commandName)?.run(i);
    else if (i.isAutocomplete()) await commands.get(i.commandName)?.autocomplete?.(i);
    else if (i.isButton()) {
      const prefix = i.customId.split(':')[0];
      await features.find((f) => f.buttonPrefix === prefix)?.onButton?.(i);
    }
  } catch (err) {
    console.error(err);
    if (!i.isRepliable()) return;
    const msg = { content: 'Something broke. Check the bot logs.', flags: MessageFlags.Ephemeral } as const;
    await (i.replied || i.deferred ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await client.destroy();
    db.close();
    process.exit(0);
  });
}

await client.login(config.token);
