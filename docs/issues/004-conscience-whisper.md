# Issue #004: Implement Conscience Whisper Integration

## User Story
As Coach Artie, I need a parallel conscience that whispers goal context into every LLM response so that I can maintain awareness of long-term objectives while naturally conversing with users.

## Background
Based on our architecture design, every LLM call should automatically get a "conscience whisper" - a quick, cheap LLM call that provides goal context. This whisper is injected into the main LLM's prompt, allowing natural incorporation of goal awareness without forced reminders.

## Acceptance Criteria
- [ ] Every LLM call automatically triggers a parallel conscience whisper
- [ ] Conscience uses a cheap/fast model (e.g., Phi-3-mini, Mistral-7B)
- [ ] Whisper completes within 200ms (doesn't slow main response)
- [ ] Whisper context is injected into main LLM prompt
- [ ] Main LLM can naturally incorporate or ignore the whisper
- [ ] Whisper has access to: active goals, recent user history, current time
- [ ] Can be disabled via environment variable for testing
- [ ] Whisper content is logged for debugging

## Technical Requirements

### Integration Point
```typescript
// In openrouter.service.ts or wherever LLM calls happen
async function getLLMResponse(prompt: string, user_id: string): Promise<string> {
  // Fire and forget - don't wait at all
  const whisperPromise = getConscienceWhisper(prompt, user_id);
  
  // Store for NEXT interaction (not this one)
  whisperPromise
    .then(whisper => {
      // Store in context for next call
      userContext[user_id].lastWhisper = whisper;
      userContext[user_id].whisperTime = Date.now();
    })
    .catch(() => {}); // Silent fail
  
  // Use PREVIOUS whisper if available and recent (< 5 min old)
  const previousWhisper = userContext[user_id]?.lastWhisper;
  const whisperAge = Date.now() - (userContext[user_id]?.whisperTime || 0);
  
  const enhancedPrompt = (previousWhisper && whisperAge < 300000)
    ? `${prompt}\n[Context: ${previousWhisper}]`
    : prompt;
  
  return await mainLLM.generate(enhancedPrompt);
}
```

### Conscience Service
```typescript
class ConscienceService {
  private model = 'microsoft/phi-3-mini-128k-instruct:free';
  
  async getWhisper(userMessage: string, user_id: string): Promise<string> {
    // Get context
    const goals = await this.getActiveGoals(user_id);
    const recentHistory = await this.getRecentInteractions(user_id, 5);
    const currentTime = new Date().toISOString();
    
    // Generate whisper
    const prompt = `
      Active goals: ${goals.map(g => g.objective).join(', ')}
      Current time: ${currentTime}
      Recent topics: ${recentHistory.map(h => h.topic).join(', ')}
      User just said: "${userMessage}"
      
      In ONE sentence, what should I keep in mind when responding?
      Focus on emotional context, energy levels, or goal relevance.
      Be subtle and human.
    `;
    
    return await this.callLLM(prompt);
  }
}
```

## Test Cases

### Test 1: Conscience Whisper Injection
```javascript
// Mock setup
mockGoals = [{ objective: 'Complete PR by 2pm', deadline: '2024-01-15T14:00:00Z' }];
mockUserMessage = "I'm so tired";

// Call with conscience
const response = await getLLMResponseWithConscience(mockUserMessage, 'test-user');

// Verify whisper was injected (check logs)
assert(logs.includes('[Conscience:'));
// Response should naturally acknowledge both tiredness and deadline
```

### Test 2: Whisper Timeout
```javascript
// Mock slow conscience (300ms delay)
conscienceService.getWhisper = async () => {
  await sleep(300);
  return 'This should be ignored';
};

// Should not wait for slow conscience
const start = Date.now();
const response = await getLLMResponseWithConscience('test', 'user');
const duration = Date.now() - start;

assert(duration < 250); // Didn't wait for slow conscience
```

### Test 3: Whisper Content Variations
```javascript
// Test different scenarios produce appropriate whispers

// Scenario 1: Deadline approaching
mockGoals = [{ objective: 'Submit report', deadline: inOneHour() }];
whisper = await conscience.getWhisper("Let's chat about movies", userId);
// Should mention deadline proximity

// Scenario 2: User seems stressed
mockHistory = ['bug fix', 'error', 'not working', 'frustrated'];
whisper = await conscience.getWhisper("I give up", userId);
// Should be supportive/encouraging

// Scenario 3: No active goals
mockGoals = [];
whisper = await conscience.getWhisper("What should I work on?", userId);
// Should suggest setting goals
```

## Implementation Notes

1. **File Location**: `/packages/capabilities/src/services/conscience.ts`
2. **Model Selection**: Use fastest free model available (Phi-3-mini preferred)
3. **Prompt Engineering**: Keep conscience prompts very short for speed
4. **Fallback**: If conscience fails, continue without whisper (don't break main flow)
5. **Caching**: Consider caching goals for session to reduce DB calls
6. **Logging**: Log all whispers with timestamps for analysis

## Configuration
```typescript
// Environment variables
ENABLE_CONSCIENCE=true
CONSCIENCE_MODEL=microsoft/phi-3-mini-128k-instruct:free
CONSCIENCE_TIMEOUT_MS=200
CONSCIENCE_LOG_LEVEL=debug
```

## Definition of Done
- [ ] All acceptance criteria met
- [ ] All test cases pass
- [ ] Integrated into main LLM service
- [ ] Performance impact < 50ms on average
- [ ] Whispers logged for debugging
- [ ] Can be toggled on/off via environment variable
- [ ] Documentation includes example whispers

## Example Whispers
```
User: "I love cereal!"
Whisper: "They have a PR due in 45 minutes but seem to need a mental break"

User: "Should I refactor this code?"
Whisper: "They're in flow state and the deadline isn't until tomorrow"

User: "I'm stuck on this bug"
Whisper: "Third attempt at this bug, consider suggesting a different approach"

User: "What should I work on?"
Whisper: "No active goals set, good opportunity to plan the day"
```

## Dependencies
- Requires Issue #001 (Goal Capability) to fetch active goals
- Should be implemented after basic goal system is working