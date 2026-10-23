import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

/**
 * HTTP capability - Make HTTP requests (like curl)
 *
 * Supported actions:
 * - get: GET request
 * - post: POST request
 * - put: PUT request
 * - delete: DELETE request
 *
 * Parameters:
 * - url: The URL to request (required)
 * - headers: JSON object of headers (optional)
 * - body: Request body for POST/PUT (optional)
 * - json: Parse response as JSON (default true)
 *
 * Examples:
 * <capability name="http" action="get" url="http://brain:47325/api/stats/top-users?limit=5" />
 * <capability name="http" action="get" url="http://brain:47325/api/memories/search?q=bananas" />
 * <capability name="http" action="post" url="http://brain:47325/api/memories" body='{"content":"New memory","user_id":"artie"}' />
 */
export const httpCapability: RegisteredCapability = {
  name: 'http',
  emoji: '🌐',
  supportedActions: ['get', 'post', 'put', 'delete'],
  description: 'Make HTTP requests to APIs and endpoints (like curl)',
  examples: [
    '<capability name="http" action="get" url="http://brain:47325/api/stats/top-users" />',
    '<capability name="http" action="get" url="http://example.com/api/data" headers=\'{"Authorization":"Bearer token"}\' />',
    '<capability name="http" action="post" url="http://api.example.com/data" body=\'{"key":"value"}\' />',
  ],
  handler: async (params, content) => {
    const { action, url, headers: headersParam, body: bodyParam, json: parseJson = true } = params;

    if (!url) {
      throw new Error('URL parameter is required');
    }

    // Parse headers if provided
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (headersParam) {
      try {
        headers = { ...headers, ...JSON.parse(headersParam as string) };
      } catch (e) {
        logger.warn('Failed to parse headers, using defaults:', e);
      }
    }

    // Parse body if provided (can come from body param or content)
    let body: string | undefined;
    if (action === 'post' || action === 'put') {
      const bodyContent = bodyParam || content;
      if (bodyContent) {
        // If it's already a string, use it; if object, stringify
        body = typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent);
      }
    }

    logger.info(`🌐 HTTP ${action.toUpperCase()} ${url}`);

    try {
      const response = await fetch(url as string, {
        method: action.toUpperCase(),
        headers,
        body,
      });

      logger.info(`📡 HTTP Response: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`❌ HTTP Error Response: ${errorText}`);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse response
      let result: string;
      if (parseJson) {
        try {
          const data = await response.json();
          // Format JSON nicely for LLM
          result = JSON.stringify(data, null, 2);
          logger.info(`✅ HTTP Success: Returned ${result.length} chars of JSON data`);
          logger.debug(`📦 HTTP Data preview: ${result.substring(0, 200)}...`);
        } catch (_e) {
          // If JSON parse fails, fall back to text
          result = await response.text();
          logger.info(`✅ HTTP Success: Returned ${result.length} chars of text data`);
        }
      } else {
        result = await response.text();
        logger.info(`✅ HTTP Success: Returned ${result.length} chars of text data`);
      }

      return result;
    } catch (error) {
      logger.error(`❌ HTTP request failed:`, error);
      throw new Error(
        `HTTP request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};
