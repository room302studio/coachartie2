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
import { processUserIntent } from '../services/user-intent-processor.js';

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
 * Button interaction adapter - tiny bridge to unified processor
 * Replaces ~150 lines of duplicate logic with ~15 lines
 */
async function handleButtonInteraction(interaction: ButtonInteraction) {
  const buttonText = (interaction.component as any)?.label || interaction.customId;
  
  await interaction.deferReply();
  
  await processUserIntent({
    content: buttonText,
    userId: interaction.user.id,
    username: interaction.user.username,
    source: 'button',
    metadata: { customId: interaction.customId },
    
    respond: async (content: string) => {
      await interaction.editReply(`🔘 **${buttonText}**\n\n${content}`);
    },
    
    updateProgress: async (status: string) => {
      await interaction.editReply(`🔄 **${buttonText}**\n\n${status}`);
    }
  });
}

/**
 * Select menu interaction adapter - tiny bridge to unified processor  
 * Replaces ~150 lines of duplicate logic with ~15 lines
 */
async function handleSelectMenuInteraction(interaction: SelectMenuInteraction) {
  const selectedValue = interaction.values[0];
  const selectedOption = interaction.component?.options?.find(opt => opt.value === selectedValue);
  const selectedLabel = selectedOption?.label || selectedValue;
  
  await interaction.deferReply();
  
  await processUserIntent({
    content: selectedLabel,
    userId: interaction.user.id,
    username: interaction.user.username,
    source: 'select',
    metadata: { 
      customId: interaction.customId,
      selectedValue,
      selectedLabel 
    },
    
    respond: async (content: string) => {
      await interaction.editReply(`📋 **${selectedLabel}**\n\n${content}`);
    },
    
    updateProgress: async (status: string) => {
      await interaction.editReply(`🔄 **${selectedLabel}**\n\n${status}`);
    }
  });
}