import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
import { createLoopApi, LoopRoom } from './loopBot.ts';

// The loop bot's own container. It shares the main bot's image and data volume (read-only), but none of its settings
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const token = required('LOOP_BOT_TOKEN');
const apiToken = required('LOOP_TOKEN');
const port = Number(process.env.LOOP_PORT || 8788);
const filesRoot = process.env.DATA_DIR ?? './data';
const allowed = process.env.ALLOWED_GUILD_IDS?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];

// Only voice: it needs no privileged intents, and no commands
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const rooms = new Map<string, LoopRoom>();

function stayIfAllowed(guild: Guild) {
  if (!allowed.length || allowed.includes(guild.id)) return;
  console.log(`Leaving ${guild.name} (${guild.id}): not in ALLOWED_GUILD_IDS`);
  void guild.leave().catch(console.error);
}

client.once(Events.ClientReady, (c) => {
  for (const guild of c.guilds.cache.values()) stayIfAllowed(guild);
  console.log(`Loop bot logged in as ${c.user.tag} in ${c.guilds.cache.size} server${c.guilds.cache.size === 1 ? '' : 's'}`);
});
client.on(Events.GuildCreate, stayIfAllowed);
client.on(Events.VoiceStateUpdate, (_old, state) => rooms.get(state.guild.id)?.checkEmpty());

const server = createLoopApi(client, apiToken, filesRoot, rooms).listen(port, () => console.log(`Loop bot API listening on port ${port}`));
server.on('error', (err) => console.error('Loop bot API failed:', err.message));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    for (const room of rooms.values()) room.stop();
    server.close();
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(token);
