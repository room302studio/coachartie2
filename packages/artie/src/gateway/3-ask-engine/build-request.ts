/**
 * Build request: turn one Discord message (plus its channel window, links, reply and forum
 * context) into the engine turn request, and hand it to stream-reply with the Discord
 * delivery hooks. Moved verbatim out of on-message.ts (wave 5): this was
 * handleMessageAsIntent.
 */

import type { Message } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { getShortCorrelationId } from '../correlation.js';
import { processUserIntent } from '../4-reply/stream-reply.js';
import { createDiscordReplyHandlers, type ProxyOptions } from '../4-reply/discord-reply.js';
import {
  fetchReplyContext,
  fetchChannelHistory,
  fetchRecentAttachments,
  fetchRecentUrls,
  fetchChannelWindow,
  isForumThread,
} from '../1-receive/channel-history.js';
import { resolveDiscordMessageLinks } from '../1-receive/expand-links.js';

const MAX_JOB_ATTEMPTS = 100; // ~5 minute max job timeout (100 * 3s checks) - allows for large metro files
const STATUS_UPDATE_INTERVAL = 5; // Update status every 5 progress callbacks

/**
 * Simple adapter: Convert Discord message to UserIntent and delegate to unified processor
 * Replaces ~400 lines of duplicate logic with ~30 lines of adapter code
 */
