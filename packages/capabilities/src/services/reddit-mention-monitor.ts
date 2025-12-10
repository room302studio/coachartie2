import { v4 as uuidv4 } from 'uuid';
import { createRedisConnection, QUEUES, logger } from '@coachartie/shared';
import { Queue } from 'bullmq';
import { redditClient } from './reddit-client.js';

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
      return m.subreddit ? allowlist.allowedSubreddits.includes(m.subreddit.toLowerCase()) : false;
    });

    const skipped = mentions.length - allowedMentions.length;

    // Queue messages for processing
    const queue = await this.ensureQueue();
    for (const mention of allowedMentions) {
      const mentionId = mention.name || uuidv4();
      const messageText = [
        `Reddit mention for bot account`,
        `Author: u/${mention.author}`,
        mention.subreddit ? `Subreddit: r/${mention.subreddit}` : null,
        mention.linkTitle ? `Thread: ${mention.linkTitle}` : null,
        mention.context ? `Context: https://reddit.com${mention.context}` : mention.linkPermalink,
        mention.body ? `Quoted: ${mention.body}` : null,
      ]
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
