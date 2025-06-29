import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import axios, { AxiosRequestConfig } from 'axios';

/**
 * Interface for MCP server connection details
 */
interface MCPServerConnection {
  id: string;
  url: string;
  name?: string;
  connected: boolean;
  connectedAt?: Date;
  lastPing?: Date;
  tools?: MCPTool[];
  error?: string;
}

/**
 * MCP Tool definition
 */
interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * MCP JSON-RPC request structure
 */
interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * MCP JSON-RPC response structure
 */
interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPClientParams {
  action: string;
  url?: string;
  name?: string;
  connection_id?: string;
  id?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
}

interface MCPToolCallResult {
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

/**
 * MCP Client Service for managing connections to MCP servers
 */
class MCPClientService {
  private connections = new Map<string, MCPServerConnection>();
  private requestId = 1;

  /**
   * Generate a unique request ID for JSON-RPC calls
   */
  private getNextRequestId(): number {
    return this.requestId++;
  }

  /**
   * Generate a unique connection ID
   */
  private generateConnectionId(url: string): string {
    return `mcp_${Date.now()}_${url.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  /**
   * Validate MCP server URL
   */
  private validateServerUrl(url: string): { isValid: boolean; error?: string } {
    try {
      const parsed = new URL(url);
      
      // Only allow HTTP and HTTPS
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { isValid: false, error: 'Only HTTP and HTTPS protocols are supported' };
      }

      // Basic security check - don't allow localhost in production
      if (process.env.NODE_ENV === 'production' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        return { isValid: false, error: 'Localhost connections not allowed in production' };
      }

      return { isValid: true };
    } catch {
      return { isValid: false, error: 'Invalid URL format' };
    }
  }

  /**
   * Make a JSON-RPC call to an MCP server
   */
  private async makeJsonRpcCall(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: this.getNextRequestId(),
      method,
      params
    };

    const config: AxiosRequestConfig = {
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CoachArtie-MCP-Client/1.0.0'
      },
      data: request,
      timeout: 30000, // 30 second timeout
      validateStatus: (status) => status < 500
    };

    try {
      logger.info(`Making MCP JSON-RPC call: ${method} to ${url}`);
      const response = await axios(config);

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const mcpResponse: MCPResponse = response.data;

      if (mcpResponse.error) {
        throw new Error(`MCP Error ${mcpResponse.error.code}: ${mcpResponse.error.message}`);
      }

      return mcpResponse.result;
    } catch (error) {
      logger.error(`MCP JSON-RPC call failed: ${method} to ${url}`, error);
      throw error;
    }
  }

  /**
   * Connect to an MCP server
   */
  async connect(url: string, name?: string): Promise<string> {
    // Validate URL
    const validation = this.validateServerUrl(url);
    if (!validation.isValid) {
      throw new Error(`Invalid server URL: ${validation.error}`);
    }

    // Check if already connected
    const existingConnection = Array.from(this.connections.values())
      .find(conn => conn.url === url && conn.connected);
    
    if (existingConnection) {
      return `Already connected to MCP server: ${existingConnection.id}`;
    }

    const connectionId = this.generateConnectionId(url);
    
    // Create initial connection record
    const connection: MCPServerConnection = {
      id: connectionId,
      url,
      name: name || `MCP Server ${connectionId}`,
      connected: false
    };

    this.connections.set(connectionId, connection);

    try {
      // Test connection with initialize call
      await this.makeJsonRpcCall(url, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true }
        },
        clientInfo: {
          name: 'CoachArtie',
          version: '1.0.0'
        }
      });

      // Mark as connected
      connection.connected = true;
      connection.connectedAt = new Date();
      connection.lastPing = new Date();
      connection.error = undefined;

      // Try to get available tools
      try {
        const toolsResult = await this.makeJsonRpcCall(url, 'tools/list');
        connection.tools = (toolsResult as any)?.tools || [];
      } catch (toolsError) {
        logger.warn(`Failed to get tools from MCP server ${url}:`, toolsError);
        connection.tools = [];
      }

      logger.info(`Successfully connected to MCP server: ${connectionId} at ${url}`);
      return `Connected to MCP server: ${connectionId} (${connection.tools?.length || 0} tools available)`;

    } catch (error) {
      connection.error = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to connect to MCP server ${url}:`, error);
      throw new Error(`Failed to connect to MCP server: ${connection.error}`);
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(connectionId: string): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    if (!connection.connected) {
      this.connections.delete(connectionId);
      return `Connection ${connectionId} was already disconnected`;
    }

    try {
      // Attempt graceful shutdown
      await this.makeJsonRpcCall(connection.url, 'notifications/cancelled');
    } catch (error) {
      logger.warn(`Failed to send cancellation to MCP server ${connectionId}:`, error);
    }

    // Remove connection
    this.connections.delete(connectionId);
    logger.info(`Disconnected from MCP server: ${connectionId}`);
    
    return `Disconnected from MCP server: ${connectionId}`;
  }

  /**
   * List all connected MCP servers
   */
  listServers(): string {
    const connections = Array.from(this.connections.values());
    
    if (connections.length === 0) {
      return 'No MCP servers connected';
    }

    const serverList = connections.map(conn => {
      const status = conn.connected ? '✅ Connected' : '❌ Disconnected';
      const toolCount = conn.tools?.length || 0;
      const connectedTime = conn.connectedAt ? ` (since ${conn.connectedAt.toLocaleString()})` : '';
      const error = conn.error ? ` - Error: ${conn.error}` : '';
      
      return `• ${conn.id}: ${conn.name || conn.url} - ${status} - ${toolCount} tools${connectedTime}${error}`;
    }).join('\n');

    return `MCP Servers (${connections.length}):\n${serverList}`;
  }

