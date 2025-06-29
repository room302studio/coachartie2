import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { searchWeb, fetchWebContent } from '../utils/web-fetch.js';

/**
 * Web capability - performs web searches and fetches content from URLs
 * 
 * Supported actions:
 * - search: Searches the web for a given query
 * - fetch: Fetches content from a specific URL
 * 
 * Parameters:
 * - query: The search query (for search action)
 * - url: The URL to fetch (for fetch action)
 * 
 * Content: Can also provide the query/URL as content instead of a parameter
 */
export const webCapability: RegisteredCapability = {
  name: 'web',
  supportedActions: ['search', 'fetch'],
  description: 'Performs web searches and fetches content from URLs',
  handler: async (params, content) => {
    const { action } = params;

    if (action === 'search') {
      const query = params.query || content;
      if (!query) {
        throw new Error('No search query provided');
      }
      
      logger.info(`🔍 Performing web search for: ${query}`);
      
      try {
        const result = await searchWeb(query);

        if (result.success) {
          return result.content || `No results found for: "${query}"`;
        } else {
          return `Search failed for "${query}": ${result.error}`;
        }
      } catch (error) {
        logger.error('Web search failed:', error);
        return `Search temporarily unavailable for "${query}"`;
      }
    }

    if (action === 'fetch') {
      const url = params.url;
      if (!url) {
        throw new Error('No URL provided for fetch');
      }
      
      logger.info(`🌐 Fetching web content from: ${url}`);
      
      try {
        const result = await fetchWebContent(url, {
          extractText: true,
          includeMetadata: true,
        });

        if (result.success) {
          let content = '';
          if (result.title) {content += `Title: ${result.title}\n`;}
          if (result.description) {content += `Description: ${result.description}\n`;}
          if (result.content) {content += `Content: ${result.content}`;}
          return content || `No content extracted from ${url}`;
        } else {
          return `Failed to fetch ${url}: ${result.error}`;
        }
      } catch (error) {
        logger.error('Web fetch failed:', error);
        return `Web fetch temporarily unavailable for ${url}`;
      }
    }

    throw new Error(`Unknown web action: ${action}`);
  }
};