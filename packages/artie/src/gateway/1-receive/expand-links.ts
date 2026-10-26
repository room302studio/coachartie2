/**
 * Expand links: GitHub URLs become repo/PR/issue embeds (working guilds), and Discord message
 * links resolve to the linked message's text for the turn's context. Moved verbatim out of
 * on-message.ts (wave 5).
 */

import { Message, EmbedBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import type { getGitHubIntegrationSafe } from '../watchers/github/issue-sync.js';

interface PRInfo {
  state: string;
  mergedAt?: string | null;
  isDraft?: boolean;
}

function getPRStateEmoji(prInfo: PRInfo): string {
  if (prInfo.state === 'open') {
    return '🟢';
  }
  if (prInfo.mergedAt) {
    return '🟣';
  }
  return '🔴';
}

function getPRStateText(prInfo: PRInfo): string {
  if (prInfo.state === 'open') {
    return 'Open';
  }
  if (prInfo.mergedAt) {
    return 'Merged';
  }
  return 'Closed';
}

function getPRColor(prInfo: PRInfo): number {
  if (prInfo.state === 'open') {
    return 0x2ea44f;
  }
  if (prInfo.mergedAt) {
    return 0x6f42c1;
  }
  return 0xcb2431;
}

function getDraftSuffix(isDraft: boolean | undefined): string {
  if (isDraft) {
    return ' (Draft)';
  }
  return '';
}

function getChannelName(channel: any): string {
  if ('name' in channel) {
    return channel.name;
  }
  return 'unknown';
}

function appendAttachmentInfo(content: string, attachmentInfo: string): string {
  if (content) {
    return `${content}\n${attachmentInfo}`;
  }
  return attachmentInfo;
}

interface IssueInfo {
  state: string;
}

function getIssueStateEmoji(issueInfo: IssueInfo): string {
  if (issueInfo.state === 'open') {
    return '🟢';
  }
  return '🔴';
}

function getIssueStateText(issueInfo: IssueInfo): string {
  if (issueInfo.state === 'open') {
    return 'Open';
  }
  return 'Closed';
}

function getIssueColor(issueInfo: IssueInfo): number {
  if (issueInfo.state === 'open') {
    return 0x2ea44f;
  }
  return 0xcb2431;
}

/**
 * Auto-expand GitHub URLs in messages (only in working guilds)
 * Returns true if expansion was performed
 */
export async function handleGitHubAutoExpansion(
  message: Message,
  githubService: NonNullable<ReturnType<typeof getGitHubIntegrationSafe>>
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
            const stateEmoji = getPRStateEmoji(prInfo);
            const stateText = getPRStateText(prInfo);

            const embed = new EmbedBuilder()
              .setColor(getPRColor(prInfo))
              .setTitle(`${stateEmoji} PR #${prInfo.number}: ${prInfo.title}`)
              .setURL(prInfo.url)
              .setDescription(prInfo.body?.slice(0, 200) || 'No description provided');

            const fields = [
              {
                name: 'Status',
                value: `${stateText}${getDraftSuffix(prInfo.isDraft)}`,
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
            const stateEmoji = getIssueStateEmoji(issueInfo);
            const stateText = getIssueStateText(issueInfo);

            const embed = new EmbedBuilder()
              .setColor(getIssueColor(issueInfo))
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

      const channelName = getChannelName(channel);

      // Build content including attachments
      let content = referencedMessage.content || '';
      if (referencedMessage.attachments.size > 0) {
        const attachmentInfo = referencedMessage.attachments
          .map((att: any) => `[Attachment: ${att.name}]`)
          .join(', ');
        content = appendAttachmentInfo(content, attachmentInfo);
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
