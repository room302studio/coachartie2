/**
 * GitHub Discord Poster
 *
 * Formats and posts GitHub events to Discord channels.
 * Handles embed formatting, mentions, and message styling.
 * Now with Discord ↔ GitHub cross-referencing!
 */

import { createHash } from 'node:crypto';
import { Client, EmbedBuilder, TextChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { logger } from '../../../shared/logger.js';
import { GITHUB_FEED_CHANNEL_ID } from '../../../shared/config/channels.js';
import type { GitHubSyncEvent, GitHubEventType } from './poller.js';
import type { ProcessedEvent, BatchedEvents, DiscordMention } from './event-batcher.js';
import * as engine from '../../../engine/api.js';

/** Short content fingerprint so an edited title/body gets a fresh gist, not a stale one. */
function contentHash(title: string, body: string): string {
  return createHash('sha1').update(title).update('\0').update(body).digest('hex').slice(0, 10);
}

/** Only real http(s) URLs: discord.js throws on anything else, which would drop the post. */
function isLinkable(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Batch lines that actually render a gist; others don't pay for one. */
const BATCH_GIST_TYPES = new Set<string>([
  'issue_opened',
  'issue_closed',
  'issue_comment',
  'pr_comment',
  'pr_opened',
  'pr_draft',
  'pr_ready_for_review',
  'pr_merged',
  'pr_closed',
]);

function formatContentWithPrefix(content: string): string {
  if (content) {
    return `\n${content}`;
  }
  return '';
}

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
  issue_opened: 0x238636, // Green
  issue_closed: 0x8957e5, // Purple
  issue_comment: 0x6e7681, // Gray
  issue_labeled: 0xd29922, // Yellow
  issue_assigned: 0x1f6feb, // Blue
  pr_review_requested: 0xd29922, // Yellow
  pr_draft: 0x6e7681, // Gray
  push: 0x1f6feb, // Blue
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
  issue_opened: '📋',
  issue_closed: '✅',
  issue_comment: '💬',
  issue_labeled: '🏷️',
  issue_assigned: '👤',
  pr_review_requested: '👀',
  pr_draft: '📝',
  push: '⬆️',
};

// Labels that indicate important/breaking changes
const IMPORTANT_LABELS = [
  'breaking-change',
  'breaking',
  'security',
  'critical',
  'urgent',
  'hotfix',
];
const MINOR_LABELS = ['documentation', 'docs', 'chore', 'typo', 'style', 'refactor'];

// Size thresholds for PR size badges (based on total lines changed)
const SIZE_THRESHOLDS = {
  XS: 10, // Tiny fix
  S: 50, // Small change
  M: 200, // Medium feature
  L: 500, // Large feature
  // XL: anything above L
};

// Size badge display with emoji
const SIZE_BADGES: Record<string, { emoji: string; color: number; label: string }> = {
  XS: { emoji: '🟢', color: 0x238636, label: 'XS' },
  S: { emoji: '🟢', color: 0x238636, label: 'S' },
  M: { emoji: '🟡', color: 0xd29922, label: 'M' },
  L: { emoji: '🟠', color: 0xdb6d28, label: 'L' },
  XL: { emoji: '🔴', color: 0xda3633, label: 'XL' },
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

    const gist = await this.gistFor(processed.event);
    const embed = this.createEmbed(processed.event, gist);
    const content = this.formatMentions(processed.mentions);

    try {
      await channel.send({
        content: content || undefined,
        embeds: [embed],
      });
      logger.info(`Posted ${processed.event.type} event to ${channel.id}`);
    } catch (error) {
      logger.error(`Failed to post event to ${channel.id}:`, error);
      // Missing Access / Missing Permissions: the watch points somewhere Artie can't post.
      // Don't drop the event; put it in the studio-wide feed (2026-10-22: a PR comment was
      // lost this way after a channel move).
      const code = (error as { code?: number })?.code;
      if ((code === 50001 || code === 50013) && channel.id !== GITHUB_FEED_CHANNEL_ID) {
        const feed = await this.getChannel(GITHUB_FEED_CHANNEL_ID);
        if (feed) {
          await feed
            .send({ content: `⚠️ couldn't post in <#${channel.id}> (no access), so here:${formatContentWithPrefix(content)}`, embeds: [embed] })
            .catch((e) => logger.error('Fallback post to the GitHub feed also failed:', e));
        }
      }
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

    // Create batch embed (gists for the lines it shows, in parallel)
    const gists = await Promise.all(
      batch.events.slice(0, 5).map((e) => {
        if (BATCH_GIST_TYPES.has(e.event.type)) {
          return this.gistFor(e.event);
        }
        return Promise.resolve(null);
      })
    );
    const embed = this.createBatchEmbed(batch, gists);

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
  private createEmbed(event: GitHubSyncEvent, gist: string | null = null): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(EVENT_COLORS[event.type] || 0x6e7681)
      .setTimestamp(new Date(event.timestamp));

    const emoji = EVENT_EMOJI[event.type] || '📌';
    const [owner, repo] = event.repo.split('/');

    const dense = this.createDenseEmbed(event, embed, gist);
    if (dense) {
      return dense;
    }

    switch (event.type) {
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

      case 'ci_failure': {
        let ciDesc: string;
        if (event.data.checkRunUrl) {
          ciDesc = `**[${event.data.checkRunName}](${event.data.checkRunUrl})** failed`;
        } else {
          ciDesc = `**${event.data.checkRunName}** failed`;
        }
        embed
          .setTitle(`${emoji} CI Failed`)
          .setDescription(ciDesc)
          .setFooter({ text: `${owner}/${repo} • Click name for logs` });
        if (event.data.checkRunUrl) {
          embed.setURL(event.data.checkRunUrl);
        }
        break;
      }

      case 'issue_labeled':
        embed
          .setTitle(`${emoji} Label added to #${event.data.issueNumber}`)
          .setURL(event.data.issueUrl || '')
          .setDescription(`**${event.data.issueTitle}**\n\nLabel: \`${event.data.label}\``)
          .addFields({
            name: 'By',
            value: event.data.commentAuthor || 'Unknown',
            inline: true,
          })
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'issue_assigned':
        embed
          .setTitle(`${emoji} #${event.data.issueNumber} assigned to ${event.data.assignee}`)
          .setURL(event.data.issueUrl || '')
          .setDescription(`**${event.data.issueTitle}**`)
          .addFields({
            name: 'Assigned by',
            value: event.data.assignedBy || 'Unknown',
            inline: true,
          })
          .setFooter({ text: `${owner}/${repo}` });
        break;

      case 'pr_review_requested': {
        const reviewers = event.data.reviewers?.join(', ') || 'Unknown';
        embed
          .setTitle(`${emoji} Review requested on PR #${event.data.prNumber}`)
          .setURL(event.data.prUrl || '')
          .setDescription(`**${event.data.prTitle}**\n\nReviewer: **${reviewers}**`)
          .addFields({
            name: 'Requested by',
            value: event.data.reviewRequestedBy || 'Unknown',
            inline: true,
          })
          .setFooter({ text: `${owner}/${repo}` });
        break;
      }

      case 'push': {
        const commitCount = event.data.commitCount || 1;
        const commits = event.data.commits || [];
        const commitList = commits
          .map((c: any) => `[\`${c.sha}\`](${c.url}) ${c.message} — ${c.author}`)
          .join('\n');

        let pluralS: string;
        if (commitCount > 1) {
          pluralS = 's';
        } else {
          pluralS = '';
        }
        const branch = event.data.branch || 'main';
        embed
          .setTitle(`${emoji} ${commitCount} commit${pluralS} pushed to ${branch}`)
          .setURL(event.data.commitUrl || '')
          .setDescription(commitList || event.data.commitMessage || '')
          .setFooter({ text: `${owner}/${repo}` });
        break;
      }

      default:
        embed
          .setTitle(`${emoji} GitHub Event`)
          .setDescription(event.type)
          .setFooter({ text: `${owner}/${repo}` });
    }

    return embed;
  }

  /**
   * Dense cards (EJ 2026-11-17, "like tufte, any text shown should contain data, no
   * duplication"): the title is `#N gist` (the gist replaces the title, falling back to the
   * title itself), ONE facts line joined by " · ", the repo in the footer, and the state in the
   * color. No emoji headlines, no "By X" restated in fields, no body dumps. Returns null for
   * event types that keep their old card.
   */
  private createDenseEmbed(
    event: GitHubSyncEvent,
    embed: EmbedBuilder,
    gist: string | null
  ): EmbedBuilder | null {
    const d = event.data;
    const repoName = event.repo;
    const stats = this.statFacts(d.additions, d.deletions, d.changedFiles);
    const labels = (d.labels || d.issueLabels || []).map((l) => l.replace(/`/g, "'"));
    let labelFact: string | undefined;
    if (labels.length > 0) {
      labelFact = labels.join(', ');
    }

    let headline: string | undefined;
    let url: string | undefined;
    let facts: Array<string | undefined> = [];
    let quote: string | undefined;

    switch (event.type) {
      case 'pr_opened': {
        headline = this.cardTitle(d.prNumber, gist || d.prTitle);
        url = d.prUrl;
        const size = SIZE_BADGES[this.getPrSize(d.additions, d.deletions)];
        embed.setColor(size.color);
        let sizeFact: string | undefined;
        if (size.label === 'L' || size.label === 'XL') {
          sizeFact = `${size.label}, needs extra review`;
        }
        facts = [`opened → ${d.prBaseBranch || 'main'}`, ...stats, sizeFact, d.prAuthor, labelFact];
        break;
      }
      case 'pr_ready_for_review': {
        headline = this.cardTitle(d.prNumber, gist || d.prTitle);
        url = d.prUrl;
        let reviewFact: string | undefined;
        if (d.reviewers && d.reviewers.length > 0) {
          reviewFact = `review: ${d.reviewers.join(', ')}`;
        }
        facts = ['ready for review', ...stats, d.prAuthor, reviewFact];
        break;
      }
      case 'pr_merged': {
        headline = this.cardTitle(d.prNumber, gist || d.prTitle);
        url = d.prUrl;
        const base = d.prBaseBranch || 'main';
        let mergedFact = `merged → ${base}`;
        if (this.hasImportantLabel(d.labels)) {
          mergedFact = `BREAKING, merged → ${base}`;
          embed.setColor(0xd29922);
        } else if (['main', 'master', 'beta', 'production', 'prod'].includes(base.toLowerCase())) {
          mergedFact = `merged → ${base}, live`;
          embed.setColor(0x238636);
        }
        let byFact = d.prAuthor;
        if (d.mergedBy && d.prAuthor && d.mergedBy !== d.prAuthor) {
          byFact = `${d.prAuthor}, merged by ${d.mergedBy}`;
        }
        facts = [mergedFact, ...stats, byFact];
        break;
      }
      case 'pr_closed':
        headline = this.cardTitle(d.prNumber, gist || d.prTitle);
        url = d.prUrl;
        facts = ['closed unmerged', d.prAuthor];
        break;
      case 'issue_opened':
        headline = this.cardTitle(d.issueNumber, gist || d.issueTitle);
        url = d.issueUrl;
        facts = ['new issue', d.issueAuthor, labelFact];
        break;
      case 'issue_closed': {
        headline = this.cardTitle(d.issueNumber, gist || d.issueTitle);
        url = d.issueUrl;
        let closedFact = 'closed';
        if (d.closedBy) {
          closedFact = `closed by ${d.closedBy}`;
        }
        facts = [closedFact];
        break;
      }
      case 'pr_comment':
      case 'issue_comment': {
        const num = d.prNumber ?? d.issueNumber;
        headline = this.cardTitle(num, d.prTitle || d.issueTitle || 'comment');
        url = d.commentUrl || d.prUrl || d.issueUrl;
        quote = `**${d.commentAuthor || 'someone'}**: ${gist || this.truncate(d.commentBody || '', 280)}`;
        break;
      }
      case 'pr_approved':
      case 'pr_changes_requested': {
        headline = this.cardTitle(d.prNumber, d.prTitle);
        url = d.prUrl;
        let verdict = `approved by ${d.reviewAuthor}`;
        if (event.type === 'pr_changes_requested') {
          verdict = `changes requested by ${d.reviewAuthor}`;
        }
        facts = [verdict];
        if (d.reviewBody) {
          quote = gist || this.truncate(d.reviewBody, 280);
        }
        break;
      }
      default:
        return null;
    }

    embed.setTitle(this.truncate(headline || repoName, 256));
    // discord.js throws on a non-URL, which would drop the whole post.
    if (isLinkable(url)) {
      embed.setURL(url);
    }
    const factLine = facts.filter((f): f is string => Boolean(f)).join(' · ');
    const description = [factLine, quote].filter((s): s is string => Boolean(s)).join('\n');
    if (description) {
      embed.setDescription(description);
    }
    embed.setFooter({ text: repoName });
    return embed;
  }

  private cardTitle(num: number | undefined, text: string | undefined): string {
    if (num === undefined) {
      return text || '';
    }
    return `#${num} ${text || ''}`.trim();
  }

  /** "+412 −88", "14 files": only what's known. */
  private statFacts(additions?: number, deletions?: number, files?: number): string[] {
    const out: string[] = [];
    if (additions !== undefined || deletions !== undefined) {
      out.push(`+${additions || 0} −${deletions || 0}`);
    }
    if (files) {
      let noun = 'files';
      if (files === 1) {
        noun = 'file';
      }
      out.push(`${files} ${noun}`);
    }
    return out;
  }

  /**
   * What to send the gist model for this event, or null when the plain text is already the
   * best data (no body to distill, or a comment short enough to show whole).
   */
  gistRequestFor(event: GitHubSyncEvent): { key: string; kind: string; title: string; body: string } | null {
    const d = event.data;
    const SHORT = 160;
    switch (event.type) {
      case 'pr_opened':
      case 'pr_ready_for_review':
      case 'pr_merged':
      case 'pr_closed':
        if (!d.prTitle || !d.prBody || d.prBody.trim().length < 40) {
          return null;
        }
        return {
          key: `${event.repo}#${d.prNumber}:pr:${contentHash(d.prTitle, d.prBody)}`,
          kind: 'pull request',
          title: d.prTitle,
          body: d.prBody,
        };
      case 'issue_opened':
      case 'issue_closed':
        if (!d.issueTitle || !d.issueBody || d.issueBody.trim().length < 40) {
          return null;
        }
        return {
          key: `${event.repo}#${d.issueNumber}:issue:${contentHash(d.issueTitle, d.issueBody)}`,
          kind: 'issue',
          title: d.issueTitle,
          body: d.issueBody,
        };
      case 'pr_comment':
      case 'issue_comment': {
        const body = d.commentBody || '';
        if (body.length <= SHORT) {
          return null;
        }
        return {
          key: `${event.repo}#${d.prNumber ?? d.issueNumber}:comment:${d.commentId ?? body.length}`,
          kind: 'comment (summarize only what the comment says)',
          title: this.truncate(body.split('\n')[0], 120),
          body,
        };
      }
      case 'pr_approved':
      case 'pr_changes_requested': {
        const body = d.reviewBody || '';
        if (body.length <= SHORT) {
          return null;
        }
        return {
          key: `${event.repo}#${d.prNumber}:review:${d.reviewId ?? body.length}`,
          kind: 'code review (summarize only what the reviewer asks for)',
          title: this.truncate(body.split('\n')[0], 120),
          body,
        };
      }
      default:
        return null;
    }
  }

  private async gistFor(event: GitHubSyncEvent): Promise<string | null> {
    const req = this.gistRequestFor(event);
    if (!req) {
      return null;
    }
    try {
      return await engine.githubGist({ ...req, guildId: event.guildId });
    } catch {
      return null;
    }
  }

  /**
   * Create embed for a batch of events
   */
  private createBatchEmbed(batch: BatchedEvents, gists: Array<string | null> = []): EmbedBuilder {
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
      .map((e, i) => this.getShortEventSummary(e.event, gists[i] ?? null))
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
   * Get short summary for event (for batch display)
   */
  private getShortEventSummary(event: GitHubSyncEvent, gist: string | null = null): string {
    switch (event.type) {
      case 'pr_comment':
        return `${event.data.commentAuthor}: ${gist || this.truncate(event.data.commentBody || '', 80)}`;
      case 'pr_approved':
        return `${event.data.reviewAuthor} approved`;
      case 'pr_changes_requested':
        return `${event.data.reviewAuthor} requested changes`;
      case 'ci_success':
        return `${event.data.checkRunName} passed`;
      case 'ci_failure':
        return `${event.data.checkRunName} failed`;
      case 'issue_opened':
      case 'issue_closed':
        return this.numberedLine(event.data.issueNumber, event.data.issueUrl, gist || event.data.issueTitle);
      case 'issue_comment':
        return `${this.numberedLine(event.data.issueNumber, event.data.issueUrl, undefined)} ${event.data.commentAuthor}: ${gist || this.truncate(event.data.commentBody || '', 80)}`;
      case 'issue_labeled':
        return `${this.numberedLine(event.data.issueNumber, event.data.issueUrl, undefined)} +\`${(event.data.label || '').replace(/`/g, "'")}\``;
      case 'issue_assigned':
        return `${this.numberedLine(event.data.issueNumber, event.data.issueUrl, undefined)} → ${event.data.assignee}`;
      case 'pr_opened':
      case 'pr_draft':
      case 'pr_ready_for_review':
      case 'pr_merged':
      case 'pr_closed':
        return this.numberedLine(event.data.prNumber, event.data.prUrl, gist || event.data.prTitle);
      default:
        // Never print a bare raw event type (the 4× "issue_opened" card, 2026-11-17).
        return this.fallbackLine(event);
    }
  }

  private fallbackLine(event: GitHubSyncEvent): string {
    const kind = event.type.replace(/_/g, ' ');
    if (event.data.issueNumber) {
      return `${this.numberedLine(event.data.issueNumber, event.data.issueUrl, event.data.issueTitle)} (${kind})`;
    }
    if (event.data.prNumber) {
      return `${this.numberedLine(event.data.prNumber, event.data.prUrl, event.data.prTitle)} (${kind})`;
    }
    return kind;
  }

  /** "[#1502](url) Title", trimmed to one scannable line. */
  private numberedLine(num: number | undefined, url: string | undefined, title: string | undefined): string {
    let ref: string;
    if (url) {
      ref = `[#${num}](${url})`;
    } else {
      ref = `#${num}`;
    }
    if (!title) {
      return ref;
    }
    return `${ref} ${this.truncate(title, 80)}`;
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

  /**
   * Check if PR has important/breaking labels
   */
  private hasImportantLabel(labels?: string[]): boolean {
    if (!labels || labels.length === 0) return false;
    return labels.some((label) =>
      IMPORTANT_LABELS.some((important) => label.toLowerCase().includes(important.toLowerCase()))
    );
  }

  /**
   * Get PR size category based on lines changed
   */
  private getPrSize(additions?: number, deletions?: number): keyof typeof SIZE_BADGES {
    const total = (additions || 0) + (deletions || 0);
    if (total <= SIZE_THRESHOLDS.XS) return 'XS';
    if (total <= SIZE_THRESHOLDS.S) return 'S';
    if (total <= SIZE_THRESHOLDS.M) return 'M';
    if (total <= SIZE_THRESHOLDS.L) return 'L';
    return 'XL';
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
    throw new Error('GitHub Discord poster not initialized. Call initializeDiscordPoster first.');
  }
  return posterInstance;
}