  /**
   * List available tools from all connected servers
   */
  listTools(connectionId?: string): string {
    let connections: MCPServerConnection[];
    
    if (connectionId) {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }
      connections = [connection];
    } else {
      connections = Array.from(this.connections.values()).filter(conn => conn.connected);
    }

    if (connections.length === 0) {
      return connectionId 
        ? `No connected server found with ID: ${connectionId}`
        : 'No connected MCP servers';
    }

    let toolsList = '';
    let totalTools = 0;

    for (const connection of connections) {
      const tools = connection.tools || [];
      totalTools += tools.length;
      
      if (tools.length === 0) {
        toolsList += `\n${connection.name || connection.id}: No tools available`;
        continue;
      }

      toolsList += `\n${connection.name || connection.id} (${tools.length} tools):`;
      for (const tool of tools) {
        toolsList += `\n  • ${tool.name}`;
        if (tool.description) {
          toolsList += ` - ${tool.description}`;
        }
      }
    }

    return `Available MCP Tools (${totalTools} total):${toolsList}`;
  }

  /**
   * Call a specific tool on an MCP server
   */
  async callTool(connectionId: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    if (!connection.connected) {
      throw new Error(`Server not connected: ${connectionId}`);
    }

    // Check if tool exists
    const tool = connection.tools?.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found on server ${connectionId}`);
    }

    try {
      const result = await this.makeJsonRpcCall(connection.url, 'tools/call', {
        name: toolName,
        arguments: args
      });

      // Update last ping time
      connection.lastPing = new Date();

      // Format the result
      const typedResult = result as MCPToolCallResult;
      if (typedResult.content && Array.isArray(typedResult.content)) {
        const textContent = typedResult.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .filter((text): text is string => typeof text === 'string')
          .join('\n');
        
        if (textContent) {
          return textContent;
        }
      }

      // Fallback to JSON representation
      return JSON.stringify(result, null, 2);

    } catch (error) {
      connection.error = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to call tool ${toolName} on server ${connectionId}:`, error);
      throw error;
    }
  }

  /**
   * Get connection by ID
   */
  getConnection(connectionId: string): MCPServerConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Find connection by URL
   */
  findConnectionByUrl(url: string): MCPServerConnection | undefined {
    return Array.from(this.connections.values()).find(conn => conn.url === url);
  }

  /**
   * Health check for all connections
   */
  async healthCheck(): Promise<string> {
    const connections = Array.from(this.connections.values());
    const results: string[] = [];

    for (const connection of connections) {
      if (!connection.connected) {
        results.push(`❌ ${connection.id}: Disconnected`);
        continue;
      }

      try {
        // Simple ping to check if server is responsive
        await this.makeJsonRpcCall(connection.url, 'ping');
        connection.lastPing = new Date();
        connection.error = undefined;
        results.push(`✅ ${connection.id}: Healthy (${connection.tools?.length || 0} tools)`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        connection.error = errorMsg;
        results.push(`⚠️  ${connection.id}: Unhealthy - ${errorMsg}`);
      }
    }

    return results.length > 0 
      ? `MCP Server Health Check:\n${results.join('\n')}`
      : 'No MCP servers to check';
  }
}

// Singleton instance
const mcpClientService = new MCPClientService();

/**
 * MCP Client capability - connects to and manages MCP servers
 * 
 * Supported actions:
 * - connect: Connect to an MCP server by URL
 * - disconnect: Disconnect from an MCP server
 * - list_tools: List available tools from connected servers
 * - call_tool: Call a specific tool on a connected server
 * - list_servers: List all connected MCP servers
 * - health_check: Check health of all connections
 * 
 * Parameters:
 * - url: MCP server URL (for connect action)
 * - name: Optional server name (for connect action)
 * - connection_id: Server connection ID (for disconnect, call_tool actions)
 * - tool_name: Tool name to call (for call_tool action)
 * - args: Tool arguments as JSON object (for call_tool action)
 */
export const mcpClientCapability: RegisteredCapability = {
  name: 'mcp_client',
  supportedActions: ['connect', 'disconnect', 'list_tools', 'call_tool', 'list_servers', 'health_check'],
  description: 'Connects to and manages MCP (Model Context Protocol) servers',
  handler: async (params: MCPClientParams, content?: string) => {
    const { action } = params;

    try {
      switch (action) {
        case 'connect': {
          const url = params.url || content;
          if (!url) {
            throw new Error('MCP server URL is required');
          }
          
          const name = params.name;
          return await mcpClientService.connect(url, name);
        }

        case 'disconnect': {
          const connectionId = params.connection_id || params.id || content;
          if (!connectionId) {
            throw new Error('Connection ID is required');
          }
          
          return await mcpClientService.disconnect(connectionId);
        }

        case 'list_servers': {
          return mcpClientService.listServers();
        }

        case 'list_tools': {
          const connectionId = params.connection_id || params.id;
          return mcpClientService.listTools(connectionId);
        }

        case 'call_tool': {
          const connectionId = params.connection_id || params.id;
          const toolName = params.tool_name || params.name;
          
          if (!connectionId) {
            throw new Error('Connection ID is required');
          }
          if (!toolName) {
            throw new Error('Tool name is required');
          }

          // Parse args from params or content
          let args = params.args || {};
          if (content && !params.args) {
            try {
              args = JSON.parse(content);
            } catch {
              // If content is not JSON, pass it as a single argument
              args = { input: content };
            }
          }

          return await mcpClientService.callTool(connectionId, toolName, args);
        }

        case 'health_check': {
          return await mcpClientService.healthCheck();
        }

        default:
          throw new Error(`Unknown MCP client action: ${action}`);
      }
    } catch (error) {
      logger.error(`MCP client capability failed for action ${action}:`, error);
      throw error;
    }
  }
};