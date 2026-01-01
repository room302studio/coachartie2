import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

const N8N_URL = 'http://localhost:5678';
const WORKFLOW_ID = 'icDlrOYPgN9OGPqb';

/**
 * n8n Browser capability - fetches web pages via n8n workflow
 *
 * This bypasses some bot detection by going through n8n's HTTP node.
 * Future: can be extended for screenshots and form filling with Puppeteer.
 */
export const n8nBrowserCapability: RegisteredCapability = {
  name: 'n8n_browser',
  emoji: '🌐',
  supportedActions: ['fetch', 'browse'],
  description:
    'Fetches web pages via n8n browser automation workflow. Useful for sites that block direct requests. Returns page content with status code.',
  examples: [
    '<capability name="n8n_browser" action="fetch" url="https://example.com" />',
    '<capability name="n8n_browser" action="browse" url="https://httpbin.org/get" />',
  ],
  handler: async (params, content) => {
    const url = params.url || content;

    if (!url) {
      throw new Error('No URL provided. Use url parameter or content.');
    }

    logger.info(`🌐 n8n browser fetching: ${url}`);

    try {
      const response = await fetch(`${N8N_URL}/webhook/${WORKFLOW_ID}/webhook/claude-browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        throw new Error(`n8n webhook failed: ${response.status}`);
      }

      const result = (await response.json()) as {
        success?: boolean;
        url?: string;
        status?: number;
        length?: number;
      };

      if (result.success) {
        return `Fetched ${result.url}\nStatus: ${result.status}\nContent length: ${result.length} bytes`;
      } else {
        return `Failed to fetch ${url}: ${JSON.stringify(result)}`;
      }
    } catch (error) {
      logger.error('n8n browser fetch failed:', error);
      throw new Error(
        `n8n browser error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },
};

export default n8nBrowserCapability;
