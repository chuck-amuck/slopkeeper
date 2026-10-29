import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
} from 'discord.js';

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  run(interaction: ChatInputCommandInteraction): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}

export interface Feature {
  /** Heading for the feature's commands in /help */
  title?: string;
  commands?: Command[];
  /** Handles buttons and select menus whose customId starts with `${componentPrefix}:` */
  componentPrefix?: string;
  onButton?(interaction: ButtonInteraction): Promise<unknown>;
  onSelect?(interaction: StringSelectMenuInteraction): Promise<unknown>;
  setup?(client: Client<true>): void | Promise<void>;
  /** Runs before the bot exits */
  shutdown?(): void;
}
