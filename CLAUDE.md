# Coach Artie 2 - Architecture Evolution

## 🧠 MISSION: BULLETPROOF INTELLIGENCE PLATFORM

**Current Sprint:** Systems Thinking & Tool Orchestration
**Philosophy:** LEGO-BLOCK DEVELOPMENT - Combine existing tools, don't build new ones
**Status:** 🔧 ORCHESTRATION-FIRST ARCHITECTURE 🔧

**Vision**: 
```
User: "Build your resume"
System: *orchestrates memory→AI→filesystem using existing tools*
User: "Update your LinkedIn"
System: *chains memories→content generation→posting*
Result: ✨ Complex behaviors from simple, reliable parts ✨
```

## 🎯 CORE PHILOSOPHY: LEGO-BLOCK ARCHITECTURE

Every complex behavior should emerge from combining simple, reliable tools:
- **NO MONOLITHS**: Never build a "resume-builder.ts" 
- **YES ORCHESTRATION**: Chain memory→generation→filesystem
- **IDENTIFY GAPS**: Find missing atomic tools, not missing features
- **FIX THE ATOMS**: Debug individual tools, not complex systems

## 🧠 THE CONSCIENCE WHISPER: Parallel Goal Awareness

**The Simplification:** Every LLM interaction gets a parallel "conscience whisper" injected into context.

```python
async def get_llm_response(user_message: str):
    goals = await get_active_goals()
    conscience_whisper = await cheap_llm(
        f"Goals: {goals}\nUser said: {user_message}\n"
        f"What should I keep in mind? (one sentence)"
    )
    response = await main_llm(
        f"User: {user_message}\n"
        f"[Conscience: {conscience_whisper}]\n"
        f"Respond naturally."
    )
    return response
```

**Example:**
```
User: "I love cereal!"
Conscience: "PR deadline in 45min, but they've been coding for 3 hours straight"
Response: "Nice! Quick cereal break sounds perfect before we tackle that final PR push 🥣"
```

### Goal Tools for Main Thread

```xml
<!-- Check current goals -->
<capability name="goal" action="check" />

<!-- Update goal status -->
<capability name="goal" action="update" goal_id="pr" status="blocked on API" />

<!-- Set new goal -->
<capability name="goal" action="set" objective="Finish resume" deadline="Friday" />

<!-- Complete goal -->
<capability name="goal" action="complete" goal_id="pr" />
```

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

## 🗑️ DELETE-DRIVEN DEVELOPMENT MANIFESTO

**CORE PRINCIPLE:** When system hangs, delete code until it works. No clever fixes, no complex solutions.

**THE DELETE-DRIVEN WAY:**
- Find the bloat, the memory leaks, the duplicate parsers, the orphaned listeners - **DELETE THEM**
- Broken thing? **Delete it**
- Hanging timeout? **Delete the timeout** 
- Memory leak? **Delete the event handlers**
- **Always prefer removing code over adding it**
- **Simple beats complex. Working beats perfect.**

**RECENT DELETE-DRIVEN VICTORIES:**
✅ **Deleted confusing `brain_memories` table** → Brain API now works  
✅ **Deleted regex XML parsing** → Multi-tool detection works perfectly
✅ **Deleted complex MCP auto-install** → Simple embedded runtime approach
✅ **Deleted zombie processes** → Docker isolation eliminates networking chaos

## 🚀 SENIOR STAFF ENGINEER PLANS: "MAKE IT ACTUALLY GOOD"

### 🎯 THE NEW PHILOSOPHY

**Old Mindset**: "Let's add more features and hope it works in production"
**New Mindset**: "Let's build systems that are impossible to break"

**Core Principles:**
1. **Predictive over Reactive** - Prevent failures before they happen
2. **Consensus over Hope** - Multi-model validation for reliability  
3. **Embedded over External** - Reduce external dependencies to zero
4. **Self-Healing over Manual** - Systems that repair themselves
5. **Graceful Degradation** - Never fully fail, always provide some value

### Immediate Priorities

**Priority 1: ✅ COMPLETED - Multi-Tool Detection Fixed**
- DELETE-driven approach: Simple regex patterns replace complex XML parsing  
- Einstein workflow proven: `<search-wikipedia>X</search-wikipedia> then <calculate>Y</calculate>`

**Priority 2: ✅ COMPLETED - Simple Self-Healing**
- ✅ Wired `simple-healer.ts` into main service startup
- ✅ Auto-restart Wikipedia MCP when registry empty
- ✅ Force GC when memory > 200MB

**Priority 3: Fix Concurrency Bottleneck**  
- Implement hybrid memory + async persistence
- Eliminate SQLite locking issues

**Priority 4: Add Model Consensus**
- Multi-model validation for reliability
- Graceful handling of model hallucinations

## ✅ CURRENT STATUS

### POC Infrastructure Complete
- ✅ **XML Parsing**: 100% regex-free, functional  
- ✅ **MCP Process Spawning**: Working but being replaced with embedded runtime
- ✅ **Simple XML Syntax**: Functional (`<search-wikipedia>`, `<calculate>`)
- ✅ **Docker Deployment**: Basic production setup complete
- ✅ **Integration Testing**: Core functionality validated

### Known Limitations (Being Addressed)
- ❌ **External Process Dependencies**: NPM/network failures cause outages (→ Embedded Runtime)
- ❌ **SQLite Concurrency**: Bottleneck under load (→ Hybrid Memory Layer)
- ❌ **Free Model Unreliability**: Single model can hallucinate (→ Consensus Engine)
- ❌ **No Self-Healing**: Manual intervention required (→ Auto-repair system)

## 🔧 Development Workflow

### Start Services
```bash
# RECOMMENDED: Use Docker for reliable process management
docker-compose up -d redis
docker-compose up --build capabilities

# OR: Local development (prone to port conflicts)
cd /Users/ejfox/code/coachartie2
pnpm run dev:clean    # Kill zombies + fresh start
```

### Test Endpoints
```bash
# Docker (port 18239)
curl http://localhost:18239/health
curl -X POST http://localhost:18239/chat -H "Content-Type: application/json" -d '{"message":"<search-wikipedia>python</search-wikipedia>","userId":"test"}'

# Local development (various ports)
curl http://localhost:23701/health
```

### Database
```bash
sqlite3 data/coachartie.db
.tables
SELECT * FROM memories WHERE user_id = 'ejfox' LIMIT 3;
```

## 🎯 SUCCESS METRICS

**Reliability Targets:**
- 99.99% uptime (current ~95%)
- Sub-100ms response times (current ~500ms)
- Zero manual interventions per week
- Auto-healing 95% of issues

**Performance Targets:**
- Handle 1000+ concurrent users (current ~10)
- Memory usage stays flat over time (no leaks)
- Zero resource exhaustion scenarios

---

**STATUS**: Infrastructure Complete, Vision Clear, Path Forward Defined  
**NEXT**: Build unbreakable systems through superior architecture! ✨🚀