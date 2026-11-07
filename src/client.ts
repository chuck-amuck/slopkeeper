import { Client, GatewayIntentBits } from 'discord.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildExpressions, // soundboard sound create/delete events
    GatewayIntentBits.GuildMembers, // privileged: enable "Server Members Intent" in the developer portal
    GatewayIntentBits.GuildPresences, // privileged: enable "Presence Intent" (used to see what game people are playing)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable "Message Content Intent" (used to read a channel aloud)
  ],
  // Messages quote names people typed, so nothing pings unless the message says so with its own allowedMentions
  allowedMentions: { parse: [] },
});
