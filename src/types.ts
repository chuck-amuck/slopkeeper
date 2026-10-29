import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  run(interaction: ChatInputCommandInteraction): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}

export interface Feature {
  commands?: Command[];
  /** Handles buttons whose customId starts with `${buttonPrefix}:` */
  buttonPrefix?: string;
  onButton?(interaction: ButtonInteraction): Promise<unknown>;
  setup?(client: Client<true>): void | Promise<void>;
}
