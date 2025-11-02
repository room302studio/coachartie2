import { logger } from '@coachartie/shared';
import fetch from 'node-fetch';
import FormData from 'form-data';

export interface MediaWikiConfig {
  id: string;
  name: string;
  apiUrl: string;
  username?: string;
  password?: string;
  botPassword?: string;
  description?: string;
}

export interface EditResult {
  success: boolean;
  pageTitle: string;
  newRevId?: number;
  timestamp?: string;
  error?: string;
}

export interface PageInfo {
  pageId: number;
  title: string;
  content: string;
  revisionId: number;
  timestamp: string;
}

interface MediaWikiTokens {
  csrfToken?: string;
  loginToken?: string;
  cookies?: string;
}

export class MediaWikiClient {
  public config: MediaWikiConfig;
  private tokens: MediaWikiTokens = {};
  public authenticated = false;

  constructor(config: MediaWikiConfig) {
    this.config = config;
  }

  /**
   * Authenticate with MediaWiki API
   */
  async authenticate(): Promise<boolean> {
    if (!this.config.username || (!this.config.password && !this.config.botPassword)) {
      logger.info(`📖 No credentials for ${this.config.name}, using anonymous access`);
      this.authenticated = false;
      return false;
    }

    try {
      // Get login token
      const loginTokenResponse = await fetch(`${this.config.apiUrl}?action=query&meta=tokens&type=login&format=json`);
      const loginTokenData = await loginTokenResponse.json() as any;
      this.tokens.loginToken = loginTokenData.query.tokens.logintoken;

      // Get cookies from response headers
      const cookies = loginTokenResponse.headers.get('set-cookie');
      if (cookies) {
        this.tokens.cookies = cookies;
      }

      // Login
      const formData = new FormData();
      formData.append('action', 'login');
      formData.append('lgname', this.config.username);
      formData.append('lgpassword', this.config.botPassword || this.config.password || '');
      formData.append('lgtoken', this.tokens.loginToken);
      formData.append('format', 'json');

      const loginResponse = await fetch(this.config.apiUrl, {
        method: 'POST',
        body: formData,
        headers: {
          ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
        }
      });

      const loginData = await loginResponse.json() as any;

      if (loginData.login?.result === 'Success') {
        logger.info(`✅ Authenticated with ${this.config.name} as ${this.config.username}`);

        // Update cookies
        const newCookies = loginResponse.headers.get('set-cookie');
        if (newCookies) {
          this.tokens.cookies = newCookies;
        }

        // Get CSRF token for editing
        await this.getCsrfToken();
        this.authenticated = true;
        return true;
      } else {
        logger.error(`❌ Failed to authenticate with ${this.config.name}:`, loginData);
        return false;
      }
    } catch (error) {
      logger.error(`❌ Authentication error for ${this.config.name}:`, error);
      return false;
    }
  }

  /**
   * Get CSRF token for editing
   */
  private async getCsrfToken(): Promise<void> {
    const response = await fetch(
      `${this.config.apiUrl}?action=query&meta=tokens&format=json`,
      {
        headers: {
          ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
        }
      }
    );

    const data = await response.json() as any;
    this.tokens.csrfToken = data.query.tokens.csrftoken;
  }

