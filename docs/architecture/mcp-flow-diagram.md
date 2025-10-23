# MCP Auto-Installation Flow Diagram

```mermaid
graph TD
    A[User Message:<br/>'&lt;mcp-auto-install&gt;metmuseum-mcp&lt;/mcp-auto-install&gt;'] --> B[XML Parser]
    B --> C{Tag Detection}
    C -->|✅ WORKING| D[Bulletproof Capability Extractor]
    D --> E[Capability: mcp_auto_installer<br/>Action: install_npm<br/>Package: metmuseum-mcp]
    E --> F[MCP Auto-Installer]
    F --> G[Install NPM Package<br/>✅ WORKING]
    G --> H[Create stdio:// URL<br/>'stdio://npx metmuseum-mcp']
    H --> I[MCP Client: Connect]
    I --> J[MCP Process Manager:<br/>startProcess()]
    J --> K[Spawn Process<br/>npx metmuseum-mcp]
    K --> L{Process Status Check<br/>After 1 second}
    L -->|✅ Process Running| M[Send MCP Initialize<br/>via JSON-RPC]
    L -->|❌ Exit Code 1| N[Process Failed]
    M --> O[Receive Initialize Response<br/>✅ WORKING MANUALLY]
    O --> P[Send tools/list Request]
    P --> Q[Receive Tools Array<br/>✅ 3 TOOLS FOUND]
    Q --> R{Tool Registration}
    R -->|❌ BROKEN HERE| S[Map Tools to Simple XML Tags]
    R -->|❌ NOT HAPPENING| T[Register in Capability Registry]

    U[User Message:<br/>'&lt;search-museum-objects&gt;monet&lt;/search-museum-objects&gt;'] --> V[XML Parser]
    V --> W{Tag Detection}
    W -->|✅ Detects MCP Tool| X[Map to MCP Client Call]
    X --> Y{Tool Available?}
    Y -->|❌ NO - Not Registered| Z[Fallback Response:<br/>'Tool unavailable']
    Y -->|Would be ✅| AA[Execute MCP Tool Call]

    style N fill:#f99
    style R fill:#f99
    style Z fill:#f99
    style S fill:#f99
    style T fill:#f99
```

## Problem Analysis

### ✅ WORKING PARTS:

1. **XML Parsing** - `<mcp-auto-install>` tags detected correctly
2. **Package Installation** - NPM packages install successfully
3. **Process Spawning** - Met Museum MCP process is running
4. **MCP Protocol** - Manual testing shows initialize & tools/list work
5. **Tool Discovery** - 3 tools found: list-departments, search-museum-objects, get-museum-object

### ❌ BROKEN PARTS:

1. **Tool Registration** - Discovered tools aren't being registered in the capability registry
2. **Tool Mapping** - No mapping from MCP tool names to simple XML tags
3. **Tool Availability** - When user tries `<search-museum-objects>`, system doesn't know about it

### 🎯 THE MISSING LINK:

After successful tool discovery (line 428 in mcp-client.ts), we need to:

1. Register each discovered tool in the capability registry
2. Create mappings from kebab-case XML tags to MCP tool calls
3. Make tools available for the XML parser to recognize

### 🔧 FIX NEEDED:

In `mcp-client.ts` after line 428 where tools are discovered:

```typescript
// Register discovered tools in capability registry
for (const tool of connection.tools) {
  // Register tool as available capability
  capabilityRegistry.registerMCPTool(tool.name, connectionId);
}
```
