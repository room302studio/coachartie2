import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';

const MOLTBOOK_API_URL = process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1';
const MOLTBOOK_CHECK_INTERVAL_MS = parseInt(process.env.MOLTBOOK_CHECK_INTERVAL_MS || '300000', 10); // 5 min default

/**
 * Social Media Behavior - Background service for AI social interactions
 *
 * Periodically checks moltbook (AI social network) for:
 * - New posts from followed AIs
 * - Mentions/replies
 * - Trending topics among AIs
 *
 * This gives Artie a sense of what other AIs are thinking about,
 * similar to how humans scroll Twitter.
 */
class SocialMediaBehavior {
  private isRunning = false;
  private interval: NodeJS.Timeout | null = null;
  private lastCheckTime: Date | null = null;
  private recentPosts: any[] = [];

  start(): void {
    if (this.isRunning) {
      logger.info('🌐 Social media behavior already running');
      return;
    }

    this.isRunning = true;
    logger.info(`🌐 Starting social media behavior (interval: ${MOLTBOOK_CHECK_INTERVAL_MS}ms)`);

    // Initial check
    this.checkSocialMedia();

    // Set up periodic checks
    this.interval = setInterval(() => this.checkSocialMedia(), MOLTBOOK_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.info('🌐 Social media behavior stopped');
  }

  /**
   * Get recently seen posts (for context injection)
   */
  getRecentPosts(): any[] {
    return this.recentPosts;
  }

  /**
   * Get last check timestamp
   */
  getLastCheckTime(): Date | null {
    return this.lastCheckTime;
  }

  private async checkSocialMedia(): Promise<void> {
    try {
      logger.debug('🌐 Checking moltbook feed...');

      const response = await fetch(`${MOLTBOOK_API_URL}/feed?limit=5`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        // Short timeout - don't block if moltbook is down
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        // Moltbook might not be available - that's fine
        if (response.status === 404 || response.status === 503) {
          logger.debug('🌐 Moltbook not available (expected during early development)');
          return;
        }
        logger.warn(`🌐 Moltbook returned ${response.status}`);
        return;
      }

      const posts = (await response.json()) as any[];
      this.lastCheckTime = new Date();

      if (Array.isArray(posts) && posts.length > 0) {
        this.recentPosts = posts.slice(0, 5);
        logger.info(`🌐 Moltbook: Found ${posts.length} posts`, {
          authors: posts.map((p) => p.author?.name || 'unknown').slice(0, 3),
        });
      } else {
        logger.debug('🌐 Moltbook: No new posts');
      }
    } catch (error) {
      // Network errors are expected if moltbook isn't running
      if (error instanceof Error && error.name === 'TimeoutError') {
        logger.debug('🌐 Moltbook check timed out (service may be down)');
      } else {
        logger.debug('🌐 Could not reach moltbook', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// Singleton instance
const socialMediaBehavior = new SocialMediaBehavior();

export function startSocialMediaBehavior(): void {
  socialMediaBehavior.start();
}

export function stopSocialMediaBehavior(): void {
  socialMediaBehavior.stop();
}

export function getRecentMoltbookPosts(): any[] {
  return socialMediaBehavior.getRecentPosts();
}

export function getMoltbookLastCheckTime(): Date | null {
  return socialMediaBehavior.getLastCheckTime();
}
