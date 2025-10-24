# Coach Artie 2

## IMPORTANT

Only do what is explicitly asked. Don't commit unless requested.

## Ports

```
47319 → Health
47320 → Redis
47321 → Filesystem MCP
47322 → Wikipedia MCP
47323 → ASCII Art MCP
47324 → Capabilities
47325 → Brain UI
47326 → SMS
47327+ → Dynamic MCPs
```

## Start

```bash
npm run dev
```

## Missing

- Discord token in `.env`

## Bug Discovery: Job Tracking Issue (Fixed)

### The Problem

Coach Artie was getting stuck with "Job not found or expired" errors, causing Discord to infinitely retry checking job status.

### Root Cause Analysis

1. **Discord → Capabilities Communication Pattern Mismatch**
   - Discord uses job polling pattern: POST `/chat` → get job ID → poll GET `/chat/{jobId}`
   - Capabilities has the endpoints but wasn't actually tracking jobs

2. **The Missing Link**
   - `/packages/capabilities/src/routes/chat.ts` created job IDs but never called `jobTracker.startJob()`
   - When Discord polled `/chat/{jobId}`, it got 404 because job wasn't in tracker
   - Discord kept retrying every 3 seconds, forever

3. **The Fix Applied**
   - Added `jobTracker.startJob()` when job is created in `/chat` endpoint
   - Added `jobTracker.markJobProcessing()` when queue starts processing
   - Added `jobTracker.updatePartialResponse()` for streaming updates
   - Added `jobTracker.completeJob()` when message processing succeeds
   - Added `jobTracker.failJob()` when errors occur

### Files Modified

- `/packages/capabilities/src/routes/chat.ts` - Added job tracking on creation
- `/packages/capabilities/src/queues/consumer.ts` - Added job status updates during processing

### Testing

After fix, messages should:

1. Get tracked immediately when submitted
2. Update status as they process
3. Complete properly so Discord stops polling
4. No more infinite "Job not found" errors

### Model Configuration

- Locked to Claude 3.5 Sonnet: `OPENROUTER_MODELS=anthropic/claude-3.5-sonnet` in `.env`

## Bloat Cleanup Spree (2025-01-24)

### The Great Deletion: 3,896 Lines Removed 🔥

We went on a cleanup rampage and deleted a ton of overengineered code and stale debugging artifacts. The system is now cleaner, faster, and more maintainable.

**What Got Deleted:**

1. **Regex-based overengineering** (1,253 lines)
   - `passive-listener.ts` (551 lines) - Redundant entity extraction running AFTER LLM analysis
   - `basic-keyword-memory-entourage.ts` (400+ lines) - Hardcoded food/place regex patterns like `/(pizza|burger|taco)/gi`
   - Combined-memory-entourage simplifications (302 lines) - Went from 3-layer to 2-layer (semantic + temporal)

2. **Stoned overengineering** (938 lines)
   - `linkedin-content-generator.ts` (322 lines) - Never registered, never used
   - `deployment-monitor.ts` (270 lines) - Unused scheduling wrapper
   - `deployment-cheerleader.ts` (346 lines) - Non-functional skeleton with hardcoded emoji arrays 🚀🎉✨

3. **Security hazard test files** (606 lines)
   - `test-send-real.ts` - **CONTAINED HARDCODED SENDGRID API KEY** 🚨
   - 8 other debug test scripts (test-calculator-fix.ts, test-todo-fix.ts, etc.)

4. **Old debugging docs** (696 lines)
   - `CALCULATOR_BUG_FIX.md`, `COST_MONITORING_FIX.md`, `TIMEOUT_FIX.md` - Post-mortems for fixed bugs

5. **Stale Discord debugging docs** (403 lines)
   - `DISCORD_DUPLICATE_TEST_PLAN.md` - Test plan for a fixed bug
   - `discord-message-flow.md`, `discord-oncomplete-flow.md` - Debugging artifacts

**What's Still Here (The Good Stuff):**

- ✅ Main capability pipeline with LLM orchestration
- ✅ Semantic memory with real OpenAI vector embeddings
- ✅ Temporal memory entourage for time-based context
- ✅ Context Alchemy for intelligent context assembly
- ✅ All working capabilities and the main system

**Philosophy:**

We deleted code that was either:
- Never used/registered
- Doing inferior work compared to the LLM (regex patterns vs semantic understanding)
- Debugging artifacts from fixed bugs
- Security hazards (hardcoded credentials)

Git history preserves everything if we ever need to reference the old approaches. The fixes are in commits, we don't need markdown detective work cluttering the repo.
