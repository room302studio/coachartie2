/**
 * Discord Data Fetchers - Gather context from Discord channels
 *
 * Fetches channel history, attachments, URLs, reply context, and resolves
 * Discord message links. This is raw data gathering, NOT context assembly
 * (that happens in context-alchemy).
 */

import { Message, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import Chance from 'chance';
import { GuildConfig } from '../config/guild-whitelist.js';
import { MIN_CHANNEL_HISTORY, MAX_CHANNEL_HISTORY } from './message-utils.js';

const chance = new Chance();

// =============================================================================
// GUILD & DM CONTEXT HELPERS
// =============================================================================

/**
 * Load guild context with scratchpad notes
 * Returns the base context plus any notes from the guild's scratchpad file
 */
export function getEnhancedGuildContext(guildConfig: GuildConfig | null | undefined): string | undefined {
  // Load context from file if contextPath is set, otherwise use inline context
  let baseContext: string | undefined;

  if (guildConfig?.contextPath) {
    try {
      const contextFullPath = join(process.cwd(), guildConfig.contextPath);
      if (existsSync(contextFullPath)) {
        baseContext = readFileSync(contextFullPath, 'utf-8');
      } else {
        logger.warn(`Context file not found for ${guildConfig.name}: ${contextFullPath}`);
        baseContext = guildConfig.context; // Fall back to inline
      }
    } catch (error) {
      logger.warn(`Failed to load context file for ${guildConfig.name}:`, error);
      baseContext = guildConfig.context; // Fall back to inline
    }
  } else {
    baseContext = guildConfig?.context;
  }

  if (!baseContext) return undefined;

  let fullContext = baseContext;

  // Load scratchpad if configured (guildConfig is guaranteed to exist if we have baseContext from it)
  if (guildConfig?.scratchpadPath) {
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
      logger.warn(`Failed to load scratchpad for ${guildConfig?.name}:`, error);
    }
  }

  return fullContext;
}

/**
 * Get or create per-user DM scratchpad
 * Each person Artie DMs with gets their own notes file
 * Returns the scratchpad content and path for the LLM to read/write
 */
export function getDMScratchpad(userId: string, username: string): { content: string; path: string } | null {
  const DM_NOTES_DIR = 'reference-docs/dm-notes';
  const scratchpadPath = `${DM_NOTES_DIR}/${userId}.md`;
  const fullPath = join(process.cwd(), scratchpadPath);
  const dirPath = join(process.cwd(), DM_NOTES_DIR);

  try {
    // Ensure dm-notes directory exists
    if (!existsSync(dirPath)) {
      const { mkdirSync } = require('fs');
      mkdirSync(dirPath, { recursive: true });
      logger.info(`📁 Created DM notes directory: ${DM_NOTES_DIR}`);
    }

    // Check if user has a scratchpad
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      return { content, path: scratchpadPath };
    }

    // Create initial scratchpad for new DM user
    const { writeFileSync } = require('fs');
    const initialContent = `# DM Notes: ${username}
<!-- Artie's private notes about conversations with ${username} (${userId}) -->
<!-- Created: ${new Date().toISOString()} -->

## About This Person
_No notes yet - Artie will learn about them through conversation_

## Conversation History Notes
_Key things to remember from past conversations_

## Preferences & Context
_Things they like, their projects, how they prefer to communicate_
`;
    writeFileSync(fullPath, initialContent);
    logger.info(`📝 Created new DM scratchpad for ${username} (${userId})`);
    return { content: initialContent, path: scratchpadPath };
  } catch (error) {
    logger.warn(`Failed to get/create DM scratchpad for ${userId}:`, error);
    return null;
  }
}

// =============================================================================
// CHANNEL HISTORY & CONTEXT FETCHING
// =============================================================================

/**
 * Fetch the message being replied to (if any)
 * Returns the message content or null if unavailable
 */
export async function fetchReplyContext(message: Message): Promise<{
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
export async function fetchChannelHistory(message: Message): Promise<
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
export async function fetchRecentAttachments(message: Message): Promise<
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
export async function fetchRecentUrls(message: Message): Promise<string[]> {
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
 * Extract URLs from a message's content
 */
export function extractUrlsFromContent(content: string): string[] {
  const urls: string[] = [];
  for (const token of content.split(/\s+/)) {
    try {
      const parsed = new URL(token);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        urls.push(parsed.toString());
      }
    } catch {
      // not a URL
    }
  }
  return urls;
}

/**
 * Resolve Discord message links to their actual content
 * Links look like: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
 */
export async function resolveDiscordMessageLinks(
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

// =============================================================================
// GITHUB AUTO-EXPANSION
// =============================================================================

/**
 * Auto-expand GitHub URLs in messages (only in working guilds)
 * Returns true if expansion was performed
 */
export async function handleGitHubAutoExpansion(
  message: Message,
  githubService: {
    detectGitHubUrls: (content: string) => Array<{
      url: string;
      type: 'repo' | 'pr' | 'issue';
      owner: string;
      repo: string;
      number?: number;
    }>;
    getRepositoryInfo: (owner: string, repo: string) => Promise<any>;
    getPullRequestInfo: (owner: string, repo: string, number: number) => Promise<any>;
    getIssueInfo: (owner: string, repo: string, number: number) => Promise<any>;
  }
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
                  .map((a: string) => `@${a}`)
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
// PROACTIVE ANSWERING JUDGMENT
// =============================================================================

/**
 * Use LLM to judge if Artie should proactively answer a question
 * Based on the guild context and message content
 */
export async function shouldProactivelyAnswer(
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

    const openRouterResponse = await fetch('https://router.tools.ejfox.com/v1/chat/completions', {
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
