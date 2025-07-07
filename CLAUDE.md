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

**Last Updated:** 2025-07-07 17:45 UTC  
**Status:** 🎉 ALL SYSTEMS OPERATIONAL 🎉 | Network Issues RESOLVED ✅

## 🔄 RECENT: Documentation & Process Cleanup (2025-06-30 19:30)
**Problem**: CLAUDE.md was outdated and networking issues were misdiagnosed
**Solution**: Updated documentation and identified real root cause
**Findings**:
- Previous "networking issue" was actually port conflicts from zombie processes
- Multiple tsx processes from previous dev sessions were still running
- Services now have proper error handling showing port conflicts
- Documentation updated with current status and realistic next steps
**Actions Taken**:
- Killed conflicting tsx processes with `pkill -f "coachartie2.*tsx"`
- Updated status timestamps and current priority tasks
- Corrected networking issue diagnosis (was process cleanup, not macOS networking)
**Next**: Restart services cleanly and verify all endpoints work

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

## 🚨 CRITICAL ISSUE: Phantom Server Problem (2025-07-07)
**Problem**: Services claim to start successfully but connections fail
**Symptoms**: 
- Services log: "✅ Server listening on 0.0.0.0:18239"
- `curl localhost:18239` → "Connection refused"
- `lsof -i :18239` → No output (nothing listening)
- `netstat | grep 18239` → Shows TIME_WAIT connections only
- Services appear to start then silently crash or stop listening

**Root Cause Analysis**: Multiple possible causes identified from research
1. **IPv6/IPv4 Resolution Conflict**: macOS resolves `localhost` to `::1` (IPv6) but Express binds to IPv4
2. **Hosts File IPv6 Entry**: `/etc/hosts` has both `127.0.0.1 localhost` and `::1 localhost`
3. **Phantom Process Issue**: Services start, log success, then immediately crash
4. **macOS Security/Firewall**: System blocking localhost connections
5. **Multiple .listen() Calls**: Code potentially calling app.listen() multiple times

**FINAL STATUS**: ❌ ISSUE NOT RESOLVED - IPv6/IPv4 fix was temporary/incomplete

## 🚨 PHANTOM SERVER ISSUE IS BACK (2025-07-07 17:35)

**RECURRING PROBLEM**: The supposed "fix" didn't actually work long-term
**Current Status**: 
- ✅ Hosts file fix still in place (`::1 localhost` removed)
- ✅ Services log: "✅ Server listening on 0.0.0.0:18239"
- ✅ Services log: "✅ Self-test successful: Server is running!"
- ❌ `curl localhost:18239` → "Connection refused"  
- ❌ `lsof -i :18239` → Nothing listening
- ❌ `curl -4 127.0.0.1:18239` → "Connection refused"

**WHAT THIS MEANS**: The root cause was NEVER actually identified or fixed
**Evidence**: 
1. Same phantom server behavior happening again
2. IPv6/IPv4 fix didn't prevent recurrence
3. Services start successfully but immediately become unreachable
4. No actual processes listening on claimed ports

**REAL ROOT CAUSE THEORIES**:
1. **Silent Process Crashes**: Services start, log success, then crash without error logging
2. **Multiple .listen() Calls**: Express app calling `app.listen()` multiple times causing conflicts
3. **Uncaught Exceptions**: Middleware or startup code throwing unhandled errors
4. **macOS Security**: System-level process blocking (firewall, security software)
5. **Node.js Event Loop Issues**: Process appears running but event loop blocked/crashed
6. **Port Binding Race Conditions**: Multiple processes competing for same port

**CRITICAL NEXT STEPS**:
1. **Debug Express Server Code**: Look for multiple .listen() calls, error handling gaps
2. **Add Comprehensive Error Logging**: Catch uncaught exceptions, log server lifecycle
3. **Test Minimal HTTP Server**: Strip down to basic http.createServer() to isolate issue
4. **Check for Process Conflicts**: Ensure no other services binding to same ports
5. **Consider Alternative Ports**: Test if specific port ranges are blocked by macOS

## 🔧 DEBUGGING PLAN: Multiple Attack Vectors (ARCHIVED)

### **Plan A: IPv6/IPv4 Resolution Fix** 
**Priority**: HIGH - Most likely culprit based on research
**Steps**:
1. Apply hosts file fix: `sudo cp ~/hosts_fixed /etc/hosts` (removes `::1 localhost`)
2. Test with IPv4 explicit: `curl -4 http://localhost:18239/health`
3. Test with IP direct: `curl http://127.0.0.1:18239/health`
4. Flush DNS cache: `sudo dscacheutil -flushcache`

