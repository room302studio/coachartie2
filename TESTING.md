# Context Alchemy v3 Testing Guide

## What Changed

### 1. Configurable Context Window
**File:** `.env`
```bash
CONTEXT_WINDOW_SIZE=32000  # Change this to scale everything
```

**Scales automatically:**
- 4k → Minimal (free models)
- 8k → Original baseline
- 16k → 2x everything
- 32k → Current (recommended)
- 64k → Beast mode

### 2. Hybrid Memory (70/30 Split)
**Behavior:**
- 70% recent messages from current channel
- 30% recent messages from ANY channel

**Test it:**
1. Have Subway Builder conversation in Channel A
2. Ask about Subway Builder in Channel B
3. Artie should reference Channel A conversation!

### 3. Bug Fixes Applied
- ✅ Docker volume mount fixed
- ✅ Database permissions (666)
- ✅ XML leak in summaries fixed
- ✅ includeCapabilities flag working

## Testing Checklist

### Basic Function
- [ ] Artie responds to messages
- [ ] Context window shows 32000 in logs
- [ ] No database I/O errors

### Conversation Memory
- [ ] Artie remembers recent chat in SAME channel
- [ ] Artie recalls some context from OTHER channels
- [ ] Follow-up questions work naturally

### Cross-Channel Awareness
- [ ] Discuss topic in Channel A
- [ ] Ask about same topic in Channel B
- [ ] Verify Artie brings in Channel A context

### Memory Integration
- [ ] Memory search finds relevant info
- [ ] Artie uses memories to enhance responses
- [ ] Proactive capability use (web search when needed)

## Log Verification

Watch for these in `docker logs coachartie2-capabilities-1`:

```
✅ Success indicators:
│ Total Window: 32000 tokens
│ ✅ Loaded XX messages from conversation history
│ 💬 Adding XX messages from conversation history
🧠 Semantic: X memories, X% confidence

❌ Error indicators:
SQLITE_IOERR: disk I/O error
Failed to load conversation history
⚠️ No relevant memories found (might be expected)
```

## Adjust Context Size

Want to experiment?

```bash
# Conservative (cost-optimized)
CONTEXT_WINDOW_SIZE=16000

# Generous (recommended)
CONTEXT_WINDOW_SIZE=32000

# Beast mode (maximum awareness)
CONTEXT_WINDOW_SIZE=64000
```

Then: `docker-compose restart capabilities`

## Expected Behavior

**Before (v2):**
- Channel-isolated conversations
- No cross-context awareness
- "I don't know about Subway Builder" in different channel

**After (v3):**
- Blended memory across channels
- Cross-context awareness
- "Based on our Subway Builder discussion..." from any channel

## Cost Impact

At 32k context:
- Input: ~$0.096/message
- Still pennies, massive UX improvement
- Can scale down to 16k if needed

---

Ready for testing! 🚀
