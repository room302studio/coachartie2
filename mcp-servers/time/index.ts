#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "time-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_current_time",
        description: "Get the current date and time",
        inputSchema: {
          type: "object",
          properties: {
            timezone: {
              type: "string",
              description: "Timezone (optional, defaults to UTC)",
              default: "UTC"
            },
            format: {
              type: "string", 
              description: "Format string (optional, defaults to ISO)",
              default: "ISO"
            }
          },
        },
      },
      {
        name: "get_timestamp",
        description: "Get the current Unix timestamp",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "parse_date",
        description: "Parse a date string and return formatted information",
        inputSchema: {
          type: "object",
          properties: {
            date_string: {
              type: "string",
              description: "Date string to parse"
            },
            output_format: {
              type: "string",
              description: "Output format (optional, defaults to detailed)",
              default: "detailed"
            }
          },
          required: ["date_string"]
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_current_time": {
        const timezone = args?.timezone || "UTC";
        const format = args?.format || "ISO";
        
        const now = new Date();
        let result: string;
        
        if (format === "ISO") {
          result = now.toISOString();
        } else if (format === "locale") {
          result = now.toLocaleString();
        } else if (format === "date") {
          result = now.toDateString();
        } else if (format === "time") {
          result = now.toTimeString();
        } else {
          result = now.toISOString();
        }
        
        return {
          content: [
            {
              type: "text",
              text: `Current time (${timezone}): ${result}`,
            },
          ],
        };
      }

      case "get_timestamp": {
        const timestamp = Math.floor(Date.now() / 1000);
        return {
          content: [
            {
              type: "text", 
              text: `Current Unix timestamp: ${timestamp}`,
            },
          ],
        };
      }

      case "parse_date": {
        const dateString = args?.date_string as string;
        const outputFormat = (args?.output_format as string) || "detailed";
        
        if (!dateString) {
          throw new McpError(ErrorCode.InvalidParams, "date_string is required");
        }
        
        const parsedDate = new Date(dateString);
        
        if (isNaN(parsedDate.getTime())) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid date string");
        }
        
        let result: string;
        
        if (outputFormat === "detailed") {
          result = `Parsed date: ${parsedDate.toISOString()}\n` +
                  `Unix timestamp: ${Math.floor(parsedDate.getTime() / 1000)}\n` +
                  `Day of week: ${parsedDate.toLocaleDateString('en-US', { weekday: 'long' })}\n` +
                  `Month: ${parsedDate.toLocaleDateString('en-US', { month: 'long' })}\n` +
                  `Year: ${parsedDate.getFullYear()}`;
        } else {
          result = parsedDate.toISOString();
        }
        
        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Error executing tool: ${error}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Time MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});