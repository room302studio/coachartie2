import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * Intelligent Capability Suggester
 * 
 * Analyzes user queries and suggests relevant capabilities using:
 * - Keyword matching
 * - Intent analysis  
 * - Fuzzy search
 * - Context awareness
 * - Usage patterns
 */

interface CapabilitySuggestion {
  capability: string;
  action: string;
  confidence: number;
  reasoning: string;
  example: string;
  keywords: string[];
}

interface QueryAnalysis {
  intent: string;
  keywords: string[];
  entities: string[];
  actionWords: string[];
  domain: string;
}

/**
 * Keyword-to-capability mapping for intelligent suggestions
 */
const CAPABILITY_KEYWORDS = {
  calculator: {
    keywords: ['calculate', 'math', 'compute', 'equation', 'solve', 'add', 'subtract', 'multiply', 'divide', 'sum', 'total', 'average', 'percentage', 'formula', 'arithmetic'],
    actions: {
      calculate: ['calculate', 'compute', 'solve', 'equation', 'formula'],
      eval: ['evaluate', 'expression', 'result']
    }
  },
  web: {
    keywords: ['search', 'find', 'lookup', 'google', 'web', 'internet', 'online', 'browse', 'fetch', 'scrape', 'url', 'website', 'page'],
    actions: {
      search: ['search', 'find', 'lookup', 'google'],
      fetch: ['fetch', 'get', 'retrieve', 'download', 'scrape']
    }
  },
  weather: {
    keywords: ['weather', 'temperature', 'forecast', 'rain', 'snow', 'sunny', 'cloudy', 'humidity', 'wind', 'storm', 'climate', 'precipitation', 'degrees', 'celsius', 'fahrenheit'],
    actions: {
      current: ['current', 'now', 'today'],
      forecast: ['forecast', 'tomorrow', 'week', 'prediction'],
      alerts: ['alert', 'warning', 'emergency', 'severe']
    }
  },
  mcp_client: {
    keywords: ['mcp', 'connect', 'tool', 'external', 'server', 'list', 'available', 'call', 'model context protocol', 'disconnect', 'health', 'protocol', 'client'],
    actions: {
      connect: ['connect', 'connection', 'establish', 'link'],
      disconnect: ['disconnect', 'close', 'unlink', 'stop'],
      list_tools: ['list', 'tools', 'available', 'show', 'what'],
      call_tool: ['call', 'execute', 'run', 'use', 'invoke'],
      list_servers: ['servers', 'connected', 'show'],
      health_check: ['health', 'status', 'check', 'ping']
    }
  },
  mcp_installer: {
    keywords: ['install', 'setup', 'configure', 'add', 'create', 'build', 'deploy', 'template', 'mcp', 'server', 'service'],
    actions: {
      install_from_template: ['install', 'setup', 'template', 'from template'],
      create_custom_mcp: ['create', 'build', 'custom', 'new'],
      setup_environment: ['configure', 'environment', 'env', 'variables', 'settings'],
      start_mcp_server: ['start', 'run', 'launch', 'activate'],
      check_mcp_status: ['status', 'check', 'health', 'running']
    }
  },
  filesystem: {
    keywords: ['file', 'folder', 'directory', 'path', 'read', 'write', 'create', 'delete', 'save', 'load', 'exists', 'list'],
    actions: {
      read_file: ['read', 'open', 'load', 'view', 'show'],
      write_file: ['write', 'save', 'create', 'edit'],
      create_directory: ['create', 'mkdir', 'folder', 'directory'],
      list_directory: ['list', 'show', 'contents', 'files'],
      exists: ['exists', 'check', 'find'],
      delete: ['delete', 'remove', 'rm']
    }
  },
  memory: {
    keywords: ['remember', 'recall', 'memory', 'store', 'save', 'note', 'memorize', 'forget', 'retrieve'],
    actions: {
      remember: ['remember', 'store', 'save', 'note', 'memorize'],
      recall: ['recall', 'retrieve', 'remember', 'what', 'find']
    }
  },
  scheduler: {
    keywords: ['schedule', 'remind', 'later', 'time', 'alarm', 'notification', 'timer', 'delay', 'cron', 'task'],
    actions: {
      remind: ['remind', 'reminder', 'alert', 'notify'],
      schedule: ['schedule', 'recurring', 'repeat', 'cron'],
      list: ['list', 'show', 'tasks', 'scheduled'],
      cancel: ['cancel', 'remove', 'delete', 'stop']
    }
  },
  wolfram: {
    keywords: ['wolfram', 'complex', 'scientific', 'advanced', 'integral', 'derivative', 'equation', 'physics', 'chemistry', 'knowledge'],
    actions: {
      query: ['query', 'ask', 'calculate', 'solve'],
      search: ['search', 'find', 'lookup']
    }
  },
  package_manager: {
    keywords: ['npm', 'package', 'install', 'dependency', 'module', 'library', 'node', 'script'],
    actions: {
      install_package: ['install', 'add', 'dependency'],
      create_package: ['create', 'init', 'new package'],
      run_script: ['run', 'execute', 'script'],
      check_dependencies: ['check', 'dependencies', 'audit'],
      update_package_json: ['update', 'package.json', 'modify']
    }
  },
  environment: {
    keywords: ['environment', 'env', 'variable', 'config', 'setting', 'configuration'],
    actions: {
      read_env: ['read', 'get', 'show', 'env'],
      set_env: ['set', 'create', 'add', 'env'],
      create_env_file: ['create', 'file', '.env'],
      backup_env: ['backup', 'save', 'copy'],
      validate_env: ['validate', 'check', 'verify']
    }
  }
};

