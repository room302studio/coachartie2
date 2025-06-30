import { XMLParser } from 'fast-xml-parser';
import { logger } from '@coachartie/shared';

export interface ParsedCapability {
  name: string;
  action: string;
  content: string;
  params: Record<string, unknown>;
}

export class CapabilityXMLParser {
  private xmlParser: XMLParser;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      ignoreDeclaration: true,
      ignorePiTags: true,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      cdataPropName: false
    });
  }

  /**
   * Extract capability tags from text and parse them
   */
  extractCapabilities(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    try {
      // Find capability tags using a simple regex
      const capabilityMatches = text.match(/<capability[^>]*(?:\/>|>.*?<\/capability>)/gs);
      
      if (capabilityMatches) {
        capabilityMatches.forEach((match) => {
          try {
            const parsed = this.parseCapabilityTag(match);
            if (parsed) {
              capabilities.push(parsed);
            }
          } catch (error) {
            logger.warn(`Failed to parse capability tag: ${match}`, error);
          }
        });
      }

      // Also find MCP tool tags (e.g., <search-wikipedia>query</search-wikipedia>)
      const mcpToolMatches = this.extractMCPToolTags(text);
      if (mcpToolMatches.length > 0) {
        logger.info(`🎯 NEW XML SYNTAX: Found ${mcpToolMatches.length} MCP tool tags: ${JSON.stringify(mcpToolMatches)}`);
      }
      capabilities.push(...mcpToolMatches);

    } catch (error) {
      logger.error('Failed to extract capabilities from text:', error);
    }

    return capabilities;
  }

  /**
   * Parse a single capability tag
   */
  private parseCapabilityTag(capabilityTag: string): ParsedCapability | null {
    try {
      // Wrap in root element for valid XML
      const wrappedXml = `<root>${capabilityTag}</root>`;
      const parsed = this.xmlParser.parse(wrappedXml);

      if (!parsed.root?.capability) {
        return null;
      }

      const cap = parsed.root.capability;

      // Extract name and action from attributes
      const name = cap['@_name'];
      const action = cap['@_action'];

      if (!name || !action) {
        logger.warn('Capability missing required name or action attributes');
        return null;
      }

      // Extract all other attributes as params
      const params: Record<string, unknown> = {};
      Object.keys(cap).forEach(key => {
        if (key.startsWith('@_') && key !== '@_name' && key !== '@_action') {
          const paramName = key.substring(2); // Remove "@_" prefix
          params[paramName] = cap[key];
        }
      });

      // Extract content (text between opening and closing tags)
      let content = '';
      if (typeof cap === 'string') {
        content = cap;
      } else if (cap['#text']) {
        content = cap['#text'];
      } else if (capabilityTag.includes('</capability>')) {
        // For tags with content, extract everything between opening and closing tags
        const contentMatch = capabilityTag.match(/>(.+?)<\/capability>/s);
        content = contentMatch ? contentMatch[1].trim() : '';
      }

      return {
        name,
        action,
        content,
        params
      };

    } catch (error) {
      logger.error(`Failed to parse capability XML: ${capabilityTag}`, error);
      return null;
    }
  }

  /**
   * Extract MCP tool tags with simplified syntax
   * e.g., <search-wikipedia>query</search-wikipedia>
   * or <get-wikipedia-article limit="5">Python</get-wikipedia-article>
   */
  private extractMCPToolTags(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // Match any tag that looks like an MCP tool (kebab-case)
    const toolTagRegex = /<([a-z]+(?:-[a-z]+)+)([^>]*?)(?:\/>|>(.*?)<\/\1>)/gs;
    
    let match;
    while ((match = toolTagRegex.exec(text)) !== null) {
      const [fullMatch, toolName, attributesStr, content] = match;
      
      try {
        // Parse attributes if any
        const params: Record<string, unknown> = {};
        if (attributesStr.trim()) {
          const attrRegex = /(\w+)="([^"]*)"/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
            params[attrMatch[1]] = attrMatch[2];
          }
        }
        
        // Convert kebab-case to snake_case for tool name
        const snakeToolName = toolName.replace(/-/g, '_');
        
        capabilities.push({
          name: 'mcp_client',
          action: 'call_tool',
          params: {
            tool_name: snakeToolName,
            ...params
          },
          content: content?.trim() || ''
        });
        
      } catch (error) {
        logger.warn(`Failed to parse MCP tool tag: ${fullMatch}`, error);
      }
    }
    
    return capabilities;
  }

  /**
   * Find capability tags in memory content for pattern extraction
   */
  findCapabilityTags(text: string): string[] {
    const matches = text.match(/<capability[^>]*>.*?<\/capability>/g);
    return matches || [];
  }
}

// Export singleton instance
export const capabilityXMLParser = new CapabilityXMLParser();