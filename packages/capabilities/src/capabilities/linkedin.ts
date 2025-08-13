import { logger } from '@coachartie/shared';
import axios from 'axios';
import { RegisteredCapability } from '../services/capability-registry.js';

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
  private baseUrl = 'https://api.linkedin.com/v2';
  
  constructor() {
    // Load tokens from environment or database
    this.accessToken = process.env.LINKEDIN_ACCESS_TOKEN || null;
    this.refreshToken = process.env.LINKEDIN_REFRESH_TOKEN || null;
  }

  /**
   * Initialize OAuth flow - returns authorization URL
   */
  getAuthorizationUrl(): string {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/auth/linkedin/callback';
    const scope = 'openid profile w_member_social email';
    const state = Math.random().toString(36).substring(7);
    
    return `https://www.linkedin.com/oauth/v2/authorization?` +
      `response_type=code&` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scope)}&` +
      `state=${state}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<void> {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI || 'http://localhost:3000/auth/linkedin/callback';
    
    try {
      const response = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', {
        grant_type: 'authorization_code',
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      
      // TODO: Store tokens securely in database
      logger.info('✅ LinkedIn OAuth tokens obtained successfully');
    } catch (error) {
      logger.error('❌ Failed to exchange LinkedIn OAuth code:', error);
      throw error;
    }
  }

  /**
   * Get current user's LinkedIn profile
   */
  async getProfile(): Promise<LinkedInProfile | null> {
    if (!this.accessToken) {
      throw new Error('No LinkedIn access token available');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/people/~:(id,localizedFirstName,localizedLastName,profilePicture(displayImage~digitalmediaAsset:playableStreams),localizedHeadline)`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'LinkedIn-Version': '202212',
        },
      });

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
    if (!this.accessToken) {
      throw new Error('No LinkedIn access token available');
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
          'Authorization': `Bearer ${this.accessToken}`,
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
  async generateContent(topic: string, tone: 'professional' | 'casual' | 'thought-leadership' = 'professional'): Promise<string> {
    // This would integrate with Coach Artie's AI capabilities
    const prompts = {
      professional: `Create a professional LinkedIn post about "${topic}". Keep it engaging, informative, and under 300 characters. Include relevant hashtags.`,
      casual: `Write a casual but professional LinkedIn post about "${topic}". Make it conversational and relatable. Under 250 characters.`,
      'thought-leadership': `Write a thought-leadership LinkedIn post about "${topic}". Share insights, ask questions, and encourage discussion. Under 400 characters.`
    };

    // TODO: Integrate with Coach Artie's AI service
    // For now, return a placeholder
    return `Excited to share thoughts on ${topic}! As an AI assistant, I'm constantly learning and growing. What are your thoughts on this topic? #AI #Innovation #TechTrends`;
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

// Singleton service instance
const linkedInService = new LinkedInService();

/**
 * LinkedIn capability handler
 */
async function handleLinkedInCapability(params: any, content?: string): Promise<string> {
  const { action } = params;

  try {
    switch (action) {
      case 'get_auth_url':
        if (!linkedInService.isConfigured()) {
          return '❌ LinkedIn not configured. Please set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET environment variables.';
        }
        const authUrl = linkedInService.getAuthorizationUrl();
        return `🔗 Please visit this URL to authorize LinkedIn access: ${authUrl}`;

      case 'exchange_code':
        const { code } = params;
        if (!code) {
          return '❌ Authorization code is required';
        }
        await linkedInService.exchangeCodeForToken(code);
        return '✅ LinkedIn authorization successful! You can now post and manage your LinkedIn profile.';

      case 'get_profile':
        if (!linkedInService.isAuthenticated()) {
          return '❌ Not authenticated with LinkedIn. Please run get_auth_url first.';
        }
        const profile = await linkedInService.getProfile();
        if (profile) {
          return `👤 LinkedIn Profile:
Name: ${profile.localizedFirstName} ${profile.localizedLastName}
Headline: ${profile.localizedHeadline || 'No headline set'}
ID: ${profile.id}`;
        }
        return '❌ Could not retrieve LinkedIn profile';

      case 'create_post':
        if (!linkedInService.isAuthenticated()) {
          return '❌ Not authenticated with LinkedIn. Please run get_auth_url first.';
        }
        
        const postContent = content || params.content;
        if (!postContent) {
          return '❌ Post content is required';
        }

        const visibility = params.visibility || 'PUBLIC';
        const success = await linkedInService.createPost({
          content: postContent,
          visibility: visibility as 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN'
        });

        return success 
          ? '✅ LinkedIn post created successfully!' 
          : '❌ Failed to create LinkedIn post';

      case 'generate_content':
        const topic = params.topic || content;
        if (!topic) {
          return '❌ Topic is required for content generation';
        }
        
        const tone = params.tone || 'professional';
        const generatedContent = await linkedInService.generateContent(topic, tone);
        return `📝 Generated LinkedIn content:\n\n${generatedContent}`;

      case 'update_profile':
        if (!linkedInService.isAuthenticated()) {
          return '❌ Not authenticated with LinkedIn. Please run get_auth_url first.';
        }
        
        const updates = {
          headline: params.headline,
          summary: params.summary
        };
        
        const updateSuccess = await linkedInService.updateProfile(updates);
        return updateSuccess 
          ? '✅ LinkedIn profile updated successfully!' 
          : '⚠️ Profile updates require LinkedIn API partnership approval';

      case 'status':
        return `LinkedIn Integration Status:
🔧 Configured: ${linkedInService.isConfigured() ? '✅' : '❌'}
🔐 Authenticated: ${linkedInService.isAuthenticated() ? '✅' : '❌'}
📡 Ready to post: ${linkedInService.isConfigured() && linkedInService.isAuthenticated() ? '✅' : '❌'}`;

      default:
        return `❌ Unknown LinkedIn action: ${action}. Available actions: get_auth_url, exchange_code, get_profile, create_post, generate_content, update_profile, status`;
    }
  } catch (error) {
    logger.error(`❌ LinkedIn capability error:`, error);
    return `❌ LinkedIn operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * LinkedIn capability registration
 */
export const linkedInCapability: RegisteredCapability = {
  name: 'linkedin',
  supportedActions: [
    'get_auth_url',
    'exchange_code', 
    'get_profile',
    'create_post',
    'generate_content',
    'update_profile',
    'status'
  ],
  handler: handleLinkedInCapability,
  description: 'LinkedIn integration for autonomous posting and profile management',
  examples: [
    '<capability name="linkedin" action="get_auth_url" />',
    '<capability name="linkedin" action="create_post" visibility="PUBLIC">Excited to share my latest AI insights! #AI #Innovation</capability>',
    '<capability name="linkedin" action="generate_content" topic="AI trends" tone="thought-leadership" />',
    '<capability name="linkedin" action="update_profile" headline="AI Assistant & Innovation Enthusiast" />'
  ]
};

export { linkedInService, LinkedInService };