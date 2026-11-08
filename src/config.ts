function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/** A comma-separated list of ids, or null when there are none; an empty variable means the same as an unset one */
export function parseIds(value: string | undefined): string[] | null {
  const ids = value?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
  return ids.length ? ids : null;
}

// What only the host can provide. Per-server settings and their env defaults are in settings.ts
export const config = {
  token: required('DISCORD_TOKEN'),
  // Servers allowed to use the bot; unset allows any server that adds it
  allowedGuildIds: parseIds(process.env.ALLOWED_GUILD_IDS),
  steamApiKey: process.env.STEAM_API_KEY || null,
  // One price check covers every server, so this isn't a per-server setting
  saleCheckHours: Number(process.env.SALE_CHECK_HOURS || 6),
  dataDir: process.env.DATA_DIR ?? './data',
  // Turns on the management API that the web UI uses. Only for other containers: never publish its port
  apiToken: process.env.API_TOKEN || null,
  apiPort: Number(process.env.API_PORT || 8787),
  // The voice container, for text to speech. Unset turns it off
  voiceUrl: process.env.VOICE_URL || null,
  // The music container, which plays Spotify, and the password it shares with the bot. Unset turns music off
  musicUrl: process.env.MUSIC_URL || null,
  musicToken: process.env.MUSIC_TOKEN || null,
  // Where the music container's downloaded audio is, read-only, shared with it as a volume
  musicAudioDir: process.env.MUSIC_AUDIO_DIR || '/music/audio',
  // The loop bot, a second bot that plays the looping room so this one is free elsewhere, and the password they share. Unset plays the room here
  loopBotUrl: process.env.LOOP_BOT_URL || null,
  loopToken: process.env.LOOP_TOKEN || null,
  // A Spotify app's credentials, for search. They only read the catalogue, so nobody signs in
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || null,
  // From the account owner signing in to that app once, so the bot can read their own playlists. Unset leaves playlists out
  spotifyRefreshToken: process.env.SPOTIFY_REFRESH_TOKEN || null,
  // Which country's catalogue search uses, since what can be played differs between them
  spotifyMarket: (process.env.SPOTIFY_MARKET || 'US').toUpperCase(),
};
