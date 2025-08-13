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
    
    // Debug: Check global registry at start of parsing
    if (global.mcpToolRegistry && global.mcpToolRegistry.size > 0) {
    }
    
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
          // If XML parsing fails completely, content stays empty
          content = '';
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
   * Extract simple capability tags using simple pattern matching
   * DELETE-DRIVEN: Remove complex XML parsing, use simple patterns
   */
  private extractSimpleCapabilityTags(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // DELETE complex XML parsing, use simple patterns that actually work
    const tagPatterns = [
      /<(search[-_]wikipedia)>([^<]+)<\/\1>/g,
      /<(get[-_]wikipedia[-_]article)>([^<]+)<\/\1>/g, 
      /<(get[-_]random[-_]wikipedia)\s*\/>/g,
      /<(calculate)>([^<]+)<\/\1>/g,
      /<(remember)>([^<]+)<\/\1>/g,
      /<(recall)>([^<]+)<\/\1>/g,
      /<(web[-_]search)>([^<]+)<\/\1>/g,
      /<(mcp[-_]auto[-_]install)>([^<]+)<\/\1>/g,
      /<(list[-_]departments)\s*\/>/g
    ];
    
    for (const pattern of tagPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const tagName = match[1];
        const content = match[2] || '';
        
        const capability = this.mapTagToCapability(tagName, {}, content);
        if (capability) {
          capabilities.push(capability);
        }
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
    
    // MCP auto-installation with corruption resistance
    if (tagName === 'mcp-auto-install' || tagName === 'mcp-install' || tagName === 'install-mcp') {
      // Extract package name from content, validate and sanitize
      const packageName = this.sanitizePackageName(content);
      if (packageName) {
        return {
          name: 'mcp_auto_installer',
          action: 'install_npm',
          params: { package: packageName },
          content: packageName
        };
      } else {
        return null;
      }
    }
    
    // Check for registered MCP tools first (prioritize MCP system)
    if (global.mcpToolRegistry && global.mcpToolRegistry.has(tagName)) {
      const mcpTool = global.mcpToolRegistry.get(tagName);
      if (mcpTool) {
        return {
          name: 'mcp_client',
          action: 'call_tool', 
          params: {
            connectionId: mcpTool.connectionId,
            tool_name: tagName,
            args: content ? { q: content, __intent: `Search for ${content}` } : params
          },
          content: ''
        };
      }
    }
    
    if (global.mcpToolRegistry && global.mcpToolRegistry.size > 0) {
    } else {
    }
    
    // MCP tools (kebab-case with multiple parts)
    if (tagName.includes('-')) {
      // Convert kebab-case to snake_case without regex
      let snakeToolName = '';
      for (let i = 0; i < tagName.length; i++) {
        if (tagName[i] === '-') {
          snakeToolName += '_';
        } else {
          snakeToolName += tagName[i];
        }
      }
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
      // If XML parsing fails, we don't extract anything rather than falling back to regex
    }
    
    return matches;
  }

  /**
   * Recursively find capability elements in parsed XML
   */
  private findCapabilityElementsRecursive(obj: any, originalText: string, matches: string[]): void {
    if (typeof obj !== 'object' || obj === null) {return;}
    
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
    }
    
    return null;
  }

  /**
   * Find capability tags in memory content for pattern extraction
   */
  findCapabilityTags(text: string): string[] {
    return this.extractCapabilityTagsWithXMLParser(text);
  }

  /**
   * Recursively find simple capability tags in parsed XML
   */
  private findSimpleCapabilityTagsRecursive(obj: any, capabilities: ParsedCapability[]): void {
    if (typeof obj !== 'object' || obj === null) {return;}
    
    // Check each property to see if it represents a simple capability tag
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const value = obj[key];
        
        // Skip special XML parser properties
        if (key.startsWith('@_') || key === '#text') {
          continue;
        }
        
        // Check if this could be a simple capability tag
        if (this.isSimpleCapabilityTag(key)) {
          // Extract attributes and content from the parsed object
          const params: Record<string, unknown> = {};
          let content = '';
          
          if (typeof value === 'string') {
            content = value;
          } else if (typeof value === 'object' && value !== null) {
            // Extract attributes (prefixed with @_)
            for (const attrKey in value) {
              if (attrKey.startsWith('@_')) {
                const paramName = attrKey.substring(2);
                params[paramName] = value[attrKey];
              } else if (attrKey === '#text') {
                content = value[attrKey] || '';
              }
            }
          }
          
          // Map to capability
          const capability = this.mapTagToCapability(key, params, content.trim());
          if (capability) {
            capabilities.push(capability);
          }
        }
        
        // Recursively search nested objects
        if (typeof value === 'object' && value !== null) {
          this.findSimpleCapabilityTagsRecursive(value, capabilities);
        }
      }
    }
  }

  /**
   * Sanitize and validate npm package names to prevent model corruption
   */
  private sanitizePackageName(input: string): string | null {
    if (!input || typeof input !== 'string') {
      return null;
    }

    // Remove any extra whitespace and newlines
    const cleaned = input.trim().replace(/\s+/g, '');
    
    // Valid npm package name patterns
    const npmPackagePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    
    // Check if it matches valid npm package format
    if (npmPackagePattern.test(cleaned)) {
      return cleaned;
    }

    // Try to extract package name from corrupted output
    // Look for patterns like "metmuseum-mcp" or "@shelm/wikipedia-mcp-server"
    const extractPatterns = [
      /(@?[a-z0-9-]+\/[a-z0-9-]+)/i,  // Scoped packages
      /([a-z][a-z0-9-]*mcp[a-z0-9-]*)/i,  // Packages with "mcp" in name
      /([a-z][a-z0-9-]{2,})/i  // General package-like strings
    ];

    for (const pattern of extractPatterns) {
      const match = cleaned.match(pattern);
      if (match && npmPackagePattern.test(match[1])) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Check if a tag name represents a simple capability
   */
  private isSimpleCapabilityTag(tagName: string): boolean {
    // Known simple capability tags
    const knownTags = [
      'remember', 'recall', 'search-memory', 'calculate', 'calc', 'web-search',
      'mcp-auto-install', 'mcp-install', 'install-mcp'
    ];
    
    if (knownTags.includes(tagName)) {
      return true;
    }
    
    // MCP tools (kebab-case with dashes) - use simple string checks instead of regex
    if (tagName.includes('-')) {
      // Check if it's a valid kebab-case pattern (letters and dashes only)
      let isValid = true;
      for (let i = 0; i < tagName.length; i++) {
        const char = tagName[i];
        if (!(char >= 'a' && char <= 'z') && char !== '-') {
          isValid = false;
          break;
        }
      }
      return isValid && !tagName.startsWith('-') && !tagName.endsWith('-');
    }
    
    return false;
  }
}

// Export singleton instance
export const capabilityXMLParser = new CapabilityXMLParser();