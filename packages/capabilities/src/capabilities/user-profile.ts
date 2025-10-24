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
  supportedActions: ['set', 'set-many', 'get', 'get-all', 'delete', 'has'],
  description: 'Store and retrieve structured user information (contact, preferences, metadata)',
  handler: handleUserProfileAction,
  examples: [
    '<capability name="user-profile" action="set" attribute="github" value="ejfox" />',
    '<capability name="user-profile" action="set" attribute="timezone" value="America/New_York" />',
    '<capability name="user-profile" action="set-many">{"github":"ejfox","reddit":"ejfox","twitter":"@ejfox"}</capability>',
    '<capability name="user-profile" action="get" attribute="email" />',
    '<capability name="user-profile" action="get-all" />',
    '<capability name="user-profile" action="delete" attribute="old_phone" />',
  ],
};