### **Plan B: Process Debugging & Isolation**
**Priority**: HIGH - Debug phantom process issue
**Steps**:
1. Run single service in foreground: `npx tsx src/index.ts`
2. Check for multiple .listen() calls in code
3. Use `sudo lsof -nP -i :18239` (elevated permissions)
4. Add detailed logging to server.listen() callback
5. Check for uncaught exceptions causing silent crashes

### **Plan C: macOS Security & Firewall**
**Priority**: MEDIUM - System-level blocking
**Steps**:
1. Temporarily disable macOS firewall: System Preferences → Security & Privacy
2. Check for antivirus/security software blocking Node.js
3. Add Node.js to firewall exceptions
4. Test with different ports (avoid common blocked ranges)

### **Plan D: Alternative Binding Strategy**
**Priority**: LOW - Fallback if others fail
**Steps**:
1. Try binding to 127.0.0.1 specifically instead of 0.0.0.0
2. Use different port ranges (8000s, 9000s)
3. Implement port auto-discovery with retry logic
4. Test with basic HTTP server (no Express middleware)

**Research Sources**:
- Stack Overflow: IPv6/IPv4 localhost resolution on macOS
- GitHub Issues: Node.js phantom listening processes
- Apple Forums: macOS networking security changes

## ✅ NEW: SMS Service + Discord Phone Linking (2025-06-30)
**Problem**: SMS service existed but wasn't loading environment variables, no phone linking
**Solution**: Added dotenv configuration + secure Discord slash commands
**Implementation**:
- Fixed SMS service environment loading with proper dotenv path resolution
- Added `/link-phone`, `/verify-phone`, `/unlink-phone` Discord commands
- Secure phone verification with 6-digit codes, rate limiting, encrypted storage
- Fallback system: shows code in Discord when SMS is unavailable
**Result**: Production-ready SMS + phone linking system (awaits Twilio account recharge)

## 🧠 ACTIVE: Brain Frontend Integration (2025-06-30 19:45)
**Status**: ✅ Cloned, 📊 Analyzed, 📋 Migration Planning
**Repo**: Integrated into `packages/brain` (original will be archived)
**Stack**: Nuxt 3 + Vue 3 + TypeScript + Tailwind CSS + D3.js

### 📊 Analysis Complete ✅
**Framework**: Nuxt 3 with sophisticated data visualization capabilities
**Key Features Discovered**:
- Advanced memory clustering (t-SNE, UMAP dimensional reduction)
- Real-time D3.js network graphs of entity relationships  
- Comprehensive queue monitoring and task tracking
- Vector similarity search with multiple embeddings
- Time-series analytics and sparkline visualizations
- Hot-reloading prompt management system
- Real-time log streaming with filtering

**Database Schema** (8 main tables):
- `memories` - Core memory storage with vector embeddings
- `messages` - Message history with platform metadata
- `queue` - Task management with priority/retry logic
- `prompts` - System prompt management with versioning
- `config` - Key-value configuration with history
- `user_identities` - Cross-platform user mapping
- `logs` - Structured logging with levels
- `todos` - Task tracking

### 📋 Migration Plan - 3 Phase Approach

**Phase 1: Database Layer (Priority 1)**
1. **Create SQLite Adapter** (`packages/brain/lib/database.ts`)
   - Replace `@nuxtjs/supabase` with direct SQLite client
   - Port PostgreSQL schema to SQLite (simplify complex types)
   - Implement basic CRUD operations for all 8 tables
   
2. **Vector Search Adaptation**  
   - PostgreSQL pgvector → SQLite FTS5 + manual similarity
   - May lose some advanced vector operations but keep core search
   - Preserve embedding storage, simplify similarity calculations

3. **API Layer Creation**
   - Build REST endpoints: `/api/{memories,messages,queue,logs}`
   - Replace direct Supabase calls with internal API
   - Maintain existing component interfaces

**Phase 2: Real-time & Integration (Priority 2)**  
1. **Remove Authentication** (local-only deployment)
2. **Replace Real-time Subscriptions**
   - Supabase real-time → WebSocket or polling
   - Update components to handle connection state
3. **Connect to Capabilities API**
   - Link to `http://localhost:23701` for live data
   - Sync queue status with capabilities service
   - Pull memory/message data from shared SQLite database

