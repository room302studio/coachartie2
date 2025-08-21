import { Client, Events, Interaction, ChatInputCommandInteraction, ButtonInteraction, SelectMenuInteraction } from 'discord.js';
import { logger } from '@coachartie/shared';
import { linkPhoneCommand } from '../commands/link-phone.js';
import { verifyPhoneCommand } from '../commands/verify-phone.js';
import { unlinkPhoneCommand } from '../commands/unlink-phone.js';
import { statusCommand } from '../commands/status.js';
import { botStatusCommand } from '../commands/bot-status.js';
import { modelsCommand } from '../commands/models.js';
import { memoryCommand } from '../commands/memory.js';
import { usageCommand } from '../commands/usage.js';
import { debugCommand } from '../commands/debug.js';
import { telemetry } from '../services/telemetry.js';
import { CorrelationContext, generateCorrelationId, getShortCorrelationId } from '../utils/correlation.js';
import { capabilitiesClient } from '../services/capabilities-client.js';

const commands = new Map([
  ['link-phone', linkPhoneCommand],
  ['verify-phone', verifyPhoneCommand],
  ['unlink-phone', unlinkPhoneCommand],
  ['status', statusCommand],
  ['bot-status', botStatusCommand],
  ['models', modelsCommand],
  ['memory', memoryCommand],
  ['usage', usageCommand],
  ['debug', debugCommand]
] as any);

export function setupInteractionHandler(client: Client) {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Handle different types of interactions
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    }
  });

  logger.info('Interaction handler setup complete with telemetry tracking');
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {

    // Generate correlation ID for command tracking
    const correlationId = generateCorrelationId();
    const shortId = getShortCorrelationId(correlationId);

    const command = commands.get(interaction.commandName);
    if (!command) {
      logger.warn(`Unknown command [${shortId}]:`, {
        correlationId,
        command: interaction.commandName,
        userId: interaction.user.id
      });
      telemetry.logEvent('command_unknown', {
        command: interaction.commandName
      }, correlationId, interaction.user.id, undefined, false);
      return;
    }

    const startTime = Date.now();

    try {
      logger.info(`Executing command [${shortId}]:`, {
        correlationId,
        command: interaction.commandName,
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guild?.id,
        service: 'discord'
      });

      telemetry.logEvent('command_started', {
        command: interaction.commandName,
        guildId: interaction.guild?.id
      }, correlationId, interaction.user.id);

      await (command as any).execute(interaction);

      const duration = Date.now() - startTime;
      logger.info(`Command completed [${shortId}]:`, {
        correlationId,
        command: interaction.commandName,
        duration: `${duration}ms`,
        userId: interaction.user.id
      });

      telemetry.logEvent('command_completed', {
        command: interaction.commandName,
        duration
      }, correlationId, interaction.user.id, duration, true);

    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error(`Command failed [${shortId}]:`, {
        correlationId,
        command: interaction.commandName,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration: `${duration}ms`,
        userId: interaction.user.id
      });

      telemetry.logEvent('command_failed', {
        command: interaction.commandName,
        error: error instanceof Error ? error.message : String(error),
        duration
      }, correlationId, interaction.user.id, duration, false);
      
      const errorMessage = `❌ There was an error executing this command! [${shortId}]`;
      
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: errorMessage, ephemeral: true });
        } else {
          await interaction.reply({ content: errorMessage, ephemeral: true });
        }
      } catch (replyError) {
        logger.error(`Failed to send error reply [${shortId}]:`, {
          correlationId,
          replyError: replyError instanceof Error ? replyError.message : String(replyError)
        });
      }
    }
}

/**
 * Handle button interactions - send button label as message to LLM
 */
