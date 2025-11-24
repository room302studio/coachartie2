import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { mediaWikiManager } from '../services/mediawiki-manager.js';

export const mediaWikiCapability: RegisteredCapability = {
  name: 'mediawiki',
  emoji: '📚',
  supportedActions: ['read', 'write', 'search', 'list', 'add'],
  description: 'Read and write to MediaWiki instances',
  requiredParams: [],

  handler: async (params: any, content: string | undefined) => {
    try {
      const action = params.action || 'read';

      // LIST - Show available wikis
      if (action === 'list' || action === 'wikis') {
        const wikis = mediaWikiManager.getAvailableWikis();

        if (wikis.length === 0) {
          return JSON.stringify({
            success: true,
            message:
              'No wikis configured. Add them with environment variables:\nMEDIAWIKI_ARCHIVE_URL=...\nMEDIAWIKI_ARCHIVE_USERNAME=...\nMEDIAWIKI_ARCHIVE_PASSWORD=...',
          });
        }

        return JSON.stringify({
          success: true,
          wikis: wikis.map(
            (w) => `${w.name}${w.isActive ? ' (active)' : ''}${w.hasAuth ? ' ✓' : ' (no auth)'}`
          ),
          message: `${wikis.length} wiki(s) available`,
        });
      }

      // ADD - Dynamically add a new wiki
      if (action === 'add' || action === 'setup') {
        const name = params.name || params.wiki;
        const url = params.url || params.apiUrl;

        if (!name || !url) {
          return JSON.stringify({
            success: false,
            message: "To add a wiki: action='add' name='mywiki' url='https://wiki.com'",
          });
        }

        const client = await mediaWikiManager.ensureWiki(
          name,
          url,
          params.username,
          params.password || params.bot_password
        );

        return JSON.stringify({
          success: !!client,
          message: client ? `Added wiki '${name}'` : `Failed to add wiki '${name}'`,
        });
      }

      // Smart wiki selection for read/write/search
      let wikiName = params.wiki || params.w;

      // If no wiki specified, try to be smart
      if (!wikiName) {
        // Check if content suggests a specific wiki
        const suggested = mediaWikiManager.suggestWiki(params.page || content || '');
        wikiName = suggested;
      }

      const client = await mediaWikiManager.getClient(wikiName);

      if (!client) {
        const available = mediaWikiManager.getAvailableWikis();

        return JSON.stringify({
          success: false,
          message:
            available.length > 0
              ? `Wiki '${wikiName}' not found. Available: ${available.map((w) => w.name).join(', ')}`
              : "No wikis configured. Set environment variables or use action='add' to add one.",
        });
      }

      // READ
      if (action === 'read' || action === 'get') {
        const pageName = params.page || params.p || content || 'Main_Page';
        const page = await client.getPage(pageName);

        if (!page) {
          return JSON.stringify({
            success: false,
            message: `Page '${pageName}' not found on wiki '${wikiName || 'default'}'`,
          });
        }

        return JSON.stringify({
          success: true,
          wiki: wikiName,
          title: page.title,
          content: page.content,
        });
      }

      // WRITE
      if (action === 'write' || action === 'edit' || action === 'update') {
        const pageName = params.page || params.p;
        const pageContent = content || params.content || params.text;

        if (!pageName) {
          return JSON.stringify({
            success: false,
            message: "Need a page name (page='PageName')",
          });
        }

        if (!pageContent) {
          return JSON.stringify({
            success: false,
            message: 'Need content to write',
          });
        }

        const result = await client.editPage(
          pageName,
          pageContent,
          params.summary || 'Updated by Coach Artie'
        );

        return JSON.stringify({
          success: result.success,
          wiki: wikiName,
          message: result.success ? `Saved ${pageName}` : `Failed: ${result.error}`,
        });
      }

      // SEARCH
      if (action === 'search' || action === 'find' || action === 'query') {
        const query = params.query || params.q || params.search || content;

        if (!query) {
          return JSON.stringify({
            success: false,
            message: 'What should I search for?',
          });
        }

        const results = await client.searchPages(query, params.limit || 5);

        return JSON.stringify({
          success: true,
          wiki: wikiName,
          query: query,
          results,
          count: results.length,
        });
      }

      // Unknown action
      return JSON.stringify({
        success: false,
        message: `Unknown action '${action}'. I can: read, write, search, list, add`,
      });
    } catch (error) {
      logger.error('MediaWiki error:', error);
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'MediaWiki error',
      });
    }
  },
};