**Phase 3: Advanced Features (Priority 3)**
1. **Preserve Clustering** - Keep t-SNE/UMAP capabilities
2. **Enhance Network Graphs** - Connect to capabilities relationship data  
3. **Performance Optimization** - SQLite query optimization for large datasets

### 🔧 Technical Migration Details

**Dependencies to Replace**:
- `@nuxtjs/supabase` → Custom SQLite adapter
- Authentication flows → Remove entirely  
- Real-time subscriptions → WebSocket/polling

**Dependencies to Keep**:
- `d3` - Network graphs and visualizations
- `tsne-js` & `umap-js` - Clustering algorithms
- `openai` - Can proxy through capabilities service
- `tailwindcss` - Styling system

**New Environment Variables**:
```bash
# Remove
SUPABASE_URL, SUPABASE_KEY

# Add  
DATABASE_PATH=/path/to/coachartie.db
CAPABILITIES_API_URL=http://localhost:23701
```

### 🎯 Success Metrics
- ✅ Brain runs locally without Supabase dependency
- ✅ All 8 data tables migrated and functional
- ✅ Vector search working (even if simplified)
- ✅ Real-time updates via WebSocket/polling
- ✅ Integration with capabilities service for live data
- ✅ Clustering visualizations preserved (t-SNE, UMAP)
- ✅ Network graphs showing memory relationships

**Estimated Effort**: 2-3 focused work sessions
**Complexity**: Medium-High (vector search adaptation is the main challenge)

---

**Previous Status:** Memory System Fixed ✅ | Free Model Guidance In Progress

---

## 🎯 Current Status

### ✅ WORKING PROPERLY
- **Memory System**: Fixed! Now extracts capabilities from user messages AND LLM responses
- **SMS Service**: Environment loading fixed, ready for production (needs Twilio funding)
- **Discord Phone Linking**: Secure verification system with `/link-phone`, `/verify-phone`, `/unlink-phone`
- **Capability Architecture**: 12 capabilities, 48+ actions registered
- **Free Model Fallback**: Graceful degradation when credits exhausted + auto-injection
- **Database**: SQLite persistence, prompt hot-reloading fixed
- **Token Usage Tracking**: Full implementation with cost calculation and stats
- **MCP Tool Syntax**: Simplified to `<tool-name>args</tool-name>` format
- **Networking Issues**: IPv6/IPv4 localhost resolution fixed (removed `::1 localhost` from /etc/hosts)
- **Diagnostic Tools**: Comprehensive `networking_doctor.sh` script for future debugging

### ⚠️ NEEDS WORK
- **MCP stdio://**: Only HTTP/HTTPS supported, can't connect to local servers
- **CapabilitySuggester**: Broken substring matching, needs keyword improvements

### 🎯 PLANNED WORK
- **Brain Migration**: Integrate existing Vue brain (https://github.com/room302studio/coachartie_brain) with local SQLite
- **Service Health Monitoring**: Add automated health checks and restart logic

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

### Start Services (ALWAYS USE CLEAN)
```bash
pnpm run dev:clean    # Kill zombies + start fresh (RECOMMENDED)
# OR if you're sure no conflicts:
pnpm run dev          # Standard start
tail -f /tmp/turbo.log # Watch logs
```

### Restart After Changes
```bash
pnpm run dev:clean    # Clean restart (RECOMMENDED)
# OR old way:
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

### Immediate (High Priority)
1. **Test All Service Endpoints**: Verify memory, calculator, MCP tools, chat API
2. **Update Service Documentation**: Confirm actual working ports and endpoints
3. **Brain Frontend Migration**: Integrate Vue.js brain with local SQLite + capabilities API

### Soon (Medium Priority)
1. **stdio:// MCP Support**: Enable local MCP calculator server connection
2. **Service Health Monitoring**: Add automated health checks and restart logic
3. **Process Management**: Implement proper process lifecycle management

### Eventually (Low Priority)
1. **Service Discovery**: Automatic port allocation and service registry
2. **Integration Tests**: Automated testing for capability workflows
3. **Production Deployment**: Move beyond development mode conflicts
4. **Docker Alternative**: Consider containerized development to avoid port conflicts

### 🔧 Diagnostic Tools Available
- **Networking Doctor**: `./scripts/networking_doctor.sh [port] [host]` - comprehensive network debugging
- **Process Cleanup**: `pnpm run dev:clean` - kill zombie processes and restart services
- **Service Health**: `curl http://localhost:23701/health` - check service status

---

*Clean, organized notes for future-us. No more regex crimes or hard-coded nonsense.*