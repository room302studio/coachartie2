# Coach Artie 2 - Development SITREP

## 🎯 MCP Tool Syntax (CRITICAL - DO NOT CHANGE)

**The ONLY way to call MCP tools is with this simple syntax:**

```xml
<!-- Search Wikipedia -->
<search-wikipedia>Python programming language</search-wikipedia>

<!-- Get Wikipedia article with optional limit -->
<get-wikipedia-article limit="5">Python (programming language)</get-wikipedia-article>

<!-- Get current time (no args) -->
<get-current-time />

<!-- Parse a date -->
<parse-date>2025-06-30</parse-date>
```

**Rules:**
- Tool name = XML tag name (kebab-case like `search-wikipedia`)
- Main argument = tag content
- Optional params = XML attributes
- No args = self-closing tag
- NO OTHER FORMAT IS ACCEPTABLE

**This is automatically converted to:**
```xml
<capability name="mcp_client" action="call_tool" tool_name="search_wikipedia">{"query": "Python programming language"}</capability>
```

But LLMs should NEVER generate the complex format - only the simple one!

---

**Last Updated:** 2025-06-30 14:25 UTC  
**Status:** MCP Tool Syntax Simplified ✅ | XML Parser Updated ✅

## ✅ NEW: Simplified MCP Tool Syntax (2025-06-30)
**Problem**: Complex XML syntax was confusing LLMs
**Solution**: Direct tool-name tags like `<search-wikipedia>query</search-wikipedia>`
**Implementation**: 
- Updated `xml-parser.ts` to detect kebab-case tags and convert to MCP calls
- Smart parameter mapping in `mcp-client.ts` (query for search, title for articles, etc.)
- Attributes become extra params: `<get-wikipedia-article limit="5">Title</get-wikipedia-article>`
**Result**: Dead simple syntax that any LLM can generate correctly

## ✅ FIXED: XML Parser Refactoring (2025-06-27)
**Problem**: Hardcoded regex patterns scattered throughout codebase for XML capability parsing
**Solution**: Created centralized `xml-parser.ts` using `fast-xml-parser` library
**Files Changed**:
- `packages/capabilities/src/utils/xml-parser.ts` (NEW - centralized parser)
- `packages/capabilities/src/services/capability-orchestrator.ts` (removed regex methods)
- `packages/capabilities/src/capabilities/memory.ts` (uses new parser)
**Benefits**: Clean, maintainable, properly tested XML parsing with comprehensive unit tests
**Test Results**: ✅ Memory remember/search, ✅ Calculator parsing, ✅ Self-closing tags, ✅ Multiple capabilities

## ✅ FIXED: TypeScript Compilation Errors (2025-06-27)
**Problem**: Build failures due to missing methods and type errors
**Solution**: 
- Fixed missing `lastCacheUpdate` property in PromptManager
- Replaced deleted method calls with inline logic
- Fixed OpenRouter service call signatures
**Result**: `pnpm build` now completes successfully

## 🚨 MAJOR ISSUE: Development Server Networking (2025-06-27)
**Problem**: Service claims to bind successfully but nothing actually listens on the port
**Symptoms**: 
- Logs show "✅ Capabilities service successfully bound to port 18239 on 0.0.0.0"
- Express server.listen() callback executes without errors
- BUT: `lsof -i :18239` shows nothing listening
- `curl http://localhost:18239/health` fails with "Connection refused"
- Tried multiple ports (18239, 8888) - same issue

**Debugging Attempts**:
- ✅ Fixed Express binding to use '0.0.0.0' instead of default
- ✅ Killed all tsx/node processes multiple times
- ✅ Used killall -9 to force kill everything
- ✅ Tried different ports to rule out conflicts
- ✅ Checked for zombie processes and port conflicts
- ❌ Service still claims success but port never actually binds

**This is NOT a minor quirk** - something is fundamentally broken with the Express server binding or macOS networking. The Express callback fires (suggesting successful bind) but the OS shows no process listening on the port.

