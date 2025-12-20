import { logger, getRawDb, initializeDb } from '@coachartie/shared';
import { join } from 'path';

interface OAuthToken {
  id?: number;
  userId: string;
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * OAuth Token Manager
 * Handles secure storage and retrieval of OAuth tokens
 */
export class OAuthManager {
  private db: ReturnType<typeof getRawDb> | null = null;

  constructor() {
    // Initialize synchronously
    try {
      initializeDb();
      this.db = getRawDb();
      logger.info('🔐 OAuth Manager initialized');
    } catch (error) {
      logger.error('Failed to initialize OAuth Manager:', error);
    }
  }

  private ensureDb(): void {
    if (!this.db) {
      initializeDb();
      this.db = getRawDb();
    }
  }

  private getDb() {
    this.ensureDb();
    return this.db!;
  }

  /**
   * Store or update OAuth tokens
   */
  async storeTokens(token: OAuthToken): Promise<void> {
    try {
      const db = this.getDb();
      const stmt = db.prepare(`
        INSERT INTO oauth_tokens (
          user_id, provider, access_token, refresh_token,
          expires_at, scopes, metadata, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, provider) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          scopes = excluded.scopes,
          metadata = excluded.metadata,
          updated_at = CURRENT_TIMESTAMP
      `);

      stmt.run(
        token.userId,
        token.provider,
        token.accessToken,
        token.refreshToken || null,
        token.expiresAt ? token.expiresAt.toISOString() : null,
        token.scopes ? JSON.stringify(token.scopes) : null,
        token.metadata ? JSON.stringify(token.metadata) : null
      );

      logger.info(`✅ Stored OAuth tokens for ${token.provider} (user: ${token.userId})`);
    } catch (error) {
      logger.error('❌ Failed to store OAuth tokens:', error);
      throw error;
    }
  }

  /**
   * Retrieve OAuth tokens
   */
  async getTokens(userId: string, provider: string): Promise<OAuthToken | null> {
    try {
      const db = this.getDb();
      const stmt = db.prepare(`
        SELECT * FROM oauth_tokens
        WHERE user_id = ? AND provider = ?
      `);

      const row = stmt.get(userId, provider) as any;

      if (!row) {
        logger.debug(`🔍 No OAuth tokens found for ${provider} (user: ${userId})`);
        return null;
      }

      return {
        id: row.id,
        userId: row.user_id,
        provider: row.provider,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
        scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      };
    } catch (error) {
      logger.error('❌ Failed to retrieve OAuth tokens:', error);
      return null;
    }
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(token: OAuthToken): boolean {
    if (!token.expiresAt) {
      return false;
    }
    return new Date() >= new Date(token.expiresAt);
  }

  /**
   * Delete OAuth tokens
   */
  async deleteTokens(userId: string, provider: string): Promise<void> {
    try {
      const db = this.getDb();
      const stmt = db.prepare(`
        DELETE FROM oauth_tokens
        WHERE user_id = ? AND provider = ?
      `);

      stmt.run(userId, provider);
      logger.info(`🗑️ Deleted OAuth tokens for ${provider} (user: ${userId})`);
    } catch (error) {
      logger.error('❌ Failed to delete OAuth tokens:', error);
      throw error;
    }
  }

  /**
   * Get all stored providers for a user
   */
  async getUserProviders(userId: string): Promise<string[]> {
    try {
      const db = this.getDb();
      const stmt = db.prepare(`
        SELECT provider FROM oauth_tokens
        WHERE user_id = ?
      `);

      const rows = stmt.all(userId) as any[];
      return rows.map((row) => row.provider);
    } catch (error) {
      logger.error('❌ Failed to get user providers:', error);
      return [];
    }
  }
}

// Export singleton instance
export const oauthManager = new OAuthManager();
