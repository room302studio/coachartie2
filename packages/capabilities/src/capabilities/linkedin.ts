import { logger } from '@coachartie/shared';
import axios from 'axios';
import { RegisteredCapability } from '../services/capability-registry.js';
import { oauthManager } from '../services/oauth-manager.js';

/**
 * LinkedIn integration capability for autonomous posting and profile management
 *
 * Provides functionality to:
 * - Authenticate with LinkedIn OAuth
 * - Post content autonomously
 * - Update profile information
 * - Generate professional content
 * - Schedule posts
 */

interface LinkedInProfile {
  id: string;
  localizedFirstName: string;
  localizedLastName: string;
  profilePicture?: {
    displayImage: string;
  };
  localizedHeadline?: string;
}

interface LinkedInPost {
  content: string;
  visibility: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN';
  media?: {
    type: 'IMAGE' | 'VIDEO' | 'ARTICLE';
    url: string;
  };
}

class LinkedInService {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private userId: string = 'default'; // Can be overridden per request
  private baseUrl = 'https://api.linkedin.com/v2';

  constructor(userId?: string) {
    if (userId) {
      this.userId = userId;
    }
    // Tokens will be loaded from database when needed
  }

  /**
   * Load tokens from database
   */
  async loadTokens(): Promise<boolean> {
    try {
      const tokens = await oauthManager.getTokens(this.userId, 'linkedin');
      if (tokens) {
        // Check if token is expired
        if (oauthManager.isTokenExpired(tokens)) {
          logger.warn('⚠️ LinkedIn token is expired, needs refresh');
          // TODO: Implement token refresh
          return false;
        }

        this.accessToken = tokens.accessToken;
        this.refreshToken = tokens.refreshToken || null;
        logger.info(`✅ LinkedIn tokens loaded from database for user ${this.userId}`);
        return true;
      }

      // Fallback to environment variables for backward compatibility
      if (process.env.LINKEDIN_ACCESS_TOKEN) {
        this.accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
        this.refreshToken = process.env.LINKEDIN_REFRESH_TOKEN || null;
        logger.info('📦 LinkedIn tokens loaded from environment variables');
        return true;
      }

      return false;
    } catch (error) {
      logger.error('❌ Failed to load LinkedIn tokens:', error);
      return false;
    }
  }

  /**
   * Initialize OAuth flow - returns authorization URL
   */
  getAuthorizationUrl(): string {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const redirectUri =
      process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/auth/linkedin/callback';
    const scope = 'openid profile w_member_social email';
    const state = Math.random().toString(36).substring(7);

    return (
      `https://www.linkedin.com/oauth/v2/authorization?` +
      `response_type=code&` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&` +
      `state=${state}`
    );
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<void> {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirectUri =
      process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/auth/linkedin/callback';

    try {
      const response = await axios.post(
        'https://www.linkedin.com/oauth/v2/accessToken',
        {
          grant_type: 'authorization_code',
          code: code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;

      if (!this.accessToken) {
        throw new Error('No access token received from LinkedIn');
      }

      // Store tokens securely in database
      const expiresIn = response.data.expires_in; // Seconds until expiration
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined;

      await oauthManager.storeTokens({
        userId: this.userId,
        provider: 'linkedin',
        accessToken: this.accessToken,
        refreshToken: this.refreshToken || undefined,
        expiresAt: expiresAt,
        scopes: ['openid', 'profile', 'w_member_social', 'email'],
        metadata: {
          tokenType: response.data.token_type,
          scope: response.data.scope,
        },
      });

      logger.info(`✅ LinkedIn OAuth tokens obtained and stored for user ${this.userId}`);
    } catch (error) {
      logger.error('❌ Failed to exchange LinkedIn OAuth code:', error);
      throw error;
    }
  }

  /**
   * Get current user's LinkedIn profile
   */
  async getProfile(): Promise<LinkedInProfile | null> {
    // Try to load tokens if not already loaded
    if (!this.accessToken) {
      const tokensLoaded = await this.loadTokens();
      if (!tokensLoaded) {
        throw new Error('No LinkedIn access token available');
      }
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/people/~:(id,localizedFirstName,localizedLastName,profilePicture(displayImage~digitalmediaAsset:playableStreams),localizedHeadline)`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'LinkedIn-Version': '202212',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('❌ Failed to get LinkedIn profile:', error);
      return null;
    }
  }

