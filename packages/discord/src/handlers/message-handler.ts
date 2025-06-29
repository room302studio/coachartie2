import { Client, Events, Message } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';

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

      // Always process for passive observation (memory formation, capability extraction)
      await publishMessage(
        message.author.id,
        fullMessage, // Use full message for passive observation
        message.channelId,
        message.author.tag,
        shouldRespond // Pass whether we should actually respond
      );

      // Only show user-facing indicators if we're going to respond
      if (shouldRespond) {
        logger.info(`Will respond to message from ${message.author.tag}: ${cleanMessage}`);
        
        // Send typing indicator (only if channel supports it and we're responding)
        if ('sendTyping' in message.channel) {
          await message.channel.sendTyping();
        }
      } else {
        logger.info(`Passive observation of message from ${message.author.tag} in #${message.channel.type === 0 && 'name' in message.channel ? message.channel.name : 'DM'}`);
      }

    } catch (error) {
      logger.error('Error handling Discord message:', error);
      await message.reply('Sorry, I encountered an error processing your message.');
    }
  });
}