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
};
