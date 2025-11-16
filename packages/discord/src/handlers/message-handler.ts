/**
 * Discord Message Handler - Core message processing and streaming system
 *
 * Features:
 * - Smart response detection (mentions, DMs, robot channels)
 * - Real-time streaming with duplicate prevention
 * - Job tracking with persistent monitoring
 * - Message chunking for Discord's 2000 character limit
 * - Comprehensive telemetry and correlation tracking
 */

import { Client, Events, Message, EmbedBuilder, ChannelType } from 'discord.js';
import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { telemetry } from '../services/telemetry.js';
import {
  CorrelationContext,
  generateCorrelationId,
  getShortCorrelationId,
} from '../utils/correlation.js';
import { processUserIntent } from '../services/user-intent-processor.js';
import { isGuildWhitelisted, isWorkingGuild, getGuildConfig } from '../config/guild-whitelist.js';
import { getConversationState } from '../services/conversation-state.js';
import { getGitHubIntegration } from '../services/github-integration.js';
import { getForumTraversal } from '../services/forum-traversal.js';
import { getMentionProxyService } from '../services/mention-proxy-service.js';
import Chance from 'chance';

const chance = new Chance();

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

// Message deduplication cache to prevent duplicate processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds TTL

// Discord API limits and timeouts
const TYPING_REFRESH_INTERVAL = 8000; // Refresh typing every 8s (Discord typing lasts 10s)
const CHUNK_RATE_LIMIT_DELAY = 200; // 200ms delay between message chunks
const MAX_JOB_ATTEMPTS = 60; // 5 minute max job timeout (60 * 3s checks)
const DISCORD_MESSAGE_LIMIT = 2000; // Discord's maximum message length

// UI and status constants
const STATUS_UPDATE_INTERVAL = 5; // Update status every 5 progress callbacks
const CONTEXT_CLEANUP_PROBABILITY = 0.01; // 1% chance to cleanup correlation context
const ID_SLICE_LENGTH = -8; // Last 8 characters for job short IDs

// Channel detection constants
const GUILD_CHANNEL_TYPE = 0; // Discord guild text channel type

// Channel history fetching constants
const MIN_CHANNEL_HISTORY = 10; // Minimum messages to fetch
const MAX_CHANNEL_HISTORY = 25; // Maximum messages to fetch

// Status emojis
const STATUS_EMOJI_PROCESSING = '🔄';
const STATUS_EMOJI_THINKING = '🤔';
const STREAM_EMOJI = '📡';

// =============================================================================
// MESSAGE CHUNKING UTILITIES
// =============================================================================

/**
 * Helper: Check if channel name indicates robot interaction
 */
function isRobotChannelName(channel: Message['channel']): boolean {
  return (
    (channel.type === GUILD_CHANNEL_TYPE &&
      'name' in channel &&
      (channel.name?.includes('🤖') || channel.name?.includes('robot'))) ||
    false
  );
}

/**
 * Helper: Check if message is in a forum thread (Discord Discussions)
 */
async function isForumThread(message: Message): Promise<boolean> {
  if (
    message.channel.type !== ChannelType.PublicThread &&
    message.channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }

  // Get the parent channel to check if it's a forum
  const parent = message.channel.parent;
  return parent?.type === ChannelType.GuildForum;
}

/**
 * Split long messages into Discord-compatible chunks
 * First splits on intentional breaks (double line breaks), then handles Discord's 2000 char limit
 *
 * @param text - The text to chunk
 * @param maxLength - Maximum chunk size (default: 2000)
 * @returns Array of message chunks
 */
