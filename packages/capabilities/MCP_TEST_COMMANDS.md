# MCP Integration Test Commands

Test these queries to verify that MCP requests are now properly recognized and converted to capability tags:

## 1. Test MCP Server Connection
```
Connect to an MCP server and list available tools
```
**Expected**: Should generate `<capability name="mcp_client" action="connect" />` or `<capability name="mcp_client" action="list_tools" />`

## 2. Test Specific MCP Connection
```
Connect to MCP server at localhost:3005
```
**Expected**: Should generate `<capability name="mcp_client" action="connect" url="http://localhost:3005" />`

## 3. Test Tool Listing
```
List all available tools from connected MCP servers
```
**Expected**: Should generate `<capability name="mcp_client" action="list_tools" />`

## 4. Test Server Status
```
Show me all connected MCP servers
```
**Expected**: Should generate `<capability name="mcp_client" action="list_servers" />`

## 5. Test Health Check
```
Check MCP server health status
```
**Expected**: Should generate `<capability name="mcp_client" action="health_check" />`

## 6. Test Tool Execution
```
Call the weather tool on the MCP server with location New York
```
**Expected**: Should generate `<capability name="mcp_client" action="call_tool" tool_name="weather" args='{"location": "New York"}' />`

## Testing with Existing MCP Servers

You have these MCP servers available for testing:

### Weather OpenMeteo Server
- **Path**: `/Users/ejfox/code/coachartie2/mcp-servers/weather_openmeteo/`
- **Port**: 3005
- **Config**: `weather-openmeteo-mcp-config.json`
- **Start**: `cd /Users/ejfox/code/coachartie2/mcp-servers/weather_openmeteo && ./start.sh`

### Filesystem Server  
- **Path**: `/Users/ejfox/code/coachartie2/mcp-servers/filesystem/`
- **Port**: 3003
- **Config**: `filesystem-mcp-config.json`
- **Start**: `cd /Users/ejfox/code/coachartie2/mcp-servers/filesystem && ./start.sh`

### ASCII Art Generator (Custom)
- **Path**: `/Users/ejfox/code/coachartie2/mcp-servers/custom/ascii-art-generator/`
- **Config**: `mcp-config.json`

## Integration Test Workflow

1. **Start an MCP Server**:
   ```bash
   cd /Users/ejfox/code/coachartie2/mcp-servers/weather_openmeteo
   ./start.sh &
   ```

2. **Test Connection with Coach Artie**:
   ```
   Connect to MCP server at http://localhost:3005 and list available tools
   ```

3. **Test Tool Usage**:
   ```
   Call the weather tool to get current weather for San Francisco
   ```

4. **Test Server Management**:
   ```
   Show me all connected MCP servers and their health status
   ```

## Expected Behavior After Fix

- ✅ MCP-related queries should generate proper `<capability name="mcp_client" action="..." />` tags
- ✅ The system should suggest MCP client actions with high confidence (95%)
- ✅ Users should get functional MCP integration instead of generic responses
- ✅ The capability orchestrator should execute MCP client capabilities properly

## Status Before Fix

❌ "Connect to an MCP server and list available tools" → Generic LLM response  
❌ No capability tags generated for MCP requests  
❌ MCP functionality was implemented but not discoverable  

## Status After Fix

✅ MCP requests are properly recognized and converted to capability tags  
✅ High-confidence suggestions for MCP-related queries  
✅ Proper example generation for LLM capability usage  
✅ Full integration between user intent and MCP functionality  