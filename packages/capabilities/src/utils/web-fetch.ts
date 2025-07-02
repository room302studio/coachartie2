import axios, { AxiosResponse, AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { decode as decodeHtmlEntities } from 'html-entities';
import { z } from 'zod';
import { logger } from '@coachartie/shared';

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
  // Blocked domains (security)
  BLOCKED_DOMAINS: [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '169.254.169.254', // AWS metadata
    '10.0.0.0/8',
    '172.16.0.0/12', 
    '192.168.0.0/16'
  ],
  // Blocked ports
  BLOCKED_PORTS: [22, 23, 25, 53, 80, 110, 143, 443, 993, 995]
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
const urlSchema = z.string().url().refine((url) => {
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
export function validateUrl(url: string): { isValid: boolean; error?: string; normalizedUrl?: string } {
  try {
    // Basic format validation
    const validationResult = urlSchema.safeParse(url);
    if (!validationResult.success) {
      return {
        isValid: false,
        error: 'Invalid URL format or unsupported protocol'
      };
    }

    const parsedUrl = new URL(url);
    
    // Check for blocked domains
    const hostname = parsedUrl.hostname.toLowerCase();
    for (const blockedDomain of CONFIG.BLOCKED_DOMAINS) {
      if (hostname === blockedDomain || hostname.endsWith(`.${blockedDomain}`)) {
        return {
          isValid: false,
          error: 'URL points to a blocked domain'
        };
      }
    }

    // Check for private IP ranges (basic check)
    if (isPrivateIP(hostname)) {
      return {
        isValid: false,
        error: 'URL points to a private IP address'
      };
    }

    // Check for blocked ports
    const port = parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
    if (CONFIG.BLOCKED_PORTS.includes(port) && parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return {
        isValid: false,
        error: 'URL uses a blocked port'
      };
    }

    return {
      isValid: true,
      normalizedUrl: parsedUrl.toString()
    };
  } catch {
    return {
      isValid: false,
      error: 'Failed to parse URL'
    };
  }
}

/**
 * Basic private IP detection
 */
function isPrivateIP(hostname: string): boolean {
  // Basic regex patterns for private IP ranges
  const privateIPPatterns = [
    /^10\./,                    // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
    /^192\.168\./,              // 192.168.0.0/16
    /^127\./,                   // 127.0.0.0/8 (loopback)
    /^169\.254\./,              // 169.254.0.0/16 (link-local)
    /^0\.0\.0\.0$/,             // 0.0.0.0
    /^::1$/,                    // IPv6 loopback
    /^fe80:/i,                  // IPv6 link-local
    /^fc00:/i,                  // IPv6 unique local
    /^fd00:/i                   // IPv6 unique local
  ];

  return privateIPPatterns.some(pattern => pattern.test(hostname));
}

/**
 * Extracts readable text content from HTML
 */
function extractTextFromHtml(html: string, _url: string): { title?: string; description?: string; content?: string } {
  // For now, skip Readability since JSDOM is not available
  // Focus on cheerio-based extraction which is more reliable for our use case

  // Fallback to cheerio for basic parsing
  try {
    const $ = cheerio.load(html);
    
    // Extract title
    const title = $('title').first().text().trim() || 
                  $('h1').first().text().trim() ||
                  $('meta[property="og:title"]').attr('content') ||
                  $('meta[name="title"]').attr('content');

    // Extract description
    const description = $('meta[name="description"]').attr('content') ||
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
    content = content
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    return {
      title: title ? decodeHtmlEntities(title.substring(0, CONFIG.MAX_TITLE_LENGTH)) : undefined,
      description: description ? decodeHtmlEntities(description.substring(0, CONFIG.MAX_DESCRIPTION_LENGTH)) : undefined,
      content: content ? decodeHtmlEntities(content.substring(0, CONFIG.MAX_TEXT_LENGTH)) : undefined
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
        content: JSON.stringify(jsonData, null, 2).substring(0, CONFIG.MAX_TEXT_LENGTH)
      };
    } catch {
      return { content: String(data).substring(0, CONFIG.MAX_TEXT_LENGTH) };
    }
  }

  // Handle plain text and other text types
  if (contentType.includes('text/')) {
    return {
      content: String(data).substring(0, CONFIG.MAX_TEXT_LENGTH)
    };
  }

  // Handle XML content
  if (contentType.includes('xml')) {
    const $ = cheerio.load(data, { xmlMode: true });
    const textContent = $.text().trim();
    return {
      content: textContent.substring(0, CONFIG.MAX_TEXT_LENGTH)
    };
  }

  // For other content types, return basic info
  return {
    content: `[${contentType}] Binary content (${response.data?.length || 0} bytes)`
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
        error: validation.error || 'URL validation failed'
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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      responseType: 'text',
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      transformResponse: [(data) => data] // Prevent automatic JSON parsing
    };

    logger.info(`Fetching web content from: ${normalizedUrl}`);

    // Make the request
    const response = await axios(axiosConfig);
    const duration = Date.now() - startTime;

    logger.info(`Web fetch completed in ${duration}ms, status: ${response.status}, size: ${response.data?.length || 0} bytes`);

    // Check for HTTP errors
    if (response.status >= 400) {
      return {
        success: false,
        url: normalizedUrl,
        error: `HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status
      };
    }

    // Process content based on type
    const processed = processContent(response, {
      extractText: options.extractText !== false,
      includeMetadata: options.includeMetadata !== false,
      ...options
    });

    const result: WebFetchResult = {
      success: true,
      url: normalizedUrl,
      contentType: response.headers['content-type'],
      size: response.data?.length || 0,
      statusCode: response.status,
      ...processed
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
      error: errorMessage
    };
  }
}

/**
 * Simple web search placeholder (would integrate with actual search API)
 */
export async function searchWeb(query: string): Promise<WebFetchResult> {
  try {
    // Use DuckDuckGo's instant answer API (no API key needed!)
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    
    logger.info(`🦆 Searching DuckDuckGo for: ${query}`);
    
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'CoachArtie-Bot/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Search API returned ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    
    // Build response from DuckDuckGo instant answers
    let content = '';
    
    // Abstract (summary)
    if (data.Abstract) {
      content += `**Summary**: ${data.Abstract}\n\n`;
    }
    
    // Answer (direct answer)
    if (data.Answer) {
      content += `**Answer**: ${data.Answer}\n`;
      if (data.AnswerType) {
        content += ` (${data.AnswerType})\n`;
      }
      content += '\n';
    }
    
    // Definition
    if (data.Definition) {
      content += `**Definition**: ${data.Definition}\n`;
      if (data.DefinitionSource) {
        content += `Source: ${data.DefinitionSource}\n`;
      }
      content += '\n';
    }
    
    // Related topics
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics) && data.RelatedTopics.length > 0) {
      content += '**Related Topics**:\n';
      (data.RelatedTopics as Array<Record<string, unknown>>).slice(0, 5).forEach((topic: Record<string, unknown>) => {
        if (topic.Text) {
          content += `• ${topic.Text}\n`;
          if (topic.FirstURL) {
            content += `  ${topic.FirstURL}\n`;
          }
        }
      });
      content += '\n';
    }
    
    // Infobox data
    const infobox = data.Infobox as Record<string, unknown> | undefined;
    if (infobox && infobox.content && Array.isArray(infobox.content) && infobox.content.length > 0) {
      content += '**Quick Facts**:\n';
      (infobox.content as Array<Record<string, unknown>>).slice(0, 5).forEach((item: Record<string, unknown>) => {
        if (item.label && item.value) {
          content += `• ${item.label}: ${item.value}\n`;
        }
      });
      content += '\n';
    }
    
    // If we got no useful content, try a web scrape approach
    if (!content.trim()) {
      // Fallback to scraping DuckDuckGo HTML results
      const htmlSearchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const htmlResponse = await fetch(htmlSearchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CoachArtie/1.0)'
        }
      });
      
      if (htmlResponse.ok) {
        const html = await htmlResponse.text();
        
        // Extract result snippets using regex (quick and dirty)
        const snippetMatches = html.match(/<a class="snippet"[^>]*>([^<]+)<\/a>/g);
        if (snippetMatches && snippetMatches.length > 0) {
          content = '**Search Results**:\n\n';
          snippetMatches.slice(0, 5).forEach((match, i) => {
            const snippet = match.replace(/<[^>]*>/g, '').trim();
            content += `${i + 1}. ${snippet}\n\n`;
          });
        } else {
          content = `No detailed results found for "${query}". Try rephrasing your search.`;
        }
      }
    }
    
    return {
      success: true,
      url: searchUrl,
      title: `Search Results for "${query}"`,
      content: content.trim() || `No results found for "${query}"`,
      contentType: 'application/json'
    };
    
  } catch (error) {
    logger.error('DuckDuckGo search failed:', error);
    
    // Last resort - at least give them a search link
    return {
      success: false,
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      title: 'Search Error',
      content: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}. Try searching directly at: https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      contentType: 'text/plain',
      error: error instanceof Error ? error.message : 'Search failed'
    };
  }
}