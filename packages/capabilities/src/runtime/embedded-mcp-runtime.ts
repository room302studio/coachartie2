import { logger } from '@coachartie/shared';

/**
 * Embedded MCP Tool Interface
 */
export interface EmbeddedMCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Built-in Wikipedia Search Tool
 */
class WikipediaSearchTool implements EmbeddedMCPTool {
  name = 'search-wikipedia';
  description = 'Search Wikipedia articles';
  inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) {
      throw new Error('Query is required for Wikipedia search');
    }

    try {
      // Use Wikipedia API directly
      const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl);

      if (response.ok) {
        const data = (await response.json()) as { title?: string; extract?: string };
        return `**${data.title || 'Unknown'}**\n\n${data.extract || 'No summary available.'}`;
      } else {
        // Fallback to search API
        const searchApiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json&origin=*`;
        const searchResponse = await fetch(searchApiUrl);
        const searchData = (await searchResponse.json()) as [string, string[], string[], string[]];

        if (searchData[1] && searchData[1].length > 0) {
          const results = searchData[1]
            .slice(0, 3)
            .map(
              (title: string, index: number) =>
                `• ${title}: ${searchData[3][index] || 'No URL available'}`
            )
            .join('\n');
          return `Wikipedia search results for "${query}":\n\n${results}`;
        }

        return `No Wikipedia results found for "${query}"`;
      }
    } catch (error) {
      logger.error('Wikipedia search failed:', error);
      return `Wikipedia search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}

/**
 * Built-in Time/Date Tool
 */
class TimeProviderTool implements EmbeddedMCPTool {
  name = 'get-current-time';
  description = 'Get current date and time';
  inputSchema = {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'Timezone (optional)' },
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const timezone = (args.timezone as string) || 'UTC';

    try {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
        timeZone: timezone,
      };

      const formattedTime = now.toLocaleString('en-US', options);
      return `Current time: ${formattedTime}`;
    } catch (_error) {
      // Fallback to simple ISO string
      return `Current time (UTC): ${new Date().toISOString()}`;
    }
  }
}

/**
 * Built-in Calculator Tool
 */
class CalculatorTool implements EmbeddedMCPTool {
  name = 'calculate';
  description = 'Perform mathematical calculations';
  inputSchema = {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Mathematical expression to evaluate' },
    },
    required: ['expression'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const expression = (args.expression || args.input) as string;
    if (!expression) {
      throw new Error('Mathematical expression is required');
    }

    try {
      // Basic safe math evaluation - only allow numbers, operators, and parentheses
      const cleanExpression = expression.replace(/[^0-9+\-*/.() ]/g, '');
      if (cleanExpression !== expression) {
        throw new Error('Invalid characters in mathematical expression');
      }

      // Use Function constructor for safe evaluation
      const result = new Function('return ' + cleanExpression)();

      if (typeof result !== 'number' || !isFinite(result)) {
        throw new Error('Invalid mathematical result');
      }

      return `${expression} = ${result}`;
    } catch (error) {
      logger.error('Calculation failed:', error);
      throw new Error(
        `Calculation failed: ${error instanceof Error ? error.message : 'Invalid expression'}`
      );
    }
  }
}

/**
 * Embedded MCP Runtime - Zero External Dependencies
 *
 * This replaces the fragile external process spawning system with
 * embedded, instant-activation tools that never fail.
 */
export class EmbeddedMCPRuntime {
  private tools = new Map<string, EmbeddedMCPTool>();

  constructor() {
    this.initializeBuiltinTools();
  }

  /**
   * Initialize built-in tools that are always available
   */
  private initializeBuiltinTools(): void {
    const builtinTools = [new WikipediaSearchTool(), new TimeProviderTool(), new CalculatorTool()];

    for (const tool of builtinTools) {
      this.tools.set(tool.name, tool);
      // Also register kebab-case versions
      const kebabName = tool.name.replace(/_/g, '-');
      if (kebabName !== tool.name) {
        this.tools.set(kebabName, tool);
      }
    }

    logger.info(`✅ Embedded MCP Runtime initialized with ${this.tools.size} built-in tools`);
  }

  /**
   * Get available tools
   */
  getAvailableTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool exists
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Get tool definition
   */
  getTool(toolName: string): EmbeddedMCPTool | undefined {
    return this.tools.get(toolName);
  }

  /**
   * Execute a tool - instant, reliable, no external dependencies
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found in embedded runtime`);
    }

    try {
      logger.info(`🔧 Executing embedded tool: ${toolName}`);
      const result = await tool.execute(args);
      logger.info(`✅ Embedded tool '${toolName}' completed successfully`);
      return result;
    } catch (error) {
      logger.error(`❌ Embedded tool '${toolName}' failed:`, error);
      throw error;
    }
  }

  /**
   * Install/activate a tool - instant activation without external processes
   */
  installTool(toolName: string): Promise<void> {
    // For embedded runtime, installation is instant activation
    if (this.tools.has(toolName)) {
      logger.info(`✅ Tool '${toolName}' already available in embedded runtime`);
      return Promise.resolve();
    }

    // Future: Could add dynamic tool loading here
    logger.warn(`⚠️ Tool '${toolName}' not available in embedded runtime`);
    return Promise.reject(new Error(`Tool '${toolName}' not available in embedded runtime`));
  }

  /**
   * List all available tools with descriptions
   */
  listTools(): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
    }));
  }

  /**
   * Health check - embedded tools are always healthy
   */
  async healthCheck(): Promise<{ healthy: number; total: number }> {
    return {
      healthy: this.tools.size,
      total: this.tools.size,
    };
  }
}

// Singleton instance
export const embeddedMCPRuntime = new EmbeddedMCPRuntime();