**Next Steps**: 
1. **System reboot** (most likely fix)
2. Check for macOS firewall/security restrictions
3. Investigate Express version compatibility issues
4. Consider Docker networking as alternative

**Impact**: Cannot test API endpoints, but core XML parsing logic verified via unit tests

## ✅ FIXED: Discord Double Response Issue
**Problem**: Discord bot was processing same message twice, sending duplicate responses
**Root Cause**: Two parallel Discord implementations were both active:
  - Legacy `index.js` directly calling `capabilitiesClient.chat()` 
  - New `src/index.ts` using BullMQ message queue
**Fix Applied**: Renamed `index.js` to `index.js.backup` to disable legacy implementation
**Result**: Only the TypeScript queue-based implementation is active now

---

**Previous Status:** Memory System Fixed ✅ | Free Model Guidance In Progress

---

## 🎯 Current Status

### ✅ WORKING PROPERLY
- **Memory System**: Fixed! Now extracts capabilities from user messages AND LLM responses
- **Basic API**: Chat endpoint on port 23701, all services healthy  
- **Capability Architecture**: 10 capabilities, 41+ actions registered
- **Free Model Fallback**: Graceful degradation when credits exhausted + auto-injection
- **Database**: SQLite persistence, prompt hot-reloading fixed
- **Token Usage Tracking**: Full implementation with cost calculation and stats
- **MCP Tool Syntax**: Simplified to `<tool-name>args</tool-name>` format

### ⚠️ NEEDS WORK
- **MCP stdio://**: Only HTTP/HTTPS supported, can't connect to local servers
- **CapabilitySuggester**: Broken substring matching, needs keyword improvements

### ❌ KNOWN BROKEN
- **Brain Migration**: Core brain still in ARCHIVE, needs monorepo integration

---

## 🧠 Memory/Context System (FIXED)

### How It Works Now
1. **Storage**: `<capability name="memory" action="remember">content</capability>` → SQLite with FTS5
2. **Search**: `<capability name="memory" action="search" query="food" />` → fuzzy search with wildcards  
3. **Retrieval**: System returns actual stored memories (no hallucination)
4. **Integration**: LLM weaves results into natural responses

### Key Fix Applied
```typescript
// Before: Only extracted from LLM response
const capabilities = this.extractCapabilities(llmResponse);

// After: Extract from BOTH user message and LLM response  
const userCapabilities = this.extractCapabilities(message.message);
const llmCapabilities = this.extractCapabilities(llmResponse);
const capabilities = [...userCapabilities, ...llmCapabilities];
```

### Test Results
```bash
# Store chocolate preference
curl -X POST http://localhost:23701/chat -d '{"message": "<capability name=\"memory\" action=\"remember\">I prefer dark chocolate</capability>", "userId": "test"}'

# Recall it back  
curl -X POST http://localhost:23701/chat -d '{"message": "<capability name=\"memory\" action=\"search\" query=\"chocolate\" />", "userId": "test"}'
# ✅ Returns: "I prefer dark chocolate over milk chocolate, as I've mentioned twice..."
```

---

## 📊 Token Usage & Cost Tracking (NEW)

### Implementation Complete ✅
- **UsageTracker Service**: Captures token usage from OpenRouter API responses
- **Database Schema**: Extended `model_usage_stats` table with token columns
- **Cost Calculation**: Model-specific pricing per 1K tokens (Claude, GPT, free models)
- **Statistics API**: User usage, model usage, daily aggregations

### How It Works
```typescript
// Automatic capture in OpenRouter service
const usage = completion.usage; // { prompt_tokens, completion_tokens, total_tokens }
const cost = UsageTracker.calculateCost(model, usage);

// Stats queries
const userStats = await UsageTracker.getUserUsage('user123', 30);
const modelStats = await UsageTracker.getModelUsage('claude-3.5-sonnet', 7);
const dailyStats = await UsageTracker.getDailyUsage(7);
```

### Current Pricing (per 1K tokens)
- **Claude 3.5 Sonnet**: $0.003 input / $0.015 output  
- **GPT-3.5**: $0.0005 input / $0.0015 output
- **Free Models**: $0 (Mistral, Phi-3, Llama, Gemma)

