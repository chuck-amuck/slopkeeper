import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.ts';
import { db } from './db.ts';
import { games } from './features/games.ts';
import { hopOn } from './features/hopon.ts';
import { sales } from './features/sales.ts';
import { sessions } from './features/sessions.ts';
import { soundboard } from './features/soundboard.ts';
import { steam } from './features/steam.ts';
import type { Feature } from './types.ts';

const features: Feature[] = [hopOn, sessions, steam, games, sales, soundboard];
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

client.once(Events.ClientReady, async (c) => {
  const guild = await c.guilds.fetch(config.guildId);
  await guild.members.fetch();
  // Guild-scoped commands update instantly, unlike global ones
  await guild.commands.set([...commands.values()].map((cmd) => cmd.data.toJSON()));
  for (const feature of features) await feature.setup?.(c);
  console.log(`Logged in as ${c.user.tag}, ${commands.size} commands registered in ${guild.name}`);
});

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
