# Discord Duplicate Message Prevention - Test Plan

## 🎯 CRITICAL FIXES IMPLEMENTED

### 1. Race Condition Fix
- **Issue**: Job monitor called `onComplete` then immediately unregistered, but callback was async
- **Fix**: Unregister job FIRST, then call callback (job-monitor.ts:181)
- **Result**: Prevents multiple monitor polls from triggering same completion

### 2. Duplicate Callback Guard  
- **Issue**: No protection against multiple `onComplete` calls on same job
- **Fix**: Added `jobCompleted` flag checked at start of callback (message-handler.ts:507-514)
- **Result**: Blocks any duplicate completion attempts with error logging

### 3. Enhanced Logging
- **Added**: Comprehensive tracking with job IDs, timestamps, and correlation IDs
- **Added**: Specific "DUPLICATE PREVENTION" warning logs
- **Added**: Success confirmation logs after response delivery

## 🧪 TEST SCENARIOS

### Scenario 1: Simple Capability Request
```bash
# Test input: Basic calculator request
User: "Calculate 5 * 8 please"

# Expected behavior:
✅ One job submitted
✅ Job monitor polls periodically  
✅ Job completes → onComplete fires ONCE
✅ Job unregistered immediately
✅ Exactly ONE Discord message sent
✅ Status message updates to "✅ Complete!"

# Failure signs:
❌ "DUPLICATE onComplete CALL BLOCKED" in logs
❌ Two identical responses in Discord
❌ Job still being polled after completion
```

### Scenario 2: Failed Capability Request
```bash
# Test input: Invalid capability or error condition
User: "Search the web for invalid-capability-test"

# Expected behavior:
✅ Job fails gracefully
✅ onError callback fires ONCE
✅ Job unregistered on failure
✅ Exactly ONE error message to Discord
✅ No completion callbacks triggered

# Failure signs:
❌ Multiple error messages
❌ Job keeps polling after error
❌ onComplete called after onError
```

### Scenario 3: Long Response (Chunking Test)
```bash
# Test input: Request that generates >2000 characters
User: "Tell me a very detailed story about programming"

# Expected behavior:
✅ Job completes with long response
✅ Response chunked into multiple Discord messages
✅ All chunks delivered in sequence
✅ NO duplicate chunks
✅ Proper rate limiting between chunks

# Failure signs:
❌ Duplicate chunks sent
❌ Chunks sent out of order
❌ Rate limiting failures
```

### Scenario 4: Streaming Response Test
```bash
# Test input: Capability that supports streaming
User: "Generate a step-by-step plan for learning React"

# Expected behavior:
✅ Partial responses stream to Discord
✅ streamedChunks counter increments
✅ onComplete skips final response (already streamed)
✅ Log shows "already streamed X chunks"

# Failure signs:
❌ Both streamed AND complete response sent
❌ Duplicate streaming chunks
❌ Complete response sent despite streaming
```

### Scenario 5: Rapid Fire Requests
```bash
# Test input: Multiple requests from same user quickly
User: "Calculate 1+1"
User: "Calculate 2+2" (sent immediately)
User: "Calculate 3+3" (sent immediately)

# Expected behavior:
✅ Each request gets unique job ID
✅ Each job tracked independently
✅ Each job completes exactly once
✅ No cross-contamination between jobs
✅ All three responses delivered correctly

# Failure signs:
❌ Jobs interfering with each other
❌ Missing responses
❌ Duplicate responses
❌ Job ID confusion in logs
```

## 🔍 DEBUGGING COMMANDS

### Check for Duplicate Detection
```bash
# Look for duplicate prevention logs
docker logs capabilities-c1 2>&1 | grep -E "(DUPLICATE|already streamed|onComplete CALL BLOCKED)"

# Check job unregistration timing
docker logs capabilities-c1 2>&1 | grep -E "(COMPLETED|unregister|onComplete)"
```

### Monitor Response Delivery
```bash
# Track response sending
docker logs capabilities-c1 2>&1 | grep -E "(📤|Response sent successfully|chunks delivered)"

# Check for streaming conflicts
docker logs capabilities-c1 2>&1 | grep -E "(📡|streaming chunk|streamedChunks)"
```

### Verify Job Lifecycle
```bash
# Full job lifecycle trace
docker logs capabilities-c1 2>&1 | grep -E "(Job submitted|COMPLETED|unregister)" | tail -20
```

## ⚡ PERFORMANCE EXPECTATIONS

- **Single Response Time**: < 3 seconds for simple calculations
- **Chunking Delay**: 200ms between chunks (rate limit protection)  
- **Memory Usage**: No job accumulation (proper unregistration)
- **Duplicate Rate**: 0% (complete prevention)

## 🚨 FAILURE INDICATORS

### Critical Issues
- Multiple identical Discord messages for same request
- "DUPLICATE onComplete CALL BLOCKED" errors in logs
- Jobs continuing to poll after completion
- Response chunks sent out of order

### Performance Issues  
- Jobs timing out due to failed unregistration
- Memory leaks from accumulated pending jobs
- Discord API rate limiting from duplicate requests

## ✅ SUCCESS CRITERIA

1. **Zero Duplicate Messages**: Never send same response twice
2. **Clean Job Lifecycle**: Submit → Poll → Complete → Unregister  
3. **Robust Error Handling**: Graceful failure without cascading issues
4. **Performance**: No memory leaks, proper cleanup
5. **Logging**: Clear audit trail for debugging

## 🎯 EDGE CASES TO MONITOR

1. **Network interruptions** during job polling
2. **Discord API failures** during message sending
3. **Very slow responses** that approach timeout limits
4. **Malformed responses** from capabilities service
5. **Concurrent users** with similar requests

---

**Test Results**: Run these scenarios and document any failures. The fixes implemented should prevent ALL duplicate message issues while maintaining system reliability.