function chunkMessage(text: string, maxLength: number = DISCORD_MESSAGE_LIMIT): string[] {
  // First, split on intentional message breaks (double line breaks)
  // This allows the LLM to control message chunking naturally
  const segments = text.split(/\n\n+/);

  const chunks: string[] = [];

  // Process each segment
  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;

    // If segment fits in Discord limit, use it as-is
    if (trimmedSegment.length <= maxLength) {
      chunks.push(trimmedSegment);
      continue;
    }

    // Segment is too long - split it further by lines, then words if needed
    let currentChunk = '';
    const lines = trimmedSegment.split('\n');

    for (const line of lines) {
      // If adding this line would exceed the limit, start a new chunk
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // If a single line is too long, split it by words
        if (line.length > maxLength) {
          const words = line.split(' ');
          for (const word of words) {
            if (currentChunk.length + word.length + 1 > maxLength) {
              if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
              }
            }
            currentChunk += (currentChunk ? ' ' : '') + word;
          }
        } else {
          currentChunk += (currentChunk ? '\n' : '') + line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Check if we should stream this partial response
 */
function shouldStreamPartialResponse(
  status: any,
  lastSentContent: string,
  channel: Message['channel']
): boolean {
  return !!(
    status.partialResponse &&
    status.partialResponse !== lastSentContent &&
    'send' in channel &&
    typeof channel.send === 'function'
  );
}

/**
 * Send message chunks with rate limiting
 */
async function sendMessageChunks(
  content: string,
  channel: Message['channel'],
  currentChunkCount: number
): Promise<number> {
  const chunks = chunkMessage(content);
  let chunksAdded = 0;

  for (const chunk of chunks) {
    await (channel as any).send(chunk);
    chunksAdded++;

    // Rate limiting: prevent Discord API abuse
    if (currentChunkCount + chunksAdded > 1) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_RATE_LIMIT_DELAY));
    }
  }

  return chunksAdded;
}

/**
 * Check if status message should be updated
 */
function shouldUpdateStatus(
  currentStatus: string,
  lastStatus: string,
  updateCount: number
): boolean {
  return currentStatus !== lastStatus || updateCount % STATUS_UPDATE_INTERVAL === 0;
}

/**
 * Update the status message with current progress
 */
async function updateStatusMessage(
  statusMessage: Message,
  status: any,
  streamedChunks: number,
  shortId: string,
  jobShortId: string
): Promise<void> {
  const statusEmoji =
    status.status === 'processing' ? STATUS_EMOJI_PROCESSING : STATUS_EMOJI_THINKING;
  const streamEmoji = streamedChunks > 0 ? ` ${STREAM_EMOJI}` : '';

  // Human-friendly status messages without technical clutter
  let statusText = status.status === 'processing' ? 'Processing' : 'Working on it';
  const statusContent = `${statusEmoji}${streamEmoji} ${statusText}...`;

  await statusMessage.edit(statusContent);
}

/**
 * Send complete response in chunks
 */
async function sendCompleteResponse(message: Message, result: string): Promise<number> {
  const chunks = chunkMessage(result);
  await message.reply(chunks[0]);

  for (let i = 1; i < chunks.length; i++) {
    if ('send' in message.channel) {
      await (message.channel as any).send(chunks[i]);
    }
  }

  return chunks.length;
}

// =============================================================================
// GITHUB AUTO-EXPANSION
// =============================================================================

/**
 * Auto-expand GitHub URLs in messages (only in working guilds)
 * Returns true if expansion was performed
 */
