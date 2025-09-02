# Discord Message Flow Diagram

```
USER MESSAGE: "@coachartie calculate 25 * 4"
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. DISCORD BOT (packages/discord/src/handlers/message-handler.ts)          │
│    • Receives Discord message                                              │
│    • Cleans message (removes mentions)                                     │
│    • Sends typing indicator                                                │
│    • Creates status message: "🤔 Working on it... (shortId/jobId)"       │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ HTTP POST /chat
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. CAPABILITIES SERVICE (packages/capabilities/src/routes/chat.ts)         │
│    • Receives message via HTTP API                                         │
│    • Creates job ID                                                        │
│    • Returns: {"messageId": "job-uuid", "status": "pending"}              │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ Queue Job
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. CAPABILITY ORCHESTRATOR (capability-orchestrator.ts)                    │
│    • First LLM call to determine if capabilities are needed                │
│    • LLM Response: "I'll calculate that for you"                          │
│    • Detects no <capability> tags, triggers auto-injection                 │
│    • Auto-injects calculator capability                                    │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ Execute Capabilities
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. CALCULATOR CAPABILITY                                                    │
│    • Executes: 25 * 4 = 100                                               │
│    • Result: "calculator:calculate → 100"                                  │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ Generate Final Response
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. FINAL LLM CALL (generateFinalResponse)                                  │
│    • Prompt: "User asked: calculate 25 * 4"                               │
│    • "Capability results: calculator:calculate → 100"                      │
│    • "Provide coherent response incorporating these results"                │
│    • LLM Response: "Sure thing! 25 * 4 equals **100**"                    │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ Job Complete
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. JOB STORAGE & POLLING                                                    │
│    • Final response stored in job result                                   │
│    • Discord bot polls GET /chat/{jobId} every 3 seconds                  │
│    • When status = "completed", triggers onComplete callback               │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ Message Delivery
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. DISCORD MESSAGE DELIVERY                                                │
│    • onComplete callback receives final response                           │
│    • Updates status message: "✅ Complete! (shortId/jobId)"               │
│    • Chunks response (2000 char limit)                                     │
│    • Sends message(s) to Discord channel                                   │
│    • User sees: "Sure thing! 25 * 4 equals **100**"                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## The Problem We Found

**Step 7 was failing** - the `onComplete` callback wasn't being triggered because:
1. The job status API was sometimes returning malformed responses
2. The Discord bot polling logic wasn't properly handling edge cases
3. Responses were getting stuck in the completion handler

## The Debug Process

1. **Added logging** to track each step
2. **Found** responses were completing but not delivering to Discord
3. **Identified** weak LLM models were generating responses with internal reasoning
4. **Fixed** by ensuring proper response delivery (then removed cleanup function per your request)

## Current State

- ✅ Steps 1-6 working perfectly  
- ❓ Step 7 should now work (needs testing)
- 🚀 Ready for Discord message test

The flow shows **two separate LLM calls**:
- **First**: Determine what to do
- **Second**: Generate human-readable response from capability results