import { createWorker, QUEUES, OutgoingMessage, logger } from '@coachartie/shared';
import type { Worker } from 'bullmq';
import * as irc from 'irc-framework';

// IRC message length limit (standard is 512 bytes including protocol overhead)
const IRC_MESSAGE_LIMIT = 400; // Conservative limit to account for protocol overhead

function chunkMessage(message: string, limit: number): string[] {
  if (message.length <= limit) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split on natural boundaries
    let splitIndex = limit;

    // First try to split on double newline
    const doubleNewline = remaining.lastIndexOf('\n\n', limit);
    if (doubleNewline > limit * 0.5) {
      splitIndex = doubleNewline + 2;
    } else {
      // Try single newline
      const newline = remaining.lastIndexOf('\n', limit);
      if (newline > limit * 0.5) {
        splitIndex = newline + 1;
      } else {
        // Try space
        const space = remaining.lastIndexOf(' ', limit);
        if (space > limit * 0.5) {
          splitIndex = space + 1;
        }
      }
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

export async function startResponseConsumer(client: irc.Client): Promise<any> {
  const worker = createWorker<OutgoingMessage, void>(QUEUES.OUTGOING_IRC, async (job) => {
    const response = job.data;

    try {
      // Get target from metadata (channelId from original message)
      const target = response.metadata?.channelId || response.metadata?.target;
      if (!target) {
        throw new Error('No target channel/user in response metadata');
      }

      // Check if client is connected
      if (!client.connected) {
        throw new Error('IRC client is not connected');
      }

      // Split message into chunks if needed
      const chunks = chunkMessage(response.message, IRC_MESSAGE_LIMIT);

      // Send each chunk
      for (const chunk of chunks) {
        client.say(target, chunk);
        // Small delay between chunks to avoid flooding
        if (chunks.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      logger.info(`IRC message sent successfully`, {
        messageId: response.id,
        inReplyTo: response.inReplyTo,
        target,
        chunks: chunks.length,
      });
    } catch (error) {
      logger.error(`Failed to send IRC message for ${response.inReplyTo}:`, error);
      throw error; // Let BullMQ handle retries
    }
  });

  worker.on('completed', (job: any) => {
    logger.info(`IRC response sent successfully for message ${job.data.inReplyTo}`);
  });

  worker.on('failed', (job: any, err: Error) => {
    logger.error(`IRC response failed for message ${job?.data?.inReplyTo}:`, err);
  });

  worker.on('error', (err: Error) => {
    logger.error('IRC worker error:', err);
  });

  logger.info('IRC response consumer started');

  return worker;
}
