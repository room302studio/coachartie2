import { v4 as uuidv4 } from 'uuid';
import { createRedisConnection } from '../../shared/queue/redis.js';
import { QUEUES } from '../../shared/queue/names.js';
import { logger } from '../../shared/logger.js';
import { Queue } from 'bullmq';
import { redditClient } from '../tools/personal/reddit-client.js';

interface MentionJobContext {
  mentionId: string;
  mention: {
    name: string;
    author: string;
    subreddit?: string;
    body?: string;
    context?: string;
    linkTitle?: string;
    linkPermalink?: string;
    createdUtc?: number;
  };
}

/**
 * Check if a subreddit is in the allowlist
 */
function isSubredditAllowed(subreddit: string | undefined, allowedSubreddits: string[]): boolean {
  if (subreddit) {
    return allowedSubreddits.includes(subreddit.toLowerCase());
  }
  return false;
}

/**
 * Format subreddit info for message
 */
function formatSubreddit(subreddit: string | undefined): string | null {
  if (subreddit) {
    return `Subreddit: r/${subreddit}`;
  }
  return null;
}

/**
 * Format link title for message
 */
function formatLinkTitle(title: string | undefined): string | null {
  if (title) {
    return `Thread: ${title}`;
  }
  return null;
}

/**
 * Format body quote for message
 */
function formatBodyQuote(body: string | undefined): string | null {
  if (body) {
    return `Quoted: ${body}`;
  }
  return null;
}

export class RedditMentionMonitor {
  private incomingQueue: Queue | null = null;

  constructor() {
    // Lazy init; create queue only if Redis is available
  }

  private async ensureQueue(): Promise<Queue> {
    if (this.incomingQueue) return this.incomingQueue;
    this.incomingQueue = new Queue(QUEUES.INCOMING_MESSAGES, {
      connection: createRedisConnection(),
    });
    return this.incomingQueue;
  }

  async pollMentions(): Promise<{ fetched: number; queued: number; skipped: number }> {
    if (!redditClient.isConfigured()) {
      logger.warn('Reddit mention poll skipped: reddit not configured');
      return { fetched: 0, queued: 0, skipped: 0 };
    }

    const allowlist = redditClient.getAllowedSubreddits();

    const mentionsResult = await redditClient.fetchMentions(50);
    const mentions = mentionsResult.mentions;

    if (!mentions.length) {
      logger.info('No new Reddit mentions found');
      return { fetched: 0, queued: 0, skipped: 0 };
    }

    const allowedMentions = mentions.filter((m) => {
      if (allowlist.allowedSubreddits.length === 0) return true;
      return isSubredditAllowed(m.subreddit, allowlist.allowedSubreddits);
    });

    const skipped = mentions.length - allowedMentions.length;

    // Queue messages for processing
    const queue = await this.ensureQueue();
    for (const mention of allowedMentions) {
      const mentionId = mention.name || uuidv4();
      const messageLines: (string | null)[] = [
        `Reddit mention for bot account`,
        `Author: u/${mention.author}`,
        formatSubreddit(mention.subreddit),
        formatLinkTitle(mention.linkTitle),
      ];

      let contextLine: string;
      if (mention.context) {
        contextLine = `Context: https://reddit.com${mention.context}`;
      } else {
        contextLine = mention.linkPermalink || '';
      }
      if (contextLine) {
        messageLines.push(contextLine);
      }

      messageLines.push(formatBodyQuote(mention.body));

      const messageText = messageLines
        .filter(Boolean)
        .join('\n');

      const context: MentionJobContext = {
        mentionId,
        mention: {
          name: mention.name,
          author: mention.author,
          subreddit: mention.subreddit,
          body: mention.body,
          context: mention.context,
          linkTitle: mention.linkTitle,
          linkPermalink: mention.linkPermalink,
          createdUtc: mention.createdUtc,
        },
      };

      await queue.add('incoming-message', {
        id: mentionId,
        timestamp: new Date(),
        retryCount: 0,
        source: 'reddit',
        userId: `reddit:${mention.author}`,
        message: messageText,
        context: {
          platform: 'reddit',
          shouldRespond: false, // avoid noisy status replies; LLM can still act with capabilities
          reddit: {
            ...context,
            allowedSubreddits: allowlist.allowedSubreddits,
            botUsername: redditClient.getBotUsername(),
          },
        },
        respondTo: {
          type: 'reddit',
        },
      });
    }

    // Mark all mentions as read (both allowed and skipped) to avoid reprocessing noise
    await redditClient.markMessagesRead(mentions.map((m) => m.name).filter(Boolean));

    logger.info(
      `Queued ${allowedMentions.length} Reddit mention(s); skipped ${skipped} (not in allowlist)`
    );

    return { fetched: mentions.length, queued: allowedMentions.length, skipped };
  }
}

export const redditMentionMonitor = new RedditMentionMonitor();
