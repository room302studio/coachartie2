import { Client } from 'discord.js';
import { createWorker, QUEUES, OutgoingMessage, logger } from '@coachartie/shared';
import type { Worker } from 'bullmq';

export async function startResponseConsumer(client: Client): Promise<Worker<OutgoingMessage>> {
  const worker = createWorker<OutgoingMessage, void>(
    QUEUES.OUTGOING_DISCORD,
    async (job) => {
      const response = job.data;
      
      try {
        // Get channel ID from the response metadata
        const channelId = response.metadata?.channelId;
        if (!channelId) {
          throw new Error('No channelId in response metadata');
        }

        // Find the channel
        const channel = await client.channels.fetch(channelId);
        
        if (!channel || !channel.isTextBased()) {
          throw new Error(`Invalid channel: ${channelId}`);
        }

        // Send the message (only if channel supports it)
        if ('send' in channel) {
          await channel.send(response.message);
        } else {
          throw new Error(`Channel type does not support sending messages: ${channel.type}`);
        }
        
        logger.info(`Response sent to Discord channel ${channelId}`);
      } catch (error) {
        logger.error(`Failed to send Discord response for message ${response.inReplyTo}:`, error);
        throw error; // Let BullMQ handle retries
      }
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Discord response sent successfully for message ${job.data.inReplyTo}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Discord response failed for message ${job?.data?.inReplyTo}:`, err);
  });

  return worker;
}