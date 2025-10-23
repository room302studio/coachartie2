import { SlashCommandBuilder } from 'discord.js';
import { createResponseEmbed } from './responses.js';
import logger from '../logger.js';

/**
 * Creates a help command with subcommands
 */
export const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Get help with Coach Artie')
  .addSubcommand((subcommand) =>
    subcommand.setName('commands').setDescription('List all available commands')
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('quick-start').setDescription('Quick start guide for new users')
  );

/**
 * Thread management commands
 */
export const threadCommands = new SlashCommandBuilder()
  .setName('thread')
  .setDescription('Thread management commands')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('summarize')
      .setDescription('Generate a summary of this thread')
      .addBooleanOption((option) =>
        option
          .setName('rename')
          .setDescription('Automatically rename thread with summary')
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('archive').setDescription('Archive this thread with an AI-generated summary')
  );
