import { ThreadAutoArchiveDuration } from 'discord.js';
import logger from '../logger.js';

/**
 * Creates a thread for a specific task or conversation
 * @param {Message} message - The message to create thread from
 * @param {string} threadName - Name for the new thread
 * @param {Object} options - Additional thread options
 */
export async function createThread(message, threadName, options = {}) {
  try {
    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: options.reason || 'New conversation thread',
    });

    logger.info(`Thread created: ${thread.name} (${thread.id})`);
    return thread;
  } catch (error) {
    logger.error('Failed to create thread:', error);
    throw error;
  }
}

/**
 * Archives a thread
 * @param {ThreadChannel} thread - The thread to archive
 */
export async function archiveThread(thread) {
  try {
    await thread.setArchived(true);
    logger.info(`Thread archived: ${thread.name} (${thread.id})`);
  } catch (error) {
    logger.error('Failed to archive thread:', error);
    throw error;
  }
}
