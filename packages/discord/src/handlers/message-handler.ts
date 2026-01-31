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
  GuildConfig,
} from '../config/guild-whitelist.js';
import { getGitHubIntegration } from '../services/github-integration.js';
import { getForumTraversal } from '../services/forum-traversal.js';
import { getMentionProxyService } from '../services/mention-proxy-service.js';
import { quizSessionManager } from '../services/quiz-session-manager.js';
import Chance from 'chance';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const chance = new Chance();

/**
 * Load guild context with scratchpad notes
 * Returns the base context plus any notes from the guild's scratchpad file
 */
function getEnhancedGuildContext(guildConfig: GuildConfig | null | undefined): string | undefined {
  if (!guildConfig?.context) return undefined;

  let fullContext = guildConfig.context;

  // Load scratchpad if configured
  if (guildConfig.scratchpadPath) {
    try {
      const scratchpadFullPath = join(process.cwd(), guildConfig.scratchpadPath);
      if (existsSync(scratchpadFullPath)) {
        const scratchpadContent = readFileSync(scratchpadFullPath, 'utf-8');
        fullContext += `

📝 YOUR SCRATCHPAD (your personal notes for this guild):
${scratchpadContent}

To add notes: <append path="${guildConfig.scratchpadPath}">
## New Note (include date/username)
Your observation here
</append>

To rewrite entirely: <write path="${guildConfig.scratchpadPath}">full new content</write>
To delete: <rm path="${guildConfig.scratchpadPath}" />`;
      }
    } catch (error) {
      logger.warn(`Failed to load scratchpad for ${guildConfig.name}:`, error);
    }
  }

  return fullContext;
}

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================

// Message deduplication cache to prevent duplicate processing
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_TTL = 10000; // 10 seconds TTL

// Proactive answering cooldown cache (guildId -> lastProactiveAnswerTimestamp)
const proactiveCooldownCache = new Map<string, number>();

// Discord API limits and timeouts
const TYPING_REFRESH_INTERVAL = 8000; // Refresh typing every 8s (Discord typing lasts 10s)
const CHUNK_RATE_LIMIT_DELAY = 200; // 200ms delay between message chunks
const MAX_JOB_ATTEMPTS = 100; // ~5 minute max job timeout (100 * 3s checks) - allows for large metro files
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
 * Use LLM to judge if Artie should proactively answer a question
 * Based on the guild context and message content
 */
async function shouldProactivelyAnswer(
  message: Message,
  guildContext: string,
  correlationId: string
): Promise<boolean> {
  try {
    // Use fetch directly to call the capabilities service
    const capabilitiesUrl = process.env.CAPABILITIES_URL || 'http://localhost:47324';

    // Debug: log what context we have
    logger.info(`🔍 Proactive judgment context length: ${guildContext?.length || 0} chars`);

    const prompt = `You are a helper bot deciding whether to engage with a message. Be CONSERVATIVE - only answer clear help requests.

YOUR KNOWLEDGE BASE:
${guildContext}

USER MESSAGE:
"${message.content}"

Respond with JSON only:
{"answer": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}

Set answer=true ONLY if:
- They're clearly asking a SPECIFIC question about the game
- They have a bug/issue AND are asking for help
- Your knowledge base EXPLICITLY covers what they're asking about
- The message is at least 10 words and contains a clear question

Set answer=false if:
- Short messages (under 10 words) - these are usually banter
- Just chatting/joking between users
- Rhetorical questions or sarcasm ("askers?", "who asked?", etc.)
- Off-topic discussion (not about the game)
- Meta-discussion about the bot itself ("the bot should...", "limit when bot...")
- Someone else already answered
- They're responding to someone else (not asking the room)
- One-word or two-word messages
- Messages that are reactions/commentary ("lmao", "bro", "oh my god", etc.)

CRITICAL: When in doubt, answer FALSE. It's better to miss a question than to interrupt conversations. Only engage when someone is CLEARLY asking for help with the game.

JSON response:`;

    // Use direct OpenRouter call to avoid capability orchestration
    // The full chat endpoint includes email/calendar capabilities that can hijack the response
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      logger.warn('No OpenRouter API key for proactive judgment');
      return false;
    }

    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie Proactive Judgment',
      },
      body: JSON.stringify({
        model: process.env.PROACTIVE_JUDGMENT_MODEL || 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200, // Small response - just need yes/no JSON
      }),
    });

    if (!openRouterResponse.ok) {
      throw new Error(`OpenRouter returned ${openRouterResponse.status}`);
    }

    const openRouterResult = (await openRouterResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawResponse = openRouterResult.choices?.[0]?.message?.content || '';

    // Parse JSON response
    try {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const judgment = JSON.parse(jsonMatch[0]) as {
          answer: boolean;
          confidence: number;
          reason: string;
        };
        logger.info(
          `🤔 Proactive judgment: answer=${judgment.answer}, confidence=${judgment.confidence}, reason="${judgment.reason}"`
        );

        // Require confidence > 0.7 to answer (be conservative)
        const shouldAnswer = judgment.answer && judgment.confidence > 0.7;
        logger.info(
          `🤔 Final decision for "${message.content.substring(0, 50)}...": ${shouldAnswer ? 'YES' : 'NO'}`
        );
        return shouldAnswer;
      }
    } catch (parseError) {
      logger.warn(`Failed to parse judgment JSON: ${rawResponse}`);
    }

    // Fallback: check for yes/no in response
    const decision = rawResponse.toLowerCase().trim();
    logger.info(
      `🤔 Fallback judgment for "${message.content.substring(0, 50)}...": "${rawResponse}" -> ${decision.includes('yes') ? 'YES' : 'NO'}`
    );
    return decision.includes('yes');
  } catch (error) {
    logger.warn(`Failed proactive answer judgment, defaulting to no:`, error);
    return false; // Default to not answering if judgment fails
  }
}

