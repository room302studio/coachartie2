import { Worker } from 'bullmq';
import { createRedisConnection } from '@coachartie/shared';
import { client } from '../index.js';
import { logger } from '@coachartie/shared';

const connection = createRedisConnection();

const worker = new Worker(
  'coachartie-discord-outgoing',
  async (job) => {
    const { userId, content, source, channelId } = job.data;

    try {
      if (channelId) {
        // Send to channel
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased() && 'send' in channel) {
          await channel.send(content);
        }
      } else {
        // Send DM to user
        const user = await client.users.fetch(userId);
        await user.send(content);
      }

      logger.info(`✅ Sent ${source} message to ${userId || channelId}`);
    } catch (error) {
      logger.error(`❌ Failed to send message:`, error);
      throw error; // Retry via Bull
    }
  },
  { connection }
);

export default worker;
