# Timeout Fix - Architectural Analysis

## The Problem

A 2-minute timeout was added to `executeLLMDrivenLoop()` in capability-orchestrator.ts, but jobs still ran for >2 minutes without timing out.

### Why the Previous Timeout Didn't Work

**Call Stack When Calculator Fails:**

```
processMessage()
  → orchestrateMessage()
    → assembleMessageOrchestration()
      → executeLLMDrivenLoop()
        → while (iteration < 24) {
            checkTimeout()           ← TIMEOUT CHECK HERE (line 1141)
            ↓
            capability execution
              → robustExecutor.executeWithRetry()
                → for (attempt = 1; attempt <= 3; attempt++) {
                    try calculator                ← STUCK HERE
                    wait 100ms, 200ms, 400ms
                  }
                → tryFallbackExecution()
          }
```

**The Issue:** The timeout check is at the TOP of the while loop, but the code is stuck INSIDE the retry loop. The retry loop (3 attempts + fallback) completes, then the LLM extracts the same broken capability again, and the cycle repeats. The timeout check never executes because we never complete an iteration.

## The Solution

### Layer 1: Global Job Timeout (NEW)

**File:** `/packages/capabilities/src/queues/consumer.ts` (line 61-81)

```typescript
// CRITICAL: Global timeout to prevent infinite loops at ANY level
const GLOBAL_TIMEOUT_MS = 120000; // 2 minutes
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(new Error('Global job timeout after 120s'));
  }, GLOBAL_TIMEOUT_MS);
});

const processingPromise = processMessage(message, callback);

// Race between actual processing and timeout
const response = await Promise.race([processingPromise, timeoutPromise]);
```

**Why This Works:**

- The timeout runs INDEPENDENTLY of the processing code
- It doesn't matter if we're stuck in retry loops, LLM iterations, or database calls
- After 120 seconds, the timeout promise rejects and Promise.race() returns that rejection
- Catches infinite loops at ANY architectural level

### Layer 2: LLM Loop Timeout (EXISTING)

**File:** `/packages/capabilities/src/services/capability-orchestrator.ts` (line 1118-1128)

```typescript
const GLOBAL_TIMEOUT_MS = 120000;
const startTime = Date.now();

const checkTimeout = () => {
  const elapsed = Date.now() - startTime;
  if (elapsed > GLOBAL_TIMEOUT_MS) {
    throw new Error(`Orchestration timeout after ${elapsed / 1000}s`);
  }
};

while (iterationCount < maxIterations) {
  checkTimeout(); // Called at start of each iteration
  // ... rest of loop
}
```

**Why Keep This:**

- Defense in depth - two independent timeout mechanisms
- This one provides more specific error context (which iteration we were on)
- If the consumer-level timeout fails for any reason, this catches it

### Layer 3: Circuit Breaker (NEW)

**File:** `/packages/capabilities/src/services/capability-orchestrator.ts` (line 1193-1258)

```typescript
interface OrchestrationContext {
  // ... existing fields
  capabilityFailureCount: Map<string, number>; // Track failures per capability
}

// In executeLLMDrivenLoop():
const capabilityKey = `${capability.name}:${capability.action}`;
const failureCount = context.capabilityFailureCount.get(capabilityKey) || 0;
const MAX_FAILURES_PER_CAPABILITY = 5;

if (failureCount >= MAX_FAILURES_PER_CAPABILITY) {
  logger.warn(`Circuit breaker open for ${capabilityKey}`);
  systemFeedback += `[SYSTEM: ${capabilityKey} circuit breaker open - try different approach]\n`;
  continue; // Skip this capability
}

// After execution:
if (result.success) {
  context.capabilityFailureCount.set(capabilityKey, 0); // Reset on success
} else {
  context.capabilityFailureCount.set(capabilityKey, failureCount + 1); // Increment
}
```

**Why This Helps:**

- Prevents the LLM from retrying the same broken capability endlessly
- After 5 total failures of `calculator:calculate`, circuit opens
- System feedback tells LLM to try a different approach
- Reduces time wasted on capabilities that won't work
- Complements the timeout by reducing retry loops

## How They Work Together

**Scenario: Calculator capability keeps failing**

Without fixes:

1. LLM extracts `<capability name="calculator" action="calculate" />`
2. robustExecutor tries 3 times (100ms, 200ms, 400ms delays)
3. Tries fallback
4. All fail, returns error to LLM
5. LLM extracts same broken capability again
6. Repeat steps 2-5 indefinitely
7. Timeout check never executes because we never complete iteration

With fixes:

1. LLM extracts broken calculator capability
2. robustExecutor tries 3 times (700ms total)
3. Fails, increments circuit breaker counter to 1
4. LLM tries again
5. Fails, counter = 2
6. LLM tries again
7. Fails, counter = 3
8. LLM tries again
9. Fails, counter = 4
10. LLM tries again
11. Fails, counter = 5
12. Circuit breaker opens, further attempts skipped
13. System tells LLM to try different approach
14. If LLM still loops, global timeout at consumer level fires after 120s

## Testing the Fix

**Manual Test:**

1. Send a message that triggers a capability with missing parameters
2. Verify circuit breaker opens after 5 failures
3. Verify global timeout fires if loop continues beyond 120s

**Expected Behavior:**

- Circuit breaker should open around 5-10 seconds (5 failures × ~2s per retry cycle)
- Global timeout should fire at exactly 120 seconds as hard limit
- Job should complete with error message, not hang indefinitely

## Files Modified

1. `/packages/capabilities/src/queues/consumer.ts`
   - Added Promise.race() timeout wrapper around processMessage()

2. `/packages/capabilities/src/services/capability-orchestrator.ts`
   - Added capabilityFailureCount to OrchestrationContext interface
   - Added circuit breaker logic in executeLLMDrivenLoop()
   - Kept existing timeout as secondary defense

## Architecture Lessons

**Key Insight:** Timeouts must be at a level ABOVE where the blocking can occur.

- ❌ WRONG: Timeout check inside a loop that contains blocking operations
- ✅ CORRECT: Timeout as independent Promise that races against blocking operations

**Pattern to Use:**

```typescript
const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
);

const result = await Promise.race([doWorkThatMightHang(), timeoutPromise]);
```

This pattern works because:

1. The timeout runs on the event loop INDEPENDENTLY
2. It doesn't depend on the blocking code making progress
3. Promise.race() returns whichever promise settles first
4. Even if doWorkThatMightHang() never resolves, timeout will reject

---

_Document created by SARAH - Systems Architecture for Reliable Async Handling_
