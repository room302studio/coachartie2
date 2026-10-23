/**
 * Expand links: GitHub URLs become repo/PR/issue embeds (working guilds), and Discord message
 * links resolve to the linked message's text for the turn's context. Moved verbatim out of
 * on-message.ts (wave 5).
 */

import { Message, EmbedBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import type { getGitHubIntegrationSafe } from '../watchers/github/issue-sync.js';

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
