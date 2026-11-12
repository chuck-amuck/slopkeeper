import { Events, MessageFlags, type Guild, type Interaction } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { client } from './client.ts';
import { commandMention, rememberCommands } from './commandIds.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { idSetting, isAllowed } from './settings.ts';
import { features, startOrder } from './features/all.ts';
import { servedGuilds } from './util.ts';

const commands = new Map(features.flatMap((f) => f.commands ?? []).map((c) => [c.data.name, c]));

/** Registers the commands in a server, or leaves it if it isn't allowed */
async function join(guild: Guild, isNew: boolean) {
  if (!isAllowed(guild.id)) {
    console.log(`Leaving ${guild.name} (${guild.id}): not in ALLOWED_GUILD_IDS`);
    return guild.leave();
  }
  await guild.members.fetch();
  // Guild-scoped commands update instantly, unlike global ones
  rememberCommands(guild.id, (await guild.commands.set([...commands.values()].map((cmd) => cmd.data.toJSON()))).values());
  console.log(`${commands.size} commands registered in ${guild.name} (${guild.id})`);
  if (idSetting(guild.id, 'announceChannel')) return;
  console.log(`${guild.name} has no announce channel yet; a server admin needs to run /setup announce-channel`);
  // Nothing gets announced until an admin picks a channel, so tell a newly joined server where it'll see it
  if (isNew) {
    await guild.systemChannel
      ?.send(
        `👋 Slopkeeper is here. A server admin needs to run ${commandMention(guild.id, 'setup announce-channel')} to finish setting up, and ${commandMention(guild.id, 'setup hopon-role')} before anyone can use ${commandMention(guild.id, 'notify')}. ${commandMention(guild.id, 'setup show')} lists everything else, and ${commandMention(guild.id, 'help')} shows what the bot does.`,
      )
      .catch(() => {});
  }
}

client.once(Events.ClientReady, async (c) => {
  await Promise.all(c.guilds.cache.map((guild) => join(guild, false).catch(console.error)));
  // One feature failing to start leaves the rest working
  for (const feature of startOrder) await Promise.resolve(feature.setup?.(c)).catch((err) => console.error(`Starting ${feature.title ?? feature.componentPrefix ?? 'a feature'} failed:`, err));
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
    const msg = { content: 'Something went wrong on the bot’s side. Try again, and if it keeps happening, tell whoever runs the bot.', flags: MessageFlags.Ephemeral } as const;
    // A public "thinking…" would turn into the error for everyone, so it goes and only whoever asked sees the error
    if (i.deferred && !i.replied && i.ephemeral === false) await i.deleteReply().catch(() => {});
    await (i.replied || i.deferred ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

// A stray failed promise is logged rather than taking every feature down with it
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const feature of features) feature.saveForRestart?.();
    for (const feature of features) feature.shutdown?.();
    // Leaving voice is queued on the gateway connection, so it needs a moment before that closes
    await sleep(250);
    await client.destroy();
    db.close();
    process.exit(0);
  });
}

await client.login(config.token);
