function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  guildId: required('GUILD_ID'),
  announceChannelId: required('ANNOUNCE_CHANNEL_ID'),
  hopOnRoleId: process.env.HOPON_ROLE_ID || null,
  hopOnMinPeople: num('HOPON_MIN_PEOPLE', 2),
  hopOnCooldownMin: num('HOPON_COOLDOWN_MIN', 120),
  recapMinMinutes: num('RECAP_MIN_MINUTES', 15),
  sessionGraceMin: num('SESSION_GRACE_MIN', 5),
  saleCheckHours: num('SALE_CHECK_HOURS', 6),
  steamApiKey: process.env.STEAM_API_KEY || null,
  steamCountry: process.env.STEAM_CC ?? 'us',
  weeklyPostDay: num('WEEKLY_POST_DAY', 0),
  weeklyPostHour: num('WEEKLY_POST_HOUR', 20),
  dataDir: process.env.DATA_DIR ?? './data',
};
