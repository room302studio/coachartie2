// Global type declarations for TypeScript

declare global {
  namespace NodeJS {
    interface Global {
      mcpToolRegistry?: Map<string, {
        connectionId: string;
        command: string;
        tool: {
          name: string;
          description: string;
          inputSchema: object;
        };
      }>;
      mcpConnections?: Map<string, any>;
    }
  }

  // Extend globalThis for our MCP registry
  var mcpToolRegistry: Map<string, {
    connectionId: string;
    command: string;
    tool: {
      name: string;
      description: string;
      inputSchema: object;
    };
  }> | undefined;

  var mcpConnections: Map<string, any> | undefined;
}

export {};