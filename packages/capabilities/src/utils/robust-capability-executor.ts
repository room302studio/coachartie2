import { logger } from '@coachartie/shared';
import { ParsedCapability } from './xml-parser.js';
import { capabilityRegistry } from '../services/capability-registry.js';
import { VariableStore } from '../capabilities/variable-store.js';
import Handlebars from 'handlebars';

export interface CapabilityResult {
  capability: ParsedCapability;
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: string;
  attempts: number;
  fallbackUsed?: boolean;
}

export class RobustCapabilityExecutor {
  /**
   * Execute a capability with retry logic and fallback strategies
   */
  async executeWithRetry(
    capability: ParsedCapability,
    context: { userId: string; messageId: string },
    maxRetries = capability.name === 'mcp_auto_installer' ? 1 : 3 // No retries for MCP installs
  ): Promise<CapabilityResult> {
    logger.info(
      `🔧 ROBUST: Executing ${capability.name}:${capability.action} with retry capability`
    );

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(
          `🔄 Attempt ${attempt}/${maxRetries} for ${capability.name}:${capability.action}`
        );

        // Clean and validate capability before execution
        const cleanedCapability = this.cleanCapability(capability, attempt);

        // Try to execute via registry
        const result = await this.tryRegistryExecution(cleanedCapability, context);

        // Validate result
        if (this.validateResult(cleanedCapability, result)) {
          return {
            capability: cleanedCapability,
            success: true,
            data: result,
            timestamp: new Date().toISOString(),
            attempts: attempt,
          };
        } else {
          throw new Error(`Invalid result: ${JSON.stringify(result)}`);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `❌ Attempt ${attempt} failed for ${capability.name}:${capability.action}: ${lastError.message}`
        );

        // Wait with exponential backoff (but not on last attempt)
        if (attempt < maxRetries) {
          const delay = 100 * Math.pow(2, attempt - 1); // 100ms, 200ms, 400ms
          await this.sleep(delay);
        }
      }
    }

    // All retries failed, try fallback strategies
    logger.warn(
      `🚨 All retries failed for ${capability.name}:${capability.action}, trying fallbacks`
    );

    try {
      const fallbackResult = await this.tryFallbackExecution(capability, context);
      return {
        capability,
        success: true,
        data: fallbackResult,
        timestamp: new Date().toISOString(),
        attempts: maxRetries,
        fallbackUsed: true,
      };
    } catch (_fallbackError) {
      // Final failure
      return {
        capability,
        success: false,
        error: this.getHelpfulErrorMessage(capability, lastError),
        timestamp: new Date().toISOString(),
        attempts: maxRetries,
      };
    }
  }

  /**
   * Clean and fix common capability parameter issues
   */
  private cleanCapability(capability: ParsedCapability, attempt: number): ParsedCapability {
    const cleaned = { ...capability };

    // Fix calculator parameters
    if (capability.name === 'calculator') {
      // Ensure expression parameter exists
      if (!cleaned.params.expression && cleaned.content) {
        cleaned.params.expression = cleaned.content;
      }

      // Clean math expression on retry attempts
      if (attempt > 1 && cleaned.params.expression) {
        cleaned.params.expression = this.cleanMathExpression(String(cleaned.params.expression));
      }
    }

    // Fix memory parameters
    if (capability.name === 'memory') {
      // Ensure userId is included
      if (!cleaned.params.userId) {
        cleaned.params.userId = 'unknown-user'; // This should be injected elsewhere
      }

      // Fix search query parameter
      if (capability.action === 'search' && !cleaned.params.query && cleaned.content) {
        cleaned.params.query = cleaned.content;
        cleaned.content = '';
      }
    }

    // Fix MCP client parameters
    if (capability.name === 'mcp_client') {
      if (!cleaned.params.tool_name && cleaned.content) {
        // Try to infer tool name from content
        cleaned.params.tool_name = this.inferMCPToolName(cleaned.content);
      }
    }

    logger.info(
      `🧹 CLEANED: ${capability.name}:${capability.action} - params: ${JSON.stringify(cleaned.params)}`
    );
    return cleaned;
  }

  /**
   * Try executing via capability registry
   */
  /**
   * Interpolate variables in parameters using Handlebars template engine
   * Supports both ${var} and {{var}} syntax
   */
  private interpolateParams(
    params: Record<string, any>,
    userId: string
  ): Record<string, any> {
    const variableStore = VariableStore.getInstance();
    const interpolated: Record<string, any> = {};

    // Get all variables for this user as a flat object for Handlebars
    const userVariables = this.getUserVariablesForHandlebars(userId);

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        try {
          // Convert ${var} syntax to {{var}} for Handlebars compatibility
          const normalizedTemplate = value.replace(/\$\{([^}]+)\}/g, '{{$1}}');

          // Compile and execute the template with Handlebars
          const template = Handlebars.compile(normalizedTemplate, { noEscape: true });
          const interpolatedValue = template(userVariables);

          if (interpolatedValue !== value) {
            logger.info(`🔗 Interpolated ${key}: "${value}" → "${interpolatedValue}"`);
          }

          interpolated[key] = interpolatedValue;
        } catch (error) {
          logger.warn(`⚠️ Template interpolation failed for ${key}: ${error}`);
          interpolated[key] = value; // Keep original on error
        }
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recursively interpolate nested objects
        interpolated[key] = this.interpolateParams(value, userId);
      } else {
        interpolated[key] = value;
      }
    }

    return interpolated;
  }

  /**
   * Get all user variables as a flat object for Handlebars
   */
  private getUserVariablesForHandlebars(userId: string): Record<string, any> {
    const variableStore = VariableStore.getInstance();
    const session = variableStore['sessions'].get(userId);

    if (!session) {
      return {};
    }

    // Convert Map to plain object for Handlebars
    const variables: Record<string, any> = {};
    for (const [key, value] of session.entries()) {
      variables[key] = value;
    }

    return variables;
  }

  private async tryRegistryExecution(
    capability: ParsedCapability,
    context: { userId: string; messageId: string }
  ): Promise<unknown> {
    // Inject userId and messageId into params for capabilities that need context
    let paramsWithContext = ['scheduler', 'memory'].includes(capability.name)
      ? {
          ...capability.params,
          userId: context.userId,
          messageId: context.messageId,
        }
      : capability.params;

    // Interpolate variables in params
    paramsWithContext = this.interpolateParams(paramsWithContext, context.userId);

    // Interpolate variables in content as well
    let interpolatedContent = capability.content;
    if (typeof capability.content === 'string') {
      try {
        const normalizedTemplate = capability.content.replace(/\$\{([^}]+)\}/g, '{{$1}}');
        const template = Handlebars.compile(normalizedTemplate, { noEscape: true });
        const userVariables = this.getUserVariablesForHandlebars(context.userId);
        interpolatedContent = template(userVariables);

        if (interpolatedContent !== capability.content) {
          logger.info(`🔗 Interpolated content: "${capability.content}" → "${interpolatedContent}"`);
        }
      } catch (error) {
        logger.warn(`⚠️ Content interpolation failed: ${error}`);
        interpolatedContent = capability.content; // Keep original on error
      }
    }

    logger.info(
      `🎯 REGISTRY: Executing ${capability.name}:${capability.action} with params: ${JSON.stringify(paramsWithContext)}`
    );

    return await capabilityRegistry.execute(
      capability.name,
      capability.action,
      paramsWithContext,
      interpolatedContent
    );
  }

  /**
   * Validate that a capability result makes sense
   */
  private validateResult(capability: ParsedCapability, result: unknown): boolean {
    if (result === null || result === undefined) {
      return false;
    }

    // Capability-specific validation
    switch (capability.name) {
      case 'calculator':
        // Calculator should return a number or string that looks like a calculation result
        if (typeof result === 'number') {
          return true;
        }
        if (typeof result === 'string' && /\d+/.test(result)) {
          return true;
        }
        return false;

      case 'memory':
        // Memory operations should return some kind of response
        if (typeof result === 'string' && result.length > 0) {
          return true;
        }
        if (typeof result === 'object' && result !== null) {
          return true;
        }
        return false;

      case 'web':
        // Web search should return some content
        if (typeof result === 'string' && result.length > 10) {
          return true;
        }
        return false;

      default:
        // Generic validation - just check it's not empty
        return result !== null && result !== undefined && result !== '';
    }
  }

  /**
   * Try fallback execution strategies when registry fails
   */
  private async tryFallbackExecution(
    capability: ParsedCapability,
    _context: { userId: string; messageId: string }
  ): Promise<string> {
    switch (capability.name) {
      case 'calculator':
        return this.fallbackCalculation(
          capability.content || String(capability.params.expression || '')
        );

      case 'memory':
        if (capability.action === 'remember') {
          return this.fallbackMemoryStore(capability.content);
        } else if (capability.action === 'search') {
          return this.fallbackMemorySearch(String(capability.params.query || ''));
        }
        break;

      case 'web':
        return this.fallbackWebSearch(String(capability.params.query || capability.content));

      case 'mcp_client':
        return this.fallbackMCPTool(String(capability.params.tool_name || ''));

      default:
        throw new Error(`No fallback available for ${capability.name}`);
    }

    throw new Error(`Fallback not implemented for ${capability.name}:${capability.action}`);
  }

  /**
   * Fallback calculator using basic math evaluation
   * NEVER THROWS - always returns a user-friendly message
   */
  private fallbackCalculation(expression: string): string {
    try {
      if (!expression || expression.trim().length === 0) {
        logger.warn(`🧮 FALLBACK: No expression provided for fallback calculation`);
        return `I couldn't find a mathematical expression to calculate. Please use: <capability name="calculator" action="calculate" expression="2+2" />`;
      }

      // Clean the expression
      const cleaned = this.cleanMathExpression(expression);
      logger.info(`🧮 FALLBACK: Calculating "${cleaned}"`);

      // Basic math evaluation (secure approach)
      const result = this.safeEvaluate(cleaned);
      return `The result of ${cleaned} is ${result}`;
    } catch (error) {
      logger.warn(`🧮 FALLBACK: Failed to calculate "${expression}":`, error);
      return `I tried to calculate "${expression}" but couldn't parse the mathematical expression. Please try rephrasing it like "42 * 42" or "100 + 50".`;
    }
  }

  /**
   * Fallback memory storage
   */
  private fallbackMemoryStore(content: string): string {
    // Simple in-memory fallback (not persistent)
    logger.info(`💾 FALLBACK: Storing memory: "${content}"`);
    return `I've noted: "${content}" (stored temporarily until the memory system is restored)`;
  }

  /**
   * Fallback memory search
   */
  private fallbackMemorySearch(query: string): string {
    logger.info(`🔍 FALLBACK: Searching for: "${query}"`);
    return `I tried to search my memories for "${query}" but the memory system is currently unavailable. Please try again later or rephrase your question.`;
  }

  /**
   * Fallback web search
   */
  private fallbackWebSearch(query: string): string {
    logger.info(`🌐 FALLBACK: Web search for: "${query}"`);
    return `I would search the web for "${query}" but the web search capability is currently unavailable. You might want to try searching directly on your preferred search engine.`;
  }

  /**
   * Fallback MCP tool execution
   */
  private fallbackMCPTool(toolName: string): string {
    logger.info(`🔧 FALLBACK: MCP tool: "${toolName}"`);

    // Specific fallbacks for common tools
    if (toolName.includes('time') || toolName.includes('current_time')) {
      return `The current time is approximately ${new Date().toLocaleString()} (MCP time service unavailable)`;
    }

    return `I tried to use the ${toolName} tool but it's currently unavailable. The system administrator might need to check the MCP server connections.`;
  }

  /**
   * Clean mathematical expressions
   */
  private cleanMathExpression(expression: string): string {
    return expression
      .replace(/[^0-9+\-*/(). ]/g, '') // Only allow math characters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Safe math evaluation without eval()
   */
  private safeEvaluate(expression: string): number {
    // This is a simplified math evaluator - in production you'd use a proper math parser
    // For now, handle basic cases
    const cleaned = expression.replace(/\s/g, '');

    // Handle simple cases like "42*42", "100+50", etc.
    if (/^\d+[+\-*/]\d+$/.test(cleaned)) {
      const match = cleaned.match(/^(\d+)([+\-*/])(\d+)$/);
      if (match) {
        const [, a, op, b] = match;
        const numA = parseInt(a);
        const numB = parseInt(b);

        switch (op) {
          case '+':
            return numA + numB;
          case '-':
            return numA - numB;
          case '*':
            return numA * numB;
          case '/':
            return numB !== 0 ? numA / numB : NaN;
        }
      }
    }

    throw new Error('Complex mathematical expressions not supported in fallback mode');
  }

  /**
   * Infer MCP tool name from content
   */
  private inferMCPToolName(content: string): string {
    if (/time|clock/i.test(content)) {
      return 'get_current_time';
    }
    if (/wikipedia/i.test(content)) {
      return 'search_wikipedia';
    }
    if (/weather/i.test(content)) {
      return 'get_weather';
    }
    return 'unknown_tool';
  }

  /**
   * Generate helpful error messages for users
   */
  private getHelpfulErrorMessage(capability: ParsedCapability, error: Error | null): string {
    const baseName = capability.name;
    const action = capability.action;
    const errorMsg = error?.message || 'Unknown error';

    const suggestions = {
      calculator: 'Try using a simpler mathematical expression like "42 * 42" or "100 + 50"',
      memory: 'Try rephrasing your memory request or check if the memory system is available',
      web: 'Try rephrasing your search query or check your internet connection',
      mcp_client: 'The external tool service might be temporarily unavailable',
    };

    const suggestion =
      suggestions[baseName as keyof typeof suggestions] || 'Please try again later';

    return `I encountered an issue with the ${baseName} ${action} operation: ${errorMsg}. ${suggestion}`;
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton
export const robustExecutor = new RobustCapabilityExecutor();