/**
 * Split long messages into Discord-compatible chunks with smart code block handling
 *
 * Features:
 * - NEVER splits inside code blocks (``` ... ```)
 * - Prefers splitting at paragraph boundaries (\n\n)
 * - Falls back to line boundaries, then word boundaries
 * - Keeps the 2000 char limit for Discord
 * - Handles edge cases like oversized code blocks
 *
 * @param text - The text to chunk
 * @param maxLength - Maximum chunk size (default: 2000)
 * @returns Array of message chunks
 */
function chunkMessage(text: string, maxLength: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];

  // Step 1: Identify all code blocks and their positions
  interface CodeBlock {
    start: number;
    end: number;
    content: string;
    language?: string;
  }

  const codeBlocks: CodeBlock[] = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[0],
      language: match[1],
    });
  }

  // Step 2: Split text into segments (code blocks and text between them)
  interface Segment {
    content: string;
    isCodeBlock: boolean;
    start: number;
    end: number;
  }

  const segments: Segment[] = [];
  let lastIndex = 0;

  for (const block of codeBlocks) {
    // Add text before code block
    if (block.start > lastIndex) {
      segments.push({
        content: text.slice(lastIndex, block.start),
        isCodeBlock: false,
        start: lastIndex,
        end: block.start,
      });
    }

    // Add code block
    segments.push({
      content: block.content,
      isCodeBlock: true,
      start: block.start,
      end: block.end,
    });

    lastIndex = block.end;
  }

  // Add remaining text after last code block
  if (lastIndex < text.length) {
    segments.push({
      content: text.slice(lastIndex),
      isCodeBlock: false,
      start: lastIndex,
      end: text.length,
    });
  }

  // Step 3: Build chunks respecting code block boundaries
  let currentChunk = '';

  for (const segment of segments) {
    if (segment.isCodeBlock) {
      // Code block - must be kept intact
      const segmentLength = segment.content.length;

      // If adding this code block would exceed limit, flush current chunk first
      if (currentChunk.length > 0 && currentChunk.length + segmentLength + 1 > maxLength) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If code block itself is too large, handle specially
      if (segmentLength > maxLength) {
        // Flush any pending content first
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // Split large code block while maintaining syntax
        // Extract language and content
        const codeMatch = segment.content.match(/```(\w+)?\n([\s\S]*?)```/);
        if (codeMatch) {
          const language = codeMatch[1] || '';
          const codeContent = codeMatch[2];
          const codeLines = codeContent.split('\n');

          let codeChunk = '';
          const opener = `\`\`\`${language}\n`;
          const closer = '\n```';
          const overhead = opener.length + closer.length;

          for (const line of codeLines) {
            const testChunk = codeChunk + (codeChunk ? '\n' : '') + line;

            if (testChunk.length + overhead > maxLength) {
              // Flush current code chunk
              if (codeChunk) {
                chunks.push(opener + codeChunk + closer);
                codeChunk = '';
              }

              // If single line is too long, split it (rare but possible)
              if (line.length + overhead > maxLength) {
                // Split line into smaller pieces
                const safeLength = maxLength - overhead;
                for (let i = 0; i < line.length; i += safeLength) {
                  const piece = line.slice(i, i + safeLength);
                  chunks.push(opener + piece + closer);
                }
              } else {
                codeChunk = line;
              }
            } else {
              codeChunk = testChunk;
            }
          }

          // Flush remaining code
          if (codeChunk) {
            chunks.push(opener + codeChunk + closer);
          }
        } else {
          // Fallback: just truncate with warning
          chunks.push(segment.content.slice(0, maxLength - 20) + '\n... (truncated)');
        }

        continue;
      }

      // Normal-sized code block - add to current chunk
      currentChunk += (currentChunk ? '\n' : '') + segment.content;
    } else {
      // Regular text - preserve newlines while respecting Discord's char limit
      // This is CRITICAL for markdown formatting (headers, lists, paragraphs)
      const textContent = segment.content;

      // Split on double newlines to find paragraphs, but keep the delimiters
      const paragraphParts = textContent.split(/(\n\n+)/);

      for (const part of paragraphParts) {
        // Check if this is a paragraph delimiter (double+ newlines)
        const isDelimiter = /^\n\n+$/.test(part);

        if (isDelimiter) {
          // Preserve paragraph breaks - normalize to double newline
          if (currentChunk.length + 2 <= maxLength) {
            currentChunk += '\n\n';
          } else {
            // Flush and start fresh with the delimiter
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trimEnd());
              currentChunk = '';
            }
          }
          continue;
        }

        // Regular paragraph content - preserve single newlines within it
        const lines = part.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          // Don't trim - preserve leading whitespace for indentation

          // Calculate what we need to add
          const needsNewline = currentChunk.length > 0 && lineIdx > 0;
          const addition = (needsNewline ? '\n' : '') + line;

          // If adding this line fits, add it
          if (currentChunk.length + addition.length <= maxLength) {
            currentChunk += addition;
            continue;
          }

          // Line won't fit - flush current chunk first
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trimEnd());
            currentChunk = '';
          }

          // If line itself fits, use it
          if (line.length <= maxLength) {
            currentChunk = line;
            continue;
          }

          // Line is too long - must split by words
          const words = line.split(' ');

          for (const word of words) {
            if (currentChunk.length + word.length + 1 > maxLength) {
              if (currentChunk.trim()) {
                chunks.push(currentChunk.trimEnd());
                currentChunk = '';
              }

              // If single word is too long, split it (rare but possible)
              if (word.length > maxLength) {
                for (let i = 0; i < word.length; i += maxLength) {
                  chunks.push(word.slice(i, i + maxLength));
                }
              } else {
                currentChunk = word;
              }
            } else {
              currentChunk += (currentChunk ? ' ' : '') + word;
            }
          }
        }
      }
    }
  }

  // Flush any remaining content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
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
        const lastProactive = proactiveCooldownCache.get(message.guildId || '') || 0;
        const timeSinceLast = (Date.now() - lastProactive) / 1000;

        if (timeSinceLast < cooldownSeconds) {
          logger.info(
            `⏳ Proactive answer skipped - cooldown (${Math.round(cooldownSeconds - timeSinceLast)}s remaining) [${shortId}]`
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
            proactiveCooldownCache.set(message.guildId || '', Date.now());
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

    const shouldRespond =
      responseConditions.botMentioned ||
      responseConditions.isDM ||
      shouldRespondInRobotChannel ||
      responseConditions.isProactiveAnswer;

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
        const triggerType = responseConditions.botMentioned
          ? 'mention'
          : responseConditions.isDM
            ? 'dm'
            : responseConditions.isProactiveAnswer
              ? 'proactive_answer'
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
        const guildContextToPass = proactiveAnswerContext || getEnhancedGuildContext(guildConfig);
        await handleMessageAsIntent(
          message,
          cleanMessage,
          correlationId,
          undefined,
          guildContextToPass,
          responseConditions.isProactiveAnswer
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
// MESSAGE ADAPTER - SIMPLE BRIDGE TO UNIFIED PROCESSOR
// =============================================================================

/**
 * Fetch the message being replied to (if any)
 * Returns the message content or null if unavailable
 */
async function fetchReplyContext(message: Message): Promise<{
  messageId: string;
  author: string;
  content: string;
  timestamp: string;
} | null> {
  try {
    // Check if this message is a reply
    if (!message.reference?.messageId) {
      return null;
    }

    // Fetch the referenced message
    const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);

    if (!referencedMessage) {
      return null;
    }

    // Return formatted reply context
    return {
      messageId: referencedMessage.id,
      author: referencedMessage.author.displayName || referencedMessage.author.username,
      content: referencedMessage.content,
      timestamp: referencedMessage.createdAt.toISOString(),
    };
  } catch (error) {
    // Handle gracefully - message might be deleted, or we might lack permissions
    logger.debug(`Could not fetch reply context for message ${message.id}:`, error);
    return null;
  }
}

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
 * Fetch recent attachments from the channel (last ~10 messages)
 */
async function fetchRecentAttachments(message: Message): Promise<
  Array<{
    id: string;
    name: string | null;
    url: string;
    contentType: string | null;
    size: number;
    proxyUrl: string | null;
    author: string;
    authorId: string;
    messageId: string;
    timestamp: string;
  }>
> {
  try {
    const messages = await message.channel.messages.fetch({ limit: 12, before: message.id });

    const attachments: Array<{
      id: string;
      name: string | null;
      url: string;
      contentType: string | null;
      size: number;
      proxyUrl: string | null;
      author: string;
      authorId: string;
      messageId: string;
      timestamp: string;
    }> = [];

    for (const msg of messages.values()) {
      if (!msg.attachments || msg.attachments.size === 0) continue;

      msg.attachments.forEach((att) => {
        attachments.push({
          id: att.id,
          name: att.name,
          url: att.url,
          contentType: att.contentType ?? null,
          size: att.size,
          proxyUrl: att.proxyURL ?? null,
          author: msg.author.displayName || msg.author.username,
          authorId: msg.author.id,
          messageId: msg.id,
          timestamp: msg.createdAt.toISOString(),
        });
      });

      if (attachments.length >= 10) break; // cap to keep context small
    }

    return attachments.slice(0, 10);
  } catch (error) {
    logger.error('Failed to fetch recent attachments:', error);
    return [];
  }
}

/**
 * Extract up to a few recent URLs from recent messages (excluding bot).
 */
async function fetchRecentUrls(message: Message): Promise<string[]> {
  try {
    const messages = await message.channel.messages.fetch({ limit: 12, before: message.id });
    const urls: string[] = [];

    for (const msg of messages.values()) {
      if (msg.author.bot) continue;
      const tokens = msg.content.split(/\s+/);

      // Collect URLs from message content
      for (const token of tokens) {
        try {
          const parsed = new URL(token);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            const normalized = parsed.toString();
            if (!urls.includes(normalized)) {
              urls.push(normalized);
            }
          }
        } catch {
          // not a URL, skip
        }
        if (urls.length >= 5) break;
      }

      // Also include URLs from embeds if present
      if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
          if (embed.url && !urls.includes(embed.url)) {
            urls.push(embed.url);
          }
          if (urls.length >= 5) break;
        }
      }

      if (urls.length >= 5) break; // cap before later trim
    }

    return urls.slice(0, 5);
  } catch (error) {
    logger.error('Failed to fetch recent URLs:', error);
    return [];
  }
}

