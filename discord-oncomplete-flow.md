# Discord onComplete Callback Flow - Deep Dive

```
DISCORD BOT POLLS JOB EVERY 3 SECONDS
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ CAPABILITIES CLIENT POLLING LOOP                                           │
│ (packages/discord/src/services/capabilities-client.ts:110-162)            │
│                                                                             │
│ const poll = async () => {                                                  │
│   attempts++;                                                               │
│   const status = await this.checkJobStatus(messageId); ← GET /chat/{id}    │
│   if (onProgress) { onProgress(status); }                                   │
│                                                                             │
│   if (status.status === 'completed') { ← THE CRITICAL CHECK               │
│     logger.info(`🎯 Job completed, response exists: ${!!status.response}`) │
│     if (status.response && onComplete) { ← DOUBLE CONDITION               │
│       logger.info(`🎯 Calling onComplete with ${status.response.length}`)  │
│       onComplete(status.response); ← CALLBACK TRIGGER                     │
│     } else {                                                                │
│       logger.warn(`🎯 NOT calling onComplete - response: ${!!status.response}, callback: ${!!onComplete}`) │
│     }                                                                       │
│   }                                                                         │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓ IF CALLBACK TRIGGERS
┌─────────────────────────────────────────────────────────────────────────────┐
│ DISCORD MESSAGE HANDLER onComplete CALLBACK                                │
│ (packages/discord/src/handlers/message-handler.ts:291-390)                │
│                                                                             │
│ onComplete: async (result) => {                                            │
│   logger.info(`🎯 onComplete handler started with result length: ${result.length}`) │
│   const duration = Date.now() - startTime;                                 │
│   // Stop typing...                                                         │
│   logger.info(`🎯 About to check statusMessage, exists: ${!!statusMessage}`) │
│   if (statusMessage) {                                                      │
│     logger.info(`🎯 About to edit statusMessage`)                          │
│     await statusMessage.edit(`✅ Complete! (${shortId}/${jobShortId})`)     │
│     logger.info(`🎯 Successfully edited statusMessage`)                     │
│                                                                             │
│     logger.info(`📝 About to send ${chunks.length} chunks`)                │
│     for (let i = 0; i < chunks.length; i++) {                             │
│       logger.info(`📤 Sending chunk ${i + 1}/${chunks.length}`)            │
│       await message.channel.send(chunks[i]); ← ACTUAL DISCORD SEND        │
│     }                                                                       │
│     logger.info(`✅ Successfully delivered ${chunks.length} chunks`)       │
│   }                                                                         │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## FAILURE POINTS ANALYSIS

### 1. POLLING NEVER SEES COMPLETED STATUS

**Symptom:** No debug logs at all
**Cause:** Job API returns wrong status or polling stops early
**Debug:** Check if `GET /chat/{jobId}` returns `status: "completed"`

### 2. STATUS IS COMPLETED BUT NO RESPONSE FIELD

**Symptom:** See "🎯 Job completed" but "🎯 NOT calling onComplete"
**Cause:** API response missing `response` field or it's null/empty
**Debug:** `curl -s "http://localhost:18239/chat/{jobId}" | jq .response`

### 3. onComplete CALLBACK NEVER DEFINED

**Symptom:** See "🎯 Job completed" but "callback: false"
**Cause:** Message handler didn't pass onComplete function
**Debug:** Check pollJobUntilComplete call has onComplete parameter

### 4. onComplete TRIGGERS BUT FAILS IMMEDIATELY

**Symptom:** See "🎯 onComplete handler started" but nothing after
**Cause:** Error in first few lines of callback (duration calc, typing stop)
**Debug:** Check for exceptions in callback

### 5. statusMessage.edit() FAILS

**Symptom:** See "🎯 About to edit statusMessage" but no "Successfully edited"
**Cause:** Discord API error, permissions, or message deleted
**Debug:** Discord API permissions or rate limiting

### 6. CHUNKING OR SENDING FAILS

**Symptom:** See "📝 About to send X chunks" but no "📤 Sending chunk"
**Cause:** Message too long, Discord permissions, or channel error
**Debug:** Check chunk sizes and channel.send() permissions

## THE CURRENT EVIDENCE

From our testing:

- ✅ Jobs complete successfully (`"status": "completed"`)
- ✅ Responses exist (`"response": "analysisWe need..."`)
- ✅ Discord shows "✅ Complete!" (statusMessage.edit works)
- ❌ No debug logs from onComplete callback
- ❌ No actual message delivery to Discord

**HYPOTHESIS:** The issue is in **FAILURE POINT #2 or #3**

- Either `status.response` is falsy when polled by Discord
- Or `onComplete` callback was never properly passed to the polling function

## DEBUGGING COMMANDS

```bash
# Test if polling sees the right status
curl -s "http://localhost:18239/chat/{recent-job-id}" | jq '{status, response: (.response | length)}'

# Check Discord bot logs for polling debug messages
docker logs coachartie2-discord-1 2>&1 | grep "🎯"

# Test callback definition
grep -A5 -B5 "onComplete:" packages/discord/src/handlers/message-handler.ts
```

## MOST LIKELY ROOT CAUSE

The `onComplete` callback is **never being triggered** because:

1. **Timing issue**: Discord polls before job is fully saved
2. **Response field missing**: Job completes but response isn't stored properly
3. **Callback not passed**: pollJobUntilComplete call missing onComplete parameter
4. **Silent exception**: Error in polling kills the callback silently

The fact that we see **zero debug logs** from the onComplete handler strongly suggests the callback isn't being invoked at all.