/**
 * Intent patterns for different types of requests
 */
const INTENT_PATTERNS = {
  calculate: /(?:calculate|compute|solve|math|equation|what\s+is|how\s+much)/i,
  search: /(?:search|find|lookup|google|show\s+me|what\s+about)/i,
  weather: /(?:weather|temperature|forecast|how\s+hot|how\s+cold|will\s+it\s+rain)/i,
  install: /(?:install|setup|add|create|build|deploy)/i,
  file_operation: /(?:read|write|save|load|file|folder|directory)/i,
  remember: /(?:remember|save|note|store|memorize)/i,
  recall: /(?:recall|what\s+did|remember|retrieve)/i,
  schedule: /(?:remind|schedule|later|timer|alarm)/i,
  status: /(?:status|check|health|running|working)/i,
  mcp_connect: /(?:connect.*mcp|mcp.*connect|connect.*server|link.*mcp|mcp.*client|use.*mcp)/i,
  mcp_tools: /(?:list.*tools|available.*tools|what.*tools|tools.*available|mcp.*tools|show.*tools)/i,
  mcp_servers: /(?:mcp.*servers|list.*servers|connected.*servers|show.*servers|mcp.*client)/i
};

export class CapabilitySuggester {
  private capabilities: RegisteredCapability[] = [];

  constructor(capabilities: RegisteredCapability[]) {
    this.capabilities = capabilities;
  }

  /**
   * Analyze user query and suggest relevant capabilities
   */
  suggestCapabilities(userQuery: string, maxSuggestions: number = 3): CapabilitySuggestion[] {
    const analysis = this.analyzeQuery(userQuery);
    const suggestions: CapabilitySuggestion[] = [];

    // Get keyword-based suggestions
    const keywordSuggestions = this.getKeywordSuggestions(analysis);
    suggestions.push(...keywordSuggestions);

    // Get intent-based suggestions
    const intentSuggestions = this.getIntentSuggestions(analysis);
    suggestions.push(...intentSuggestions);

    // Get fuzzy match suggestions
    const fuzzySuggestions = this.getFuzzySuggestions(analysis);
    suggestions.push(...fuzzySuggestions);

    // Deduplicate and sort by confidence
    const uniqueSuggestions = this.deduplicateAndRank(suggestions);

    return uniqueSuggestions.slice(0, maxSuggestions);
  }