export async function handleMessageAsIntent(
  message: Message,
  cleanMessage: string,
  correlationId: string,
  proxyOptions?: ProxyOptions,
  guildContext?: string,
  isProactiveAnswer: boolean = false
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);

  try {
    // MINIMAL: No status messages - just start working like a human

    const prefetchedChannel = await fetchChannelWindow(message, shortId);

    const channelHistory = await fetchChannelHistory(message, prefetchedChannel);
    logger.info(`📜 Fetched ${channelHistory.length} recent messages for context [${shortId}]`);

    const recentAttachments = await fetchRecentAttachments(message, prefetchedChannel);
    if (recentAttachments.length > 0) {
      logger.info(`📎 Found ${recentAttachments.length} recent attachments [${shortId}]`);
    }

    // Check for .metro files - affects typing behavior
    const hasMetroFile = Array.from(message.attachments.values()).some((att) =>
      att.name?.toLowerCase().endsWith('.metro')
    );

    // DEBUG: Log current message attachments
    if (message.attachments.size > 0) {
      logger.info(`📎 Current message has ${message.attachments.size} attachments [${shortId}]`, {
        attachments: Array.from(message.attachments.values()).map((att) => ({
          name: att.name,
          url: att.url?.substring(0, 50) + '...',
          contentType: att.contentType,
        })),
      });

      // React with 👀 if there's a .metro file - shows we saw it
      if (hasMetroFile) {
        try {
          await message.react('👀');
        } catch (e) {
          logger.warn(`Failed to add 👀 reaction for metro file [${shortId}]`);
        }
      }
    }

    const recentUrls = await fetchRecentUrls(message, prefetchedChannel);

    // Also extract URLs from the CURRENT message (not just recent ones)
    const currentMessageUrls: string[] = [];
    for (const token of message.content.split(/\s+/)) {
      try {
        const parsed = new URL(token);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          currentMessageUrls.push(parsed.toString());
        }
      } catch {
        // not a URL
      }
    }

    // Combine current + recent URLs (current first, dedupe)
    const allUrls = [
      ...currentMessageUrls,
      ...recentUrls.filter((u) => !currentMessageUrls.includes(u)),
    ];
    if (allUrls.length > 0) {
      logger.info(
        `🔗 Found ${allUrls.length} URLs (${currentMessageUrls.length} current, ${recentUrls.length} recent) [${shortId}]`
      );
    }

    // Resolve Discord message links to their actual content
    const resolvedDiscordMessages = await resolveDiscordMessageLinks(allUrls, message);
    if (resolvedDiscordMessages.length > 0) {
      logger.info(
        `🔗 Resolved ${resolvedDiscordMessages.length} Discord message links [${shortId}]`
      );
    }

    // ENHANCED: Fetch reply context if this is a reply
    const replyContext = await fetchReplyContext(message);
    if (replyContext) {
      logger.info(
        `💬 Fetched reply context from @${replyContext.author} [${shortId}]: "${replyContext.content.substring(0, 50)}..."`
      );
    }

    // ENHANCED: Gather Discord context for Context Alchemy
    const guildInfo = message.guild
      ? {
          guildId: message.guild.id,
          guildName: message.guild.name,
          memberCount: message.guild.memberCount,
        }
      : null;

    const channelInfo = {
      channelId: message.channelId,
      channelType: message.channel.type,
      channelName: 'name' in message.channel ? message.channel.name : 'DM',
    };

    const memberRoleNames = message.member
      ? message.member.roles.cache.map((r) => r.name).filter((n) => n && n !== '@everyone')
      : [];
    const userInfo = {
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      userTag: message.author.tag,
      isBot: message.author.bot,
      roles: memberRoleNames,
    };

    // ENHANCED: Forum-specific metadata
    const forumInfo = await (async () => {
      const isForum = await isForumThread(message);
      if (!isForum) return null;

      const thread = message.channel;
      if (!('parent' in thread)) return null;

      return {
        isForumThread: true,
        forumId: thread.parent?.id,
        forumName: thread.parent?.name,
        threadId: thread.id,
        threadName: thread.name,
        threadTags: 'appliedTags' in thread ? thread.appliedTags : [],
        threadCreatedAt: thread.createdAt?.toISOString(),
        threadMessageCount: 'messageCount' in thread ? thread.messageCount : null,
        isThreadOwner: 'ownerId' in thread && thread.ownerId === message.author.id,
      };
    })();

    const discordContext = {
      platform: 'discord',
      ...guildInfo,
      ...channelInfo,
      ...userInfo,
      ...forumInfo,
      messageId: message.id,
      timestamp: message.createdAt.toISOString(),
      hasAttachments: message.attachments.size > 0,
      recentAttachments,
      recentUrls,
      resolvedDiscordMessages, // Discord message links resolved to their actual content
      // DEBUG: Log attachment counts for troubleshooting
      _debug_currentAttachmentCount: message.attachments.size,
      _debug_recentAttachmentCount: recentAttachments.length,
      // Pass Discord channel history - source of truth for DMs (includes webhook/n8n messages)
      channelHistory,
      mentionedUsers: message.mentions.users.size,
      mentions: Array.from(message.mentions.users.entries()).map(([id, user]) => ({
        id,
        username: user.username,
        displayName: user.displayName || user.username,
      })),
      attachments:
        message.attachments.size > 0
          ? Array.from(message.attachments.values()).map((att) => ({
              id: att.id,
              name: att.name,
              url: att.url,
              contentType: att.contentType,
              size: att.size,
              proxyUrl: att.proxyURL,
            }))
          : [],
      replyingTo: message.reference?.messageId || null,
      // Reply context - the message being replied to
      ...(replyContext
        ? {
            replyContext: {
              messageId: replyContext.messageId,
              author: replyContext.author,
              content: replyContext.content,
              timestamp: replyContext.timestamp,
            },
          }
        : {}),
      // Proxy context if this is a proxy response
      ...(proxyOptions?.isProxyResponse
        ? {
            isProxyResponse: true,
            proxyTargetUser: proxyOptions.proxyRule.targetUsername,
            proxyRuleName: proxyOptions.proxyRule.name,
            proxySystemContext: proxyOptions.proxyContext,
          }
        : {}),
      // Guild-specific context (always pass if available, not just for proactive answers)
      ...(guildContext
        ? {
            isProactiveAnswer,
            guildKnowledge: guildContext,
          }
        : {}),
    };

    // Create unified intent and delegate to shared processor
    await processUserIntent(
      {
        content: cleanMessage,
        userId: message.author.id,
        username: message.author.username,
        source: 'message',
        context: discordContext, // Pass rich Discord context
        metadata: {
          messageId: message.id,
          channelId: message.channelId,
          guildId: message.guildId,
          correlationId,
        },

        ...createDiscordReplyHandlers(message, correlationId, shortId, proxyOptions),
      },
      {
        enableStreaming: true, // Enable streaming for messages
        enableTyping: !hasMetroFile, // No typing during file processing - just 👀 reaction
        enableReactions: false, // MINIMAL: No emoji reactions
        enableEditing: true, // Enable message editing for cleaner streaming
        enableThreading: false, // MINIMAL: No auto-threading
        maxAttempts: MAX_JOB_ATTEMPTS,
        statusUpdateInterval: STATUS_UPDATE_INTERVAL,
      }
    );

    // MINIMAL: No final status updates
  } catch (error) {
    logger.error(`Message intent processing failed [${shortId}]:`, error);

    // Fallback error handling
    try {
      await message.reply(`❌ Sorry, I couldn't process your message`);
    } catch (replyError) {
      logger.error(`Failed to send error reply [${shortId}]:`, replyError);
    }
  }
}
