import { logger } from '@coachartie/shared';
import { MediaWikiClient, MediaWikiConfig } from './mediawiki-client.js';

export class MediaWikiManager {
  private clients: Map<string, MediaWikiClient> = new Map();
  private lastUsedWiki: string | null = null;

  constructor() {
    this.autoDiscoverWikis();
  }

  /**
   * Auto-discover all wikis from environment variables
   * Looks for patterns like MEDIAWIKI_*_URL
   */
  private autoDiscoverWikis() {
    const wikiConfigs: Map<string, Partial<MediaWikiConfig>> = new Map();

    // Find all wiki configurations in environment
    for (const [key, value] of Object.entries(process.env)) {
      // Match patterns like MEDIAWIKI_ARCHIVE_URL, MEDIAWIKI_PERSONAL_URL, etc.
      const urlMatch = key.match(/^MEDIAWIKI_(.+)_URL$/);
      if (urlMatch && value) {
        const wikiName = urlMatch[1].toLowerCase();
        if (!wikiConfigs.has(wikiName)) {
          wikiConfigs.set(wikiName, {});
        }
        const config = wikiConfigs.get(wikiName)!;
        config.apiUrl = value.includes('/api.php') ? value : `${value}/api.php`;
        config.id = wikiName;
        config.name = wikiName.charAt(0).toUpperCase() + wikiName.slice(1);
      }

      // Match username patterns
      const userMatch = key.match(/^MEDIAWIKI_(.+)_USERNAME$/);
      if (userMatch && value) {
        const wikiName = userMatch[1].toLowerCase();
        if (!wikiConfigs.has(wikiName)) {
          wikiConfigs.set(wikiName, {});
        }
        wikiConfigs.get(wikiName)!.username = value;
      }

      // Match password patterns
      const passMatch = key.match(/^MEDIAWIKI_(.+)_PASSWORD$/);
      if (passMatch && value) {
        const wikiName = passMatch[1].toLowerCase();
        if (!wikiConfigs.has(wikiName)) {
          wikiConfigs.set(wikiName, {});
        }
        wikiConfigs.get(wikiName)!.botPassword = value;
      }
    }

    // Also support simple MEDIAWIKI_URL format (default wiki)
    if (process.env.MEDIAWIKI_URL) {
      const defaultConfig: MediaWikiConfig = {
        id: 'default',
        name: 'Default Wiki',
        apiUrl: process.env.MEDIAWIKI_URL.includes('/api.php')
          ? process.env.MEDIAWIKI_URL
          : `${process.env.MEDIAWIKI_URL}/api.php`,
        username: process.env.MEDIAWIKI_USERNAME,
        botPassword: process.env.MEDIAWIKI_PASSWORD
      };

      const client = new MediaWikiClient(defaultConfig);
      this.clients.set('default', client);
      logger.info('📚 Loaded default wiki from MEDIAWIKI_URL');
    }

    // Create clients for all discovered wikis
    for (const [name, config] of wikiConfigs) {
      if (config.apiUrl) {
        const fullConfig = config as MediaWikiConfig;
        const client = new MediaWikiClient(fullConfig);
        this.clients.set(name, client);
        logger.info(`📚 Auto-discovered wiki: ${name}`);
      }
    }

    if (this.clients.size === 0) {
      logger.info('📚 No wikis configured. Use environment variables like MEDIAWIKI_ARCHIVE_URL');
    }
  }

  /**
   * Smart wiki selection - tries to find the right wiki
   */
  async getClient(wikiHint?: string): Promise<MediaWikiClient | null> {
    // If specific wiki requested, try to find it
    if (wikiHint) {
      // Direct match
      let client = this.clients.get(wikiHint.toLowerCase());

      // Try fuzzy match
      if (!client) {
        for (const [name, wikiClient] of this.clients) {
          if (name.includes(wikiHint.toLowerCase()) ||
              wikiHint.toLowerCase().includes(name)) {
            client = wikiClient;
            break;
          }
        }
      }

      if (client) {
        this.lastUsedWiki = wikiHint.toLowerCase();
        if (!client.authenticated && client.config.username) {
          await client.authenticate();
        }
        return client;
      }
    }

    // Use last used wiki if available
    if (this.lastUsedWiki) {
      const client = this.clients.get(this.lastUsedWiki);
      if (client) {
        if (!client.authenticated && client.config.username) {
          await client.authenticate();
        }
        return client;
      }
    }

    // Use default if exists
    const defaultClient = this.clients.get('default');
    if (defaultClient) {
      this.lastUsedWiki = 'default';
      if (!defaultClient.authenticated && defaultClient.config.username) {
        await defaultClient.authenticate();
      }
      return defaultClient;
    }

    // Use first available wiki
    const firstWiki = this.clients.values().next().value;
    if (firstWiki) {
      this.lastUsedWiki = this.clients.keys().next().value;
      if (!firstWiki.authenticated && firstWiki.config.username) {
        await firstWiki.authenticate();
      }
      return firstWiki;
    }

    return null;
  }

  /**
   * Get or add wiki dynamically
   */
  async ensureWiki(name: string, url?: string, username?: string, password?: string): Promise<MediaWikiClient | null> {
    // Check if already exists
    let client = await this.getClient(name);
    if (client) return client;

    // If URL provided, add it
    if (url) {
      const config: MediaWikiConfig = {
        id: name.toLowerCase(),
        name: name,
        apiUrl: url.includes('/api.php') ? url : `${url}/api.php`,
        username: username,
        botPassword: password
      };

      client = new MediaWikiClient(config);

      // Test auth if credentials provided
      if (username && password) {
        const success = await client.authenticate();
        if (!success) {
          logger.warn(`⚠️ Failed to authenticate with ${name}, but wiki added`);
        }
      }

      this.clients.set(name.toLowerCase(), client);
      this.lastUsedWiki = name.toLowerCase();
      logger.info(`✅ Dynamically added wiki: ${name}`);

      return client;
    }

    return null;
  }

  /**
   * List all available wikis with their status
   */
  getAvailableWikis(): Array<{ name: string; hasAuth: boolean; isActive: boolean }> {
    const wikis: Array<{ name: string; hasAuth: boolean; isActive: boolean }> = [];

    for (const [name, client] of this.clients) {
      wikis.push({
        name,
        hasAuth: !!client.config.username,
        isActive: name === this.lastUsedWiki
      });
    }

    return wikis;
  }

  /**
   * Smart wiki suggestion based on page name or content
   */
  suggestWiki(pageNameOrContent: string): string | null {
    const lower = pageNameOrContent.toLowerCase();

    // Smart matching based on keywords
    if (lower.includes('subway') || lower.includes('transit')) {
      return this.clients.has('transit') ? 'transit' : null;
    }

    if (lower.includes('personal') || lower.includes('journal')) {
      return this.clients.has('personal') ? 'personal' : null;
    }

    if (lower.includes('archive')) {
      return this.clients.has('archive') ? 'archive' : null;
    }

    // Return last used or default
    return this.lastUsedWiki || 'default';
  }

  /**
   * Clear authentication for all wikis (useful for refresh)
   */
  clearAuth() {
    for (const client of this.clients.values()) {
      client.authenticated = false;
    }
  }
}

// Export singleton
export const mediaWikiManager = new MediaWikiManager();