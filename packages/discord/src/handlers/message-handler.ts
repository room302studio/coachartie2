/**
 * Discord Message Handler - Core message processing and streaming system
 *
 * This is the main entry point for Discord message handling. It imports utilities
 * from message-utils.ts and data fetchers from discord-fetchers.ts.
 *
 * Features:
 * - Smart response detection (mentions, DMs, robot channels)
 * - Real-time streaming with duplicate prevention
 * - Job tracking with persistent monitoring
 * - Message chunking for Discord's 2000 character limit
 * - Comprehensive telemetry and correlation tracking
 */

import { Client, Events, Message, EmbedBuilder, AttachmentBuilder, ChannelType } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { telemetry } from '../services/telemetry.js';
import {
  CorrelationContext,
  generateCorrelationId,
  getShortCorrelationId,
} from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';
import {
  isGuildWhitelisted,
  isWorkingGuild,
  getGuildConfig,
  getChannelPersona,
  shouldRespondToAllInChannel,
  GuildConfig,
} from '../config/guild-whitelist.js';
import { getGitHubIntegrationSafe, isGitHubIntegrationReady } from '../services/github-integration.js';
import { getForumTraversal } from '../services/forum-traversal.js';
import { getMentionProxyService } from '../services/mention-proxy-service.js';
import { quizSessionManager } from '../services/quiz-session-manager.js';

// Import utilities from split modules
import {
  GUILD_CHANNEL_TYPE,
  MAX_JOB_ATTEMPTS,
  STATUS_UPDATE_INTERVAL,
  CHUNK_RATE_LIMIT_DELAY,
  CONTEXT_CLEANUP_PROBABILITY,
  chunkMessage,
  isRobotChannelName,
  isForumThread,
  isDuplicateMessage,
  isProactiveOnCooldown,
  getProactiveCooldownRemaining,
  updateProactiveCooldown,
} from './message-utils.js';

import {
  getEnhancedGuildContext,
  getDMScratchpad,
  fetchReplyContext,
  fetchChannelHistory,
  fetchRecentAttachments,
  fetchRecentUrls,
  extractUrlsFromContent,
  resolveDiscordMessageLinks,
  handleGitHubAutoExpansion,
  shouldProactivelyAnswer,
} from './discord-fetchers.js';

// =============================================================================
// MAIN MESSAGE HANDLER SETUP
// =============================================================================

/**
 * Initialize Discord message handler with smart response detection
 *
 * Handles:
 * - Message deduplication
 * - Response condition detection (mentions, DMs, robot channels)
 * - Active response vs passive observation
 * - Error handling and telemetry
 *
 * @param client - Discord.js client instance
 */
