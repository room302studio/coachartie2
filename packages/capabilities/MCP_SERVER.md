# Coach Artie MCP Server

This package provides a Model Context Protocol (MCP) server that exposes Coach Artie's capabilities as tools that can be used by other applications.

## Overview

The MCP server registers all available capabilities (calculator, web search, memory, Wolfram Alpha, scheduler) as MCP tools and provides both STDIO and HTTP transports for communication.

## Available Tools

### Calculator Tools
- `calculator_calculate` - Evaluates mathematical expressions
- `calculator_eval` - Alias for calculate

### Web Tools  
- `web_search` - Searches the web for a given query
- `web_fetch` - Fetches content from a specific URL

### Memory Tools
- `memory_remember` - Stores information in memory
- `memory_recall` - Retrieves information from memory

### Wolfram Alpha Tools (Optional)
- `wolfram_query` - Queries Wolfram Alpha for computational knowledge
- `wolfram_search` - Alias for query

**Note:** Wolfram Alpha tools require `WOLFRAM_APP_ID` environment variable to be set.

### Scheduler Tools
- `scheduler_remind` - Sets a one-time reminder
- `scheduler_schedule` - Schedules recurring tasks with cron expressions
- `scheduler_list` - Lists all scheduled tasks
- `scheduler_cancel` - Cancels a scheduled task

## Usage

### Starting the MCP Server

#### HTTP Transport (Recommended)
```bash
# Development mode with auto-reload
pnpm run mcp:dev

# Production mode
pnpm run mcp
```

The server will start on port 3001 by default (configurable with `MCP_PORT` environment variable).

#### STDIO Transport
```bash
# For direct STDIO communication
node dist/mcp-index.js
```

### Environment Variables

- `MCP_PORT` - Port for HTTP server (default: 3001)
- `WOLFRAM_APP_ID` - Required for Wolfram Alpha capabilities
- `REDIS_URL` - Redis connection for scheduler (optional)

### HTTP Endpoints

When running with HTTP transport:

- `GET /health` - Health check and server status
- `GET /mcp` - MCP SSE connection endpoint
- `POST /mcp/message` - MCP message handling endpoint

### Example Tool Usage

#### Calculator
```json
{
  "name": "calculator_calculate",
  "arguments": {
    "expression": "2 + 2 * 3"
  }
}
```

#### Web Search
```json
{
  "name": "web_search", 
  "arguments": {
    "query": "latest news about AI"
  }
}
```

#### Scheduler
```json
{
  "name": "scheduler_remind",
  "arguments": {
    "message": "Meeting with team",
    "delay": "3600000",
    "userId": "user123"
  }
}
```

### CORS Configuration

The HTTP server is configured with CORS support for local development:
- Origins: `localhost:3000`, `localhost:3001`, `127.0.0.1:3000`, `127.0.0.1:3001`
- Methods: `GET`, `POST`, `OPTIONS`
- Headers: `Content-Type`, `Authorization`, `Accept`

### Connection Management

The server maintains active MCP connections and provides:
- Automatic connection cleanup on disconnect
- Error handling and logging
- Graceful shutdown on SIGTERM/SIGINT
- Session-based message routing

### Integration

This MCP server can be integrated with:
- Claude Desktop (via MCP configuration)
- Other MCP-compatible applications
- Custom applications using MCP client libraries

### Development

To extend the server with new capabilities:

1. Add your capability to the capability registry
2. Update the `getToolInputSchema` method with parameter definitions
3. Test with the development server: `pnpm run mcp:dev`

### Logging

The server provides comprehensive logging for:
- Tool registration and execution
- Connection management
- Error handling
- Performance monitoring

All logs use the shared logging service with structured JSON output.