  /**
   * Post content to LinkedIn
   */
  async createPost(post: LinkedInPost): Promise<boolean> {
    // Try to load tokens if not already loaded
    if (!this.accessToken) {
      const tokensLoaded = await this.loadTokens();
      if (!tokensLoaded) {
        throw new Error('No LinkedIn access token available');
      }
    }

    try {
      const profile = await this.getProfile();
      if (!profile) {
        throw new Error('Could not get LinkedIn profile');
      }

      const postData = {
        author: `urn:li:person:${profile.id}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: post.content,
            },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': post.visibility,
        },
      };

      const response = await axios.post(`${this.baseUrl}/ugcPosts`, postData, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202212',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });

      logger.info('✅ LinkedIn post created successfully:', response.data.id);
      return true;
    } catch (error) {
      logger.error('❌ Failed to create LinkedIn post:', error);
      return false;
    }
  }

  /**
   * Generate professional LinkedIn content using AI
   */
  async generateContent(
    topic: string,
    tone: 'professional' | 'casual' | 'thought-leadership' = 'professional'
  ): Promise<string> {
    const startTime = Date.now();
    logger.info(`🔍 Starting LinkedIn content generation for topic: "${topic}", tone: ${tone}`);

    try {
      const { openRouterService } = await import('../services/openrouter.js');
      const { contextAlchemy } = await import('../services/context-alchemy.js');
      const { promptManager } = await import('../services/prompt-manager.js');

      // Quick health check with shorter timeout
      const healthTimeout = 5000; // 5 seconds for health check
      const healthPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), healthTimeout);
        openRouterService
          .isHealthy()
          .then(resolve)
          .catch(() => resolve(false));
      });

      const isHealthy = await healthPromise;
      if (!isHealthy) {
        throw new Error(
          'OpenRouter service is not available for content generation - health check failed'
        );
      }

      const prompts = {
        professional: `Write a professional LinkedIn post about "${topic}". Keep it engaging, informative, and under 300 characters. Include 2-3 relevant hashtags at the end.`,
        casual: `Write a casual but professional LinkedIn post about "${topic}". Make it conversational and relatable. Under 250 characters with hashtags.`,
        'thought-leadership': `Write a thought-leadership LinkedIn post about "${topic}". Share insights, ask an engaging question, and encourage discussion. Under 400 characters with hashtags.`,
      };

      const userMessage = `${prompts[tone]}

Write in an authentic, professional voice that is:
- Encouraging and supportive
- Growth-oriented and optimistic
- Professional but not corporate
- Genuine and authentic

Return only the post content, ready to publish on LinkedIn.`;

      logger.info(`🚀 Building message chain via Context Alchemy...`);

      // Get base system prompt from prompt database
      const baseSystemPrompt = await promptManager.getCapabilityInstructions(userMessage);

      // Build intelligent message chain via Context Alchemy
      const { messages } = await contextAlchemy.buildMessageChain(
        userMessage,
        'linkedin-content-generation',
        baseSystemPrompt
      );

      logger.info(`🚀 Sending request to OpenRouter service with ${messages.length} messages...`);

      // Add more aggressive timeout for content generation
      const timeoutMs = 25000; // 25 seconds (reduced from 30)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`LinkedIn content generation timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      const response = await Promise.race([
        openRouterService.generateFromMessageChain(messages, 'linkedin-content-generation'),
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;
      logger.info(`✅ LinkedIn content generated successfully in ${duration}ms`);

      // Validate response length and content
      const trimmedResponse = response.trim();
      if (trimmedResponse.length < 10) {
        throw new Error('Generated content too short, AI service returned invalid response');
      }

      if (
        trimmedResponse.toLowerCase().includes('technical difficulties') ||
        trimmedResponse.toLowerCase().includes('i cannot') ||
        trimmedResponse.toLowerCase().includes('i am unable')
      ) {
        throw new Error('AI service returned error message instead of content');
      }

      return trimmedResponse;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`❌ Failed to generate LinkedIn content after ${duration}ms:`, error);

      // Provide detailed error context
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ LinkedIn generation error details: ${errorMessage}`);

      // Enhanced error context for debugging
      if (errorMessage.includes('timeout')) {
        throw new Error(
          `LinkedIn content generation timeout after ${duration}ms - free models may be overloaded. Try again or consider upgrading to premium models.`
        );
      }

      if (errorMessage.includes('health check failed')) {
        throw new Error(
          `LinkedIn content generation failed - OpenRouter service is currently unavailable. Please try again later.`
        );
      }

      // Re-throw the error with additional context
      throw new Error(
        `Failed to generate LinkedIn content: ${errorMessage}. Duration: ${duration}ms`
      );
    }
  }

  /**
   * Update LinkedIn profile information
   */
  async updateProfile(updates: { headline?: string; summary?: string }): Promise<boolean> {
    if (!this.accessToken) {
      throw new Error('No LinkedIn access token available');
    }

    try {
      const profile = await this.getProfile();
      if (!profile) {
        throw new Error('Could not get LinkedIn profile');
      }

      // LinkedIn API for profile updates is restricted to partners
      // This would require using LinkedIn's Profile API which needs approval
      logger.warn('⚠️ LinkedIn profile updates require API partnership approval');
      return false;
    } catch (error) {
      logger.error('❌ Failed to update LinkedIn profile:', error);
      return false;
    }
  }

  /**
   * Check if LinkedIn integration is properly configured
   */
  isConfigured(): boolean {
    return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.accessToken;
  }
}

// Service instance cache per user
const serviceCache = new Map<string, LinkedInService>();

/**
 * Get or create LinkedIn service for a specific user
 */
function getLinkedInService(userId: string = 'default'): LinkedInService {
  if (!serviceCache.has(userId)) {
    serviceCache.set(userId, new LinkedInService(userId));
  }
  return serviceCache.get(userId)!;
}

/**
 * LinkedIn capability handler
 */
async function handleLinkedInCapability(params: any, content?: string): Promise<string> {
  const { action } = params;

  // Extract userId from params or use default
  const userId = params.userId || params.user_id || 'default';
  const linkedInService = getLinkedInService(userId);

  try {
    switch (action) {
      case 'get_auth_url':
        if (!linkedInService.isConfigured()) {
          throw new Error(
            `LinkedIn not configured. Please set these environment variables:\n` +
              `- LINKEDIN_CLIENT_ID\n` +
              `- LINKEDIN_CLIENT_SECRET\n\n` +
              `Get these from: https://www.linkedin.com/developers/apps`
          );
        }
        const authUrl = linkedInService.getAuthorizationUrl();
        return `🔗 Please visit this URL to authorize LinkedIn access: ${authUrl}`;

      case 'exchange_code':
        const { code } = params;
        if (!code) {
          throw new Error(
            `Authorization code is required for exchange_code action.\n\n` +
              `Usage: <capability name="linkedin" action="exchange_code" code="YOUR_AUTH_CODE" />\n\n` +
              `First call get_auth_url to get the authorization URL, then paste the code here.`
          );
        }
        await linkedInService.exchangeCodeForToken(code);
        return '✅ LinkedIn authorization successful! You can now post and manage your LinkedIn profile.';

      case 'get_profile':
        if (!linkedInService.isAuthenticated()) {
          throw new Error(
            `Not authenticated with LinkedIn. You must authorize first.\n\n` +
              `Steps:\n` +
              `1. Call action="get_auth_url" to get the authorization link\n` +
              `2. Visit the link and authorize the application\n` +
              `3. Use the returned code with action="exchange_code" to authenticate`
          );
        }
        const profile = await linkedInService.getProfile();
        if (profile) {
          return `👤 LinkedIn Profile:
Name: ${profile.localizedFirstName} ${profile.localizedLastName}
Headline: ${profile.localizedHeadline || 'No headline set'}
ID: ${profile.id}`;
        }
        throw new Error(
          'Could not retrieve LinkedIn profile. Check your authentication or network connection.'
        );

      case 'create_post':
        if (!linkedInService.isAuthenticated()) {
          throw new Error(
            `Not authenticated with LinkedIn. You must authorize first.\n\n` +
              `Steps:\n` +
              `1. Call action="get_auth_url"\n` +
              `2. Authorize and get the code\n` +
              `3. Use action="exchange_code" with the code`
          );
        }

        const postContent = content || params.content;
        if (!postContent) {
          throw new Error(
            `Post content is required for create_post action.\n\n` +
              `Usage: <capability name="linkedin" action="create_post" visibility="PUBLIC">Your post content here</capability>`
          );
        }

        const visibility = params.visibility || 'PUBLIC';
        const success = await linkedInService.createPost({
          content: postContent,
          visibility: visibility as 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN',
        });

        if (!success) {
          throw new Error(
            'Failed to create LinkedIn post. Check your authentication and try again.'
          );
        }
        return '✅ LinkedIn post created successfully!';

      case 'generate_content':
        logger.info(`🚀 LinkedIn generate_content called with params:`, params);
        const topic = params.topic || content;
        if (!topic) {
          throw new Error(
            `Topic is required for content generation.\n\n` +
              `Usage: <capability name="linkedin" action="generate_content" topic="AI trends" tone="professional" />\n\n` +
              `Available tones: professional, casual, thought-leadership`
          );
        }

        const tone = params.tone || 'professional';
        logger.info(
          `🎯 About to call linkedInService.generateContent with topic: "${topic}", tone: "${tone}"`
        );

        try {
          const generatedContent = await linkedInService.generateContent(topic, tone);
          logger.info(
            `✅ LinkedIn content generated successfully: ${generatedContent.substring(0, 100)}...`
          );
          return `📝 Generated LinkedIn content:\n\n${generatedContent}`;
        } catch (error) {
          logger.error(`❌ LinkedIn content generation failed:`, error);
          throw error;
        }

      case 'update_profile':
        if (!linkedInService.isAuthenticated()) {
          throw new Error(`Not authenticated with LinkedIn. Please run get_auth_url first.`);
        }

        const updates = {
          headline: params.headline,
          summary: params.summary,
        };

        const updateSuccess = await linkedInService.updateProfile(updates);
        if (!updateSuccess) {
          throw new Error(
            `Profile updates require LinkedIn API partnership approval. Contact LinkedIn for access to the profile writing APIs.`
          );
        }
        return '✅ LinkedIn profile updated successfully!';

      case 'status':
        return `LinkedIn Integration Status:
🔧 Configured: ${linkedInService.isConfigured() ? '✅' : '❌'}
🔐 Authenticated: ${linkedInService.isAuthenticated() ? '✅' : '❌'}
📡 Ready to post: ${linkedInService.isConfigured() && linkedInService.isAuthenticated() ? '✅' : '❌'}`;

      default:
        throw new Error(
          `Unknown LinkedIn action: ${action}\n\n` +
            `Available actions: get_auth_url, exchange_code, get_profile, create_post, generate_content, update_profile, status\n\n` +
            `Example: <capability name="linkedin" action="get_auth_url" />`
        );
    }
  } catch (error) {
    logger.error(`❌ LinkedIn capability error:`, error);
    throw error;
  }
}

/**
 * LinkedIn capability registration
 */
export const linkedInCapability: RegisteredCapability = {
  name: 'linkedin',
  emoji: '💼',
  supportedActions: [
    'get_auth_url',
    'exchange_code',
    'get_profile',
    'create_post',
    'generate_content',
    'update_profile',
    'status',
  ],
  handler: handleLinkedInCapability,
  description: 'LinkedIn integration for autonomous posting and profile management',
  examples: [
    '<capability name="linkedin" action="get_auth_url" />',
    '<capability name="linkedin" action="create_post" visibility="PUBLIC">Excited to share my latest AI insights! #AI #Innovation</capability>',
    '<capability name="linkedin" action="generate_content" topic="AI trends" tone="thought-leadership" />',
    '<capability name="linkedin" action="update_profile" headline="AI Assistant & Innovation Enthusiast" />',
  ],
};

export { LinkedInService, getLinkedInService };
