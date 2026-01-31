/**
 * GitHub Discord Poster
 *
 * Formats and posts GitHub events to Discord channels.
 * Handles embed formatting, mentions, and message styling.
 */

import { Client, EmbedBuilder, TextChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { logger } from '@coachartie/shared';
import type { GitHubSyncEvent, GitHubEventType } from './github-poller.js';
import type { ProcessedEvent, BatchedEvents, DiscordMention } from './github-event-processor.js';

// Color palette for different event types
const EVENT_COLORS: Record<GitHubEventType, number> = {
  pr_opened: 0x238636, // Green
  pr_ready_for_review: 0x1f6feb, // Blue
  pr_merged: 0x8957e5, // Purple
  pr_closed: 0xda3633, // Red
  pr_approved: 0x238636, // Green
  pr_changes_requested: 0xd29922, // Yellow/Orange
  pr_comment: 0x6e7681, // Gray
  pr_review: 0x6e7681, // Gray
  ci_success: 0x238636, // Green
  ci_failure: 0xda3633, // Red
};

// Emoji for event types
const EVENT_EMOJI: Record<GitHubEventType, string> = {
  pr_opened: '🆕',
  pr_ready_for_review: '👀',
  pr_merged: '🎉',
  pr_closed: '❌',
  pr_approved: '✅',
  pr_changes_requested: '🔄',
  pr_comment: '💬',
  pr_review: '📝',
  ci_success: '✅',
  ci_failure: '❌',
};

export interface PosterConfig {
  maxDescriptionLength: number;
  includeFullDescription: boolean;
  showLineChanges: boolean;
  showLabels: boolean;
  showReviewers: boolean;
  verboseMerges: boolean; // Extra detail for merges to main
}

const DEFAULT_CONFIG: PosterConfig = {
  maxDescriptionLength: 200,
  includeFullDescription: false,
  showLineChanges: true,
  showLabels: true,
  showReviewers: true,
  verboseMerges: true,
};

/**
 * GitHub Discord Poster
 */
export class GitHubDiscordPoster {
  private client: Client;
  private config: PosterConfig;

  constructor(client: Client, config: Partial<PosterConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Post a single processed event to Discord
   */
  async postEvent(processed: ProcessedEvent): Promise<void> {
    if (!processed.shouldPost) {
      logger.debug(`Skipping event: ${processed.skipReason}`);
      return;
    }

    const channel = await this.getChannel(processed.event.channelId);
    if (!channel) {
      logger.error(`Channel ${processed.event.channelId} not found`);
      return;
    }

    const embed = this.createEmbed(processed.event);
    const content = this.formatMentions(processed.mentions);

    try {
      await channel.send({
        content: content || undefined,
        embeds: [embed],
      });
      logger.info(`Posted ${processed.event.type} event to ${channel.id}`);
    } catch (error) {
      logger.error(`Failed to post event to ${channel.id}:`, error);
    }
  }

  /**
   * Post a batch of events to Discord
   */
  async postBatch(batch: BatchedEvents): Promise<void> {
    const channel = await this.getChannel(batch.channelId);
    if (!channel) {
      logger.error(`Channel ${batch.channelId} not found`);
      return;
    }

    // For single-event batches, just post the event
    if (batch.events.length === 1) {
      await this.postEvent(batch.events[0]);
      return;
    }

    // Create batch embed
    const embed = this.createBatchEmbed(batch);

    // Collect all unique mentions
    const allMentions = this.collectMentions(batch.events);
    const content = this.formatMentions(allMentions);

    try {
      await channel.send({
        content: content || undefined,
        embeds: [embed],
      });
      logger.info(`Posted batch with ${batch.events.length} events to ${channel.id}`);
    } catch (error) {
      logger.error(`Failed to post batch to ${channel.id}:`, error);
    }
  }

  /**
   * Create Discord embed for a single event
   */
  private createEmbed(event: GitHubSyncEvent): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(EVENT_COLORS[event.type] || 0x6e7681)
      .setTimestamp(new Date(event.timestamp));

    const emoji = EVENT_EMOJI[event.type] || '📌';
    const [owner, repo] = event.repo.split('/');

    switch (event.type) {
      case 'pr_opened':
        embed
          .setTitle(`${emoji} New Pull Request`)
          .setURL(event.data.prUrl || '')
          .setDescription(this.formatPrDescription(event))
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'pr_ready_for_review':
        embed
          .setTitle(`${emoji} Ready for Review`)
          .setURL(event.data.prUrl || '')
          .setDescription(`**#${event.data.prNumber}** ${event.data.prTitle}`)
          .addFields({
            name: 'Author',
            value: event.data.prAuthor || 'Unknown',
            inline: true,
          })
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'pr_merged':
        embed
          .setTitle(`${emoji} Pull Request Merged`)
          .setURL(event.data.prUrl || '')
          .setDescription(this.formatMergeDescription(event))
          .setFooter({ text: `${owner}/${repo}` });

        // Extra fanfare for merges to main
        if (event.data.prBaseBranch === 'main' && this.config.verboseMerges) {
          embed.setTitle(`${emoji} Merged to Main! ${emoji}`);
        }
        break;

      case 'pr_closed':
        embed
          .setTitle(`${emoji} Pull Request Closed`)
          .setURL(event.data.prUrl || '')
          .setDescription(`**#${event.data.prNumber}** ${event.data.prTitle}`)
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'pr_approved':
        embed
          .setTitle(`${emoji} Pull Request Approved`)
          .setDescription(`**#${event.data.prNumber}** approved by **${event.data.reviewAuthor}**`)
          .setFooter({ text: `${owner}/${repo}` });
        if (event.data.reviewBody) {
          embed.addFields({
            name: 'Comment',
            value: this.truncate(event.data.reviewBody, 200),
          });
        }
        break;

      case 'pr_changes_requested':
        embed
          .setTitle(`${emoji} Changes Requested`)
          .setDescription(
            `**${event.data.reviewAuthor}** requested changes on **#${event.data.prNumber}**`
          )
          .setFooter({ text: `${owner}/${repo}` });
        if (event.data.reviewBody) {
          embed.addFields({
            name: 'Comment',
            value: this.truncate(event.data.reviewBody, 300),
          });
        }
        break;

      case 'pr_comment':
        embed
          .setTitle(`${emoji} New Comment on PR #${event.data.prNumber}`)
          .setURL(event.data.commentUrl || '')
          .setDescription(this.truncate(event.data.commentBody || '', 400))
          .addFields({
            name: 'Author',
            value: event.data.commentAuthor || 'Unknown',
            inline: true,
          })
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'pr_review':
        embed
          .setTitle(`${emoji} Review on PR #${event.data.prNumber}`)
          .setDescription(`Review by **${event.data.reviewAuthor}**: ${event.data.reviewState}`)
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'ci_success':
        embed
          .setTitle(`${emoji} CI Passed`)
          .setDescription(`**${event.data.checkRunName}** completed successfully`)
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'ci_failure':
        embed
          .setTitle(`${emoji} CI Failed`)
          .setDescription(`**${event.data.checkRunName}** failed`)
          .setFooter({ text: `${owner}/${repo}` });
        break;

      default:
        embed
          .setTitle(`${emoji} GitHub Event`)
          .setDescription(event.type)
          .setFooter({ text: `${owner}/${repo}` });
    }

    return embed;
  }

  /**
   * Create embed for a batch of events
   */
  private createBatchEmbed(batch: BatchedEvents): EmbedBuilder {
    const firstEvent = batch.events[0].event;
    const [owner, repo] = firstEvent.repo.split('/');

    const embed = new EmbedBuilder()
      .setColor(this.getBatchColor(batch))
      .setTitle(batch.summary)
      .setFooter({ text: `${owner}/${repo}` })
      .setTimestamp();

    // Add individual event summaries
    const eventSummaries = batch.events
      .slice(0, 5)
      .map((e) => {
        const emoji = EVENT_EMOJI[e.event.type] || '•';
        return `${emoji} ${this.getShortEventSummary(e.event)}`;
      })
      .join('\n');

    embed.setDescription(eventSummaries);

    if (batch.events.length > 5) {
      embed.addFields({
        name: 'And more...',
        value: `+${batch.events.length - 5} additional events`,
      });
    }

    return embed;
  }

  /**
   * Format PR description for embed
   */
  private formatPrDescription(event: GitHubSyncEvent): string {
    const parts: string[] = [];

    parts.push(`**#${event.data.prNumber}** ${event.data.prTitle}`);

    if (event.data.prAuthor) {
      parts.push(`\nBy **${event.data.prAuthor}**`);
    }

    if (this.config.showLineChanges && (event.data.additions || event.data.deletions)) {
      parts.push(
        `\n\`+${event.data.additions || 0}\` / \`-${event.data.deletions || 0}\``
      );
    }

    if (this.config.showLabels && event.data.labels && event.data.labels.length > 0) {
      parts.push(`\nLabels: ${event.data.labels.map((l) => `\`${l}\``).join(' ')}`);
    }

    return parts.join('');
  }

  /**
   * Format merge description with extra detail
   */
  private formatMergeDescription(event: GitHubSyncEvent): string {
    const parts: string[] = [];

    parts.push(`**#${event.data.prNumber}** ${event.data.prTitle}`);
    parts.push(`\nMerged to **${event.data.prBaseBranch}** by **${event.data.prAuthor}**`);

    if (this.config.showLineChanges && (event.data.additions || event.data.deletions)) {
      parts.push(
        `\n\`+${event.data.additions || 0}\` / \`-${event.data.deletions || 0}\``
      );
    }

    return parts.join('');
  }

  /**
   * Get short summary for event (for batch display)
   */
  private getShortEventSummary(event: GitHubSyncEvent): string {
    switch (event.type) {
      case 'pr_comment':
        return `${event.data.commentAuthor}: "${this.truncate(event.data.commentBody || '', 50)}"`;
      case 'pr_approved':
        return `${event.data.reviewAuthor} approved`;
      case 'pr_changes_requested':
        return `${event.data.reviewAuthor} requested changes`;
      case 'ci_success':
        return `${event.data.checkRunName} passed`;
      case 'ci_failure':
        return `${event.data.checkRunName} failed`;
      default:
        return event.type;
    }
  }

  /**
   * Get color for batch based on event types
   */
  private getBatchColor(batch: BatchedEvents): number {
    // Use the color of the highest priority event
    const sorted = [...batch.events].sort((a, b) => b.priority - a.priority);
    return EVENT_COLORS[sorted[0].event.type] || 0x6e7681;
  }

  /**
   * Format mentions as Discord message content
   */
  private formatMentions(mentions: DiscordMention[]): string {
    if (mentions.length === 0) {
      return '';
    }

    const mentionStrings = mentions.map((m) => {
      if (m.type === 'user') {
        return `<@${m.id}>`;
      } else {
        return `<@&${m.id}>`;
      }
    });

    // Remove duplicates
    const unique = [...new Set(mentionStrings)];
    return unique.join(' ');
  }

  /**
   * Collect all unique mentions from a batch
   */
  private collectMentions(events: ProcessedEvent[]): DiscordMention[] {
    const seen = new Set<string>();
    const mentions: DiscordMention[] = [];

    for (const event of events) {
      for (const mention of event.mentions) {
        const key = `${mention.type}:${mention.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          mentions.push(mention);
        }
      }
    }

    return mentions;
  }

  /**
   * Get a Discord channel by ID
   */
  private async getChannel(
    channelId: string
  ): Promise<TextChannel | NewsChannel | ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (
        channel &&
        (channel instanceof TextChannel ||
          channel instanceof NewsChannel ||
          channel instanceof ThreadChannel)
      ) {
        return channel;
      }
      return null;
    } catch (error) {
      logger.error(`Failed to fetch channel ${channelId}:`, error);
      return null;
    }
  }

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength - 3) + '...';
  }
}

// Singleton instance
let posterInstance: GitHubDiscordPoster | null = null;

/**
 * Initialize the Discord poster
 */
export function initializeDiscordPoster(
  client: Client,
  config?: Partial<PosterConfig>
): GitHubDiscordPoster {
  posterInstance = new GitHubDiscordPoster(client, config);
  logger.info('GitHub Discord poster initialized');
  return posterInstance;
}

/**
 * Get the Discord poster instance
 */
export function getDiscordPoster(): GitHubDiscordPoster {
  if (!posterInstance) {
    throw new Error(
      'GitHub Discord poster not initialized. Call initializeDiscordPoster first.'
    );
  }
  return posterInstance;
}
