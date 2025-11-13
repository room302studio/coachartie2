import type { App } from '@slack/bolt';
import { createWorker, QUEUES, OutgoingMessage, logger } from '@coachartie/shared';
import type { Worker } from 'bullmq';

export async function startResponseConsumer(app: App): Promise<Worker<OutgoingMessage>> {
  const worker = createWorker<OutgoingMessage, void>(QUEUES.OUTGOING_SLACK, async (job) => {
    const response = job.data;

    try {
      // Get channel ID from the response metadata
      const channelId = response.metadata?.channelId;
      if (!channelId) {
        throw new Error('No channelId in response metadata');
      }

      // Check if this is a special Slack UI response (Block Kit)
      if (response.message.startsWith('SLACK_UI:')) {
        await handleSlackUIResponse(app, channelId, response.message);
      } else {
        // Send regular text message
        // Add debug instance identifier if enabled
        const debugInfo =
          process.env.ENABLE_INSTANCE_DEBUG === 'true'
            ? `\n\n_[${process.env.INSTANCE_NAME || 'unknown'}]_`
            : '';

        await app.client.chat.postMessage({
          channel: channelId,
          text: response.message + debugInfo,
        });
      }

      logger.info(`Response sent to Slack channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to send Slack response for message ${response.inReplyTo}:`, error);
      throw error; // Let BullMQ handle retries
    }
  });

  worker.on('completed', (job) => {
    logger.info(`Slack response sent successfully for message ${job.data.inReplyTo}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Slack response failed for message ${job?.data?.inReplyTo}:`, err);
  });

  return worker;
}

/**
 * Handle special Slack UI responses (Block Kit: blocks, modals, etc.)
 */
async function handleSlackUIResponse(app: App, channelId: string, message: string): Promise<void> {
  try {
    // Parse the special format: SLACK_UI:TYPE:JSON_DATA:USER_MESSAGE
    const parts = message.split(':');
    if (parts.length < 4) {
      throw new Error('Invalid Slack UI response format');
    }

    const type = parts[1]; // BLOCKS, MODAL, etc.
    const jsonData = parts.slice(2, -1).join(':'); // Handle JSON with colons
    const userMessage = parts[parts.length - 1]; // The readable message

    const uiData = JSON.parse(jsonData);

    switch (type) {
      case 'BLOCKS':
        await sendBlockMessage(app, channelId, userMessage, uiData);
        break;

      case 'MODAL':
        // Modals can't be sent directly to channels, they need to be triggered by interactions
        // For now, just send a message explaining what was created
        await sendModalInfo(app, channelId, userMessage, uiData);
        break;

      default:
        logger.warn(`Unknown Slack UI type: ${type}`);
        await app.client.chat.postMessage({
          channel: channelId,
          text: userMessage,
        });
    }

    logger.info(`Slack UI component sent:`, { type, channel: channelId });
  } catch (error) {
    logger.error('Failed to handle Slack UI response:', error);
    // Fallback: send the user message part
    const fallbackMessage = message.split(':').pop() || 'Slack UI component created!';
    await app.client.chat.postMessage({
      channel: channelId,
      text: fallbackMessage,
    });
  }
}

async function sendBlockMessage(
  app: App,
  channelId: string,
  userMessage: string,
  uiData: any
): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    text: userMessage, // Fallback text
    blocks: uiData.blocks,
  });
}

async function sendModalInfo(
  app: App,
  channelId: string,
  userMessage: string,
  uiData: any
): Promise<void> {
  // Modals can't be sent directly - they need to be shown in response to interactions
  // For now, send info about the modal that was created
  await app.client.chat.postMessage({
    channel: channelId,
    text: `📝 ${userMessage}\n\n*Note: Modals appear when you interact with buttons or slash commands that trigger them.*`,
  });
}
