import { Client, Events, Message } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { capabilitiesClient } from '../services/capabilities-client.js';

// Simple deduplication cache to prevent duplicate message processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds

export function setupMessageHandler(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Debug: Log all incoming messages
    logger.info(`DEBUG: Received message - Author: ${message.author.tag}, Channel Type: ${message.channel.type}, Content: ${message.content}`);
    
    // Ignore our own messages to prevent loops, but observe other bots (GitHub, webhooks, etc.)
    if (message.author.id === client.user!.id) return;

    // Check response conditions
    const botMentioned = message.mentions.has(client.user!.id);
    const isDM = message.channel.isDMBased();
    const isRobotChannel = message.channel.type === 0 && 'name' in message.channel && 
      (message.channel.name?.includes('🤖') || message.channel.name?.includes('robot'));
    
    // Determine if we should respond vs just observe
    const shouldRespond = botMentioned || isDM || isRobotChannel;

    try {
      // Always process the full message for passive observation
      const fullMessage = message.content;
      
      // Clean message for response (remove bot mentions)
      const cleanMessage = message.content
        .replace(`<@${client.user!.id}>`, '')
        .replace(`<@!${client.user!.id}>`, '')
        .trim();

      // Deduplication check: prevent processing the same message twice
      const messageKey = `${message.author.id}-${fullMessage}-${message.channelId}`;
      const now = Date.now();
      
      // Clean up old cache entries
      for (const [key, timestamp] of messageCache.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          messageCache.delete(key);
        }
      }
      
      // Check if we've seen this exact message recently
      if (messageCache.has(messageKey)) {
        logger.info(`🚫 Duplicate message detected, skipping: ${messageKey}`);
        return;
      }
      
      // Cache this message
      messageCache.set(messageKey, now);

      // Handle response vs passive observation
      if (shouldRespond) {
        logger.info(`Will respond to message from ${message.author.tag}: ${cleanMessage}`);
        
        // Start typing indicator and process with job tracking
        await handleResponseWithJobTracking(message, cleanMessage);
      } else {
        logger.info(`Passive observation of message from ${message.author.tag} in #${message.channel.type === 0 && 'name' in message.channel ? message.channel.name : 'DM'}`);
        
        // Still process for passive observation using queue system
        await publishMessage(
          message.author.id,
          fullMessage,
          message.channelId,
          message.author.tag,
          false // Don't respond, just observe
        );
      }

    } catch (error) {
      logger.error('Error handling Discord message:', error);
      await message.reply('Sorry, I encountered an error processing your message.');
    }
  });
}

/**
 * Handle Discord message with job tracking and live updates
 */
async function handleResponseWithJobTracking(message: Message, cleanMessage: string): Promise<void> {
  let typingInterval: NodeJS.Timeout | null = null;
  let statusMessage: Message | null = null;

  try {
    // Start continuous typing indicator
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
      // Keep typing indicator alive during processing
      typingInterval = setInterval(async () => {
        try {
          if ('sendTyping' in message.channel) {
            await message.channel.sendTyping();
          }
        } catch (error) {
          logger.error('Failed to send typing indicator:', error);
        }
      }, 8000); // Refresh every 8 seconds (Discord typing lasts 10 seconds)
    }

    // Submit job and get immediate response
    const jobInfo = await capabilitiesClient.submitJob(cleanMessage, message.author.id);
    logger.info(`🤖 Job ${jobInfo.messageId} submitted for Discord user ${message.author.tag}`);

    // Send initial status message
    statusMessage = await message.reply(`🤔 Working on it... (Job: \`${jobInfo.messageId.slice(-8)}\`)`);

    let lastStatus = 'pending';
    let updateCount = 0;

    // Poll for completion with live updates
    const result = await capabilitiesClient.pollJobUntilComplete(jobInfo.messageId, {
      maxAttempts: 60, // 5 minutes max
      pollInterval: 3000, // 3 seconds for responsive Discord UX
      
      onProgress: async (status) => {
        try {
          // Only update if status changed or every 5th poll (to show it's alive)
          const shouldUpdate = status.status !== lastStatus || (updateCount % 5 === 0);
          
          if (shouldUpdate && statusMessage) {
            const processingTime = Math.round(status.processingTime / 1000);
            const statusEmoji = status.status === 'processing' ? '🔄' : '🤔';
            const newContent = `${statusEmoji} ${status.status}... (${processingTime}s, Job: \`${jobInfo.messageId.slice(-8)}\`)`;
            
            await statusMessage.edit(newContent);
            lastStatus = status.status;
          }
          updateCount++;
        } catch (error) {
          logger.error('Failed to update status message:', error);
        }
      },

      onComplete: async (result) => {
        try {
          // Stop typing and clear status message
          if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
          }

          if (statusMessage) {
            // Edit status message to show completion, then send result
            await statusMessage.edit(`✅ Complete! (Job: \`${jobInfo.messageId.slice(-8)}\`)`);
            
            // Send the actual result as a new message
            if ('send' in message.channel) {
              await message.channel.send(result);
            } else {
              await message.reply(result);
            }
          } else {
            // Fallback if status message failed
            await message.reply(result);
          }

          logger.info(`✅ Discord job ${jobInfo.messageId} completed for ${message.author.tag}`);
        } catch (error) {
          logger.error('Failed to send completion message:', error);
          // Fallback: try to reply directly
          try {
            await message.reply(`✅ ${result}`);
          } catch (fallbackError) {
            logger.error('Fallback reply also failed:', fallbackError);
          }
        }
      },

      onError: async (error) => {
        try {
          // Stop typing
          if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
          }

          // Update status message with error
          if (statusMessage) {
            await statusMessage.edit(`❌ Error: ${error} (Job: \`${jobInfo.messageId.slice(-8)}\`)`);
          } else {
            await message.reply(`❌ Sorry, something went wrong: ${error}`);
          }

          logger.error(`❌ Discord job ${jobInfo.messageId} failed for ${message.author.tag}: ${error}`);
        } catch (updateError) {
          logger.error('Failed to send error message:', updateError);
        }
      }
    });

  } catch (error) {
    // Clean up on any error
    if (typingInterval) {
      clearInterval(typingInterval);
    }

    logger.error('Job tracking failed for Discord message:', error);

    try {
      if (statusMessage) {
        await statusMessage.edit(`❌ Failed to process: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        await message.reply(`❌ Sorry, I couldn't process your message: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (replyError) {
      logger.error('Failed to send error reply:', replyError);
    }
  }
}