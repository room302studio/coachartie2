/**
 * Slack Interaction Handler
 *
 * Handles all Slack interactions:
 * - Slash commands
 * - Button clicks
 * - Select menu selections
 * - Modal submissions
 *
 * Architecture: Mirrors Discord interaction-handler.ts patterns
 */

import type { App } from '@slack/bolt';
import { logger } from '@coachartie/shared';
import { telemetry } from '../services/telemetry.js';
import {
  CorrelationContext,
  generateCorrelationId,
  getShortCorrelationId,
} from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';

// TODO: Add Slack slash commands here
const commands = new Map([
  // Example: ['status', statusCommand],
  // Example: ['help', helpCommand],
]);

export function setupInteractionHandler(app: App) {
  // =============================================================================
  // SLASH COMMANDS
  // =============================================================================

  // Generic slash command handler
  app.command(/.*/,  async ({ command, ack, respond, client }) => {
    // Acknowledge command immediately (required by Slack within 3 seconds)
    await ack();

    const correlationId = generateCorrelationId();
    const shortId = getShortCorrelationId(correlationId);

    const commandHandler = commands.get(command.command.substring(1)); // Remove leading /
    if (!commandHandler) {
      logger.warn(`Unknown command [${shortId}]:`, {
        correlationId,
        command: command.command,
        userId: command.user_id,
      });
      telemetry.logEvent(
        'command_unknown',
        {
          command: command.command,
        },
        correlationId,
        command.user_id,
        undefined,
        false
      );

      await respond({
        text: `Unknown command: ${command.command}`,
        response_type: 'ephemeral',
      });
      return;
    }

    const startTime = Date.now();

    try {
      logger.info(`Executing command [${shortId}]:`, {
        correlationId,
        command: command.command,
        userId: command.user_id,
        userName: command.user_name,
        channelId: command.channel_id,
        service: 'slack',
      });

      telemetry.logEvent(
        'command_started',
        {
          command: command.command,
          channelId: command.channel_id,
        },
        correlationId,
        command.user_id
      );

      await (commandHandler as any).execute(command, respond, client);

      const duration = Date.now() - startTime;
      logger.info(`Command completed [${shortId}]:`, {
        correlationId,
        command: command.command,
        duration: `${duration}ms`,
        userId: command.user_id,
      });

      telemetry.logEvent(
        'command_completed',
        {
          command: command.command,
          duration,
        },
        correlationId,
        command.user_id,
        duration,
        true
      );
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(`Command failed [${shortId}]:`, {
        correlationId,
        command: command.command,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration: `${duration}ms`,
        userId: command.user_id,
      });

      telemetry.logEvent(
        'command_failed',
        {
          command: command.command,
          error: error instanceof Error ? error.message : String(error),
          duration,
        },
        correlationId,
        command.user_id,
        duration,
        false
      );

      await respond({
        text: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
        response_type: 'ephemeral',
      });
    }
  });

  // =============================================================================
  // BUTTON INTERACTIONS
  // =============================================================================

  app.action(/.*/,  async ({ ack, body, client, respond }) => {
    // Acknowledge action immediately
    await ack();

    if (body.type !== 'block_actions') {
      return;
    }

    const correlationId = generateCorrelationId();
    const shortId = getShortCorrelationId(correlationId);

    const action = body.actions[0];
    const userId = body.user.id;

    logger.info(`Button interaction [${shortId}]:`, {
      correlationId,
      actionId: action.action_id,
      userId,
      channelId: body.channel?.id,
    });

    telemetry.logEvent(
      'button_interaction',
      {
        actionId: action.action_id,
        channelId: body.channel?.id,
      },
      correlationId,
      userId
    );

    try {
      // Handle button interactions through unified intent processor
      const buttonContent = `[Button: ${action.action_id}] ${action.value || ''}`;

      await processUserIntent(
        {
          content: buttonContent,
          userId,
          username: body.user.username || body.user.name || userId,
          source: 'button',
          metadata: {
            actionId: action.action_id,
            actionValue: action.value,
            channelId: body.channel?.id,
            messageTs: body.message?.ts,
            correlationId,
          },
          context: {
            platform: 'slack',
            channelId: body.channel?.id,
            userId,
            interactionType: 'button',
            actionId: action.action_id,
          },

          // Response handlers
          respond: async (content: string) => {
            await respond({
              text: content,
              replace_original: false, // Post as new message
            });
          },
        },
        {
          enableStreaming: false, // No streaming for button interactions
          enableTyping: false,
          enableReactions: false,
          enableEditing: false,
        }
      );
    } catch (error) {
      logger.error(`Button interaction failed [${shortId}]:`, error);

      await respond({
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        response_type: 'ephemeral',
      });
    }
  });

  // =============================================================================
  // MODAL SUBMISSIONS
  // =============================================================================

  app.view(/.*/,  async ({ ack, body, view, client }) => {
    // Acknowledge view submission
    await ack();

    const correlationId = generateCorrelationId();
    const shortId = getShortCorrelationId(correlationId);

    const userId = body.user.id;

    logger.info(`Modal submission [${shortId}]:`, {
      correlationId,
      callbackId: view.callback_id,
      userId,
    });

    telemetry.logEvent(
      'modal_submission',
      {
        callbackId: view.callback_id,
      },
      correlationId,
      userId
    );

    try {
      // Extract form values from view state
      const values = view.state.values;
      const formData: Record<string, any> = {};

      for (const blockId in values) {
        for (const actionId in values[blockId]) {
          const element = values[blockId][actionId];
          formData[actionId] = element.value || element.selected_option?.value;
        }
      }

      logger.info(`Modal form data [${shortId}]:`, formData);

      // TODO: Handle modal submissions through appropriate command handlers
      logger.info(`Modal submission processed [${shortId}]`);
    } catch (error) {
      logger.error(`Modal submission failed [${shortId}]:`, error);
    }
  });

  logger.info('Slack interaction handler setup complete with telemetry tracking');
}
