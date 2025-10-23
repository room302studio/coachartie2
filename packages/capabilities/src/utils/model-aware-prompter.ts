import { logger } from '@coachartie/shared';

export interface ModelCapabilities {
  supportsXML: boolean;
  prefersSimpleSyntax: boolean;
  needsExplicitExamples: boolean;
  maxComplexity: 'low' | 'medium' | 'high';
  isWeakModel: boolean;
}

export class ModelAwarePrompter {
  /**
   * Get model capabilities based on model name
   */
  getModelCapabilities(modelName: string): ModelCapabilities {
    const name = modelName.toLowerCase();

    // Free/weak models
    if (this.isWeakModel(name)) {
      return {
        supportsXML: false,
        prefersSimpleSyntax: true,
        needsExplicitExamples: true,
        maxComplexity: 'low',
        isWeakModel: true,
      };
    }

    // Strong models (Claude, GPT-4, etc.)
    if (this.isStrongModel(name)) {
      return {
        supportsXML: true,
        prefersSimpleSyntax: false,
        needsExplicitExamples: false,
        maxComplexity: 'high',
        isWeakModel: false,
      };
    }

    // Medium models (GPT-3.5, etc.)
    return {
      supportsXML: true,
      prefersSimpleSyntax: false,
      needsExplicitExamples: true,
      maxComplexity: 'medium',
      isWeakModel: false,
    };
  }

  /**
   * Generate capability instruction prompt based on model capabilities
   */
  generateCapabilityPrompt(modelName: string, basePrompt: string): string {
    // DEBUGGING: Force return basePrompt to test XML
    logger.info(`🎯 FORCED XML MODE: Returning original basePrompt for ${modelName}`);
    return basePrompt;
  }

  /**
   * Weak model prompt (Mistral 7B, Phi-3, Gemma, etc.)
   */
  private generateWeakModelPrompt(basePrompt: string): string {
    return `${basePrompt}

🚨 CRITICAL INSTRUCTIONS FOR CAPABILITIES 🚨

You can perform special actions using these EXACT formats only:

FOR MATH CALCULATIONS:
Write: **CALCULATE:** your_expression_here
Example: **CALCULATE:** 42 * 42

FOR REMEMBERING INFORMATION:
Write: **REMEMBER:** what_to_save
Example: **REMEMBER:** User likes pizza

FOR SEARCHING MEMORIES:
Write: **SEARCH:** what_to_find
Example: **SEARCH:** pizza preferences

FOR WEB SEARCHES:
Write: **WEB:** search_query
Example: **WEB:** Docker best practices

FOR CURRENT TIME:
Write: **TIME**

CRITICAL RULES:
- Use ONLY the formats above
- Do NOT use < or > symbols
- Do NOT use XML tags
- Do NOT use other formats
- The ** symbols are required
- Follow the examples exactly

If you need to do math, remember something, or search, use these formats.
If you don't use the exact format, the action won't work.`;
  }

  /**
   * Medium model prompt (GPT-3.5, etc.)
   */
  private generateMediumModelPrompt(basePrompt: string): string {
    return `${basePrompt}

CAPABILITY INSTRUCTIONS:

You can use special capabilities by using simple XML tags:

EXAMPLES:
- Math: <calculate>42 * 42</calculate>
- Memory: <remember>User likes pizza</remember>
- Search: <search>pizza preferences</search>
- Web: <web>Docker best practices</web>
- Time: <time/>

Keep the XML simple and follow the examples above.
Use the capability when the user needs calculation, memory, or search functionality.`;
  }

  /**
   * Strong model prompt (Claude, GPT-4, etc.)
   */
  private generateStrongModelPrompt(basePrompt: string): string {
    return `${basePrompt}

ADVANCED CAPABILITY SYSTEM:

You have access to powerful capabilities through XML syntax:

<capability name="calculator" action="calculate">mathematical_expression</capability>
<capability name="memory" action="remember">information_to_store</capability>
<capability name="memory" action="search" query="search_terms" />
<capability name="web" action="search" query="search_query" />
<capability name="mcp_client" action="call_tool" tool_name="get_current_time" />

You can also use simplified syntax:
- <calculate>expression</calculate>
- <remember>information</remember>
- <search>query</search>
- <get-current-time/>

Use capabilities when users need computation, memory, or external information.
You can chain multiple capabilities in a single response.`;
  }

