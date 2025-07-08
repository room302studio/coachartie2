import { logger } from '@coachartie/shared';
import { ParsedCapability } from './xml-parser.js';

export class BulletproofCapabilityExtractor {
  /**
   * Extract capabilities using multiple fallback strategies
   * Works even with the worst free models
   */
  extractCapabilities(text: string, modelName?: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    logger.info(`🔍 BULLETPROOF: Extracting capabilities from: "${text.substring(0, 100)}..."`);
    
    // Tier 1: Natural Language Detection (Always works)
    const naturalLanguageCapabilities = this.tryNaturalLanguageDetection(text);
    if (naturalLanguageCapabilities.length > 0) {
      logger.info(`🎯 TIER 1: Found ${naturalLanguageCapabilities.length} natural language capabilities`);
      capabilities.push(...naturalLanguageCapabilities);
    }
    
    // Tier 2: Markdown-Style Detection (Easy for any model)
    if (capabilities.length === 0) {
      const markdownCapabilities = this.tryMarkdownDetection(text);
      if (markdownCapabilities.length > 0) {
        logger.info(`📝 TIER 2: Found ${markdownCapabilities.length} markdown capabilities`);
        capabilities.push(...markdownCapabilities);
      }
    }
    
    // Tier 3: Simple XML Detection (Minimal syntax)
    if (capabilities.length === 0) {
      const simpleXMLCapabilities = this.trySimpleXMLDetection(text);
      if (simpleXMLCapabilities.length > 0) {
        logger.info(`🏷️ TIER 3: Found ${simpleXMLCapabilities.length} simple XML capabilities`);
        capabilities.push(...simpleXMLCapabilities);
      }
    }
    
    // Tier 4: Fuzzy Extraction (Even from broken XML)
    if (capabilities.length === 0) {
      const fuzzyCapabilities = this.tryFuzzyExtraction(text);
      if (fuzzyCapabilities.length > 0) {
        logger.info(`🔧 TIER 4: Found ${fuzzyCapabilities.length} fuzzy-extracted capabilities`);
        capabilities.push(...fuzzyCapabilities);
      }
    }
    
    return capabilities;
  }
  
