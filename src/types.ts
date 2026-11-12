import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  RESTPostAPIContextMenuApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  run(interaction: ChatInputCommandInteraction): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}

/** A command in a message's or member's Apps menu (right-click, or press and hold on a phone) */
export interface MenuCommand {
  data: { name: string; toJSON(): RESTPostAPIContextMenuApplicationCommandsJSONBody };
  /** What it does, for /help, as Discord shows these without a description */
  about: string;
  run(interaction: MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction): Promise<unknown>;
}

export interface Feature {
  /** Heading for the feature's commands in /help */
  title?: string;
  commands?: Command[];
  menus?: MenuCommand[];
  /** Handles buttons, select menus and modals whose customId starts with `${componentPrefix}:` */
  componentPrefix?: string;
  onButton?(interaction: ButtonInteraction): Promise<unknown>;
  onSelect?(interaction: StringSelectMenuInteraction): Promise<unknown>;
  onModal?(interaction: ModalSubmitInteraction): Promise<unknown>;
  setup?(client: Client<true>): void | Promise<void>;
  /** Runs first when the bot is exiting, before any feature's shutdown, to keep state that shutting down would change */
  saveForRestart?(): void;
  /** Runs before the bot exits */
  shutdown?(): void;
}