  /**
   * Check if model is considered weak/free
   */
  private isWeakModel(modelName: string): boolean {
    const weakModels = [
      'mistral-7b',
      'mistral:7b',
      'phi-3',
      'phi-3-mini',
      'gemma',
      'gemma-2b',
      'gemma-7b',
      'llama-3.2',
      'qwen-7b',
      'code-llama',
      'neural-chat',
      'zephyr',
      'orca-mini',
      'vicuna',
      'alpaca',
    ];

    return (
      weakModels.some((weak) => modelName.includes(weak)) ||
      modelName.includes(':free') ||
      modelName.includes('free')
    );
  }

  /**
   * Check if model is considered strong
   */
  private isStrongModel(modelName: string): boolean {
    const strongModels = [
      'claude-3',
      'claude-3.5',
      'gpt-4',
      'gpt-4o',
      'gemini-pro',
      'gemini-1.5',
      'llama-3.1-70b',
      'llama-3.1-405b',
      'mixtral-8x22b',
      'command-r-plus',
    ];

    return strongModels.some((strong) => modelName.includes(strong));
  }

  /**
   * Generate error recovery prompt for failed capability extraction
   */
  generateRecoveryPrompt(
    originalMessage: string,
    modelName: string,
    missingCapability: { type: 'math' | 'memory' | 'search' | 'web' | 'time'; content: string }
  ): string {
    const capabilities = this.getModelCapabilities(modelName);

    if (capabilities.isWeakModel) {
      return this.generateWeakModelRecoveryPrompt(originalMessage, missingCapability);
    } else {
      return this.generateStrongModelRecoveryPrompt(originalMessage, missingCapability);
    }
  }

  /**
   * Recovery prompt for weak models
   */
  private generateWeakModelRecoveryPrompt(
    originalMessage: string,
    missing: { type: 'math' | 'memory' | 'search' | 'web' | 'time'; content: string }
  ): string {
    const formatExamples = {
      math: '**CALCULATE:** 42 * 42',
      memory: '**REMEMBER:** User likes pizza',
      search: '**SEARCH:** pizza preferences',
      web: '**WEB:** Docker tips',
      time: '**TIME**',
    };

    return `You received: "${originalMessage}"

This requires a ${missing.type} operation. Please respond again using this EXACT format:

${formatExamples[missing.type]}

Then provide your response. Use the exact format shown above.`;
  }

  /**
   * Recovery prompt for strong models
   */
  private generateStrongModelRecoveryPrompt(
    originalMessage: string,
    missing: { type: 'math' | 'memory' | 'search' | 'web' | 'time'; content: string }
  ): string {
    const examples = {
      math: '<calculate>42 * 42</calculate>',
      memory: '<remember>Important information</remember>',
      search: '<search>search terms</search>',
      web: '<web>search query</web>',
      time: '<get-current-time/>',
    };

    return `The user asked: "${originalMessage}"

This requires a ${missing.type} capability. Please include this capability in your response:

${examples[missing.type]}

Then provide a natural response incorporating the results.`;
  }

  /**
   * Detect what capabilities might be needed based on user message
   */
  detectNeededCapabilities(
    message: string
  ): Array<{ type: 'math' | 'memory' | 'search' | 'web' | 'time'; content: string }> {
    const needed: Array<{ type: 'math' | 'memory' | 'search' | 'web' | 'time'; content: string }> =
      [];

    // Math detection
    if (/\d+.*?[\+\-\*/].*?\d+|calculate|compute|math/.test(message)) {
      const mathMatch = message.match(/(\d+.*?[\+\-\*/].*?\d+)/);
      needed.push({ type: 'math', content: mathMatch?.[1] || 'mathematical expression' });
    }

    // Memory search detection
    if (
      /what do (?:i|you) (?:like|prefer|think)|my (?:preference|opinion)|do i like/.test(message)
    ) {
      const searchMatch = message.match(/(?:about|like|prefer)\s+(.+?)(?:\?|$)/);
      needed.push({ type: 'search', content: searchMatch?.[1] || 'user preferences' });
    }

    // Memory storage detection
    if (/remember|store|save|note/.test(message)) {
      const rememberMatch = message.match(/(?:remember|store|save|note)\s+(.+?)(?:\.|$)/);
      needed.push({ type: 'memory', content: rememberMatch?.[1] || 'information' });
    }

    // Time detection
    if (/what time|current time|time now/.test(message)) {
      needed.push({ type: 'time', content: 'current time' });
    }

    return needed;
  }
}

// Export singleton
export const modelAwarePrompter = new ModelAwarePrompter();
