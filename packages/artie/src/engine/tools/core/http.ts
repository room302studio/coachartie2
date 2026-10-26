import axios, { AxiosRequestConfig } from 'axios';
import { getErrorMessage } from '../../../shared/errors.js';
import { logger } from '../../../shared/logger.js';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import { validateUrl, httpAgent, httpsAgent, WEB_FETCH_MAX_REDIRECTS } from './web-fetch.js';

function serializeBody(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content);
}

/**
 * HTTP capability - Make HTTP requests (like curl)
 *
 * Owner-only (owner-only.ts: `http: 'all'`) — but an owner's own turn can be prompt-injected
 * (a fetched page or linked message telling Artie to call this tool), so this still needs its
 * own SSRF guard rather than trusting the caller's identity alone. Security audit 2026-10-26
 * (sec-leaks.md finding #2): this tool used to do a raw `fetch()` with no URL validation and
 * no guarded DNS lookup, so it could reach Artie's own internal routes (which trust direct
 * loopback callers with no Bearer token) and any private/internal host. It now reuses
 * web-fetch.ts's validateUrl + guarded http/https agents — the one SSRF guard in the codebase
 * — instead of duplicating that logic.
 *
 * Supported actions:
 * - get: GET request
 * - post: POST request
 * - put: PUT request
 * - delete: DELETE request
 *
 * Parameters:
 * - url: The URL to request (required) — must resolve to a public address
 * - headers: JSON object of headers (optional)
 * - body: Request body for POST/PUT (optional)
 * - json: Parse response as JSON (default true)
 *
 * Examples:
 * <capability name="http" action="get" url="https://api.example.com/data" />
 * <capability name="http" action="post" url="https://api.example.com/data" body='{"key":"value"}' />
 */
export const httpCapability: RegisteredCapability = {
  name: 'http',
  emoji: '🌐',
  supportedActions: ['get', 'post', 'put', 'delete'],
  description:
    'Make HTTP requests to public APIs and endpoints (like curl). Owner-only; private/internal/loopback addresses are blocked, same guard as the web tool.',
  examples: [
    '<capability name="http" action="get" url="https://api.example.com/data" />',
    '<capability name="http" action="get" url="https://example.com/api/data" headers=\'{"Authorization":"Bearer token"}\' />',
    '<capability name="http" action="post" url="https://api.example.com/data" body=\'{"key":"value"}\' />',
  ],
  handler: async (params, content) => {
    const { action, url, headers: headersParam, body: bodyParam, json: parseJson = true } = params;

    if (!url) {
      throw new Error('URL parameter is required');
    }

    const validation = validateUrl(url as string);
    if (!validation.isValid) {
      throw new Error(`Refused: ${validation.error || 'URL failed validation'}`);
    }
    const normalizedUrl = validation.normalizedUrl!;

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
        body = serializeBody(bodyContent);
      }
    }

    logger.info(`🌐 HTTP ${String(action).toUpperCase()} ${normalizedUrl}`);

    try {
      const axiosConfig: AxiosRequestConfig = {
        url: normalizedUrl,
        method: String(action).toUpperCase(),
        headers,
        data: body,
        httpAgent,
        httpsAgent,
        maxRedirects: WEB_FETCH_MAX_REDIRECTS,
        responseType: 'text',
        validateStatus: () => true, // We check response.status ourselves below, like the old fetch path
        transformResponse: [(data) => data], // Don't auto-parse; we decide JSON vs text below
      };

      const response = await axios(axiosConfig);

      logger.info(`📡 HTTP Response: ${response.status} ${response.statusText}`);

      if (response.status >= 400) {
        logger.error(`❌ HTTP Error Response: ${response.data}`);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse response
      let result: string;
      if (parseJson) {
        try {
          const data = JSON.parse(response.data as string);
          // Format JSON nicely for LLM
          result = JSON.stringify(data, null, 2);
          logger.info(`✅ HTTP Success: Returned ${result.length} chars of JSON data`);
          logger.debug(`📦 HTTP Data preview: ${result.substring(0, 200)}...`);
        } catch (_e) {
          // If JSON parse fails, fall back to text
          result = String(response.data ?? '');
          logger.info(`✅ HTTP Success: Returned ${result.length} chars of text data`);
        }
      } else {
        result = String(response.data ?? '');
        logger.info(`✅ HTTP Success: Returned ${result.length} chars of text data`);
      }

      return result;
    } catch (error) {
      logger.error(`❌ HTTP request failed:`, error);
      throw new Error(`HTTP request to ${normalizedUrl} failed: ${getErrorMessage(error)}`);
    }
  },
};