  /**
   * Analyze the user query to extract intent, keywords, and entities
   */
  private analyzeQuery(query: string): QueryAnalysis {
    const lowerQuery = query.toLowerCase();
    const words = lowerQuery.split(/\s+/);
    
    // Extract action words (verbs that indicate what to do)
    const actionWords = words.filter(word => 
      /^(get|find|search|calculate|install|create|read|write|show|tell|help|check|start|stop|run|save|load|delete|remove|add|set|list|remember|recall|schedule|remind)/.test(word)
    );

    // Extract entities (nouns that indicate what to work with)
    const entities = words.filter(word =>
      /^(weather|temperature|file|folder|package|server|mcp|environment|memory|task|reminder|calculation|equation|result)/.test(word)
    );

    // Determine primary intent
    let intent = 'unknown';
    for (const [intentName, pattern] of Object.entries(INTENT_PATTERNS)) {
      if (pattern.test(query)) {
        intent = intentName;
        break;
      }
    }

    // Determine domain
    const domain = this.determineDomain(lowerQuery);

    return {
      intent,
      keywords: words,
      entities,
      actionWords,
      domain
    };
  }

  /**
   * Get suggestions based on keyword matching
   */
  private getKeywordSuggestions(analysis: QueryAnalysis): CapabilitySuggestion[] {
    const suggestions: CapabilitySuggestion[] = [];

    for (const [capabilityName, capabilityData] of Object.entries(CAPABILITY_KEYWORDS)) {
      // Check if this capability is available
      const registeredCapability = this.capabilities.find(cap => cap.name === capabilityName);
      if (!registeredCapability) {continue;}

      // Calculate keyword match score
      const matchingKeywords = capabilityData.keywords.filter(keyword =>
        analysis.keywords.some(queryWord => 
          queryWord.includes(keyword) || keyword.includes(queryWord)
        )
      );

      if (matchingKeywords.length > 0) {
        // Find best matching action
        let bestAction = registeredCapability.supportedActions[0];
        let bestActionScore = 0;

        for (const [actionName, actionKeywords] of Object.entries(capabilityData.actions)) {
          if (!registeredCapability.supportedActions.includes(actionName)) {continue;}

          const actionMatches = actionKeywords.filter(keyword =>
            analysis.keywords.some(queryWord => 
              queryWord.includes(keyword) || keyword.includes(queryWord)
            )
          );

          if (actionMatches.length > bestActionScore) {
            bestActionScore = actionMatches.length;
            bestAction = actionName;
          }
        }

        const confidence = Math.min(0.9, (matchingKeywords.length + bestActionScore) / 5);

        suggestions.push({
          capability: capabilityName,
          action: bestAction,
          confidence,
          reasoning: `Keyword matches: ${matchingKeywords.join(', ')}`,
          example: this.generateExample(capabilityName, bestAction, analysis),
          keywords: matchingKeywords
        });
      }
    }

    return suggestions;
  }

