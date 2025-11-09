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
          throw new Error(
            'Missing email. Example: <capability name="user-profile" action="link-email" value="user@example.com" />'
          );
        }

        // Validate email format
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(email)) {
          throw new Error(`Invalid email format: "${email}"\n\nExample format: user@example.com`);
        }

        await UserProfileService.setAttribute(userId, 'email', email);
        logger.info(`📧 LLM linked email for user ${userId}`);
        return `✅ Email linked: ${email}. I can now email you when you ask!`;
      }

      case 'link-phone': {
        const phone = value || content;
        if (!phone) {
          throw new Error(
            'Missing phone. Example: <capability name="user-profile" action="link-phone" value="+1234567890" />'
          );
        }

        // Validate phone format (international)
        const phoneRegex = /^\+[1-9]\d{1,14}$/;
        if (!phoneRegex.test(phone)) {
          throw new Error(
            `Invalid phone format: "${phone}"\n\nUse international format: +1234567890 (country code + up to 15 digits)`
          );
        }

        await UserProfileService.setAttribute(userId, 'phone', phone);
        logger.info(`📱 LLM linked phone for user ${userId}`);
        return `✅ Phone linked: ${phone}`;
      }

      case 'link-github': {
        const github = value || content;
        if (!github) {
          throw new Error(
            'Missing GitHub username. Example: <capability name="user-profile" action="link-github" value="ejfox" />'
          );
        }

        await UserProfileService.setAttribute(userId, 'github', github);
        logger.info(`🐙 LLM linked GitHub for user ${userId}: ${github}`);
        return `✅ GitHub linked: ${github}`;
      }

      case 'link-reddit': {
        const reddit = value || content;
        if (!reddit) {
          throw new Error(
            'Missing Reddit username. Example: <capability name="user-profile" action="link-reddit" value="ejfox" />'
          );
        }

        await UserProfileService.setAttribute(userId, 'reddit', reddit);
        logger.info(`🔗 LLM linked Reddit for user ${userId}: ${reddit}`);
        return `✅ Reddit linked: ${reddit}`;
      }

      case 'link-twitter': {
        const twitter = value || content;
        if (!twitter) {
          throw new Error(
            'Missing Twitter handle. Example: <capability name="user-profile" action="link-twitter" value="ejfox" />'
          );
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
          throw new Error(
            'Missing LinkedIn username/URL. Example: <capability name="user-profile" action="link-linkedin" value="ejfox" />'
          );
        }

        await UserProfileService.setAttribute(userId, 'linkedin', linkedin);
        logger.info(`💼 LLM linked LinkedIn for user ${userId}: ${linkedin}`);
        return `✅ LinkedIn linked: ${linkedin}`;
      }

      case 'link': {
        // GENERIC LINK ACTION - handles ANY service, even ones that don't exist yet
        // Usage: <capability name="user-profile" action="link" attribute="bluesky" value="ejfox.bsky.social" />
        //        <capability name="user-profile" action="link" attribute="mastodon" value="@ejfox@mastodon.social" />
        //        <capability name="user-profile" action="link" attribute="threads" value="@ejfox" />

        if (!attribute || !value) {
          throw new Error(
            'Missing service name or value. Example: <capability name="user-profile" action="link" attribute="bluesky" value="ejfox.bsky.social" />'
          );
        }

        const serviceName = attribute.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        await UserProfileService.setAttribute(userId, serviceName, value);
        logger.info(`🔗 LLM linked ${serviceName} for user ${userId}: ${value}`);
        return `✅ ${attribute} linked: ${value}`;
      }

      case 'set': {
        if (!attribute || !value) {
          throw new Error(
            'Missing attribute or value. Example: <capability name="user-profile" action="set" attribute="timezone" value="America/New_York" />'
          );
        }

        await UserProfileService.setAttribute(userId, attribute, value);
        return `✅ Set ${attribute} = ${value} for user ${userId}`;
      }

      case 'set-many': {
        const attributesJson = params.attributes || content;
        if (!attributesJson) {
          throw new Error(
            'Missing attributes JSON. Example: <capability name="user-profile" action="set-many">{"github":"ejfox","timezone":"America/New_York"}</capability>'
          );
        }

        try {
          const attributes = JSON.parse(attributesJson);
          await UserProfileService.setAttributes(userId, attributes);
          return `✅ Set ${Object.keys(attributes).length} attributes for user ${userId}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          throw new Error(
            `Invalid JSON: ${errorMsg}\n\nExample format: {"github":"ejfox","timezone":"America/New_York"}`
          );
        }
      }

      case 'get': {
        if (!attribute) {
          throw new Error(
            'Missing attribute. Example: <capability name="user-profile" action="get" attribute="github" />'
          );
        }

        const val = await UserProfileService.getAttribute(userId, attribute);
        if (val) {
          return `✅ ${attribute} = ${val}`;
        } else {
          const profile = await UserProfileService.getProfile(userId);
          const keys = Object.keys(profile).filter(
            (k) => !k.startsWith('_') && k !== 'created_at' && k !== 'updated_at'
          );
          const suggestions =
            keys.length > 0
              ? `\n\nAvailable attributes: ${keys.join(', ')}`
              : '\n\nNo profile data exists. Use action="set" to add information.';
          throw new Error(`Attribute "${attribute}" not found for user ${userId}.${suggestions}`);
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
          throw new Error(
            'Missing attribute. Example: <capability name="user-profile" action="delete" attribute="github" />'
          );
        }

        await UserProfileService.deleteAttribute(userId, attribute);
        return `✅ Deleted ${attribute} for user ${userId}`;
      }

      case 'has': {
        const hasProfile = await UserProfileService.hasProfile(userId);
        return hasProfile
          ? `✅ User ${userId} has a profile`
          : `User ${userId} has no profile data. Use action="set" to add information.`;
      }

      default:
        throw new Error(
          `Unknown action: ${action}. Supported actions: set, set-many, get, get-all, delete, has, link, link-email, link-phone, link-github, link-reddit, link-twitter, link-linkedin`
        );
    }
  } catch (error) {
    logger.error(`User profile capability error:`, error);
    throw error;
  }
}

/**
 * User Profile capability registration
 */
export const userProfileCapability: RegisteredCapability = {
  name: 'user-profile',
  supportedActions: [
    'link', // Generic - handles ANY service (bluesky, mastodon, threads, future services)
    'link-email', // Specific - validates email format
    'link-phone', // Specific - validates international phone format
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
    'EXTENSIBLE user profile system. Link ANY service with "link" action. Specific link-* actions provide validation for known services.',
  handler: handleUserProfileAction,
  examples: [
    // Known services with validation
    '<capability name="user-profile" action="link-email" value="user@example.com" />',
    '<capability name="user-profile" action="link-github" value="ejfox" />',

    // Generic link - works for ANY service, even ones that don\'t exist yet
    '<capability name="user-profile" action="link" attribute="bluesky" value="ejfox.bsky.social" />',
    '<capability name="user-profile" action="link" attribute="mastodon" value="@ejfox@mastodon.social" />',
    '<capability name="user-profile" action="link" attribute="threads" value="@ejfox" />',
    '<capability name="user-profile" action="link" attribute="discord" value="ejfox#1234" />',

    // Metadata
    '<capability name="user-profile" action="set" attribute="timezone" value="America/New_York" />',
    '<capability name="user-profile" action="get-all" />',
  ],
};