async function handleButtonInteraction(interaction: ButtonInteraction) {
  const correlationId = generateCorrelationId();
  const shortId = getShortCorrelationId(correlationId);

  try {
    logger.info(`Button clicked [${shortId}]:`, {
      correlationId,
      customId: interaction.customId,
      userId: interaction.user.id,
      username: interaction.user.username,
      buttonLabel: (interaction.component as any)?.label || 'Unknown'
    });

    telemetry.logEvent('button_clicked', {
      customId: interaction.customId,
      buttonLabel: (interaction.component as any)?.label
    }, correlationId, interaction.user.id);

    // Acknowledge the interaction immediately
    await interaction.deferReply();

    // Get the button text to send as a message
    const buttonText = (interaction.component as any)?.label || interaction.customId;
    const messageText = `${buttonText}`;

    logger.info(`Sending button selection as message [${shortId}]:`, {
      correlationId,
      messageText,
      userId: interaction.user.id
    });

    // Submit the button selection as a new message to the LLM
    const jobInfo = await capabilitiesClient.submitJob(messageText, interaction.user.id);
    
    telemetry.incrementJobsSubmitted(interaction.user.id, jobInfo.messageId);
    telemetry.logEvent('button_job_submitted', {
      jobId: jobInfo.messageId,
      buttonText
    }, correlationId, interaction.user.id);

    // Poll for completion and send response
    const jobResult = await capabilitiesClient.pollJobUntilComplete(jobInfo.messageId, {
      maxAttempts: 60,
      pollInterval: 3000
    });

    const responseText = jobResult.response || 'No response received';
    
    await interaction.editReply({
      content: `🔘 **${buttonText}**\n\n${responseText}`
    });

    telemetry.logEvent('button_response_sent', {
      jobId: jobInfo.messageId,
      responseLength: responseText.length
    }, correlationId, interaction.user.id, undefined, true);

  } catch (error) {
    logger.error(`Button interaction failed [${shortId}]:`, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      customId: interaction.customId
    });

    telemetry.logEvent('button_failed', {
      error: error instanceof Error ? error.message : String(error)
    }, correlationId, interaction.user.id, undefined, false);

    try {
      const errorMessage = `❌ Failed to process button click: ${error instanceof Error ? error.message : String(error)}`;
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorMessage });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (replyError) {
      logger.error(`Failed to send button error reply [${shortId}]:`, {
        correlationId,
        replyError: replyError instanceof Error ? replyError.message : String(replyError)
      });
    }
  }
}

/**
 * Handle select menu interactions - send selected option as message to LLM
 */
async function handleSelectMenuInteraction(interaction: SelectMenuInteraction) {
  const correlationId = generateCorrelationId();
  const shortId = getShortCorrelationId(correlationId);

  try {
    const selectedValue = interaction.values[0];
    const selectedOption = interaction.component?.options?.find(opt => opt.value === selectedValue);
    const selectedLabel = selectedOption?.label || selectedValue;

    logger.info(`Select menu option chosen [${shortId}]:`, {
      correlationId,
      customId: interaction.customId,
      selectedValue,
      selectedLabel,
      userId: interaction.user.id,
      username: interaction.user.username
    });

    telemetry.logEvent('select_option_chosen', {
      customId: interaction.customId,
      selectedValue,
      selectedLabel
    }, correlationId, interaction.user.id);

    // Acknowledge the interaction immediately
    await interaction.deferReply();

    // Send the selected option as a message
    const messageText = selectedLabel;

    logger.info(`Sending select option as message [${shortId}]:`, {
      correlationId,
      messageText,
      userId: interaction.user.id
    });

    // Submit the selection as a new message to the LLM
    const jobInfo = await capabilitiesClient.submitJob(messageText, interaction.user.id);
    
    telemetry.incrementJobsSubmitted(interaction.user.id, jobInfo.messageId);
    telemetry.logEvent('select_job_submitted', {
      jobId: jobInfo.messageId,
      selectedOption: selectedLabel
    }, correlationId, interaction.user.id);

    // Poll for completion and send response
    const jobResult = await capabilitiesClient.pollJobUntilComplete(jobInfo.messageId, {
      maxAttempts: 60,
      pollInterval: 3000
    });

    const responseText = jobResult.response || 'No response received';
    
    await interaction.editReply({
      content: `📋 **${selectedLabel}**\n\n${responseText}`
    });

    telemetry.logEvent('select_response_sent', {
      jobId: jobInfo.messageId,
      responseLength: responseText.length
    }, correlationId, interaction.user.id, undefined, true);

  } catch (error) {
    logger.error(`Select menu interaction failed [${shortId}]:`, {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      customId: interaction.customId
    });

    telemetry.logEvent('select_failed', {
      error: error instanceof Error ? error.message : String(error)
    }, correlationId, interaction.user.id, undefined, false);

    try {
      const errorMessage = `❌ Failed to process selection: ${error instanceof Error ? error.message : String(error)}`;
      
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorMessage });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (replyError) {
      logger.error(`Failed to send select error reply [${shortId}]:`, {
        correlationId,
        replyError: replyError instanceof Error ? replyError.message : String(replyError)
      });
    }
  }
}