  /**
   * Get page content
   */
  async getPage(title: string): Promise<PageInfo | null> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content|timestamp|ids&format=json`,
        {
          headers: {
            ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
          }
        }
      );

      const data = await response.json() as any;
      const pages = data.query.pages;
      const pageId = Object.keys(pages)[0];

      if (pageId === '-1') {
        return null; // Page doesn't exist
      }

      const page = pages[pageId];
      return {
        pageId: parseInt(pageId),
        title: page.title,
        content: page.revisions[0]['*'],
        revisionId: page.revisions[0].revid,
        timestamp: page.revisions[0].timestamp
      };
    } catch (error) {
      logger.error(`❌ Failed to get page ${title}:`, error);
      return null;
    }
  }

  /**
   * Edit or create a page
   */
  async editPage(title: string, content: string, summary: string = 'Automated edit by Coach Artie'): Promise<EditResult> {
    try {
      // Ensure we have authentication if credentials were provided
      if (this.config.username && !this.authenticated) {
        const authResult = await this.authenticate();
        if (!authResult) {
          return {
            success: false,
            pageTitle: title,
            error: 'Authentication failed'
          };
        }
      }

      // Get fresh CSRF token
      await this.getCsrfToken();

      const formData = new FormData();
      formData.append('action', 'edit');
      formData.append('title', title);
      formData.append('text', content);
      formData.append('summary', summary);
      formData.append('bot', 'true');
      formData.append('format', 'json');

      if (this.tokens.csrfToken) {
        formData.append('token', this.tokens.csrfToken);
      } else {
        formData.append('token', '+\\'); // Anonymous edit token
      }

      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        body: formData,
        headers: {
          ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
        }
      });

      const data = await response.json() as any;

      if (data.edit?.result === 'Success') {
        logger.info(`✅ Successfully edited ${title} on ${this.config.name}`);
        return {
          success: true,
          pageTitle: title,
          newRevId: data.edit.newrevid,
          timestamp: data.edit.newtimestamp
        };
      } else {
        logger.error(`❌ Failed to edit ${title}:`, data);
        return {
          success: false,
          pageTitle: title,
          error: data.error?.info || 'Unknown error'
        };
      }
    } catch (error) {
      logger.error(`❌ Error editing page ${title}:`, error);
      return {
        success: false,
        pageTitle: title,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Search for pages
   */
  async searchPages(query: string, limit: number = 10): Promise<string[]> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`,
        {
          headers: {
            ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
          }
        }
      );

      const data = await response.json() as any;
      return data.query.search.map((result: any) => result.title);
    } catch (error) {
      logger.error(`❌ Search failed for query "${query}":`, error);
      return [];
    }
  }

  /**
   * Get recent changes
   */
  async getRecentChanges(limit: number = 10): Promise<any[]> {
    try {
      const response = await fetch(
        `${this.config.apiUrl}?action=query&list=recentchanges&rcprop=title|timestamp|user|comment|sizes&rclimit=${limit}&format=json`,
        {
          headers: {
            ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
          }
        }
      );

      const data = await response.json() as any;
      return data.query.recentchanges;
    } catch (error) {
      logger.error(`❌ Failed to get recent changes:`, error);
      return [];
    }
  }

  /**
   * Upload a file
   */
  async uploadFile(filename: string, fileContent: Buffer, comment: string = 'Uploaded by Coach Artie'): Promise<boolean> {
    try {
      if (!this.authenticated) {
        logger.warn('⚠️ Upload requires authentication');
        return false;
      }

      await this.getCsrfToken();

      const formData = new FormData();
      formData.append('action', 'upload');
      formData.append('filename', filename);
      formData.append('file', fileContent, filename);
      formData.append('comment', comment);
      formData.append('token', this.tokens.csrfToken!);
      formData.append('format', 'json');
      formData.append('ignorewarnings', 'true');

      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        body: formData,
        headers: {
          ...(this.tokens.cookies ? { 'Cookie': this.tokens.cookies } : {})
        }
      });

      const data = await response.json() as any;

      if (data.upload?.result === 'Success') {
        logger.info(`✅ Successfully uploaded ${filename} to ${this.config.name}`);
        return true;
      } else {
        logger.error(`❌ Failed to upload ${filename}:`, data);
        return false;
      }
    } catch (error) {
      logger.error(`❌ Error uploading file ${filename}:`, error);
      return false;
    }
  }

  /**
   * Parse wikitext to HTML
   */
  async parseWikitext(wikitext: string): Promise<string | null> {
    try {
      const formData = new FormData();
      formData.append('action', 'parse');
      formData.append('text', wikitext);
      formData.append('contentmodel', 'wikitext');
      formData.append('format', 'json');

      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        body: formData
      });

      const data = await response.json() as any;
      return data.parse?.text?.['*'] || null;
    } catch (error) {
      logger.error('❌ Failed to parse wikitext:', error);
      return null;
    }
  }
}