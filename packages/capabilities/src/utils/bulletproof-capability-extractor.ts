import { logger } from '@coachartie/shared';
import { ParsedCapability, CapabilityXMLParser } from './xml-parser.js';
import { XMLParser } from 'fast-xml-parser';

export class BulletproofCapabilityExtractor {
  private xmlParser: XMLParser;
  private capabilityParser: CapabilityXMLParser;

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
    this.capabilityParser = new CapabilityXMLParser();
  }

  /**
   * Extract XML capabilities with robust parsing for all models
   * Focuses on XML as the lingua franca - no NLP bullshit
   */
  extractCapabilities(text: string, modelName?: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    logger.info(`🔍 XML EXTRACTION: Parsing "${text.substring(0, 100)}..."`);
    
    // First try the existing capability parser
    const existingCapabilities = this.capabilityParser.extractCapabilities(text);
    if (existingCapabilities.length > 0) {
      logger.info(`✅ CAPABILITY PARSER: Found ${existingCapabilities.length} capabilities`);
      capabilities.push(...existingCapabilities);
    }
    
    // Try simple XML patterns for MCP-specific tags
    if (capabilities.length === 0) {
      const simpleXMLCapabilities = this.trySimpleXMLDetection(text);
      if (simpleXMLCapabilities.length > 0) {
        logger.info(`🏷️ SIMPLE XML: Found ${simpleXMLCapabilities.length} capabilities`);
        capabilities.push(...simpleXMLCapabilities);
      }
    }
    
    return capabilities;
  }
  
  /**
   * Simple XML Detection using proper XML parser
   */
  private trySimpleXMLDetection(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    try {
      // Parse as XML and look for our specific tags
      const wrappedText = `<root>${text}</root>`;
      const parsed = this.xmlParser.parse(wrappedText);
      
      if (parsed.root) {
        // Check for MCP installation tags
        this.checkForTag(parsed.root, 'mcp-auto-install', capabilities, 'mcp_auto_installer', 'install_npm');
        this.checkForTag(parsed.root, 'mcp-install', capabilities, 'mcp_auto_installer', 'install_npm');
        this.checkForTag(parsed.root, 'install-mcp', capabilities, 'mcp_auto_installer', 'install_npm');
        
        // Check for calculator tags
        this.checkForTag(parsed.root, 'calculate', capabilities, 'calculator', 'calculate');
        this.checkForTag(parsed.root, 'calc', capabilities, 'calculator', 'calculate');
        
        // Check for memory tags
        this.checkForTag(parsed.root, 'remember', capabilities, 'memory', 'remember');
        this.checkForTag(parsed.root, 'memory', capabilities, 'memory', 'remember');
      }
    } catch (error) {
      logger.debug('XML parsing failed, skipping simple detection:', error);
    }
    
    return capabilities;
  }
  
  /**
   * Helper to check for a specific tag in parsed XML
   */
  private checkForTag(
    obj: any, 
    tagName: string, 
    capabilities: ParsedCapability[], 
    capabilityName: string, 
    action: string
  ): void {
    if (obj[tagName]) {
      const content = typeof obj[tagName] === 'string' ? obj[tagName] : obj[tagName]['#text'] || '';
      const params = capabilityName === 'mcp_auto_installer' ? { package: content } : {};
      
      capabilities.push({
        name: capabilityName,
        action,
        content: capabilityName === 'mcp_auto_installer' ? '' : content,
        params
      });
      logger.info(`📦 XML: Detected ${tagName}: "${content}"`);
    }
  }

  /**
   * Detect auto-injection opportunities based on message content
   */
  detectAutoInjectCapabilities(userMessage: string, llmResponse: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // Look for math expressions in user message
    if (/\d+\s*[+\-*/]\s*\d+/.test(userMessage)) {
      capabilities.push({
        name: 'calculator',
        action: 'calculate', 
        content: userMessage.match(/\d+\s*[+\-*/]\s*\d+[^.]*/)![0],
        params: {}
      });
    }
    
    // Look for memory-related keywords
    if (/remember|memorize|note|save/.test(userMessage.toLowerCase())) {
      capabilities.push({
        name: 'memory',
        action: 'remember',
        content: userMessage,
        params: {}
      });
    }
    
    return capabilities;
  }
}

// Export singleton instance
export const bulletproofExtractor = new BulletproofCapabilityExtractor();