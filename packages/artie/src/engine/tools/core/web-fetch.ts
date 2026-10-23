import axios, { AxiosResponse, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { decode as decodeHtmlEntities } from 'html-entities';
import { z } from 'zod';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { logger } from '../../../shared/logger.js';
import { collapseWhitespace } from '../../../shared/text.js';

// Configuration constants
const CONFIG = {
  // Maximum content size in bytes (10MB)
  MAX_CONTENT_SIZE: 10 * 1024 * 1024,
  // Maximum title length
  MAX_TITLE_LENGTH: 200,
  // Maximum description length
  MAX_DESCRIPTION_LENGTH: 500,
  // Maximum extracted text length
  MAX_TEXT_LENGTH: 50000,
  // Request timeout in milliseconds
  REQUEST_TIMEOUT: 30000,
  // Maximum number of redirects
  MAX_REDIRECTS: 5,
  // User agent string
  USER_AGENT: 'CoachArtie/1.0 (Web Content Fetcher; +https://coachartie.com)',
  // Allowed protocols
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  // Blocked hostnames (security). IP ranges are in BLOCKED_ADDRESSES below.
  BLOCKED_DOMAINS: ['localhost'],
  // Blocked ports
  BLOCKED_PORTS: [22, 23, 25, 53, 80, 110, 143, 443, 993, 995],
};

// Types
export interface WebFetchResult {
  success: boolean;
  url: string;
  title?: string;
  description?: string;
  content?: string;
  contentType?: string;
  size?: number;
  error?: string;
  statusCode?: number;
}

export interface WebFetchOptions {
  maxContentSize?: number;
  timeout?: number;
  followRedirects?: boolean;
  extractText?: boolean;
  includeMetadata?: boolean;
}

// URL validation schema
const urlSchema = z
  .string()
  .url()
  .refine((url) => {
    try {
      const parsed = new URL(url);
      return CONFIG.ALLOWED_PROTOCOLS.includes(parsed.protocol);
    } catch {
      return false;
    }
  }, 'Invalid or unsupported protocol');

/**
 * Validates a URL for security and format
 */
export function validateUrl(url: string): {
  isValid: boolean;
  error?: string;
  normalizedUrl?: string;
} {
  try {
    // Basic format validation
    const validationResult = urlSchema.safeParse(url);
    if (!validationResult.success) {
      return {
        isValid: false,
        error: 'Invalid URL format or unsupported protocol',
      };
    }

    const parsedUrl = new URL(url);

    // Check for blocked domains
    const hostname = parsedUrl.hostname.toLowerCase();
    for (const blockedDomain of CONFIG.BLOCKED_DOMAINS) {
      if (hostname === blockedDomain || hostname.endsWith(`.${blockedDomain}`)) {
        return {
          isValid: false,
          error: 'URL points to a blocked domain',
        };
      }
    }

    // Check for private/reserved IP ranges
    if (isBlockedAddress(hostname)) {
      return {
        isValid: false,
        error: 'URL points to a private IP address',
      };
    }

    // Check for blocked ports
    const port = parsedUrl.port
      ? parseInt(parsedUrl.port)
      : parsedUrl.protocol === 'https:'
        ? 443
        : 80;
    if (
      CONFIG.BLOCKED_PORTS.includes(port) &&
      parsedUrl.protocol !== 'https:' &&
      parsedUrl.protocol !== 'http:'
    ) {
      return {
        isValid: false,
        error: 'URL uses a blocked port',
      };
    }

    return {
      isValid: true,
      normalizedUrl: parsedUrl.toString(),
    };
  } catch {
    return {
      isValid: false,
      error: 'Failed to parse URL',
    };
  }
}

/**
 * Address ranges a fetch must never reach: loopback, RFC 1918, CGNAT, link-local (cloud
 * metadata lives at 169.254.169.254), IETF protocol assignments, benchmarking, multicast,
 * reserved, and the IPv6 equivalents. A node:net BlockList replaces the old regex list,
 * which missed 100.64/10, 192.0.0/24, 198.18/15, 224/4, 240/4 and every fd00::/8 address
 * except fd00:: itself.
 */
const BLOCKED_ADDRESSES = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(net, prefix, 'ipv4');
}
BLOCKED_ADDRESSES.addAddress('::', 'ipv6');
BLOCKED_ADDRESSES.addAddress('::1', 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');

/**
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) → the IPv4 address, so the IPv4 rules apply to it.
 * WHATWG URL serializes [::ffff:10.0.0.1] as [::ffff:a00:1], so both forms are handled.
 */
function unwrapMappedIPv4(ip: string): string | null {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1];
  if (isIPv4(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/**
 * True when `host` (a URL hostname, IPv6 possibly in brackets) is a literal IP address in a
 * blocked range. Hostnames are not resolved here: axios does its own lookup, and this guard
 * has only ever checked literal addresses.
 */
export function isBlockedAddress(host: string): boolean {
  const ip = host.replace(/^\[|\]$/g, '');
  if (isIPv4(ip)) return BLOCKED_ADDRESSES.check(ip, 'ipv4');
  if (isIPv6(ip)) {
    const v4 = unwrapMappedIPv4(ip);
    if (v4) return BLOCKED_ADDRESSES.check(v4, 'ipv4');
    return BLOCKED_ADDRESSES.check(ip, 'ipv6');
  }
  return false;
}

/**
 * Extracts readable text content from HTML
 */
function extractTextFromHtml(
  html: string,
  _url: string
): { title?: string; description?: string; content?: string } {
  // For now, skip Readability since JSDOM is not available
  // Focus on cheerio-based extraction which is more reliable for our use case

  // Fallback to cheerio for basic parsing
  try {
    const $ = cheerio.load(html);

    // Extract title
    const title =
      $('title').first().text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="title"]').attr('content');

    // Extract description
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="twitter:description"]').attr('content');

    // Remove script and style elements
    $('script, style, nav, header, footer, aside, .ad, .advertisement, .sidebar').remove();

    // Get main content
    let content = '';
    const mainContent = $('main, article, .content, .post, .entry, #content').first();
    if (mainContent.length) {
      content = mainContent.text();
    } else {
      content = $('body').text();
    }

    // Clean up text
    // (The old second step, /\n\s*\n/ -> '\n', could never match after the collapse; dropped.)
    content = collapseWhitespace(content).trim();

    return {
      title: title ? decodeHtmlEntities(title.substring(0, CONFIG.MAX_TITLE_LENGTH)) : undefined,
      description: description
        ? decodeHtmlEntities(description.substring(0, CONFIG.MAX_DESCRIPTION_LENGTH))
        : undefined,
      content: content
        ? decodeHtmlEntities(content.substring(0, CONFIG.MAX_TEXT_LENGTH))
        : undefined,
    };
  } catch (error) {
    logger.error('Failed to parse HTML with cheerio:', error);
    return {};
  }
}

/**
 * Processes different content types appropriately
 */
function processContent(
  response: AxiosResponse,
  options: WebFetchOptions
): { title?: string; description?: string; content?: string } {
  const contentType = response.headers['content-type']?.toLowerCase() || '';
  const data = response.data;

  // Handle HTML content
  if (contentType.includes('text/html')) {
    if (options.extractText) {
      return extractTextFromHtml(data, response.config.url || '');
    } else {
      return { content: data };
    }
  }

  // Handle JSON content
  if (contentType.includes('application/json')) {
    try {
      const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
      return {
        content: JSON.stringify(jsonData, null, 2).substring(0, CONFIG.MAX_TEXT_LENGTH),
      };
    } catch {
      return { content: String(data).substring(0, CONFIG.MAX_TEXT_LENGTH) };
    }
  }

  // Handle plain text and other text types
  if (contentType.includes('text/')) {
    return {
      content: String(data).substring(0, CONFIG.MAX_TEXT_LENGTH),
    };
  }

  // Handle XML content
  if (contentType.includes('xml')) {
    const $ = cheerio.load(data, { xmlMode: true });
    const textContent = $.text().trim();
    return {
      content: textContent.substring(0, CONFIG.MAX_TEXT_LENGTH),
    };
  }

  // For other content types, return basic info
  return {
    content: `[${contentType}] Binary content (${response.data?.length || 0} bytes)`,
  };
}

/**
 * Fetches web content with comprehensive error handling and security measures
 */
export async function fetchWebContent(
  url: string,
  options: WebFetchOptions = {}
): Promise<WebFetchResult> {
  const startTime = Date.now();

  try {
    // Validate URL
    const validation = validateUrl(url);
    if (!validation.isValid) {
      return {
        success: false,
        url,
        error: validation.error || 'URL validation failed',
      };
    }

    const normalizedUrl = validation.normalizedUrl!;

    // Prepare axios configuration
    const axiosConfig: AxiosRequestConfig = {
      url: normalizedUrl,
      method: 'GET',
      timeout: options.timeout || CONFIG.REQUEST_TIMEOUT,
      maxRedirects: options.followRedirects !== false ? CONFIG.MAX_REDIRECTS : 0,
      maxContentLength: options.maxContentSize || CONFIG.MAX_CONTENT_SIZE,
      maxBodyLength: options.maxContentSize || CONFIG.MAX_CONTENT_SIZE,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      responseType: 'text',
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      transformResponse: [(data) => data], // Prevent automatic JSON parsing
    };

    logger.info(`Fetching web content from: ${normalizedUrl}`);

    // Make the request
    const response = await axios(axiosConfig);
    const duration = Date.now() - startTime;

    logger.info(
      `Web fetch completed in ${duration}ms, status: ${response.status}, size: ${response.data?.length || 0} bytes`
    );

    // Check for HTTP errors
    if (response.status >= 400) {
      return {
        success: false,
        url: normalizedUrl,
        error: `HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
      };
    }

    // Process content based on type
    const processed = processContent(response, {
      extractText: options.extractText !== false,
      includeMetadata: options.includeMetadata !== false,
      ...options,
    });

    const result: WebFetchResult = {
      success: true,
      url: normalizedUrl,
      contentType: response.headers['content-type'],
      size: response.data?.length || 0,
      statusCode: response.status,
      ...processed,
    };

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    let errorMessage = 'Unknown error occurred';

    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Request timeout';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'Domain not found';
      } else if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused';
      } else if (error.response) {
        errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
      } else if (error.request) {
        errorMessage = 'No response received';
      } else {
        errorMessage = error.message;
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    logger.error(`Web fetch failed after ${duration}ms:`, errorMessage);

    return {
      success: false,
      url,
      error: errorMessage,
    };
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position?: number;
}

/**
 * Enhanced web search that returns comprehensive results with links
 */
export async function searchWeb(query: string): Promise<WebFetchResult> {
  try {
    logger.info(`🔍 Enhanced web search for: ${query}`);

    const results: SearchResult[] = [];
    let instantAnswer = '';

    // First, try DuckDuckGo instant answers
    try {
      const instantUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const instantResponse = await fetch(instantUrl, {
        headers: { 'User-Agent': 'CoachArtie-Bot/1.0' },
      });

      if (instantResponse.ok) {
        const data = (await instantResponse.json()) as Record<string, unknown>;

        // Build instant answer
        if (data.Abstract) {
          instantAnswer += `**Summary**: ${data.Abstract}\n`;
          if (data.AbstractURL) {
            instantAnswer += `Source: ${data.AbstractURL}\n`;
          }
          instantAnswer += '\n';
        }

        if (data.Answer) {
          instantAnswer += `**Answer**: ${data.Answer}\n`;
          if (data.AnswerType) {
            instantAnswer += `Type: ${data.AnswerType}\n`;
          }
          instantAnswer += '\n';
        }

        // Extract related topics as search results
        if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
          (data.RelatedTopics as Array<Record<string, unknown>>).slice(0, 3).forEach((topic, i) => {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: String(topic.Text).split(' - ')[0] || `Related Topic ${i + 1}`,
                url: String(topic.FirstURL),
                snippet: String(topic.Text),
                position: i + 1,
              });
            }
          });
        }
      }
    } catch (error) {
      logger.warn('DuckDuckGo instant answers failed:', error);
    }

    // If we don't have enough results, scrape HTML search results
    if (results.length < 3) {
      try {
        const htmlSearchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const htmlResponse = await fetch(htmlSearchUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          },
        });

        if (htmlResponse.ok) {
          const html = await htmlResponse.text();
          const $ = cheerio.load(html);

          // Extract search results
          $('.web-result, .result, .links_main').each((i, elem) => {
            if (results.length >= 8) {
              return false;
            } // Stop at 8 results

            const $elem = $(elem);
            const titleElem = $elem.find('a.result__a, .result__title a, h2 a').first();
            const title = titleElem.text().trim();
            const url = titleElem.attr('href');
            const snippet =
              $elem.find('.result__snippet, .result-snippet, .snippet').text().trim() ||
              $elem.find('.result__body, .web-result__description').text().trim();

            if (title && url && snippet) {
              // Clean up URL (DuckDuckGo sometimes uses redirect URLs)
              let cleanUrl = url;
              if (url.includes('uddg=')) {
                try {
                  const uddgMatch = url.match(/uddg=([^&]+)/);
                  if (uddgMatch) {
                    cleanUrl = decodeURIComponent(uddgMatch[1]);
                  }
                } catch (_e) {
                  // Use original URL if decoding fails
                }
              }

              results.push({
                title: title.substring(0, 100),
                url: cleanUrl,
                snippet: snippet.substring(0, 200),
                position: results.length + 1,
              });
            }
          });
        }
      } catch (error) {
        logger.warn('HTML search scraping failed:', error);
      }
    }

    // Build comprehensive response
    let content = '';

    // Add instant answer first if available
    if (instantAnswer.trim()) {
      content += instantAnswer + '---\n\n';
    }

    // Add search results
    if (results.length > 0) {
      content += '## 🔍 Search Results\n\n';
      results.forEach((result, i) => {
        content += `### ${i + 1}. [${result.title}](${result.url})\n`;
        content += `${result.snippet}\n`;
        content += `🔗 **URL**: ${result.url}\n\n`;
      });
    } else {
      content += `## No detailed search results found\n\nTry searching directly: [DuckDuckGo Search](https://duckduckgo.com/?q=${encodeURIComponent(query)})\n\n`;
      content += `**Suggested alternatives:**\n`;
      content += `• Try more specific keywords\n`;
      content += `• Use different phrasing\n`;
      content += `• Check spelling\n`;
    }

    // Add helpful search tips
    content +=
      '\n---\n*💡 Tip: For more current results, try rephrasing your search with specific years (e.g., "2024", "2025") or current terms.*';

    return {
      success: true,
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      title: `Search Results for "${query}"`,
      content: content.trim(),
      contentType: 'text/markdown',
    };
  } catch (error) {
    logger.error('Enhanced web search failed:', error);

    return {
      success: false,
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      title: 'Search Error',
      content:
        `**Search failed**: ${error instanceof Error ? error.message : 'Unknown error'}\n\n` +
        `**Manual search**: [Click here to search "${query}" on DuckDuckGo](https://duckduckgo.com/?q=${encodeURIComponent(query)})\n\n` +
        `**Try:**\n• Different keywords\n• More specific terms\n• Check your internet connection`,
      contentType: 'text/markdown',
      error: error instanceof Error ? error.message : 'Search failed',
    };
  }
}
