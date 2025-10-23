import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root (go up from packages/capabilities/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });

import { CapabilitiesMCPServer } from './mcp-server.js';
import { logger } from '@coachartie/shared';

/**
 * Entry point for the MCP server
 * This creates a standalone MCP server that can be accessed by other applications
 */
async function startMCPServer() {
  try {
    const mcpServer = new CapabilitiesMCPServer();
    const port = parseInt(process.env.MCP_PORT || '47320');
    
    logger.info('🚀 Starting Coach Artie MCP Server...');
    logger.info(`📋 Port: ${port}`);
    
    // Start HTTP server
    await mcpServer.startHttp(port);
    
  } catch (error) {
    logger.error('❌ Failed to start MCP server:', error);
    process.exit(1);
  }
}

startMCPServer();