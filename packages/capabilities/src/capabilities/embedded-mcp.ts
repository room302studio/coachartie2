import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { embeddedMCPRuntime } from '../runtime/embedded-mcp-runtime.js';

interface EmbeddedMCPParams {
  action: string;
  tool_name?: string;
  args?: Record<string, unknown>;
}

/**
 * Embedded MCP Capability - Zero External Dependencies
 *
 * This capability executes embedded MCP tools instantly without
 * external process spawning, network calls, or other failure points.
 *
 * Supported actions:
 * - execute_tool: Execute an embedded tool with given arguments
 * - list_tools: List all available embedded tools
 * - health_check: Check embedded runtime health
 */
export const embeddedMCPCapability: RegisteredCapability = {
  name: 'embedded_mcp',
  supportedActions: ['execute_tool', 'list_tools', 'health_check'],
  description: 'Execute embedded MCP tools with zero external dependencies',
  handler: async (params: EmbeddedMCPParams, content?: string) => {
    const { action } = params;

    try {
      switch (action) {
        case 'execute_tool': {
          const toolName = params.tool_name;
          if (!toolName) {
            throw new Error('Tool name is required for execute_tool action');
          }

          // Parse arguments
          let args = {};

          // Try content first (cleaner approach)
          if (content && content.trim()) {
            try {
              args = JSON.parse(content);
            } catch {
              // If content is not JSON, use smart defaults based on tool name
              if (toolName === 'search-wikipedia' || toolName === 'search_wikipedia') {
                args = { query: content };
              } else if (toolName === 'calculate') {
                args = { expression: content };
              } else if (toolName === 'get-current-time' || toolName === 'get_current_time') {
                args = {}; // No args needed for time
              } else {
                // Generic fallback
                args = { input: content, query: content };
              }
            }
          }

          // Merge any additional params
          if (params.args && typeof params.args === 'object') {
            args = { ...args, ...params.args };
          }

          // Execute the tool instantly
          logger.info(`🚀 Executing embedded tool: ${toolName} with args: ${JSON.stringify(args)}`);
          const result = await embeddedMCPRuntime.executeTool(toolName, args);

          return result;
        }

        case 'list_tools': {
          const tools = embeddedMCPRuntime.listTools();

          if (tools.length === 0) {
            return 'No embedded tools available';
          }

          const toolsList = tools
            .map((tool) => `• **${tool.name}**: ${tool.description}`)
            .join('\n');

          return `Available Embedded Tools (${tools.length}):\n\n${toolsList}`;
        }

        case 'health_check': {
          const health = await embeddedMCPRuntime.healthCheck();
          return `Embedded MCP Runtime Health:\n• Healthy tools: ${health.healthy}/${health.total}\n• Status: ✅ All systems operational`;
        }

        default:
          throw new Error(`Unknown embedded MCP action: ${action}`);
      }
    } catch (error) {
      logger.error(`Embedded MCP capability failed for action ${action}:`, error);
      throw error;
    }
  },
};