/**
 * Resolve Discord message links to their actual content
 * Links look like: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
 */
async function resolveDiscordMessageLinks(
  urls: string[],
  currentMessage: Message
): Promise<Array<{ url: string; content: string; author: string; channel: string }>> {
  const resolved: Array<{ url: string; content: string; author: string; channel: string }> = [];
  const discordLinkPattern =
    /^https:\/\/(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)\/(\d+)$/;

  for (const url of urls) {
    const match = url.match(discordLinkPattern);
    if (!match) continue;

    const [, guildId, channelId, messageId] = match;

    try {
      // Only resolve links from the same guild for security
      if (guildId !== currentMessage.guildId) {
        logger.debug(`🔗 Skipping cross-guild Discord link: ${url}`);
        continue;
      }

      const guild = currentMessage.guild;
      if (!guild) continue;

      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) {
        logger.debug(`🔗 Channel not found or not text-based: ${channelId}`);
        continue;
      }

      // Fetch the referenced message
      const referencedMessage = await (channel as any).messages.fetch(messageId);
      if (!referencedMessage) continue;

      const channelName = 'name' in channel ? channel.name : 'unknown';

      // Build content including attachments
      let content = referencedMessage.content || '';
      if (referencedMessage.attachments.size > 0) {
        const attachmentInfo = referencedMessage.attachments
          .map((att: any) => `[Attachment: ${att.name}]`)
          .join(', ');
        content += content ? `\n${attachmentInfo}` : attachmentInfo;
      }

      resolved.push({
        url,
        content: content.substring(0, 1000), // Cap length
        author: referencedMessage.author.username,
        channel: channelName,
      });

      logger.info(`🔗 Resolved Discord message link: ${url} -> "${content.substring(0, 50)}..."`);
    } catch (error) {
      logger.debug(`🔗 Failed to resolve Discord link ${url}:`, error);
    }

    if (resolved.length >= 3) break; // Cap resolved messages
  }

  return resolved;
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
  },
  guildContext?: string,
  isProactiveAnswer: boolean = false
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
