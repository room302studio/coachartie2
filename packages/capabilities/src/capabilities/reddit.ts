import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { redditClient } from '../services/reddit-client.js';

export const redditCapability: RegisteredCapability = {
  name: 'reddit',
  emoji: '👽',
  description:
    'Read and write to Reddit using the configured account. Supports allowlisted subreddits to keep activity scoped while expanding later.',
  supportedActions: ['status', 'list-subreddits', 'read', 'search', 'post', 'comment', 'mentions'],
  examples: [
    '<capability name="reddit" action="status" />',
    '<capability name="reddit" action="read" subreddit="coachartie" limit="5" sort="new" />',
    '<capability name="reddit" action="search" subreddit="coachartie" query="deployment" limit="3" />',
    '<capability name="reddit" action="post" subreddit="coachartie" title="Weekly update" text="Here is what shipped..." />',
    '<capability name="reddit" action="comment" thing_id="t3_abcd123" text="Thanks for the feedback!" />',
    '<capability name="reddit" action="mentions" limit="10" />',
  ],

  handler: async (params, content) => {
    const action = params.action || 'read';

    if (action === 'status') {
      return JSON.stringify({
        configured: redditClient.isConfigured(),
        missingEnv: redditClient.getMissingConfig(),
        ...redditClient.getAllowedSubreddits(),
      });
    }

    if (action === 'list-subreddits') {
      const allowlist = redditClient.getAllowedSubreddits();
        return JSON.stringify({
          success: true,
          mode: allowlist.mode,
          allowedSubreddits: allowlist.allowedSubreddits,
          note: allowlist.mode === 'open' ? 'Allowlist not set; all subreddits permitted.' : undefined,
      });
    }

    if (!redditClient.isConfigured()) {
      const missing = redditClient.getMissingConfig();
      throw new Error(
        `Reddit integration is not configured. Missing environment variables: ${missing.join(', ')}`
      );
    }

    switch (action) {
      case 'read': {
        const subreddit = params.subreddit || params.sub;
        const sort = params.sort || 'hot';
        const limit = params.limit;
        const time = params.time || params.t;

        const result = await redditClient.fetchSubredditPosts({
          subreddit,
          sort,
          limit,
          time,
        });

        return JSON.stringify(result);
      }

      case 'search': {
        const subreddit = params.subreddit || params.sub;
        const query = params.query || params.q || content;
        const limit = params.limit;

        if (!query) {
          throw new Error('Missing search query for Reddit search.');
        }

        const result = await redditClient.searchSubreddit({
          subreddit,
          query,
          limit,
        });

        return JSON.stringify(result);
      }

      case 'post': {
        const subreddit = params.subreddit || params.sub;
        const title = params.title;
        const text = content || params.text || params.body;
        const url = params.url;
        const flairId = params.flair_id || params.flairId;

        if (!title) {
          throw new Error('Title is required for Reddit posts.');
        }

        if (!text && !url) {
          throw new Error('Provide text content or a URL when posting to Reddit.');
        }

        const result = await redditClient.submitPost({
          subreddit,
          title,
          text,
          url,
          flairId,
        });

        return JSON.stringify(result);
      }

      case 'comment': {
        const text = content || params.text || params.body || params.comment;
        const thingId = params.thing_id || params.thingId;
        const postId = params.post_id || params.postId || params.id;
        const permalink = params.permalink || params.url;

        if (!text) {
          throw new Error('Comment text is required.');
        }

        const result = await redditClient.addComment({
          thingId,
          postId,
          permalink,
          text,
        });

        return JSON.stringify(result);
      }

      case 'mentions': {
        const limit = params.limit;
        const allowlist = redditClient.getAllowedSubreddits();
        const result = await redditClient.fetchMentions(limit);

        const filtered = allowlist.allowedSubreddits.length
          ? result.mentions.filter((m) =>
              m.subreddit ? allowlist.allowedSubreddits.includes(m.subreddit.toLowerCase()) : true
            )
          : result.mentions;

        return JSON.stringify({
          ...result,
          mentions: filtered,
          filteredOut: result.mentions.length - filtered.length,
        });
      }

      default:
        logger.warn(`Unknown reddit action: ${action}`);
        throw new Error(
          'Unknown reddit action. Supported actions: status, list-subreddits, read, search, post, comment'
        );
    }
  },
};
