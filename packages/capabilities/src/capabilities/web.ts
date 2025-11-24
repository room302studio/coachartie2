import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { searchWeb, fetchWebContent } from '../utils/web-fetch.js';
import { capabilityRegistry } from '../services/capability-registry.js';

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
  emoji: '🌐',
  supportedActions: ['search', 'fetch'],
  description:
    'Real-time web search and content retrieval engine. Excels at finding: current stock prices and financial news, breaking news and current events, product reviews and comparisons, company announcements, technical documentation, restaurant/business information, and any time-sensitive or recently published information. Use for queries requiring the latest available data from across the internet. Can also fetch and extract content from specific URLs.',
  examples: [
    '<capability name="web" action="search" query="AAPL stock price today" />',
    '<capability name="web" action="search" query="NVIDIA earnings report Q4 2024" />',
    '<capability name="web" action="search" query="latest Tesla news today" />',
    '<capability name="web" action="search" query="Bitcoin price prediction 2024" />',
    '<capability name="web" action="search" query="OpenAI GPT-5 release date" />',
    '<capability name="web" action="search" query="React 19 new features" />',
    '<capability name="web" action="search" query="best restaurants in Brooklyn 2024" />',
    '<capability name="web" action="search" query="TypeScript 5.5 changelog" />',
    '<capability name="web" action="fetch" url="https://example.com/article" />',
  ],
  handler: async (params, content) => {
    const { action } = params;

    if (action === 'search') {
      const query = params.query || content;
      if (!query) {
        throw new Error('No search query provided');
      }

      logger.info(`🔍 Performing web search for: ${query}`);

      try {
        // Try MCP Brave Search first if available
        try {
          if (capabilityRegistry.has('mcp_client')) {
            const mcpClientCapability = capabilityRegistry.get('mcp_client', 'list_servers');
            // Check if we have a connected Brave Search server
            const servers = await mcpClientCapability.handler({ action: 'list_servers' });
            if (typeof servers === 'string' && servers.includes('brave_search')) {
              // Try to use Brave Search MCP
              logger.info('🚀 Using Brave Search MCP server for web search');
              const mcpCallCapability = capabilityRegistry.get('mcp_client', 'call_tool');
              const mcpResult = await mcpCallCapability.handler({
                action: 'call_tool',
                connection_id: 'brave_search',
                tool_name: 'brave_web_search',
                args: { query },
              });

              if (typeof mcpResult === 'string' && mcpResult.length > 0) {
                return mcpResult;
              }
            }
          }
        } catch (mcpError) {
          logger.warn('MCP Brave Search failed, falling back to DuckDuckGo:', mcpError);
        }

        // Fallback to DuckDuckGo search
        logger.info('🦆 Using DuckDuckGo fallback for web search');
        const result = await searchWeb(query);

        if (result.success) {
          return result.content || `No results found for: "${query}"`;
        } else {
          throw new Error(`Search failed for "${query}": ${result.error}`);
        }
      } catch (error) {
        logger.error('Web search failed:', error);
        throw new Error(
          `Search temporarily unavailable for "${query}": ${error instanceof Error ? error.message : String(error)}`
        );
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
          if (result.title) {
            content += `Title: ${result.title}\n`;
          }
          if (result.description) {
            content += `Description: ${result.description}\n`;
          }
          if (result.content) {
            content += `Content: ${result.content}`;
          }
          return content || `No content extracted from ${url}`;
        } else {
          throw new Error(`Failed to fetch ${url}: ${result.error}`);
        }
      } catch (error) {
        logger.error('Web fetch failed:', error);
        throw new Error(
          `Web fetch temporarily unavailable for ${url}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new Error(`Unknown web action: ${action}`);
  },
};
