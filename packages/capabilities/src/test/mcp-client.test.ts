import { describe, it, expect } from 'vitest';
import { mcpClientCapability } from '../capabilities/mcp-client.js';

describe('MCP Client Capability', () => {
  it('should be properly configured', () => {
    expect(mcpClientCapability.name).toBe('mcp_client');
    expect(mcpClientCapability.supportedActions).toEqual([
      'connect', 
      'disconnect', 
      'list_tools', 
      'call_tool', 
      'list_servers', 
      'health_check'
    ]);
    expect(mcpClientCapability.description).toBe('Connects to and manages MCP (Model Context Protocol) servers');
    expect(typeof mcpClientCapability.handler).toBe('function');
  });

  it('should throw error for unknown action', async () => {
    await expect(mcpClientCapability.handler({ action: 'unknown' }))
      .rejects.toThrow('Unknown MCP client action: unknown');
  });

  it('should require URL for connect action', async () => {
    await expect(mcpClientCapability.handler({ action: 'connect' }))
      .rejects.toThrow('MCP server URL is required');
  });

  it('should require connection ID for disconnect action', async () => {
    await expect(mcpClientCapability.handler({ action: 'disconnect' }))
      .rejects.toThrow('Connection ID is required');
  });

  it('should require connection ID for call_tool action', async () => {
    await expect(mcpClientCapability.handler({ action: 'call_tool' }))
      .rejects.toThrow('Connection ID is required');
  });

  it('should require tool name for call_tool action', async () => {
    await expect(mcpClientCapability.handler({ 
      action: 'call_tool', 
      connection_id: 'test' 
    })).rejects.toThrow('Tool name is required');
  });

  it('should handle list_servers action', async () => {
    const result = await mcpClientCapability.handler({ action: 'list_servers' });
    expect(result).toBe('No MCP servers connected');
  });

  it('should handle list_tools action', async () => {
    const result = await mcpClientCapability.handler({ action: 'list_tools' });
    expect(result).toBe('No connected MCP servers');
  });

  it('should handle health_check action', async () => {
    const result = await mcpClientCapability.handler({ action: 'health_check' });
    expect(result).toBe('No MCP servers to check');
  });

  it('should validate invalid URLs', async () => {
    await expect(mcpClientCapability.handler({ 
      action: 'connect', 
      url: 'invalid-url' 
    })).rejects.toThrow('Invalid server URL');
  });

  it('should validate unsupported protocols', async () => {
    await expect(mcpClientCapability.handler({ 
      action: 'connect', 
      url: 'ftp://example.com' 
    })).rejects.toThrow('Only HTTP and HTTPS protocols are supported');
  });
});