async function handleGitHubAutoExpansion(
  message: Message,
  githubService: ReturnType<typeof getGitHubIntegration>
): Promise<boolean> {
  try {
    // Detect GitHub URLs in the message
    const detectedUrls = githubService.detectGitHubUrls(message.content);

    if (detectedUrls.length === 0) {
      return false; // No GitHub URLs found
    }

    logger.info(
      `🔍 Detected ${detectedUrls.length} GitHub URL(s) in message from ${message.author.tag}`
    );

    // Expand each detected URL
    for (const detected of detectedUrls) {
      try {
        if (detected.type === 'repo') {
          const repoInfo = await githubService.getRepositoryInfo(detected.owner, detected.repo);
          if (repoInfo) {
            const embed = new EmbedBuilder()
              .setColor(0x2ea44f)
              .setTitle(`📦 ${repoInfo.fullName}`)
              .setURL(repoInfo.url)
              .setDescription(repoInfo.description || 'No description provided');

            const fields = [];

            if (repoInfo.language) {
              fields.push({
                name: 'Language',
                value: repoInfo.language,
                inline: true,
              });
            }

            fields.push({
              name: 'Stars',
              value: `⭐ ${repoInfo.stars.toLocaleString()}`,
              inline: true,
            });

            fields.push({
              name: 'Forks',
              value: `🍴 ${repoInfo.forks.toLocaleString()}`,
              inline: true,
            });

            if (repoInfo.license) {
              fields.push({
                name: 'License',
                value: repoInfo.license,
                inline: true,
              });
            }

            fields.push({
              name: 'Open Issues',
              value: `🐛 ${repoInfo.openIssues.toLocaleString()}`,
              inline: true,
            });

            if (repoInfo.topics.length > 0) {
              fields.push({
                name: 'Topics',
                value: repoInfo.topics.slice(0, 5).join(', '),
                inline: false,
              });
            }

            embed.addFields(fields);
            embed.setFooter({
              text: `Updated ${new Date(repoInfo.updatedAt).toLocaleDateString()}`,
            });

            await message.reply({ embeds: [embed] });
            logger.info(`✅ Auto-expanded repo: ${repoInfo.fullName}`);
          }
        } else if (detected.type === 'pr') {
          const prInfo = await githubService.getPullRequestInfo(
            detected.owner,
            detected.repo,
            detected.number!
          );
          if (prInfo) {
            const stateEmoji = prInfo.state === 'open' ? '🟢' : prInfo.mergedAt ? '🟣' : '🔴';
            const stateText =
              prInfo.state === 'open' ? 'Open' : prInfo.mergedAt ? 'Merged' : 'Closed';

            const embed = new EmbedBuilder()
              .setColor(prInfo.state === 'open' ? 0x2ea44f : prInfo.mergedAt ? 0x6f42c1 : 0xcb2431)
              .setTitle(`${stateEmoji} PR #${prInfo.number}: ${prInfo.title}`)
              .setURL(prInfo.url)
              .setDescription(prInfo.body?.slice(0, 200) || 'No description provided');

            const fields = [
              {
                name: 'Status',
                value: `${stateText}${prInfo.isDraft ? ' (Draft)' : ''}`,
                inline: true,
              },
              {
                name: 'Author',
                value: `@${prInfo.author}`,
                inline: true,
              },
              {
                name: 'Changes',
                value: `+${prInfo.additions} -${prInfo.deletions}`,
                inline: true,
              },
            ];

            if (prInfo.labels.length > 0) {
              fields.push({
                name: 'Labels',
                value: prInfo.labels.slice(0, 3).join(', '),
                inline: false,
              });
            }

            embed.addFields(fields);
            embed.setFooter({
              text: `${prInfo.commits} commit(s) • ${prInfo.changedFiles} file(s)`,
            });

            await message.reply({ embeds: [embed] });
            logger.info(
              `✅ Auto-expanded PR #${prInfo.number} in ${detected.owner}/${detected.repo}`
            );
          }
        } else if (detected.type === 'issue') {
          const issueInfo = await githubService.getIssueInfo(
            detected.owner,
            detected.repo,
            detected.number!
          );
          if (issueInfo) {
            const stateEmoji = issueInfo.state === 'open' ? '🟢' : '🔴';
            const stateText = issueInfo.state === 'open' ? 'Open' : 'Closed';

            const embed = new EmbedBuilder()
              .setColor(issueInfo.state === 'open' ? 0x2ea44f : 0xcb2431)
              .setTitle(`${stateEmoji} Issue #${issueInfo.number}: ${issueInfo.title}`)
              .setURL(issueInfo.url)
              .setDescription(issueInfo.body?.slice(0, 200) || 'No description provided');

            const fields = [
              {
                name: 'Status',
                value: stateText,
                inline: true,
              },
              {
                name: 'Author',
                value: `@${issueInfo.author}`,
                inline: true,
              },
              {
                name: 'Comments',
                value: `💬 ${issueInfo.comments}`,
                inline: true,
              },
            ];

            if (issueInfo.labels.length > 0) {
              fields.push({
                name: 'Labels',
                value: issueInfo.labels.slice(0, 5).join(', '),
                inline: false,
              });
            }

            if (issueInfo.assignees.length > 0) {
              fields.push({
                name: 'Assignees',
                value: issueInfo.assignees
                  .slice(0, 3)
                  .map((a) => `@${a}`)
                  .join(', '),
                inline: false,
              });
            }

            embed.addFields(fields);
            embed.setFooter({
              text: `Created ${new Date(issueInfo.createdAt).toLocaleDateString()}`,
            });

            await message.reply({ embeds: [embed] });
            logger.info(
              `✅ Auto-expanded issue #${issueInfo.number} in ${detected.owner}/${detected.repo}`
            );
          }
        }
      } catch (error) {
        logger.error(`Failed to expand GitHub URL ${detected.url}:`, error);
        // Continue to next URL even if one fails
      }
    }

    return true; // Expansion was performed
  } catch (error) {
    logger.error('GitHub auto-expansion failed:', error);
    return false;
  }
}

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

    // Auto-expand GitHub URLs in working guilds
    if (message.guildId && isWorkingGuild(message.guildId)) {
      try {
        const githubService = getGitHubIntegration();
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
      } catch (error) {
        // Log error but continue with normal message processing
        logger.warn(`GitHub auto-expansion failed [${shortId}]:`, error);
      }
    }

    // -------------------------------------------------------------------------
    // CONVERSATION FLOW HANDLING
    // -------------------------------------------------------------------------

    // Check if user has an active conversation (multi-turn interaction)
    try {
      const conversationState = getConversationState();
      const activeConversation = conversationState.getConversation(message.author.id);

      if (activeConversation && activeConversation.conversationType === 'sync-discussions') {
        await handleSyncDiscussionsConversation(message, activeConversation, conversationState);
        return; // Don't process as normal message
      }
    } catch (error) {
      logger.warn(`Conversation handling failed [${shortId}]:`, error);
      // Continue with normal message processing
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
        await handleMessageAsIntent(message, cleanMessage, correlationId, {
          isProxyResponse: true,
          proxyRule: matchedRule,
          proxyContext: proxyService.getSystemContext(matchedRule),
          proxyPrefix: proxyService.getResponsePrefix(matchedRule, matchedRule.targetUsername),
        });

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
    const responseConditions = {
      botMentioned: message.mentions.has(client.user!.id),
      isDM: message.channel.isDMBased(),
      isRobotChannel: isRobotChannelName(message.channel),
      isForumThread: isForum,
    };

    // Determine response mode: active response vs passive observation
    // In forums, only respond when mentioned (too noisy otherwise)
    const shouldRespond =
      responseConditions.botMentioned ||
      responseConditions.isDM ||
      responseConditions.isRobotChannel;

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
      const messageKey = `${message.author.id}-${fullMessage}-${message.channelId}`;
      const now = Date.now();

      // Cleanup expired cache entries
      for (const [key, timestamp] of messageCache.entries()) {
        if (now - timestamp > MESSAGE_CACHE_TTL) {
          messageCache.delete(key);
        }
      }

      // Skip if we've seen this exact message recently
      if (messageCache.has(messageKey)) {
        logger.info(`🚫 Duplicate message detected [${shortId}]`, { correlationId, messageKey });
        telemetry.logEvent('message_duplicate', { messageKey }, correlationId, message.author.id);
        return;
      }

      // Cache this message to prevent future duplicates
      messageCache.set(messageKey, now);

      // -------------------------------------------------------------------------
      // RESPONSE ROUTING
      // -------------------------------------------------------------------------

      if (shouldRespond) {
        // ACTIVE RESPONSE: Bot will generate and send a response
        logger.info(`🤖 Will respond to message [${shortId}]`, {
          correlationId,
          author: message.author.tag,
          cleanMessage: cleanMessage.substring(0, 100) + (cleanMessage.length > 100 ? '...' : ''),
        });

        telemetry.logEvent(
          'message_will_respond',
          {
            messageLength: cleanMessage.length,
            triggerType: responseConditions.botMentioned
              ? 'mention'
              : responseConditions.isDM
                ? 'dm'
                : 'robot_channel',
          },
          correlationId,
          message.author.id
        );

        // Process with unified intent processor
        await handleMessageAsIntent(message, cleanMessage, correlationId);
      } else {
        // PASSIVE OBSERVATION: Just process for learning, no response
        const channelName =
          message.channel.type === GUILD_CHANNEL_TYPE && 'name' in message.channel
            ? message.channel.name
            : 'DM';
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
// CONVERSATION HANDLERS
// =============================================================================

/**
 * Handle multi-turn conversation for sync-discussions command
 */
async function handleSyncDiscussionsConversation(
  message: Message,
  conversation: any,
  conversationState: any
): Promise<void> {
  const { forumId, forumName, step } = conversation.state;

  if (step !== 'awaiting_repo') {
    // Unknown step, end conversation
    conversationState.endConversation(message.author.id);
    return;
  }

  const repo = message.content.trim();

  try {
    // Get services
    const githubService = getGitHubIntegration();
    const forumTraversal = getForumTraversal();

    // Parse repo reference
    const repoInfo = githubService.parseRepoReference(repo);
    if (!repoInfo) {
      await message.reply({
        content: `❌ Invalid repository format. Please use \`owner/repo\` format (e.g., \`facebook/react\`) or a full GitHub URL.\n\nTry again, or say "cancel" to stop.`,
      });
      return;
    }

    // Check for cancel
    if (repo.toLowerCase() === 'cancel') {
      conversationState.endConversation(message.author.id);
      await message.reply('❌ Sync cancelled.');
      return;
    }

    // Verify repository
    const statusMsg = await message.reply(
      `🔍 Verifying access to **${repoInfo.owner}/${repoInfo.repo}**...`
    );

    const hasAccess = await githubService.verifyRepository(repoInfo.owner, repoInfo.repo);
    if (!hasAccess) {
      await statusMsg.edit({
        content: `❌ Cannot access repository **${repoInfo.owner}/${repoInfo.repo}**. Please check:\n- Repository exists\n- GitHub token has access\n- Repository name is correct\n\nTry again with a different repo, or say "cancel" to stop.`,
      });
      return;
    }

    // Start sync
    await statusMsg.edit({
      content: `✅ Repository verified!\n\n🔄 Fetching discussions from **${forumName}**...`,
    });

    const forumSummary = await forumTraversal.getForumSummary(forumId);

    if (forumSummary.threads.length === 0) {
      conversationState.endConversation(message.author.id);
      await statusMsg.edit({
        content: `ℹ️ No discussions found in **${forumName}** to sync.`,
      });
      return;
    }

    await statusMsg.edit({
      content: `📊 Found **${forumSummary.threads.length}** discussions\n\n🚀 Creating GitHub issues in **${repoInfo.owner}/${repoInfo.repo}**...\n\n_This may take a minute..._`,
    });

    // Sync threads
    const results = await githubService.syncThreadsToGitHub(
      repoInfo.owner,
      repoInfo.repo,
      forumSummary.threads,
      forumName,
      async (current, total, result) => {
        if (current % 5 === 0 || current === total) {
          await statusMsg
            .edit({
              content: `🚀 Creating GitHub issues... (${current}/${total})\n\n${result.success ? '✅' : '❌'} ${result.issueUrl || 'Processing...'}`,
            })
            .catch(() => {
              /* Ignore rate limit errors */
            });
        }
      }
    );

    // Report results
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    let resultMessage = `## ✅ Sync Complete!\n\n`;
    resultMessage += `**Forum:** ${forumName}\n`;
    resultMessage += `**Repository:** ${repoInfo.owner}/${repoInfo.repo}\n\n`;
    resultMessage += `**Results:**\n`;
    resultMessage += `✅ ${successCount} issues created successfully\n`;

    if (failureCount > 0) {
      resultMessage += `❌ ${failureCount} failed\n`;
    }

    resultMessage += `\n**Created Issues:**\n`;
    const successfulIssues = results.filter((r) => r.success && r.issueUrl);
    successfulIssues.slice(0, 10).forEach((result) => {
      resultMessage += `- ${result.issueUrl}\n`;
    });

    if (successfulIssues.length > 10) {
      resultMessage += `_...and ${successfulIssues.length - 10} more_\n`;
    }

    await statusMsg.edit({ content: resultMessage });

    // End conversation
    conversationState.endConversation(message.author.id);

    logger.info(
      `Conversational sync completed for user ${message.author.id}: ${successCount}/${results.length} issues created`
    );
  } catch (error) {
    logger.error('Error in sync-discussions conversation:', error);
    conversationState.endConversation(message.author.id);

    await message.reply({
      content: `❌ Sync failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// =============================================================================
// MESSAGE ADAPTER - SIMPLE BRIDGE TO UNIFIED PROCESSOR
// =============================================================================

/**
 * Fetch recent channel history for context
 * Randomly fetches 10-25 messages to give Artie conversational context
 */
async function fetchChannelHistory(message: Message): Promise<
  Array<{
    author: string;
    content: string;
    timestamp: string;
    isBot: boolean;
  }>
> {
  try {
    // Randomize how many messages to fetch (10-25)
    const limit = chance.integer({ min: MIN_CHANNEL_HISTORY, max: MAX_CHANNEL_HISTORY });

    // Fetch messages before the current one
    const messages = await message.channel.messages.fetch({ limit, before: message.id });

    // Convert to simple format for context
    return Array.from(messages.values())
      .reverse() // Chronological order (oldest first)
      .map((msg) => ({
        author: msg.author.displayName || msg.author.username,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        isBot: msg.author.bot,
      }));
  } catch (error) {
    logger.error('Failed to fetch channel history:', error);
    return [];
  }
}

/**
 * Simple adapter: Convert Discord message to UserIntent and delegate to unified processor
 * Replaces ~400 lines of duplicate logic with ~30 lines of adapter code
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
  }
): Promise<void> {
  const shortId = getShortCorrelationId(correlationId);
  let statusMessage: Message | null = null;
  let streamingMessage: Message | null = null;

  try {
    // MINIMAL: No status messages - just start working like a human

    // ENHANCED: Fetch recent channel history for conversational context
    const channelHistory = await fetchChannelHistory(message);
    logger.info(`📜 Fetched ${channelHistory.length} recent messages for context [${shortId}]`);

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

    const discordContext = {
      platform: 'discord',
      ...guildInfo,
      ...channelInfo,
      ...userInfo,
      ...forumInfo,
      messageId: message.id,
      timestamp: message.createdAt.toISOString(),
      hasAttachments: message.attachments.size > 0,
      mentionedUsers: message.mentions.users.size,
      mentions: Array.from(message.mentions.users.entries()).map(([id, user]) => ({
        id,
        username: user.username,
        displayName: user.displayName || user.username,
      })),
      replyingTo: message.reference?.messageId || null,
      // Proxy context if this is a proxy response
      ...(proxyOptions?.isProxyResponse
        ? {
            isProxyResponse: true,
            proxyTargetUser: proxyOptions.proxyRule.targetUsername,
            proxyRuleName: proxyOptions.proxyRule.name,
            proxySystemContext: proxyOptions.proxyContext,
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
        enableTyping: true, // Enable typing indicators for messages
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