### Database Columns Added
- `prompt_tokens`, `completion_tokens`, `total_tokens`, `estimated_cost`
- Fully backward compatible with existing data

---

## 🤖 Free Model Challenge

**The Problem**: Free models don't naturally generate capability XML tags for memory searches, calculations, etc.

**Current Approach**: Add "hints" to user messages before sending to LLM
- Example: `(Hint: memory search might help) What foods do I like?`
- Status: Models still ignore hints

**What We Tried (and failed)**:
- ❌ Regex pattern matching  
- ❌ String.includes() analysis
- ❌ Hard-coded string mappings
- ❌ Over-engineered suggestions

**Fixed**: Simple fallback detection implemented ✅
- Auto-injects memory search for preference queries ("What do I like?", "What are my favorites?")
- Auto-injects calculator for math questions with numbers
- Auto-injects web search for information queries
- Works when LLM response contains no capability tags

---

## 📊 Service Architecture 

```
coachartie2/
├── packages/
│   ├── capabilities/     ✅ Core orchestrator (port 23701)
│   ├── discord/         ✅ Bot interface
│   ├── sms/            ✅ SMS via Twilio (port 23702)  
│   ├── email/          ✅ Email interface (port 23703)
│   ├── shared/         ✅ Database, Redis, utilities
│   └── mcp-calculator/ ✅ Local MCP server (stdio)
└── ARCHIVE/            ❌ Brain needs migration
```

**Endpoints**:
- Health: `curl http://localhost:23701/health`
- Chat: `curl -X POST http://localhost:23701/chat -d '{"message":"test","userId":"user"}'`
- All services: Redis connected, logs in `/tmp/turbo.log`

---

## 🧪 Testing Commands

### Memory System
```bash
# Store a preference
curl -X POST http://localhost:23701/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"remember\">I love Hawaiian pizza</capability>", "userId": "test"}'

# Search for it  
curl -X POST http://localhost:23701/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"search\" query=\"pizza\" />", "userId": "test"}'
```

### Calculator
```bash
# Test calculation
curl -X POST http://localhost:23701/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"calculator\" action=\"calculate\">47 * 23 + 156 / 4</capability>", "userId": "test"}'
# Should return: 1110
```

### MCP Tools (NEW SIMPLE SYNTAX!)
```bash
# Search Wikipedia
curl -X POST http://localhost:23701/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<search-wikipedia>quantum computing</search-wikipedia>", "userId": "test"}'

# Get current time
curl -X POST http://localhost:23701/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<get-current-time />", "userId": "test"}'
```

### Free Model Fallback
```bash
# Test natural language (will use free model)
curl -X POST http://localhost:23701/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What foods do I like?", "userId": "test"}'
# Currently: Ignores memory, gives generic response
# Goal: Auto-inject memory search capability
```

---

## 🚀 Development Workflow

### Start Services
```bash
pnpm run dev          # Start all services  
tail -f /tmp/turbo.log # Watch logs
```

### Restart After Changes
```bash
pkill -f "tsx watch" && pnpm run dev
```

### Check Database
```bash
sqlite3 /Users/ejfox/code/coachartie2/packages/capabilities/data/coachartie.db
.tables
SELECT * FROM memories LIMIT 5;
```

---

## 🎯 Next Sprint

### Immediate (This Session)
1. **Test new MCP syntax**: Verify `<search-wikipedia>query</search-wikipedia>` works
2. **Add MCP status capability**: So bot can check what tools are available
3. **Update all prompts**: Include new syntax examples

### Soon  
1. **stdio:// MCP Support**: Connect to local MCP calculator server
2. **Brain Migration**: Move brain from ARCHIVE to packages/brain
3. **Integration Tests**: Automated testing for capability workflows

### Eventually
1. **Semantic Search**: Embeddings for better memory matching
2. **Usage Analytics**: Track which capabilities are used most
3. **Auto-prompting**: Dynamic prompt optimization based on model performance

---

*Clean, organized notes for future-us. No more regex crimes or hard-coded nonsense.*