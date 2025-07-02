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

**Last Updated:** 2025-06-30 19:30 UTC  
**Status:** Brain Integration Started 🧠 | Migration Plan Created 📋 | Ready for Implementation 🚀

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

## 🚨 CURRENT ISSUE: Port Conflicts (2025-06-30)
**Problem**: Multiple service instances causing port binding conflicts
**Symptoms**: 
- Capabilities service: "❌ PORT CONFLICT: Port 18239 is already in use!"
- SMS service: "❌ PORT CONFLICT: Port 27461 is already in use!"
- Multiple tsx processes running from previous sessions
- Services crash immediately due to port conflicts

**Root Cause**: Previous development sessions left processes running
- Found multiple coachartie2 tsx processes still active
- Services attempting to bind to already occupied ports
- Need to clean up zombie processes

**Solution Applied**:
```bash
# Kill all coachartie2 processes
pkill -f "coachartie2"
# Or more targeted:
ps aux | grep coachartie2 | grep -v grep | awk '{print $2}' | xargs kill
```

**Status**: ⚠️ DAILY RECURRING ISSUE - Need permanent fix

**PERMANENT SOLUTION IMPLEMENTED** ✅:
```bash
# Now available in package.json
pnpm run dev:clean    # Kills all processes + starts fresh
pnpm run kill-all     # Just kills processes
```

**Commands added to package.json**:
- `kill-all`: Kills all coachartie2 tsx/node processes
- `dev:clean`: Clean kill + restart (use this every time)

**Why This Keeps Happening**:
- tsx watch processes don't die when terminals close
- Multiple dev sessions leave zombie processes
- No graceful shutdown handling
- Process management is fundamentally broken

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

### ⚠️ NEEDS WORK
- **MCP stdio://**: Only HTTP/HTTPS supported, can't connect to local servers
- **CapabilitySuggester**: Broken substring matching, needs keyword improvements

### 🎯 PLANNED WORK
- **Brain Migration**: Integrate existing Vue brain (https://github.com/room302studio/coachartie_brain) with local SQLite
- **Networking Issue**: Port binding claims success but connections fail (needs system reboot)

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

### Immediate (This Session)
1. **Fix Port Conflicts**: Clean up zombie processes and restart services properly
2. **Test Service Health**: Verify all endpoints work after cleanup
3. **Update Service Ports**: Document actual working ports (not just planned ones)

### Soon  
1. **Brain Frontend Migration**: Integrate Vue.js brain with local SQLite + capabilities API
2. **stdio:// MCP Support**: Enable local MCP calculator server connection
3. **Service Monitoring**: Add health checks and automatic restart logic
4. **Docker Alternative**: Consider containerized development to avoid port conflicts

### Eventually
1. **Process Management**: Implement proper process lifecycle management
2. **Service Discovery**: Automatic port allocation and service registry
3. **Integration Tests**: Automated testing for capability workflows
4. **Production Deployment**: Move beyond development mode conflicts

---

*Clean, organized notes for future-us. No more regex crimes or hard-coded nonsense.*