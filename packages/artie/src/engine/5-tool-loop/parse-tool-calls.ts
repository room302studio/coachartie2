import { logger, IncomingMessage } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';
import { capabilityRegistry, AUTO_INJECTED_PARAMS } from './capability-registry.js';
import { capabilityXMLParser } from '../../utils/xml-parser.js';
import { conscienceLLM } from '../monitoring/conscience.js';
import { ExtractedCapability, OrchestrationContext } from '../../types/orchestration-types.js';

// =====================================================
// CAPABILITY PARSER SERVICE
// Handles capability extraction, validation, and error generation
// =====================================================

export class CapabilityParser {
  private static instance: CapabilityParser;

  static getInstance(): CapabilityParser {
    if (!CapabilityParser.instance) {
      CapabilityParser.instance = new CapabilityParser();
    }
    return CapabilityParser.instance;
  }

  /**
   * Extract capabilities from response text using XML parser
   * Converts parsed capabilities to ExtractedCapability format with priority
   */
  extractCapabilities(response: string, _modelName?: string): ExtractedCapability[] {
    try {
      // Parse capabilities via XML parser
      const parsedCapabilities = capabilityXMLParser.extractCapabilities(response);

      // Convert to ExtractedCapability format with priority
      const capabilities = parsedCapabilities.map((cap, index) => {
        logger.info(
          `🔍 MAPPING DEBUG: cap.name=${cap.name}, cap.params=${JSON.stringify(cap.params)}, cap.content="${cap.content}"`
        );
        return {
          name: cap.name,
          action: cap.action,
          params: cap.params,
          content: cap.content,
          priority: index,
        };
      });

      logger.info(`Extracted ${capabilities.length} capabilities from response via XML parser`);
      return capabilities;
    } catch (error) {
      logger.error('Error extracting capabilities:', error);
      return [];
    }
  }

  // Simple syntax shortcuts for common capabilities
  private static readonly SIMPLE_SHORTCUTS: Record<string, string> = {
    'filesystem:read_file': '<read>path/to/file</read>',
    'filesystem:write_file': '<write path="file">content</write>',
    'memory:recall': '<recall>query</recall>',
    'memory:store': '<remember>fact to store</remember>',
    'web:search': '<websearch>query</websearch>',
    'web:fetch': '<fetch>url</fetch>',
    'calculator:calculate': '<calc>2+2</calc>',
    'scrapbook:search': '<search>query</search>',
  };

  private getSimpleSyntax(name: string, action: string): string | null {
    return CapabilityParser.SIMPLE_SHORTCUTS[`${name}:${action}`] || null;
  }

  generateHelpfulErrorMessage(capability: ExtractedCapability, originalError: string): string {
    const { name, action } = capability;

    // Check if the capability exists
    if (!capabilityRegistry.has(name)) {
      const availableCapabilities = capabilityRegistry.list().map((cap) => cap.name);
      const suggestions = this.findSimilarCapabilities(name, availableCapabilities);

      return `❌ Capability '${name}' not found. Try simple shortcuts: <read>path</read>, <recall>query</recall>, <websearch>query</websearch>. Did you mean: ${suggestions.join(' or ')}?`;
    }

    // Check if the action is supported
    const registryCapability = capabilityRegistry.list().find((cap) => cap.name === name);
    if (registryCapability && !registryCapability.supportedActions.includes(action)) {
      const supportedActions = registryCapability.supportedActions.join(', ');
      const suggestions = this.findSimilarActions(action, registryCapability.supportedActions);

      return `❌ Capability '${name}' does not support action '${action}'. Supported actions: ${supportedActions}. Did you mean: ${suggestions.join(' or ')}?`;
    }

    // Check for missing required parameters
    if (registryCapability?.requiredParams?.length) {
      const missingParams = registryCapability.requiredParams.filter(
        (param) =>
          !AUTO_INJECTED_PARAMS.has(param) && !capability.params[param] && !capability.content
      );

      if (missingParams.length > 0) {
        const simpleSyntax = this.getSimpleSyntax(name, action);
        if (simpleSyntax) {
          return `❌ Missing required parameters for '${name}:${action}': ${missingParams.join(', ')}. Try: ${simpleSyntax}`;
        }
        return `❌ Missing required parameters for '${name}:${action}': ${missingParams.join(', ')}. Required: ${missingParams.join(', ')}`;
      }
    }

    // Return enhanced original error with context - prefer simple syntax
    const simpleSyntax = this.getSimpleSyntax(name, action);
    if (simpleSyntax) {
      return `❌ ${originalError}. Try: ${simpleSyntax}`;
    }
    return `❌ ${originalError}. For '${name}' capability, use action: ${registryCapability?.supportedActions[0] || action}`;
  }

  /**
   * Find similar capability names using string similarity
   * Returns top 2 most similar capabilities with score > 0.5
   */
  findSimilarCapabilities(target: string, available: string[]): string[] {
    return available
      .map((name) => ({ name, score: this.calculateSimilarity(target, name) }))
      .filter((item) => item.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.name);
  }

  /**
   * Find similar action names using string similarity
   * Returns top 2 most similar actions with score > 0.4
   */
  findSimilarActions(target: string, available: string[]): string[] {
    return available
      .map((action) => ({ action, score: this.calculateSimilarity(target, action) }))
      .filter((item) => item.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.action);
  }

  /**
   * Simple string similarity calculation (Jaro-Winkler inspired)
   * Checks exact match, substrings, and common prefixes
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) {
      return 1.0;
    }
    if (a.length === 0 || b.length === 0) {
      return 0.0;
    }

    // Check for substring matches
    if (a.includes(b) || b.includes(a)) {
      return 0.8;
    }

    // Check for common substrings
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    if (aLower.includes(bLower) || bLower.includes(aLower)) {
      return 0.7;
    }

    // Check for similar starting characters
    let matchingChars = 0;
    const minLength = Math.min(a.length, b.length);

    for (let i = 0; i < minLength; i++) {
      if (aLower[i] === bLower[i]) {
        matchingChars++;
      } else {
        break;
      }
    }

    return matchingChars / Math.max(a.length, b.length);
  }
}

export const capabilityParser = CapabilityParser.getInstance();
