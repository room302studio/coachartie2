# Coach Artie 2 - Development SITREP

**Last Updated:** 2025-06-26 15:00:00 UTC  
**Status:** Memory System Fixed ✅ | Free Model Guidance In Progress

---

## 🎯 Current Status

### ✅ WORKING PROPERLY
- **Memory System**: Fixed! Now extracts capabilities from user messages AND LLM responses
- **Basic API**: Chat endpoint on port 23701, all services healthy  
- **Capability Architecture**: 10 capabilities, 41+ actions registered
- **Free Model Fallback**: Graceful degradation when credits exhausted
- **Database**: SQLite persistence, prompt hot-reloading fixed

### ⚠️ NEEDS WORK
- **Free Model Guidance**: Models ignore capability suggestions
- **MCP stdio://**: Only HTTP/HTTPS supported, can't connect to local servers
- **Tool Suggestions**: Half-baked, need simple fallback detection

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

**Next Approach**: Simple fallback detection
- If LLM response has no capability tags AND user asked about preferences → auto-inject memory search
- If user asks math question AND no calculator tag → auto-inject calculator
- Keep it stupid simple

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
1. **Test CapabilitySuggester**: See what it actually returns for common queries
2. **Implement Fallback Detection**: If no capabilities found, auto-inject obvious ones
3. **Test End-to-End**: Verify memory recall works naturally

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