  /**
   * Tier 1: Natural Language Detection
   * Detects capabilities from plain English
   */
  private tryNaturalLanguageDetection(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // Math detection with multiple patterns
    const mathPatterns = [
      /(?:calculate|compute|math|solve|what(?:'s|\s+is))\s+(\d+(?:\.\d+)?\s*[\+\-\*/\^]\s*\d+(?:\.\d+)?(?:\s*[\+\-\*/\^]\s*\d+(?:\.\d+)?)*)/i,
      /(\d+(?:\.\d+)?\s*[\+\-\*/\^]\s*\d+(?:\.\d+)?(?:\s*[\+\-\*/\^]\s*\d+(?:\.\d+)?)*)\s*[=\?]/,
      /(\d+\s*(?:times|multiplied by|plus|minus|divided by|[*+/\-])\s*\d+)/i
    ];
    
    for (const pattern of mathPatterns) {
      const match = text.match(pattern);
      if (match) {
        let expression = match[1] || match[0];
        // Clean up natural language
        expression = expression
          .replace(/times/gi, '*')
          .replace(/multiplied by/gi, '*')
          .replace(/plus/gi, '+')
          .replace(/minus/gi, '-')
          .replace(/divided by/gi, '/')
          .replace(/[=\?]/g, '')
          .trim();
          
        capabilities.push({
          name: 'calculator',
          action: 'calculate',
          content: expression,
          params: {}
        });
        logger.info(`🧮 NATURAL: Detected math expression: "${expression}"`);
        break;
      }
    }
    
    // Memory detection
    const memoryPatterns = [
      /(?:remember|store|save|note)\s+(?:that\s+)?["']?(.+?)["']?(?:\.|$)/i,
      /(?:i want to remember|please remember|don't forget)\s+(.+?)(?:\.|$)/i,
      /(?:store this|save this)\s*:\s*(.+?)(?:\.|$)/i
    ];
    
    for (const pattern of memoryPatterns) {
      const match = text.match(pattern);
      if (match) {
        const content = match[1].trim();
        capabilities.push({
          name: 'memory',
          action: 'remember',
          content,
          params: {}
        });
        logger.info(`💾 NATURAL: Detected memory storage: "${content}"`);
        break;
      }
    }
    
    // Search/recall detection
    const searchPatterns = [
      /(?:search|find|look up|recall|what do (?:i|you) (?:know|remember))\s+(?:for\s+)?["']?(.+?)["']?(?:\?|\.|$)/i,
      /(?:do i like|what's my opinion on|tell me about)\s+(.+?)(?:\?|\.|$)/i,
      /(?:my (?:preferences?|thoughts?) (?:on|about))\s+(.+?)(?:\?|\.|$)/i
    ];
    
    for (const pattern of searchPatterns) {
      const match = text.match(pattern);
      if (match) {
        const query = match[1].trim();
        capabilities.push({
          name: 'memory',
          action: 'search',
          content: '',
          params: { query }
        });
        logger.info(`🔍 NATURAL: Detected memory search: "${query}"`);
        break;
      }
    }
    
    // Time detection
    if (/(?:what time|current time|time now|what's the time)/i.test(text)) {
      capabilities.push({
        name: 'mcp_client',
        action: 'call_tool',
        content: '',
        params: { tool_name: 'get_current_time' }
      });
      logger.info(`🕐 NATURAL: Detected time request`);
    }
    
    return capabilities;
  }
  
  /**
   * Tier 2: Markdown-Style Detection
   * Much easier for models than XML
   */
  private tryMarkdownDetection(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    const markdownPatterns = [
      { pattern: /\*\*CALCULATE:\*\*\s*(.+?)(?:\n|$)/i, capability: 'calculator', action: 'calculate' },
      { pattern: /\*\*REMEMBER:\*\*\s*(.+?)(?:\n|$)/i, capability: 'memory', action: 'remember' },
      { pattern: /\*\*SEARCH:\*\*\s*(.+?)(?:\n|$)/i, capability: 'memory', action: 'search' },
      { pattern: /\*\*WEB:\*\*\s*(.+?)(?:\n|$)/i, capability: 'web', action: 'search' },
      { pattern: /\*\*TIME\*\*/i, capability: 'mcp_client', action: 'call_tool' }
    ];
    
    for (const { pattern, capability, action } of markdownPatterns) {
      const match = text.match(pattern);
      if (match) {
        const content = match[1]?.trim() || '';
        
        if (capability === 'memory' && action === 'search') {
          capabilities.push({
            name: capability,
            action,
            content: '',
            params: { query: content }
          });
        } else if (capability === 'mcp_client') {
          capabilities.push({
            name: capability,
            action,
            content: '',
            params: { tool_name: 'get_current_time' }
          });
        } else {
          capabilities.push({
            name: capability,
            action,
            content,
            params: {}
          });
        }
        
        logger.info(`📝 MARKDOWN: Detected ${capability}:${action} with content: "${content}"`);
      }
    }
    
    return capabilities;
  }
  
  /**
   * Tier 3: Simple XML Detection
   * Minimal XML that's easier to generate
   */
  private trySimpleXMLDetection(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    const simpleXMLPatterns = [
      { pattern: /<calc[^>]*>([^<]+)<\/calc>/gi, capability: 'calculator', action: 'calculate' },
      { pattern: /<calculate[^>]*>([^<]+)<\/calculate>/gi, capability: 'calculator', action: 'calculate' },
      { pattern: /<remember[^>]*>([^<]+)<\/remember>/gi, capability: 'memory', action: 'remember' },
      { pattern: /<search[^>]*>([^<]+)<\/search>/gi, capability: 'memory', action: 'search' },
      { pattern: /<web[^>]*>([^<]+)<\/web>/gi, capability: 'web', action: 'search' },
      { pattern: /<time\s*\/?>|<get-time\s*\/?>/gi, capability: 'mcp_client', action: 'call_tool' }
    ];
    
    for (const { pattern, capability, action } of simpleXMLPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const content = match[1]?.trim() || '';
        
        if (capability === 'memory' && action === 'search') {
          capabilities.push({
            name: capability,
            action,
            content: '',
            params: { query: content }
          });
        } else if (capability === 'mcp_client') {
          capabilities.push({
            name: capability,
            action,
            content: '',
            params: { tool_name: 'get_current_time' }
          });
        } else {
          capabilities.push({
            name: capability,
            action,
            content,
            params: {}
          });
        }
        
        logger.info(`🏷️ SIMPLE XML: Detected ${capability}:${action} with content: "${content}"`);
      }
    }
    
    return capabilities;
  }
  
  /**
   * Tier 4: Fuzzy Extraction
   * Extract capabilities even from broken/malformed XML
   */
  private tryFuzzyExtraction(text: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // Look for capability-like patterns even if malformed
    const fuzzyPatterns = [
      { pattern: /<capability[^>]*calculator[^>]*>([^<]+)/i, capability: 'calculator', action: 'calculate' },
      { pattern: /<capability[^>]*memory[^>]*remember[^>]*>([^<]+)/i, capability: 'memory', action: 'remember' },
      { pattern: /<capability[^>]*memory[^>]*search[^>]*>([^<]+)/i, capability: 'memory', action: 'search' },
      { pattern: /capability.*?calculator.*?(?:calculate)?[\"\']*([^\"\'\\n]+)/i, capability: 'calculator', action: 'calculate' },
      { pattern: /capability.*?memory.*?remember.*?[\"\']*([^\"\'\\n]+)/i, capability: 'memory', action: 'remember' }
    ];
    
    for (const { pattern, capability, action } of fuzzyPatterns) {
      const match = text.match(pattern);
      if (match) {
        const content = match[1]?.trim() || '';
        
        if (capability === 'memory' && action === 'search') {
          capabilities.push({
            name: capability,
            action,
            content: '',
            params: { query: content }
          });
        } else {
          capabilities.push({
            name: capability,
            action,
            content,
            params: {}
          });
        }
        
        logger.info(`🔧 FUZZY: Extracted ${capability}:${action} from malformed input: "${content}"`);
      }
    }
    
    return capabilities;
  }
  
  /**
   * Auto-inject capabilities based on context analysis
   */
  detectAutoInjectCapabilities(userMessage: string, llmResponse: string): ParsedCapability[] {
    const capabilities: ParsedCapability[] = [];
    
    // Enhanced math detection
    const combinedText = `${userMessage} ${llmResponse}`;
    
    // Look for math in user message + LLM discussing math
    if (this.containsMathContext(userMessage) && this.llmDiscussesMath(llmResponse)) {
      const expression = this.extractMathFromContext(userMessage, llmResponse);
      if (expression) {
        capabilities.push({
          name: 'calculator',
          action: 'calculate',
          content: expression,
          params: {}
        });
        logger.info(`🎯 AUTO-INJECT: Math detected - "${expression}"`);
      }
    }
    
    // Memory search auto-injection
    if (this.isMemoryQuery(userMessage) && !this.llmProvidesSpecificInfo(llmResponse)) {
      const searchTerms = this.extractMemorySearchTerms(userMessage);
      if (searchTerms) {
        capabilities.push({
          name: 'memory',
          action: 'search',
          content: '',
          params: { query: searchTerms }
        });
        logger.info(`🧠 AUTO-INJECT: Memory search - "${searchTerms}"`);
      }
    }
    
    return capabilities;
  }
  
  // Helper methods for auto-injection
  private containsMathContext(text: string): boolean {
    return /\d+.*?[\+\-\*/].*?\d+|calculate|compute|math|equals|result|times|plus|minus|divided/i.test(text);
  }
  
  private llmDiscussesMath(text: string): boolean {
    return /calculate|computation|result|equals|multiply|add|subtract|divide/i.test(text);
  }
  
  private extractMathFromContext(userMsg: string, llmResponse: string): string | null {
    // Try to extract mathematical expressions from context
    const mathPatterns = [
      /(\d+(?:\.\d+)?\s*[\+\-\*/\^]\s*\d+(?:\.\d+)?)/g,
      /(\d+\s*(?:times|plus|minus|divided by)\s*\d+)/gi
    ];
    
    for (const pattern of mathPatterns) {
      const match = userMsg.match(pattern) || llmResponse.match(pattern);
      if (match) {
        return match[1].replace(/times/gi, '*').replace(/plus/gi, '+').replace(/minus/gi, '-').replace(/divided by/gi, '/');
      }
    }
    return null;
  }
  
  private isMemoryQuery(text: string): boolean {
    return /what do (?:i|you) (?:like|prefer|think|remember)|my (?:preference|opinion|thought)|do i like|tell me about my/i.test(text);
  }
  
  private llmProvidesSpecificInfo(text: string): boolean {
    // Check if LLM is giving specific stored information vs generic responses
    return /you (?:like|prefer|mentioned|told me)|i remember|based on what you said/i.test(text);
  }
  
  private extractMemorySearchTerms(text: string): string | null {
    const patterns = [
      /(?:what do (?:i|you) (?:like|prefer|think) about|my (?:preference|opinion) on)\s+(.+?)(?:\?|$)/i,
      /(?:do i like|tell me about my)\s+(.+?)(?:\?|$)/i,
      /(?:my thoughts? on|what's my opinion about)\s+(.+?)(?:\?|$)/i
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }
}

// Export singleton
export const bulletproofExtractor = new BulletproofCapabilityExtractor();