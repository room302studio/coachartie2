import { createRedisConnection } from '../utils/redis.js';
import { logger } from '../utils/logger.js';

const redis = createRedisConnection();

/**
 * Unified User Profile System
 *
 * Uses Redis Hash for atomic, extensible per-user key-value storage.
 * Pattern: user_profile:{userId} -> Hash of attributes
 *
 * Supports:
 * - Contact info (email, phone, github, reddit, etc.)
 * - Preferences (timezone, theme, etc.)
 * - Metadata discovered by Artie
 * - Arbitrary key-value pairs
 */

export interface UserProfile {
  // Contact & Social
  email?: string;
  phone?: string;
  phoneHash?: string;
  github?: string;
  reddit?: string;
  linkedin?: string;
  twitter?: string;

  // Preferences
  timezone?: string;
  locale?: string;

  // Metadata
  created_at?: string;
  updated_at?: string;

  // Extensible - any other key-value pairs Artie discovers
  [key: string]: string | undefined;
}

export class UserProfileService {
  private static readonly KEY_PREFIX = 'user_profile';

  /**
   * Get full user profile
   */
  static async getProfile(userId: string): Promise<UserProfile> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;
      const data = await redis.hgetall(key);

      // Return empty object if no profile exists
      if (Object.keys(data).length === 0) {
        return {};
      }

      return data as UserProfile;
    } catch (error) {
      logger.error('Failed to get user profile:', { userId, error });
      return {};
    }
  }

  /**
   * Get specific attribute from user profile
   */
  static async getAttribute(userId: string, attribute: string): Promise<string | null> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;
      return await redis.hget(key, attribute);
    } catch (error) {
      logger.error('Failed to get user attribute:', { userId, attribute, error });
      return null;
    }
  }

  /**
   * Set specific attribute in user profile (atomic)
   */
  static async setAttribute(userId: string, attribute: string, value: string): Promise<void> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;

      // Update attribute
      await redis.hset(key, attribute, value);

      // Update timestamp
      await redis.hset(key, 'updated_at', new Date().toISOString());

      // Set created_at if this is the first attribute
      const exists = await redis.exists(key);
      if (!exists) {
        await redis.hset(key, 'created_at', new Date().toISOString());
      }

      logger.info('User attribute set', { userId, attribute, service: 'user-profile' });
    } catch (error) {
      logger.error('Failed to set user attribute:', { userId, attribute, error });
      throw error;
    }
  }

  /**
   * Set multiple attributes at once
   */
  static async setAttributes(userId: string, attributes: Record<string, string>): Promise<void> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;

      // Update all attributes + timestamp
      const updates = {
        ...attributes,
        updated_at: new Date().toISOString(),
      };

      await redis.hset(key, updates);

      logger.info('User attributes set', { userId, count: Object.keys(attributes).length });
    } catch (error) {
      logger.error('Failed to set user attributes:', { userId, error });
      throw error;
    }
  }

  /**
   * Delete specific attribute
   */
  static async deleteAttribute(userId: string, attribute: string): Promise<void> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;
      await redis.hdel(key, attribute);
      await redis.hset(key, 'updated_at', new Date().toISOString());

      logger.info('User attribute deleted', { userId, attribute });
    } catch (error) {
      logger.error('Failed to delete user attribute:', { userId, attribute, error });
      throw error;
    }
  }

  /**
   * Delete entire user profile
   */
  static async deleteProfile(userId: string): Promise<void> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;
      await redis.del(key);

      logger.info('User profile deleted', { userId });
    } catch (error) {
      logger.error('Failed to delete user profile:', { userId, error });
      throw error;
    }
  }

  /**
   * Check if user has any profile data
   */
  static async hasProfile(userId: string): Promise<boolean> {
    try {
      const key = `${this.KEY_PREFIX}:${userId}`;
      return (await redis.exists(key)) > 0;
    } catch (error) {
      logger.error('Failed to check user profile existence:', { userId, error });
      return false;
    }
  }

  /**
   * Migrate old scattered keys to unified profile
   * Call this once to consolidate user_email: and user_phone: keys
   */
  static async migrateFromLegacyKeys(userId: string): Promise<void> {
    try {
      const updates: Record<string, string> = {};

      // Migrate email
      const emailKey = `user_email:${userId}`;
      const emailData = await redis.get(emailKey);
      if (emailData) {
        const { email } = JSON.parse(emailData);
        updates.email = email;
      }

      // Migrate phone
      const phoneKey = `user_phone:${userId}`;
      const phoneData = await redis.get(phoneKey);
      if (phoneData) {
        const { phoneNumber, phoneHash } = JSON.parse(phoneData);
        updates.phone = phoneNumber;
        updates.phoneHash = phoneHash;
      }

      // Set all at once if we found data
      if (Object.keys(updates).length > 0) {
        await this.setAttributes(userId, updates);
        logger.info('Migrated legacy user data', { userId, fields: Object.keys(updates) });
      }
    } catch (error) {
      logger.error('Failed to migrate legacy user data:', { userId, error });
    }
  }
}
