import { ApplicationCommandOptionType, ApplicationCommandType } from 'discord.js';

/** Each server's command IDs, kept when the commands are registered, so messages can name a command people can click */
const ids = new Map<string, string>();
/** Each server's commands as chat tells the model about them, one a line, and every name that can be clicked, subcommands too */
const lists = new Map<string, { lines: string[]; names: string[] }>();

interface Option {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  options?: readonly Option[];
}

/** A command as Discord gives it back once registered */
export interface Registered {
  name: string;
  id: string;
  description?: string;
  type?: ApplicationCommandType;
  options?: readonly Option[];
  /** Set for a command only some can use, like /setup for server admins */
  defaultMemberPermissions?: unknown;
}

export function rememberCommands(guildId: string, commands: Iterable<Registered>) {
  const lines: string[] = [];
  const names: string[] = [];
  const apps: string[] = [];
  // A command that's gone keeps no ID
  for (const key of ids.keys()) if (key.startsWith(`${guildId}:`)) ids.delete(key);
  for (const c of commands) {
    ids.set(`${guildId}:${c.name}`, c.id);
    if (c.type !== undefined && c.type !== ApplicationCommandType.ChatInput) {
      apps.push(c.name);
      continue;
    }
    const subs = (c.options ?? []).flatMap((o) =>
      o.type === ApplicationCommandOptionType.Subcommand
        ? [{ name: o.name, description: o.description }]
        : o.type === ApplicationCommandOptionType.SubcommandGroup
          ? (o.options ?? []).map((s) => ({ name: `${o.name} ${s.name}`, description: s.description }))
          : [],
    );
    // A command with subcommands only runs as one of them, so only they're made clickable
    names.push(...(subs.length ? subs.map((s) => `${c.name} ${s.name}`) : [c.name]));
    // An admin's command is one line: everyone else only needs to know it's there
    if (c.defaultMemberPermissions || !subs.length) lines.push(`/${c.name}: ${c.description}${c.defaultMemberPermissions ? ' (for server admins)' : ''}`);
    else lines.push(...subs.map((s) => `/${c.name} ${s.name}: ${s.description}`));
  }
  if (apps.length) lines.push(`Apps on a message or a member (right-click, or press and hold on a phone): ${apps.join(', ')}`);
  lists.set(guildId, { lines, names });
}

/** A command as a mention Discord shows as clickable, like </game unhide:123>, or in code style if its ID isn't known */
export function commandMention(guildId: string | null, command: string): string {
  const id = guildId && ids.get(`${guildId}:${command.split(' ')[0]}`);
  return id ? `</${command}:${id}>` : `\`/${command}\``;
}

/** The server's commands, a line each, for chat to point people to */
export const commandList = (guildId: string) => lists.get(guildId)?.lines ?? [];

/** Text with each command written as /name, in code style or not, made clickable. Longest names first, so /gamenight plan isn't /gamenight */
export function clickableCommands(guildId: string, text: string): string {
  const names = [...(lists.get(guildId)?.names ?? [])].sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const any = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.replace(new RegExp(`(^|[\\s(“"'*_])(\`?)/(${any})(?![A-Za-z0-9-]|_[A-Za-z0-9])\\2`, 'g'), (_, before: string, _tick: string, name: string) => `${before}${commandMention(guildId, name)}`);
}
