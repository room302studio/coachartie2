import { threadCommands } from './commands.js';
import {
  generateThreadSummary,
  updateThreadTitle,
  archiveThreadWithSummary,
} from './threadUtils.js';
import { createResponseEmbed } from './responses.js';
import logger from '../logger.js';
import { Result, ResultAsync, err, ok } from 'neverthrow';

export async function handleCommand(interaction) {
  if (!interaction.isCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'thread':
        await handleThreadCommand(interaction);
        break;
      // ... other commands
    }
  } catch (error) {
    logger.error('Command handling error:', error);
    await interaction.reply({
      content: 'There was an error executing this command!',
      ephemeral: true,
    });
  }
}

async function handleThreadCommand(interaction) {
  if (!interaction.channel.isThread()) {
    await interaction.reply({
      content: 'This command can only be used in threads!',
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply();

  switch (subcommand) {
    case 'summarize': {
      const shouldRename = interaction.options.getBoolean('rename') ?? false;

      const result = await (shouldRename
        ? generateThreadSummary(interaction.channel).andThen(
            async ({ summary, suggestedTitle }) => {
              await interaction.channel.setName(suggestedTitle);
              return ok({ summary, suggestedTitle });
            }
          )
        : generateThreadSummary(interaction.channel));

      result.match(
        ({ summary, suggestedTitle }) => {
          const embed = createResponseEmbed({
            title: '📝 Thread Summary',
            description: summary,
            fields: shouldRename ? [{ name: 'New Thread Title', value: suggestedTitle }] : [],
          });
          return interaction.editReply({ embeds: [embed] });
        },
        (error) => {
          logger.error('Summary generation failed:', error);
          return interaction.editReply({
            content: `Failed to generate summary: ${error.message}`,
            ephemeral: true,
          });
        }
      );
      break;
    }

    case 'archive': {
      const result = await archiveThreadWithSummary(interaction.channel);

      result.match(
        (summary) => {
          const embed = createResponseEmbed({
            title: '🗄️ Thread Archived',
            description: 'Thread archived with summary:',
            fields: [{ name: 'Summary', value: summary }],
          });
          return interaction.editReply({ embeds: [embed] });
        },
        (error) => {
          logger.error('Archive failed:', error);
          return interaction.editReply({
            content: `Failed to archive thread: ${error.message}`,
            ephemeral: true,
          });
        }
      );
      break;
    }
  }
}
