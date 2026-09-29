import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { statusCommand } from './status.js';
import { botStatusCommand } from './bot-status.js';
import { modelsCommand } from './models.js';
import { memoryCommand } from './memory.js';
import { usageCommand } from './usage.js';
import { debugCommand } from './debug.js';
import * as syncDiscussionsCommand from './sync-discussions.js';
import { quizCommand } from './quiz.js';
import { watchRepoCommand } from './watch-repo.js';
import { unwatchRepoCommand } from './unwatch-repo.js';
import { listWatchesCommand } from './list-watches.js';
import { pairingCommand } from './pairing.js';

/**
 * THE list of global slash commands. The interaction handler routes from it and
 * register-commands.ts publishes it, so what Discord shows and what Artie can answer can't
 * drift apart again. (By 2026-09-29 they had: Discord still offered /link-phone,
 * /verify-phone and /unlink-phone, whose code was gone, while /quiz, /watch-repo,
 * /unwatch-repo and /list-watches worked but had never been registered.)
 *
 * Guild-scoped commands (e.g. /stack-talk, register-stack-talk.ts) are registered separately.
 */
export interface SlashCommand {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}

export const globalCommands: SlashCommand[] = [
  statusCommand,
  botStatusCommand,
  modelsCommand,
  memoryCommand,
  usageCommand,
  debugCommand,
  syncDiscussionsCommand,
  quizCommand,
  watchRepoCommand,
  unwatchRepoCommand,
  listWatchesCommand,
  pairingCommand,
] as SlashCommand[];
