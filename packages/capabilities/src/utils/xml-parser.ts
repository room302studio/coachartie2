import { XMLParser } from 'fast-xml-parser';
import { logger } from '@coachartie/shared';
import { capabilityRegistry } from '../services/capability-registry.js';

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
      cdataPropName: false,
    });
  }

  /**
   * Extract capability tags from text and parse them
   */
  extractCapabilities(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];

    // Debug: Check global registry at start of parsing
    if (global.mcpToolRegistry && global.mcpToolRegistry.size > 0) {
      // Registry is available for MCP tool execution
    }

    try {
      // UNIFIED EXTRACTION: Handle both attribute and content-based formats
      const unifiedCapabilities = this.extractUnifiedCapabilityTags(text);
      if (unifiedCapabilities.length > 0) {
        logger.info(
          `🎯 UNIFIED XML: Found ${unifiedCapabilities.length} capability tags: ${JSON.stringify(unifiedCapabilities.map((c) => `${c.name}:${c.action}`))}`
        );
        capabilities.push(...unifiedCapabilities);
      }
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
      Object.keys(cap).forEach((key) => {
        if (key.startsWith('@_') && key !== '@_name' && key !== '@_action') {
          const paramName = key.substring(2); // Remove "@_" prefix
          params[paramName] = cap[key];
          logger.info(`🔍 XML PARSER: Found param ${paramName} = ${JSON.stringify(cap[key])}`);
        }
      });

      // Special handling for 'data' attribute: parse as JSON and merge into params
      if (params.data && typeof params.data === 'string') {
        try {
          const parsedData = JSON.parse(params.data);
          logger.info(`🔍 XML PARSER: Parsed data attribute as JSON: ${JSON.stringify(parsedData)}`);
          // Merge parsed data into params (parsed data takes precedence)
          Object.assign(params, parsedData);
          // Remove the raw data string
          delete params.data;
        } catch (error) {
          logger.warn(`⚠️ XML PARSER: Failed to parse data attribute as JSON, keeping as string: ${params.data}`);
        }
      }

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
        } catch (_error) {
          // If XML parsing fails completely, content stays empty
          content = '';
        }
      }

      logger.info(
        `🔍 XML PARSER: Final parsed capability: name="${name}" action="${action}" params=${JSON.stringify(params)} content="${content}"`
      );

      return {
        name,
        action,
        content,
        params,
      };
    } catch (error) {
      logger.error(`Failed to parse capability XML: ${capabilityTag}`, error);
      return null;
    }
  }

  /**
   * Extract ALL capability tags using HYBRID format support
   * Handles:
   * 1. <capability name="X" action="Y" param="value" />
   * 2. <capability name="X" action="Y">content</capability>
   * 3. <action>content</action> (simplified syntax - "dumdumeasytowns")
   */
  private extractUnifiedCapabilityTags(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];

    // Extract attribute-based format first
    capabilities.push(...this.extractAttributeCapabilities(text));

    // Extract content-based format second
    capabilities.push(...this.extractContentCapabilities(text));

    // Extract simplified action tags third (e.g., <recall> instead of <capability name="memory" action="recall">)
    capabilities.push(...this.extractSimpleActionTags(text));

    return capabilities;
  }

  /**
   * Extract attribute-based capabilities: <capability name="X" action="Y" param="value" />
   */
  private extractAttributeCapabilities(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];

    // Match self-closing tags, handling quotes properly
    // This regex:
    // 1. Finds <capability
    // 2. Captures everything until /> (non-greedy to stop at first />)
    // 3. Handles nested quotes and > characters inside quoted strings
    const unifiedPattern = /<capability\s+([\s\S]+?)\s*\/>/g;

    let match;
    while ((match = unifiedPattern.exec(text)) !== null) {
      const attributeString = match[1];

      // Parse all attributes
      const attributes = this.parseAttributes(attributeString);

      if (attributes.name && attributes.action) {
        const { name, action, ...params } = attributes;

        // Convert specific content attributes to content field
        let content = '';
        if (params.content) {
          content = String(params.content);
          delete params.content;
        } else if (params.expression) {
          content = String(params.expression);
          delete params.expression;
        } else if (params.query) {
          content = String(params.query);
          delete params.query;
        } else if (params.data) {
          // Special handling for 'data' attribute - parse JSON into params
          try {
            const dataStr = String(params.data);
            logger.info(`🔍 XML PARSER: Attempting to parse data attribute: "${dataStr}"`);

            const parsedData = JSON.parse(dataStr);

            if (typeof parsedData !== 'object' || parsedData === null) {
              logger.warn(`⚠️ XML PARSER: Parsed data is not an object: ${typeof parsedData}`);
              content = dataStr;
              delete params.data;
            } else {
              // Merge parsed JSON data into params
              Object.assign(params, parsedData);
              delete params.data;
              logger.info(
                `✅ XML PARSER: Successfully parsed and merged data attribute: ${JSON.stringify(parsedData)}`
              );
              logger.info(`🔍 XML PARSER: Final params after merge: ${JSON.stringify(params)}`);
            }
          } catch (error) {
            // If JSON parsing fails, treat as content
            content = String(params.data);
            delete params.data;
            logger.warn(
              `⚠️ XML PARSER: Failed to parse data attribute as JSON, using as content. Error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        capabilities.push({
          name,
          action,
          content: content.trim(),
          params,
        });
      }
    }

    return capabilities;
  }

  /**
   * Parse XML attributes from attribute string
   */
  private parseAttributes(attributeString: string): Record<string, string> {
    const attributes: Record<string, string> = {};

    // Match attributes with proper quote handling:
    // - Double-quoted: attr="value" (value can't contain unescaped ")
    // - Single-quoted: attr='value' (value can contain " but not ')
    // Use separate patterns since we need to match the SAME quote type at start and end
    const doubleQuotePattern = /(\w+)="([^"]*)"/g;
    const singleQuotePattern = /(\w+)='([^']*)'/g;

    // First extract all double-quoted attributes
    let match;
    while ((match = doubleQuotePattern.exec(attributeString)) !== null) {
      attributes[match[1]] = match[2];
    }

    // Then extract all single-quoted attributes
    while ((match = singleQuotePattern.exec(attributeString)) !== null) {
      attributes[match[1]] = match[2];
    }

    return attributes;
  }

  /**
   * Extract content-based capabilities: <capability name="X" action="Y">content</capability>
   */
  private extractContentCapabilities(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];

    // Match content-based capability tags (with multi-line support)
    // Capture the full attribute string so we can parse ALL attributes, not just name/action
    const contentPattern = /<capability\s+([^>]+)>([\s\S]*?)<\/capability>/g;

    let match;
    while ((match = contentPattern.exec(text)) !== null) {
      const attributeString = match[1];
      const content = match[2].trim();

      // Parse all attributes from the opening tag
      const attributes = this.parseAttributes(attributeString);
      const name = attributes.name;
      const action = attributes.action;

      if (!name || !action) {
        logger.warn(`⚠️ Content capability missing name or action: ${attributeString}`);
        continue;
      }

      // Remove name and action from attributes since they're stored separately
      const { name: _, action: __, ...params } = attributes;

      logger.info(
        `🎯 CONTENT EXTRACTION: Found ${name}:${action} with params: ${JSON.stringify(params)} and content: "${content}"`
      );

      capabilities.push({
        name,
        action,
        content,
        params,
      });
    }

    return capabilities;
  }

  /**
   * Extract simplified action tags like <recall> instead of <capability name="memory" action="recall">
   * This makes capability syntax "dumdumeasytowns"
   */
  private extractSimpleActionTags(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];

    // Match any XML tags that aren't "capability" (both self-closing and with content)
    // Self-closing: <tagname attr="value" />
    // With content: <tagname attr="value">content</tagname>
    // Use [\s\S] instead of . to match newlines in content
    const simpleTagPattern = /<(\w+)([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/g;

    let match;
    while ((match = simpleTagPattern.exec(text)) !== null) {
      const tagName = match[1];
      const attributeString = match[2];
      const content = match[3] || '';

      // Skip the main capability tag and special tags
      if (tagName === 'capability' || tagName === 'wants_loop' || tagName === 'thinking') {
        continue;
      }

      // Check if this tag name is a registered action
      const capabilityName = capabilityRegistry.findCapabilityByAction(tagName);

      if (capabilityName) {
        // Parse attributes
        const params = this.parseAttributes(attributeString);

        logger.info(
          `🎯 SIMPLE ACTION TAG: Found <${tagName}> → maps to ${capabilityName}:${tagName}`
        );

        capabilities.push({
          name: capabilityName,
          action: tagName,
          content: content.trim(),
          params,
        });
      }
    }

    return capabilities;
  }

  /**
   * Map simple tag names to capability format - DELETED COMPLEX MAPPINGS
   */
  private mapTagToCapability(
    _tagName: string,
    _params: Record<string, unknown>,
    _content: string
  ): ParsedCapability | null {
    // DELETED - let the registry handle everything
    logger.warn(
      `Simple tag format not supported: ${_tagName}. Use: <capability name="..." action="..." />`
    );
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
    } catch (_error) {
      // If XML parsing fails, we don't extract anything rather than falling back to regex
    }

    return matches;
  }

  /**
   * Recursively find capability elements in parsed XML
   */
  private findCapabilityElementsRecursive(obj: any, originalText: string, matches: string[]): void {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }

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
      if (Object.prototype.hasOwnProperty.call(obj, key) && key !== 'capability') {
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
    } catch (_error) {}

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
    if (typeof obj !== 'object' || obj === null) {
      return;
    }

    // Check each property to see if it represents a simple capability tag
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
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

  // DELETED - sanitizePackageName method - not needed

  /**
   * Check if a tag name represents a simple capability - DELETED
   */
  private isSimpleCapabilityTag(_tagName: string): boolean {
    // DELETED - no more simple tags, force proper syntax
    return false;
  }
}

// Export singleton instance
export const capabilityXMLParser = new CapabilityXMLParser();
