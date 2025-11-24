import * as irc from 'irc-framework';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';

// Message deduplication cache
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of messageCache.entries()) {
    if (now - timestamp > MESSAGE_CACHE_TTL) {
      messageCache.delete(key);
    }
  }
}, MESSAGE_CACHE_TTL);

export function setupMessageHandler(client: irc.Client) {
  // Handle private messages (DMs)
  client.on('privmsg', async (event) => {
    try {
      // Skip if this is our own message
      if (event.nick === client.user.nick) {
        return;
      }

      // Create message ID for deduplication
      const messageId = `${event.nick}-${event.time || Date.now()}-${event.message}`;
      const now = Date.now();

      // Check for duplicate
      if (messageCache.has(messageId)) {
        logger.debug('Skipping duplicate IRC message', { messageId });
        return;
      }

      // Add to cache
      messageCache.set(messageId, now);

      // Determine if this is a channel message or DM
      const isChannelMessage = event.target.startsWith('#');
      const isDM = !isChannelMessage;

      // Check if bot is mentioned in channel messages
      const botNick = client.user.nick;
      const isMentioned = event.message.toLowerCase().includes(botNick.toLowerCase());

      // Only respond to DMs or messages that mention the bot
      if (!isDM && !isMentioned) {
        logger.debug('Ignoring channel message without mention', {
          channel: event.target,
          from: event.nick,
        });
        return;
      }

      // Remove bot mention from message if present
      let cleanMessage = event.message;
      if (isMentioned) {
        // Remove various mention patterns: @nick, nick:, nick,
        const mentionPatterns = [
          new RegExp(`@?${botNick}:?\\s*`, 'gi'),
          new RegExp(`${botNick},\\s*`, 'gi'),
        ];
        for (const pattern of mentionPatterns) {
          cleanMessage = cleanMessage.replace(pattern, '');
        }
      }
      cleanMessage = cleanMessage.trim();

      // Skip empty messages
      if (!cleanMessage) {
        return;
      }

      logger.info('IRC message received', {
        from: event.nick,
        target: event.target,
        isDM,
        isChannel: isChannelMessage,
        preview: cleanMessage.substring(0, 50),
      });

      // Publish to queue
      await publishMessage({
        userId: event.nick,
        message: cleanMessage,
        context: {
          target: event.target,
          isChannel: isChannelMessage,
          isDM,
          hostname: event.hostname,
          ident: event.ident,
          platform: 'irc',
        },
        respondTo: {
          type: 'irc' as any, // We'll update the type shortly
          channelId: event.target,
          threadId: event.target, // Use target as thread ID for context
        },
      });
    } catch (error) {
      logger.error('Error handling IRC message:', error);
    }
  });

  // Handle errors
  client.on('error', (error) => {
    logger.error('IRC client error:', error);
  });

  // Log joins
  client.on('join', (event) => {
    if (event.nick === client.user.nick) {
      logger.info(`Joined channel: ${event.channel}`);
    }
  });

  // Log parts
  client.on('part', (event) => {
    if (event.nick === client.user.nick) {
      logger.info(`Left channel: ${event.channel}`);
    }
  });

  logger.info('IRC message handler initialized');
}
