/** Each server's command IDs, kept when the commands are registered, so messages can name a command people can click */
const ids = new Map<string, string>();

export function rememberCommands(guildId: string, commands: Iterable<{ name: string; id: string }>) {
  for (const c of commands) ids.set(`${guildId}:${c.name}`, c.id);
}

/** A command as a mention Discord shows as clickable, like </game unhide:123>, or in code style if its ID isn't known */
export function commandMention(guildId: string | null, command: string): string {
  const id = guildId && ids.get(`${guildId}:${command.split(' ')[0]}`);
  return id ? `</${command}:${id}>` : `\`/${command}\``;
}