  /**
   * Get suggestions based on intent analysis
   */
  private getIntentSuggestions(analysis: QueryAnalysis): CapabilitySuggestion[] {
    const suggestions: CapabilitySuggestion[] = [];

    const intentMappings: Record<string, Array<{capability: string, action: string, confidence: number}>> = {
      calculate: [
        { capability: 'calculator', action: 'calculate', confidence: 0.9 },
        { capability: 'wolfram', action: 'query', confidence: 0.7 }
      ],
      search: [
        { capability: 'web', action: 'search', confidence: 0.9 },
        { capability: 'memory', action: 'recall', confidence: 0.6 }
      ],
      weather: [
        { capability: 'web', action: 'search', confidence: 0.8 } // Will suggest weather MCP when available
      ],
      install: [
        { capability: 'mcp_installer', action: 'install_from_template', confidence: 0.9 },
        { capability: 'package_manager', action: 'install_package', confidence: 0.7 }
      ],
      file_operation: [
        { capability: 'filesystem', action: 'read_file', confidence: 0.8 }
      ],
      remember: [
        { capability: 'memory', action: 'remember', confidence: 0.9 }
      ],
      recall: [
        { capability: 'memory', action: 'recall', confidence: 0.9 }
      ],
      schedule: [
        { capability: 'scheduler', action: 'remind', confidence: 0.9 }
      ],
      status: [
        { capability: 'mcp_installer', action: 'check_mcp_status', confidence: 0.8 }
      ],
      mcp_connect: [
        { capability: 'mcp_client', action: 'connect', confidence: 0.95 }
      ],
      mcp_tools: [
        { capability: 'mcp_client', action: 'list_tools', confidence: 0.95 }
      ],
      mcp_servers: [
        { capability: 'mcp_client', action: 'list_servers', confidence: 0.95 }
      ]
    };

    const mappings = intentMappings[analysis.intent];
    if (mappings) {
      for (const mapping of mappings) {
        const registeredCapability = this.capabilities.find(cap => cap.name === mapping.capability);
        if (registeredCapability && registeredCapability.supportedActions.includes(mapping.action)) {
          suggestions.push({
            capability: mapping.capability,
            action: mapping.action,
            confidence: mapping.confidence,
            reasoning: `Intent-based match for: ${analysis.intent}`,
            example: this.generateExample(mapping.capability, mapping.action, analysis),
            keywords: analysis.keywords
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Get suggestions using fuzzy matching
   */
  private getFuzzySuggestions(analysis: QueryAnalysis): CapabilitySuggestion[] {
    const suggestions: CapabilitySuggestion[] = [];

    for (const capability of this.capabilities) {
      // Fuzzy match capability name
      const nameScore = this.calculateFuzzyScore(analysis.keywords.join(' '), capability.name);
      
      // Fuzzy match actions
      for (const action of capability.supportedActions) {
        const actionScore = this.calculateFuzzyScore(analysis.keywords.join(' '), action);
        const combinedScore = Math.max(nameScore, actionScore);

        if (combinedScore > 0.3) {
          suggestions.push({
            capability: capability.name,
            action: action,
            confidence: combinedScore * 0.6, // Lower confidence for fuzzy matches
            reasoning: `Fuzzy match (score: ${combinedScore.toFixed(2)})`,
            example: this.generateExample(capability.name, action, analysis),
            keywords: analysis.keywords
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Calculate fuzzy similarity score between two strings
   */
  private calculateFuzzyScore(query: string, target: string): number {
    const queryLower = query.toLowerCase();
    const targetLower = target.toLowerCase();

    // Exact match
    if (queryLower === targetLower) {return 1.0;}

    // Substring match
    if (queryLower.includes(targetLower) || targetLower.includes(queryLower)) {return 0.8;}

    // Word-level matches
    const queryWords = queryLower.split(/[\s_-]+/);
    const targetWords = targetLower.split(/[\s_-]+/);
    
    let matches = 0;
    for (const qWord of queryWords) {
      for (const tWord of targetWords) {
        if (qWord === tWord) {matches += 1;}
        else if (qWord.includes(tWord) || tWord.includes(qWord)) {matches += 0.5;}
      }
    }

    return matches / Math.max(queryWords.length, targetWords.length);
  }

  /**
   * Generate contextual example for a capability/action
   */
  private generateExample(capability: string, action: string, analysis: QueryAnalysis): string {
    const examples: Record<string, Record<string, string>> = {
      calculator: {
        calculate: `<capability name="calculator" action="calculate">${this.extractMathExpression(analysis) || '2 + 2'}</capability>`,
        eval: `<capability name="calculator" action="eval">${this.extractMathExpression(analysis) || 'Math.sqrt(16)'}</capability>`
      },
      web: {
        search: `<capability name="web" action="search" query="${this.extractSearchQuery(analysis)}" />`,
        fetch: `<capability name="web" action="fetch" url="https://example.com" />`
      },
      mcp_client: {
        connect: `<capability name="mcp_client" action="connect" url="http://localhost:3005" name="weather_server" />`,
        disconnect: `<capability name="mcp_client" action="disconnect" connection_id="mcp_12345" />`,
        list_tools: `<capability name="mcp_client" action="list_tools" />`,
        call_tool: `<capability name="mcp_client" action="call_tool" connection_id="mcp_12345" tool_name="get_weather" args='{"location": "New York"}' />`,
        list_servers: `<capability name="mcp_client" action="list_servers" />`,
        health_check: `<capability name="mcp_client" action="health_check" />`
      },
      mcp_installer: {
        install_from_template: `<capability name="mcp_installer" action="install_from_template" template="weather_openmeteo" />`,
        create_custom_mcp: `<capability name="mcp_installer" action="create_custom_mcp" name="my_server" />`,
        check_mcp_status: `<capability name="mcp_installer" action="check_mcp_status" />`
      },
      memory: {
        remember: `<capability name="memory" action="remember">${this.extractMemoryContent(analysis)}</capability>`,
        recall: `<capability name="memory" action="recall">${this.extractRecallQuery(analysis)}</capability>`
      },
      scheduler: {
        remind: `<capability name="scheduler" action="remind" delay="60000" message="${this.extractReminderMessage(analysis)}" />`,
        schedule: `<capability name="scheduler" action="schedule" name="daily_task" cron="0 9 * * *" />`
      }
    };

    return examples[capability]?.[action] || `<capability name="${capability}" action="${action}" />`;
  }

  /**
   * Helper methods to extract context from queries
   */
  private extractMathExpression(analysis: QueryAnalysis): string {
    const query = analysis.keywords.join(' ');
    const mathPattern = /[\d\s+\-*/().]+/g;
    const matches = query.match(mathPattern);
    return matches ? matches.join(' ').trim() : '';
  }

  private extractSearchQuery(analysis: QueryAnalysis): string {
    // Remove common action words and return meaningful search terms
    const meaningfulWords = analysis.keywords.filter(word => 
      !['search', 'find', 'lookup', 'show', 'me', 'about', 'for'].includes(word)
    );
    return meaningfulWords.length > 0 ? meaningfulWords.join(' ') : 'search query';
  }

  private extractMemoryContent(analysis: QueryAnalysis): string {
    const meaningfulWords = analysis.keywords.filter(word =>
      !['remember', 'save', 'store', 'note'].includes(word)
    );
    return meaningfulWords.length > 0 ? meaningfulWords.join(' ') : 'important information';
  }

  private extractRecallQuery(analysis: QueryAnalysis): string {
    const meaningfulWords = analysis.keywords.filter(word =>
      !['recall', 'remember', 'what', 'did', 'retrieve'].includes(word)
    );
    return meaningfulWords.length > 0 ? meaningfulWords.join(' ') : 'previous information';
  }

  private extractReminderMessage(analysis: QueryAnalysis): string {
    const meaningfulWords = analysis.keywords.filter(word =>
      !['remind', 'me', 'to', 'about', 'later'].includes(word)
    );
    return meaningfulWords.length > 0 ? meaningfulWords.join(' ') : 'important task';
  }

  /**
   * Determine the domain/category of the query
   */
  private determineDomain(query: string): string {
    if (/weather|temperature|forecast/i.test(query)) {return 'weather';}
    if (/math|calculate|equation/i.test(query)) {return 'math';}
    if (/file|folder|directory/i.test(query)) {return 'filesystem';}
    if (/search|find|lookup/i.test(query)) {return 'search';}
    if (/install|setup|create/i.test(query)) {return 'installation';}
    if (/remember|recall|memory/i.test(query)) {return 'memory';}
    if (/schedule|remind|timer/i.test(query)) {return 'scheduling';}
    return 'general';
  }

  /**
   * Remove duplicates and rank suggestions by confidence
   */
  private deduplicateAndRank(suggestions: CapabilitySuggestion[]): CapabilitySuggestion[] {
    const seen = new Set<string>();
    const unique: CapabilitySuggestion[] = [];

    // Sort by confidence first
    suggestions.sort((a, b) => b.confidence - a.confidence);

    for (const suggestion of suggestions) {
      const key = `${suggestion.capability}:${suggestion.action}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(suggestion);
      }
    }

    return unique;
  }

  /**
   * Generate helpful suggestions prompt for LLM
   */
  generateSuggestionsPrompt(userQuery: string): string {
    const suggestions = this.suggestCapabilities(userQuery, 3);
    
    if (suggestions.length === 0) {
      return '';
    }

    const promptParts = [
      '🔧 **Capability Suggestions** (based on your query):',
      ''
    ];

    suggestions.forEach((suggestion, index) => {
      promptParts.push(`${index + 1}. **${suggestion.capability}:${suggestion.action}** (${Math.round(suggestion.confidence * 100)}% match)`);
      promptParts.push(`   💡 ${suggestion.reasoning}`);
      promptParts.push(`   📝 Example: \`${suggestion.example}\``);
      promptParts.push('');
    });

    promptParts.push('💭 Use these examples to accomplish your task!');

    return promptParts.join('\n');
  }
}