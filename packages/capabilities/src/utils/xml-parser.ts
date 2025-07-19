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
      // Find capability tags using proper XML parsing
      const capabilityMatches = this.extractCapabilityTagsWithXMLParser(text);
      
      if (capabilityMatches.length > 0) {
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

      // Also find simple capability tags (e.g., <remember>content</remember>, <search-wikipedia>query</search-wikipedia>)
      const simpleCapabilityMatches = this.extractSimpleCapabilityTags(text);
      if (simpleCapabilityMatches.length > 0) {
        logger.info(`🎯 SIMPLE SYNTAX: Found ${simpleCapabilityMatches.length} simple capability tags: ${JSON.stringify(simpleCapabilityMatches)}`);
      }
      capabilities.push(...simpleCapabilityMatches);

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
        // For tags with content, use XML parser to extract content safely
        try {
          const wrappedTag = `<root>${capabilityTag}</root>`;
          const parsed = this.xmlParser.parse(wrappedTag);
          if (parsed.root?.capability?.['#text']) {
            content = parsed.root.capability['#text'];
          } else if (typeof parsed.root?.capability === 'string') {
            content = parsed.root.capability;
          }
        } catch (error) {
          // Fallback to regex if XML parsing fails
          logger.debug('XML content extraction failed, using regex fallback:', error);
          const contentMatch = capabilityTag.match(/>(.+?)<\/capability>/s);
          content = contentMatch ? contentMatch[1].trim() : '';
        }
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
   * Extract simple capability tags with unified syntax
   * Handles both MCP tools (kebab-case) and regular capabilities (single words)
   * e.g., <search-wikipedia>query</search-wikipedia>
   * e.g., <remember>I love pizza</remember>
   * e.g., <calculate>2 + 2</calculate>
   */
  private extractSimpleCapabilityTags(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // Match any simple tag (single word or kebab-case)
    const simpleTagRegex = /<([a-z]+(?:-[a-z]+)*)([^>]*?)(?:\/>|>(.*?)<\/\1>)/gs;
    
    let match;
    while ((match = simpleTagRegex.exec(text)) !== null) {
      const [fullMatch, tagName, attributesStr, content] = match;
      
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
        
        // Map tag names to capabilities
        const capability = this.mapTagToCapability(tagName, params, content?.trim() || '');
        if (capability) {
          capabilities.push(capability);
        }
        
      } catch (error) {
        logger.warn(`Failed to parse simple capability tag: ${fullMatch}`, error);
      }
    }
    
    return capabilities;
  }

  /**
   * Map simple tag names to capability format
   */
  private mapTagToCapability(tagName: string, params: Record<string, unknown>, content: string): ParsedCapability | null {
    // Memory capabilities
    if (tagName === 'remember') {
      return {
        name: 'memory',
        action: 'remember',
        params,
        content
      };
    }
    
    if (tagName === 'recall') {
      // Handle different recall patterns:
      // <recall>pizza</recall> -> search for "pizza"
      // <recall user="john">pizza</recall> -> search for "pizza" for user "john"  
      // <recall auto /> -> get recent memories automatically
      return {
        name: 'memory',
        action: content ? 'search' : 'recent',
        params: {
          query: content,
          ...params
        },
        content: ''
      };
    }
    
    if (tagName === 'search-memory') {
      return {
        name: 'memory',
        action: 'search',
        params: {
          query: content,
          ...params
        },
        content: ''
      };
    }
    
    // Calculator
    if (tagName === 'calculate') {
      return {
        name: 'calculator',
        action: 'calculate',
        params,
        content
      };
    }
    
    // Web search
    if (tagName === 'web-search') {
      return {
        name: 'web',
        action: 'search',
        params: {
          query: content,
          ...params
        },
        content: ''
      };
    }
    
    // MCP auto-installation tags
    if (tagName === 'mcp-auto-install' || tagName === 'mcp-install' || tagName === 'install-mcp') {
      return {
        name: 'mcp_auto_installer',
        action: 'install_npm',
        params: {
          package: content,
          ...params
        },
        content: ''
      };
    }
    
    // MCP tools (kebab-case with multiple parts)
    if (tagName.includes('-')) {
      const snakeToolName = tagName.replace(/-/g, '_');
      return {
        name: 'mcp_client',
        action: 'call_tool',
        params: {
          tool_name: snakeToolName,
          ...params
        },
        content
      };
    }
    
    // Unknown tag - log and skip
    logger.warn(`Unknown simple capability tag: ${tagName}`);
    return null;
  }

  /**
   * Extract capability tags using proper XML parsing instead of regex
   */
  private extractCapabilityTagsWithXMLParser(text: string): string[] {
    const matches: string[] = [];
    
    try {
      // Try to parse the entire text as XML wrapped in a root element
      const wrappedText = `<root>${text}</root>`;
      const parsed = this.xmlParser.parse(wrappedText);
      
      if (parsed.root) {
        // Look for capability elements recursively
        this.findCapabilityElementsRecursive(parsed.root, text, matches);
      }
    } catch (error) {
      // Fallback to regex if XML parsing fails (for malformed XML)
      logger.debug('XML parsing failed, falling back to regex for capability extraction:', error);
      const regexMatches = text.match(/<capability[^>]*(?:\/>|>.*?<\/capability>)/gs);
      if (regexMatches) {
        matches.push(...regexMatches);
      }
    }
    
    return matches;
  }

  /**
   * Recursively find capability elements in parsed XML
   */
  private findCapabilityElementsRecursive(obj: any, originalText: string, matches: string[]): void {
    if (typeof obj !== 'object' || obj === null) return;
    
    // Check if this object represents a capability element
    if (obj.capability !== undefined) {
      // Extract the original XML string for this capability
      const capabilityXML = this.reconstructCapabilityXML(obj.capability);
      if (capabilityXML) {
        matches.push(capabilityXML);
      }
    }
    
    // Recursively search all properties
    for (const key in obj) {
      if (obj.hasOwnProperty(key) && key !== 'capability') {
        this.findCapabilityElementsRecursive(obj[key], originalText, matches);
      }
    }
  }

  /**
   * Reconstruct capability XML from parsed object
   */
  private reconstructCapabilityXML(capabilityData: any): string | null {
    try {
      if (typeof capabilityData === 'string') {
        return `<capability>${capabilityData}</capability>`;
      }
      
      if (typeof capabilityData === 'object') {
        let attributes = '';
        let content = '';
        
        // Extract attributes (prefixed with @_)
        for (const key in capabilityData) {
          if (key.startsWith('@_')) {
            const attrName = key.substring(2);
            attributes += ` ${attrName}="${capabilityData[key]}"`;
          } else if (key === '#text') {
            content = capabilityData[key];
          }
        }
        
        if (content) {
          return `<capability${attributes}>${content}</capability>`;
        } else {
          return `<capability${attributes} />`;
        }
      }
    } catch (error) {
      logger.debug('Failed to reconstruct capability XML:', error);
    }
    
    return null;
  }

  /**
   * Find capability tags in memory content for pattern extraction
   */
  findCapabilityTags(text: string): string[] {
    return this.extractCapabilityTagsWithXMLParser(text);
  }
}

// Export singleton instance
export const capabilityXMLParser = new CapabilityXMLParser();