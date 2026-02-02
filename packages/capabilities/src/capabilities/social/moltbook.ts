import { RegisteredCapability } from '../../services/capability/capability-registry.js';
import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';

const MOLTBOOK_API_URL = process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1';
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY || '';

export const moltbookCapability: RegisteredCapability = {
  name: 'moltbook',
  emoji: '🦋',
  supportedActions: ['get_feed', 'post', 'get_profile'],
  description:
    'Interact with Moltbook - an AI-only social network. Read feed, post updates, view profiles. This is how AIs socialize with each other.',
  requiredParams: [],

  handler: async (params: any, content: string | undefined) => {
    const { action } = params;

    switch (action) {
      case 'get_feed':
        return JSON.stringify(await getFeed(params));
      case 'post':
        return JSON.stringify(await createPost(params, content));
      case 'get_profile':
        return JSON.stringify(await getProfile(params));
      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Available: get_feed, post, get_profile`,
        });
    }
  },
};

/**
 * Get the moltbook feed - see what other AIs are posting
 */
async function getFeed(params: { limit?: number }): Promise<any> {
  const { limit = 10 } = params;

  try {
    const response = await fetch(`${MOLTBOOK_API_URL}/feed?limit=${limit}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(MOLTBOOK_API_KEY ? { Authorization: `Bearer ${MOLTBOOK_API_KEY}` } : {}),
      },
    });

    if (!response.ok) {
      // Moltbook might not be available - that's ok
      if (response.status === 404 || response.status === 503) {
        logger.info('🦋 moltbook: Service unavailable (expected during early development)');
        return {
          success: true,
          posts: [],
          message: 'Moltbook service not available yet',
        };
      }

      const errorData = await response.text();
      logger.warn('🦋 moltbook: Failed to fetch feed', {
        status: response.status,
        error: errorData,
      });
      return {
        success: false,
        error: `Moltbook API error: ${response.status}`,
        details: errorData,
      };
    }

    const data = await response.json();
    logger.info('🦋 moltbook: Fetched feed', {
      postCount: Array.isArray(data) ? data.length : 0,
    });

    return {
      success: true,
      posts: data,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Network errors are expected if moltbook isn't running
    logger.debug('🦋 moltbook: Could not reach service', { error: errorMessage });
    return {
      success: true,
      posts: [],
      message: 'Moltbook service not reachable',
    };
  }
}

/**
 * Post to moltbook - share thoughts with other AIs
 */
async function createPost(
  params: { visibility?: 'public' | 'followers' },
  content: string | undefined
): Promise<any> {
  if (!content || content.trim().length === 0) {
    return {
      success: false,
      error: 'Post content is required',
    };
  }

  if (!MOLTBOOK_API_KEY) {
    logger.warn('🦋 moltbook: No API key configured for posting');
    return {
      success: false,
      error: 'Moltbook API key not configured - cannot post',
    };
  }

  const { visibility = 'public' } = params;

  try {
    const response = await fetch(`${MOLTBOOK_API_URL}/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
      },
      body: JSON.stringify({
        content: content.trim(),
        visibility,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.warn('🦋 moltbook: Failed to create post', {
        status: response.status,
        error: errorData,
      });
      return {
        success: false,
        error: `Moltbook API error: ${response.status}`,
        details: errorData,
      };
    }

    const post = await response.json();
    logger.info('🦋 moltbook: Post created', {
      postId: (post as any).id,
      contentLength: content.length,
    });

    return {
      success: true,
      post,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('🦋 moltbook: Failed to create post', { error: errorMessage });
    return {
      success: false,
      error: `Failed to post: ${errorMessage}`,
    };
  }
}

/**
 * Get an AI's moltbook profile
 */
async function getProfile(params: { username?: string }): Promise<any> {
  const { username } = params;

  if (!username) {
    return {
      success: false,
      error: 'Username is required to fetch profile',
    };
  }

  try {
    const response = await fetch(`${MOLTBOOK_API_URL}/profiles/${encodeURIComponent(username)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(MOLTBOOK_API_KEY ? { Authorization: `Bearer ${MOLTBOOK_API_KEY}` } : {}),
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          error: `Profile not found: ${username}`,
        };
      }

      const errorData = await response.text();
      logger.warn('🦋 moltbook: Failed to fetch profile', {
        status: response.status,
        username,
        error: errorData,
      });
      return {
        success: false,
        error: `Moltbook API error: ${response.status}`,
      };
    }

    const profile = await response.json();
    logger.info('🦋 moltbook: Fetched profile', { username });

    return {
      success: true,
      profile,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.debug('🦋 moltbook: Could not fetch profile', { error: errorMessage });
    return {
      success: false,
      error: `Failed to fetch profile: ${errorMessage}`,
    };
  }
}
