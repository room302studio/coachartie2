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