export function setupMessageHandler(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    // DEBUG: Verify handler is receiving messages
    console.log(`🎯 HANDLER GOT MESSAGE: ${message.author.tag} in ${message.guild?.name || 'DM'}`);

    // -------------------------------------------------------------------------
    // CORRELATION & LOGGING SETUP
    // -------------------------------------------------------------------------

    const correlationId = CorrelationContext.getForMessage(message.id);
    const shortId = getShortCorrelationId(correlationId);

    // Structured logging with correlation ID
    logger.info(`📨 Message received [${shortId}]`, {
      correlationId,
      author: message.author.tag,
      userId: message.author.id,
      channelType: message.channel.type,
      channelId: message.channelId,
      messageId: message.id,
      contentLength: message.content.length,
      guildId: message.guildId || 'DM',
    });

    // Track message received
    telemetry.incrementMessagesReceived(message.author.id);
    telemetry.logEvent(
      'message_received',
      {
        channelType: message.channel.type,
        guildId: message.guildId,
        contentLength: message.content.length,
      },
      correlationId,
      message.author.id
    );

    // -------------------------------------------------------------------------
    // RESPONSE CONDITION DETECTION
    // -------------------------------------------------------------------------

    // Ignore our own messages to prevent loops
    if (message.author.id === client.user!.id) return;

    // -------------------------------------------------------------------------
    // PRESENCE CHECK-IN RESPONSE DETECTION
    // -------------------------------------------------------------------------
    // If this is a DM from EJ, capture it for the presence system
    const EJ_USER_ID = '688448399879438340';
    if (message.channel.isDMBased() && message.author.id === EJ_USER_ID) {
      try {
        const { appendFileSync } = await import('fs');
        const PRESENCE_INBOX_PATH = '/app/data/presence-inbox.jsonl';

        const presenceResponse = {
          id: `response-${Date.now()}`,
          content: message.content,
          timestamp: new Date().toISOString(),
          messageId: message.id,
          acknowledged: false,
          // Check if this is a reply to a specific message
          replyTo: message.reference?.messageId || null,
        };

        appendFileSync(PRESENCE_INBOX_PATH, JSON.stringify(presenceResponse) + '\n');
        logger.info(`📍 PRESENCE: Captured EJ's DM response (${presenceResponse.id})`);

        // Continue normal processing - the DM will still get a response from Artie
      } catch (e) {
        logger.warn('📍 PRESENCE: Failed to capture DM response:', e);
      }
    }

    // -------------------------------------------------------------------------
    // QUIZ ANSWER DETECTION
    // -------------------------------------------------------------------------

    // Check if this channel has an active quiz and if this message is an answer
    if (quizSessionManager.hasActiveQuiz(message.channelId)) {
      const result = quizSessionManager.checkAnswer(
        message.channelId,
        message.author.id,
        message.content
      );

      if (result && result.correct) {
        // User got the answer right!
        logger.info(
          `✅ Quiz answer correct! User: ${message.author.tag}, Channel: ${message.channelId}`
        );

        // React to the winning message
        try {
          await message.react('✅');
        } catch (e) {
          logger.warn('Failed to add reaction to quiz answer:', e);
        }

        // Build response
        let response = `✅ **${message.author}** got it! (+1 point)\n`;
        response += `Answer: **${result.correctAnswer}**\n\n`;
        response += `📊 ${quizSessionManager.formatScores(result.currentScores)}\n`;

        if (result.quizEnded) {
          // Quiz is over
          const scores = quizSessionManager.endQuiz(message.channelId);
          if (scores) {
            response += `\n🏁 **Quiz Complete!**\n`;
            const winners = quizSessionManager.getWinners(scores);
            if (winners.length === 1) {
              response += `🎉 **Winner: <@${winners[0]}>!**`;
            } else if (winners.length > 1) {
              response += `🎉 **It's a tie! Winners: ${winners.map((w: string) => `<@${w}>`).join(', ')}**`;
            }
          }
        } else {
          // Move to next question
          const nextSession = await quizSessionManager.nextQuestion(message.channelId);
          if (nextSession && nextSession.currentCard) {
            response += `\n---\n\n`;
            response += `**Question ${nextSession.questionNumber}/${nextSession.totalQuestions}**\n`;
            response += nextSession.currentCard.front;
            if (nextSession.currentCard.hints.length > 0) {
              response += `\n\n_💡 Hints available: ${nextSession.currentCard.hints.length}_`;
            }
          }
        }

        if ('send' in message.channel) {
          await message.channel.send(response);
        }
        return; // Don't process this message further
      }
    }

    // Check guild whitelist - only process messages from whitelisted guilds
    if (message.guildId && !isGuildWhitelisted(message.guildId)) {
      // Check if this is a "watching" guild for passive observation
      const guildConfig = getGuildConfig(message.guildId);
      if (guildConfig?.type === 'watching') {
        logger.debug(
          `👁️ Message from watching guild: ${guildConfig.name} [${shortId}] (observational learning handles these on schedule)`
        );
      } else {
        logger.debug(
          `🚫 Ignoring message from non-whitelisted guild: ${message.guildId} [${shortId}]`
        );
      }
      return;
    }

    // -------------------------------------------------------------------------
    // GITHUB AUTO-EXPANSION (Working Guilds Only)
    // -------------------------------------------------------------------------

    // Auto-expand GitHub URLs in working guilds (only if GitHub integration is ready)
    if (message.guildId && isWorkingGuild(message.guildId) && isGitHubIntegrationReady()) {
      try {
        const githubService = getGitHubIntegrationSafe();
        if (githubService) {
          const expanded = await handleGitHubAutoExpansion(message, githubService);

          if (expanded) {
            logger.info(`✅ GitHub auto-expansion completed [${shortId}]`);
            telemetry.logEvent(
              'github_auto_expansion',
              { guildId: message.guildId },
              correlationId,
              message.author.id
            );
            return; // Don't process message further - auto-expansion handled it
          }
        }
      } catch (error) {
        // Log error but continue with normal message processing
        logger.warn(`GitHub auto-expansion failed [${shortId}]:`, error);
      }
    }

    // -------------------------------------------------------------------------
    // MENTION PROXY DETECTION
    // -------------------------------------------------------------------------

    // Check if this message mentions someone we're representing
    try {
      const proxyService = getMentionProxyService();
      const mentionedUserIds = Array.from(message.mentions.users.keys());

      const matchedRule = proxyService.findMatchingRule(
        message.content,
        mentionedUserIds,
        message.guildId,
        message.channelId
      );

      if (matchedRule) {
        logger.info(`🎭 Proxy rule matched: ${matchedRule.name} [${shortId}]`, {
          correlationId,
          targetUser: matchedRule.targetUsername,
          rule: matchedRule.id,
          hasJudgment: matchedRule.useJudgment,
        });

        // Judgment layer: Should we actually respond?
        if (matchedRule.useJudgment) {
          logger.info(`⚖️ Running judgment layer for proxy rule [${shortId}]`);

          const shouldRespond = await proxyService.judgeIfShouldRespond(
            message,
            matchedRule,
            client
          );

          if (!shouldRespond) {
            logger.info(`⚖️ Judgment layer: SKIP - Active conversation detected [${shortId}]`);
            telemetry.logEvent(
              'mention_proxy_judgment_skip',
              {
                ruleId: matchedRule.id,
                ruleName: matchedRule.name,
                targetUserId: matchedRule.targetUserId,
                guildId: message.guildId,
              },
              correlationId,
              message.author.id
            );
            return; // Don't respond - user is in active conversation
          }

          logger.info(`⚖️ Judgment layer: PROCEED - Standalone mention [${shortId}]`);
        }

        telemetry.logEvent(
          'mention_proxy_triggered',
          {
            ruleId: matchedRule.id,
            ruleName: matchedRule.name,
            targetUserId: matchedRule.targetUserId,
            guildId: message.guildId,
            usedJudgment: matchedRule.useJudgment,
          },
          correlationId,
          message.author.id
        );

        // Get the clean message (remove mentions)
        const cleanMessage = message.content
          .replace(new RegExp(`<@!?${matchedRule.targetUserId}>`, 'g'), '')
          .trim();

        // Process using existing intent handler with proxy context
        await handleMessageAsIntent(
          message,
          cleanMessage,
          correlationId,
          {
            isProxyResponse: true,
            proxyRule: matchedRule,
            proxyContext: proxyService.getSystemContext(matchedRule),
            proxyPrefix: proxyService.getResponsePrefix(matchedRule, matchedRule.targetUsername),
          },
          undefined, // guildContext
          false, // isProactiveAnswer
          'groupchat', // conversationMode - proxies happen in guilds
          undefined // channelPersonaName
        );

        return; // Don't process as normal message
      }
    } catch (error) {
      logger.warn(`Mention proxy detection failed [${shortId}]:`, error);
      // Continue with normal message processing
    }

    // -------------------------------------------------------------------------
    // NORMAL RESPONSE CONDITIONS
    // -------------------------------------------------------------------------

    // Check various response triggers
    const isForum = await isForumThread(message);
    const guildConfig = getGuildConfig(message.guildId);
    const responseConditions = {
      botMentioned: message.mentions.has(client.user!.id),
      isDM: message.channel.isDMBased(),
      isRobotChannel: isRobotChannelName(message.channel),
      isForumThread: isForum,
      isProactiveAnswer: false, // Will be set below if applicable
    };

    // Check for proactive answering (guild has it enabled + message looks like a question)
    let proactiveAnswerContext: string | undefined;
    const channelNameDebug = ('name' in message.channel ? message.channel.name : 'DM') || 'unknown';

    // Basic sanity check - at least 3 words to avoid reacting to "lol" or "ok"
    // But let the LLM judgment decide whether to actually respond
    const wordCount = message.content.trim().split(/\s+/).length;
    const meetsMinimumLength = wordCount >= 3;
    const isQuestion = meetsMinimumLength; // Let LLM decide, don't regex-gatekeep

    logger.info(
      `🔍 Proactive check: guild=${guildConfig?.name || 'none'}, channel=#${channelNameDebug}, proactive=${guildConfig?.proactiveAnswering}, wordCount=${wordCount}, looksLikeQuestion=${isQuestion}, mentioned=${responseConditions.botMentioned} [${shortId}]`
    );

    if (
      guildConfig?.proactiveAnswering &&
      guildConfig.context &&
      !responseConditions.botMentioned && // Don't need proactive check if already mentioned
      !responseConditions.isDM &&
      isQuestion
    ) {
      // Check 1: Channel whitelist - only answer in designated help channels
      const channelName = ('name' in message.channel ? message.channel.name : '') || '';
      const channelNameLower = channelName.toLowerCase();
      const allowedChannels = guildConfig.proactiveChannels || [];
      const isAllowedChannel =
        allowedChannels.length === 0 ||
        allowedChannels.some((ch) => channelNameLower.includes(ch.toLowerCase()));

      if (!isAllowedChannel) {
        logger.info(
          `🚫 Proactive answer skipped - channel #${channelName} not in whitelist [${shortId}]`
        );
      } else if (message.reference && !message.mentions.has(client.user?.id || '')) {
        // Check: Don't interrupt user-to-user conversations
        // If this is a reply to another message and doesn't mention us, skip proactive answering
        // We still observe and learn from these conversations, but don't butt in
        logger.info(
          `🚫 Proactive answer skipped - user is replying to another user, not interrupting [${shortId}]`
        );
      } else {
        // Check 2: Cooldown - don't spam the server
        const cooldownSeconds = guildConfig.proactiveCooldownSeconds || 60;

        if (isProactiveOnCooldown(message.guildId || '', cooldownSeconds)) {
          const remaining = getProactiveCooldownRemaining(message.guildId || '', cooldownSeconds);
          logger.info(
            `⏳ Proactive answer skipped - cooldown (${remaining}s remaining) [${shortId}]`
          );
        } else {
          // Check 3: Conscience/reflection - thoughtful judgment about whether to help
          logger.info(
            `🤔 Checking proactive answer for question in ${guildConfig.name} #${channelName} [${shortId}]`
          );
          const shouldAnswer = await shouldProactivelyAnswer(
            message,
            guildConfig.context,
            correlationId
          );

          if (shouldAnswer) {
            responseConditions.isProactiveAnswer = true;
            proactiveAnswerContext = getEnhancedGuildContext(guildConfig);
            // Update cooldown
            updateProactiveCooldown(message.guildId || '');
            logger.info(
              `✅ Proactive answer approved for ${guildConfig.name} #${channelName} [${shortId}]`
            );
            telemetry.logEvent(
              'proactive_answer_approved',
              { guildId: message.guildId, guildName: guildConfig.name, channel: channelName },
              correlationId,
              message.author.id
            );
          }
        }
      }
    }

    // Determine response mode: active response vs passive observation
    // In forums, only respond when mentioned (too noisy otherwise)
    // In robot channels, skip replies to other users (not the bot) - they're having their own conversation
    const isReplyToOtherUser = message.reference && !responseConditions.botMentioned;
    const shouldRespondInRobotChannel = responseConditions.isRobotChannel && !isReplyToOtherUser;

    if (responseConditions.isRobotChannel && isReplyToOtherUser) {
      logger.info(`🚫 Robot channel: skipping reply to other user [${shortId}]`);
    }

    // Check for channel personas with respondToAll enabled (e.g., Judge Artie in #litigation)
    const channelName =
      message.channel.type === ChannelType.GuildText ||
      message.channel.type === ChannelType.PublicThread
        ? message.channel.name
        : '';
    const channelPersona = getChannelPersona(message.guildId, channelName);
    const isRespondToAllChannel = shouldRespondToAllInChannel(message.guildId, channelName);

    if (isRespondToAllChannel && channelPersona) {
      logger.info(`⚖️ Channel persona active: ${channelPersona.personaName} in #${channelName} [${shortId}]`);
    }

    const shouldRespond =
      responseConditions.botMentioned ||
      responseConditions.isDM ||
      shouldRespondInRobotChannel ||
      responseConditions.isProactiveAnswer ||
      isRespondToAllChannel; // NEW: Respond to all in channels with respondToAll personas

    try {
      // -------------------------------------------------------------------------
      // MESSAGE PROCESSING & DEDUPLICATION
      // -------------------------------------------------------------------------

      const fullMessage = message.content;
      const cleanMessage = message.content
        .replace(`<@${client.user!.id}>`, '') // Remove @bot mentions
        .replace(`<@!${client.user!.id}>`, '') // Remove @bot nickname mentions
        .trim();

      // Deduplication: prevent processing identical messages within TTL window
      if (isDuplicateMessage(message.author.id, fullMessage, message.channelId)) {
        logger.info(`🚫 Duplicate message detected [${shortId}]`, { correlationId });
        telemetry.logEvent('message_duplicate', {}, correlationId, message.author.id);
        return;
      }

      // -------------------------------------------------------------------------
      // RESPONSE ROUTING
      // -------------------------------------------------------------------------

      if (shouldRespond) {
        // ACTIVE RESPONSE: Bot will generate and send a response
        const triggerType = responseConditions.botMentioned
          ? 'mention'
          : responseConditions.isDM
            ? 'dm'
            : responseConditions.isProactiveAnswer
              ? 'proactive_answer'
              : isRespondToAllChannel
                ? `channel_persona:${channelPersona?.personaName || 'unknown'}`
                : 'robot_channel';

        logger.info(`🤖 Will respond to message [${shortId}] (trigger: ${triggerType})`, {
          correlationId,
          author: message.author.tag,
          cleanMessage: cleanMessage.substring(0, 100) + (cleanMessage.length > 100 ? '...' : ''),
        });

        telemetry.logEvent(
          'message_will_respond',
          {
            messageLength: cleanMessage.length,
            triggerType,
          },
          correlationId,
          message.author.id
        );

        // Process with unified intent processor
        // Always pass guild context if available (not just for proactive answers)
        let guildContextToPass = proactiveAnswerContext || getEnhancedGuildContext(guildConfig);

        // If there's a channel persona (e.g., Judge Artie), prepend its system prompt
        if (channelPersona?.systemPrompt) {
          const personaContext = `🎭 CHANNEL PERSONA: ${channelPersona.personaName}

${channelPersona.systemPrompt}

---
`;
          guildContextToPass = guildContextToPass
            ? personaContext + guildContextToPass
            : personaContext;
          logger.info(`⚖️ Injecting ${channelPersona.personaName} persona context [${shortId}]`);
        }

        // Determine conversation mode for context
        const conversationMode = responseConditions.isDM
          ? 'personal'
          : channelPersona
            ? 'persona'
            : 'groupchat';

        await handleMessageAsIntent(
          message,
          cleanMessage,
          correlationId,
          undefined,
          guildContextToPass,
          responseConditions.isProactiveAnswer || isRespondToAllChannel,
          conversationMode,
          channelPersona?.personaName
        );
      } else {
        // PASSIVE OBSERVATION: Only process for learning if channel is whitelisted
        const channelName =
          message.channel.type === GUILD_CHANNEL_TYPE && 'name' in message.channel
            ? message.channel.name
            : 'DM';

        // Check if this channel is in the observation whitelist
        const observationChannels = guildConfig?.observationChannels || [];
        const shouldObserve =
          observationChannels.length === 0 ||
          observationChannels.some((c) => channelName.toLowerCase().includes(c.toLowerCase()));

        if (shouldObserve) {
          logger.info(`👁️ Passive observation [${shortId}]`, {
            correlationId,
            author: message.author.tag,
            channel: channelName,
          });

          telemetry.logEvent(
            'message_observed',
            {
              channelName,
              messageLength: fullMessage.length,
            },
            correlationId,
            message.author.id
          );

          // Process for passive observation using queue system
          await publishMessage(
            message.author.id,
            fullMessage,
            message.channelId,
            message.author.tag,
            false // Don't respond, just observe
          );
        } else {
          logger.debug(`👁️ Skipping observation (channel not whitelisted) [${shortId}]`, {
            correlationId,
            author: message.author.tag,
            channel: channelName,
          });
        }
      }
    } catch (error) {
      logger.error(`❌ Error handling Discord message [${shortId}]:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        author: message.author.tag,
        messageId: message.id,
      });

      telemetry.incrementMessagesFailed(
        message.author.id,
        error instanceof Error ? error.message : String(error)
      );
      telemetry.logEvent(
        'message_error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        correlationId,
        message.author.id,
        undefined,
        false
      );

      // ENHANCED: User-friendly error with transparency
      const errorMsg =
        error instanceof Error && error.message.length < 100
          ? `Sorry, I encountered an error: ${error.message}`
          : 'Sorry, I encountered an error processing your message. The issue has been logged.';

      await message.reply(`❌ ${errorMsg}`);
    }

    // Clean up correlation context periodically
    if (Math.random() < CONTEXT_CLEANUP_PROBABILITY) {
      CorrelationContext.cleanup();
    }
  });
}

// =============================================================================
// MESSAGE INTENT ADAPTER
// =============================================================================

/**
 * Simple adapter: Convert Discord message to UserIntent and delegate to unified processor
 */
async function handleMessageAsIntent(
  message: Message,
  cleanMessage: string,
  correlationId: string,
  proxyOptions?: {
    isProxyResponse: boolean;
    proxyRule: any;
    proxyContext: string;
    proxyPrefix: string;
  },
  guildContext?: string,
  isProactiveAnswer: boolean = false,
  conversationMode: 'personal' | 'persona' | 'groupchat' = 'groupchat',
  channelPersonaName?: string
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);
  let statusMessage: Message | null = null;
  let streamingMessage: Message | null = null;

  try {
    // MINIMAL: No status messages - just start working like a human

    // ENHANCED: Fetch recent channel history for conversational context
    const channelHistory = await fetchChannelHistory(message);
    logger.info(`📜 Fetched ${channelHistory.length} recent messages for context [${shortId}]`);

    const recentAttachments = await fetchRecentAttachments(message);
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

    const recentUrls = await fetchRecentUrls(message);

    // Also extract URLs from the CURRENT message (not just recent ones)
    const currentMessageUrls = extractUrlsFromContent(message.content);

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

    const userInfo = {
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      userTag: message.author.tag,
      isBot: message.author.bot,
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

    // Load per-user DM scratchpad for personal conversations (DMs only)
    const isDM = conversationMode === 'personal';
    const dmScratchpad = isDM
      ? getDMScratchpad(message.author.id, message.author.username)
      : null;

    if (dmScratchpad) {
      logger.info(`📝 Loaded DM scratchpad for ${message.author.username} [${shortId}]`);
    }

    const discordContext = {
      platform: 'discord',
      conversationMode, // 'personal' (DM), 'persona' (Judge Artie etc), 'groupchat' (normal)
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
      // DM-specific scratchpad for personal conversations
      ...(dmScratchpad
        ? {
            dmScratchpad: {
              path: dmScratchpad.path,
              content: dmScratchpad.content,
              instructions: `📝 YOUR PRIVATE NOTES ABOUT THIS PERSON:
${dmScratchpad.content}

To add notes about this person:
<append path="${dmScratchpad.path}">
## ${new Date().toISOString().split('T')[0]} - Note Title
Your observation here
</append>

To update their profile section:
<write path="${dmScratchpad.path}">full updated content</write>`,
            },
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

        // Response handlers
        respond: async (content: string): Promise<void> => {
          // Check if LLM chose to stay silent
          const trimmedContent = content.trim();
          if (
            !trimmedContent ||
            trimmedContent === '[SILENT]' ||
            trimmedContent.toLowerCase() === '[silent]'
          ) {
            logger.info(`🤫 DISCORD: LLM chose to stay silent [${shortId}]`);
            return;
          }

          logger.info(`📨 DISCORD RESPOND [${shortId}]:`, {
            correlationId,
            contentLength: content.length,
            contentPreview: content.substring(0, 100),
            messageId: message.id,
            channelId: message.channelId,
            isProxy: proxyOptions?.isProxyResponse,
          });

          // Add proxy prefix if this is a proxy response
          const fullContent = proxyOptions?.proxyPrefix
            ? `${proxyOptions.proxyPrefix}${content}`
            : content;

          const chunks = chunkMessage(fullContent);
          logger.info(`📨 DISCORD: Sending ${chunks.length} chunks [${shortId}]`);

          const responseMessage = await message.reply(chunks[0]);
          logger.info(`✅ DISCORD: Sent first chunk (reply) [${shortId}]`, {
            responseMessageId: responseMessage.id,
            chunkLength: chunks[0].length,
          });

          // Store reference for potential editing
          if (!streamingMessage) {
            streamingMessage = responseMessage;
          }

          // Send additional chunks
          for (let i = 1; i < chunks.length; i++) {
            if ('send' in message.channel) {
              logger.info(`📨 DISCORD: Sending chunk ${i + 1}/${chunks.length} [${shortId}]`);
              await (message.channel as any).send(chunks[i]);
              await new Promise((resolve) => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
            }
          }

          telemetry.incrementResponsesDelivered(message.author.id, chunks.length);
          logger.info(`✅ DISCORD: All ${chunks.length} chunks delivered [${shortId}]`);
        },

        // ENHANCED: Edit response capability for cleaner streaming
        editResponse: async (content: string) => {
          logger.info(`✏️ DISCORD EDIT RESPONSE [${shortId}]:`, {
            correlationId,
            contentLength: content.length,
            contentPreview: content.substring(0, 100),
            hasStreamingMessage: !!streamingMessage,
            streamingMessageId: streamingMessage?.id,
          });

          if (!streamingMessage) {
            logger.warn(`No streaming message to edit [${shortId}]`);
            return;
          }

          try {
            // Discord has 2000 char limit for edits too
            const truncatedContent =
              content.length > 2000 ? content.slice(0, 1997) + '...' : content;

            logger.info(`✏️ DISCORD: Editing message ${streamingMessage.id} [${shortId}]`);
            await streamingMessage.edit(truncatedContent);
            logger.info(`✅ DISCORD: Message edited successfully [${shortId}]`);

            telemetry.logEvent(
              'message_edited',
              {
                contentLength: content.length,
                truncated: content.length > 2000,
              },
              correlationId,
              message.author.id
            );
          } catch (error) {
            logger.error(`❌ DISCORD: Failed to edit message [${shortId}]:`, error);
            throw error;
          }
        },

        updateProgress: statusMessage
          ? async (status: string) => {
              const msg = statusMessage as Message;
              await msg.edit(status);
            }
          : undefined,

        sendTyping:
          'sendTyping' in message.channel
            ? async () => {
                await (message.channel as any).sendTyping();
                telemetry.incrementTypingIndicators();
              }
            : undefined,

        // ENHANCED: Discord-native reaction support
        addReaction: async (emoji: string) => {
          try {
            await message.react(emoji);
            telemetry.logEvent('reaction_added', { emoji }, correlationId, message.author.id);
          } catch (error) {
            logger.warn(`Failed to add reaction ${emoji} [${shortId}]:`, error);
          }
        },

        removeReaction: async (emoji: string) => {
          try {
            const reaction = message.reactions.cache.get(emoji);
            if (reaction) {
              await reaction.users.remove(message.client.user!.id);
              telemetry.logEvent('reaction_removed', { emoji }, correlationId, message.author.id);
            }
          } catch (error) {
            logger.warn(`Failed to remove reaction ${emoji} [${shortId}]:`, error);
          }
        },

        // ENHANCED: Thread creation for complex conversations
        createThread: async (threadName: string) => {
          try {
            if (message.channel.type === 0 && 'threads' in message.channel) {
              // Guild text channel
              const thread = await message.startThread({
                name: threadName,
                autoArchiveDuration: 60, // Auto-archive after 1 hour of inactivity
                reason: 'Complex conversation - keeping channel organized',
              });

              // Add thread reaction to original message
              await message.react('🧵');

              telemetry.logEvent(
                'thread_created',
                {
                  threadName,
                  threadId: thread.id,
                },
                correlationId,
                message.author.id
              );

              logger.info(`Created thread "${threadName}" [${shortId}]`);
              return thread;
            }
          } catch (error) {
            logger.warn(`Failed to create thread "${threadName}" [${shortId}]:`, error);
          }
          return null;
        },

        // ENHANCED: Rich embed support
        sendEmbed: async (embedData: any) => {
          try {
            const embed = new EmbedBuilder(embedData);
            await message.reply({ embeds: [embed] });
            telemetry.logEvent(
              'embed_sent',
              {
                title: embedData.title,
                fieldCount: embedData.fields?.length || 0,
              },
              correlationId,
              message.author.id
            );
          } catch (error) {
            logger.warn(`Failed to send embed [${shortId}]:`, error);
          }
        },

        // Send file attachment
        sendFile: async (fileData: { buffer: Buffer; filename: string; content?: string }) => {
          try {
            const attachment = new AttachmentBuilder(fileData.buffer, { name: fileData.filename });
            await message.reply({
              content: fileData.content || `📎 Here's your file: ${fileData.filename}`,
              files: [attachment],
            });
            telemetry.logEvent(
              'file_sent',
              {
                filename: fileData.filename,
                size: fileData.buffer.length,
              },
              correlationId,
              message.author.id
            );
            logger.info(
              `📎 Sent file ${fileData.filename} (${fileData.buffer.length} bytes) [${shortId}]`
            );
          } catch (error) {
            logger.warn(`Failed to send file [${shortId}]:`, error);
          }
        },

        updateProgressEmbed: statusMessage
          ? async (embedData: any) => {
              try {
                const msg = statusMessage as Message;
                const embed = new EmbedBuilder(embedData);
                await msg.edit({ embeds: [embed] });
                telemetry.logEvent(
                  'embed_updated',
                  {
                    title: embedData.title,
                  },
                  correlationId,
                  message.author.id
                );
              } catch (error) {
                logger.warn(`Failed to update progress embed [${shortId}]:`, error);
              }
            }
          : undefined,
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
      // statusMessage is always null in current implementation
      await message.reply(`❌ Sorry, I couldn't process your message`);
    } catch (replyError) {
      logger.error(`Failed to send error reply [${shortId}]:`, replyError);
    }
  }
}
