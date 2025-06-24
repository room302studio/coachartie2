import { Client, Events, Message } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';

export function setupMessageHandler(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Debug: Log all incoming messages
    logger.info(`DEBUG: Received message - Author: ${message.author.tag}, Channel Type: ${message.channel.type}, Content: ${message.content}`);
    
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if bot was mentioned or if it's a DM
    const botMentioned = message.mentions.has(client.user!.id);
    const isDM = message.channel.isDMBased();

    if (!botMentioned && !isDM) return;

    try {
      // Remove bot mention from message
      const cleanMessage = message.content
        .replace(`<@${client.user!.id}>`, '')
        .replace(`<@!${client.user!.id}>`, '')
        .trim();

      if (!cleanMessage) return;

      logger.info(`Received message from ${message.author.tag}: ${cleanMessage}`);

      // Send typing indicator (only if channel supports it)
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }

      // Publish to queue
      await publishMessage(
        message.author.id,
        cleanMessage,
        message.channelId,
        message.author.tag
      );

    } catch (error) {
      logger.error('Error handling Discord message:', error);
      await message.reply('Sorry, I encountered an error processing your message.');
    }
  });
}