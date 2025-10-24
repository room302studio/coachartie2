import { logger, UserProfileService } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * User Profile Capability
 *
 * Lets Artie discover and store structured user information:
 * - Contact info (email, phone, social handles)
 * - Preferences (timezone, locale, etc.)
 * - Any key-value metadata Artie learns
 *
 * This is different from memory:
 * - memory: conversational facts ("user likes pizza")
 * - profile: structured metadata (email, github handle, timezone)
 */

interface UserProfileParams {
  action: string;
  userId?: string;
  attribute?: string;
  value?: string;
  attributes?: string; // JSON string of key-value pairs
}

async function handleUserProfileAction(
  params: UserProfileParams,
  content?: string
): Promise<string> {
  const { action, userId = 'unknown-user', attribute, value } = params;

  logger.info(`👤 User profile action: ${action} for user ${userId}`);

  try {
    switch (action) {
      case 'link-email': {
        const email = value || content;
        if (!email) {
          return '❌ Missing email. Usage: <capability name="user-profile" action="link-email" value="user@example.com" />';
        }

        // Validate email format
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(email)) {
          return '❌ Invalid email format';
        }

        await UserProfileService.setAttribute(userId, 'email', email);
        logger.info(`📧 LLM linked email for user ${userId}`);
        return `✅ Email linked: ${email}. I can now email you when you ask!`;
      }

      case 'link-phone': {
        const phone = value || content;
        if (!phone) {
          return '❌ Missing phone. Usage: <capability name="user-profile" action="link-phone" value="+1234567890" />';
        }

        // Validate phone format (international)
        const phoneRegex = /^\+[1-9]\d{1,14}$/;
        if (!phoneRegex.test(phone)) {
          return '❌ Invalid phone format. Use international format: +1234567890';
        }

        await UserProfileService.setAttribute(userId, 'phone', phone);
        logger.info(`📱 LLM linked phone for user ${userId}`);
        return `✅ Phone linked: ${phone}`;
      }

      case 'link-github': {
        const github = value || content;
        if (!github) {
          return '❌ Missing GitHub username. Usage: <capability name="user-profile" action="link-github" value="ejfox" />';
        }

        await UserProfileService.setAttribute(userId, 'github', github);
        logger.info(`🐙 LLM linked GitHub for user ${userId}: ${github}`);
        return `✅ GitHub linked: ${github}`;
      }

      case 'link-reddit': {
        const reddit = value || content;
        if (!reddit) {
          return '❌ Missing Reddit username. Usage: <capability name="user-profile" action="link-reddit" value="ejfox" />';
        }

        await UserProfileService.setAttribute(userId, 'reddit', reddit);
        logger.info(`🔗 LLM linked Reddit for user ${userId}: ${reddit}`);
        return `✅ Reddit linked: ${reddit}`;
      }

      case 'link-twitter': {
        const twitter = value || content;
        if (!twitter) {
          return '❌ Missing Twitter handle. Usage: <capability name="user-profile" action="link-twitter" value="ejfox" />';
        }

        // Strip @ if provided
        const cleanTwitter = twitter.replace(/^@/, '');
        await UserProfileService.setAttribute(userId, 'twitter', cleanTwitter);
        logger.info(`🐦 LLM linked Twitter for user ${userId}: ${cleanTwitter}`);
        return `✅ Twitter linked: @${cleanTwitter}`;
      }

      case 'link-linkedin': {
        const linkedin = value || content;
        if (!linkedin) {
          return '❌ Missing LinkedIn username/URL. Usage: <capability name="user-profile" action="link-linkedin" value="ejfox" />';
        }

        await UserProfileService.setAttribute(userId, 'linkedin', linkedin);
        logger.info(`💼 LLM linked LinkedIn for user ${userId}: ${linkedin}`);
        return `✅ LinkedIn linked: ${linkedin}`;
      }

      case 'set': {
        if (!attribute || !value) {
          return '❌ Missing attribute or value. Usage: <capability name="user-profile" action="set" attribute="github" value="ejfox" />';
        }

        await UserProfileService.setAttribute(userId, attribute, value);
        return `✅ Set ${attribute} = ${value} for user ${userId}`;
      }

      case 'set-many': {
        const attributesJson = params.attributes || content;
        if (!attributesJson) {
          return '❌ Missing attributes JSON. Usage: <capability name="user-profile" action="set-many">{"github":"ejfox","timezone":"PST"}</capability>';
        }

        try {
          const attributes = JSON.parse(attributesJson);
          await UserProfileService.setAttributes(userId, attributes);
          return `✅ Set ${Object.keys(attributes).length} attributes for user ${userId}`;
        } catch (error) {
          return `❌ Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'get': {
        if (!attribute) {
          return '❌ Missing attribute. Usage: <capability name="user-profile" action="get" attribute="github" />';
        }

        const val = await UserProfileService.getAttribute(userId, attribute);
        if (val) {
          return `✅ ${attribute} = ${val}`;
        } else {
          return `❌ No ${attribute} found for user ${userId}`;
        }
      }

      case 'get-all': {
        const profile = await UserProfileService.getProfile(userId);
        const keys = Object.keys(profile);

        if (keys.length === 0) {
          return `📭 No profile data for user ${userId}. Use 'set' to add information.`;
        }

        const formatted = keys
          .filter((k) => !k.startsWith('_') && k !== 'created_at' && k !== 'updated_at')
          .map((k) => `• ${k}: ${profile[k]}`)
          .join('\n');

        return `👤 User Profile (${userId}):\n${formatted}`;
      }

      case 'delete': {
        if (!attribute) {
          return '❌ Missing attribute. Usage: <capability name="user-profile" action="delete" attribute="github" />';
        }

        await UserProfileService.deleteAttribute(userId, attribute);
        return `✅ Deleted ${attribute} for user ${userId}`;
      }

      case 'has': {
        const hasProfile = await UserProfileService.hasProfile(userId);
        return hasProfile
          ? `✅ User ${userId} has a profile`
          : `❌ User ${userId} has no profile data`;
      }

      default:
        return `❌ Unknown action: ${action}. Supported: set, set-many, get, get-all, delete, has`;
    }
  } catch (error) {
    logger.error(`User profile capability error:`, error);
    return `❌ Failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * User Profile capability registration
 */
export const userProfileCapability: RegisteredCapability = {
  name: 'user-profile',
  supportedActions: [
    'link-email',
    'link-phone',
    'link-github',
    'link-reddit',
    'link-twitter',
    'link-linkedin',
    'set',
    'set-many',
    'get',
    'get-all',
    'delete',
    'has',
  ],
  description:
    'Store and retrieve user contact info and metadata. Use link-* actions when user shares contact info.',
  handler: handleUserProfileAction,
  examples: [
    '<capability name="user-profile" action="link-email" value="user@example.com" />',
    '<capability name="user-profile" action="link-github" value="ejfox" />',
    '<capability name="user-profile" action="link-reddit" value="ejfox" />',
    '<capability name="user-profile" action="link-twitter" value="@ejfox" />',
    '<capability name="user-profile" action="set" attribute="timezone" value="America/New_York" />',
    '<capability name="user-profile" action="get" attribute="email" />',
    '<capability name="user-profile" action="get-all" />',
  ],
};
