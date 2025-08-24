# Issue #005: Implement Goal Tools for Main Thread

## User Story
As Coach Artie's main LLM thread, I need simple tools to explicitly check and manage goals when appropriate so that I can proactively help users stay on track and make informed decisions about task prioritization.

## Background
While the conscience whisper provides ambient goal awareness, the main LLM also needs explicit tools to check goals, update strictness, and manage goal state when the conversation naturally calls for it. These are simple, direct tools the LLM can call via XML.

## Acceptance Criteria
- [ ] Main LLM can check current goals via XML capability
- [ ] Can update "strictness" vibe qualitatively (not numbers)
- [ ] Can update goal status with natural language
- [ ] Can view goal history and patterns
- [ ] Returns human-friendly responses (not JSON)
- [ ] Supports fuzzy/natural language parameters
- [ ] All actions complete in <500ms
- [ ] Integrates with existing goal capability from Issue #001

## Technical Requirements

### Capability Interface
```xml
<!-- Check current goals -->
<capability name="goal" action="check" />
<!-- Returns: "You have 2 active goals: 
             1. Complete PR review (due in 2 hours) - in_progress
             2. Learn React hooks (due Friday) - not_started" -->

<!-- Update strictness vibe -->
<capability name="goal" action="update_strictness" vibe="chill" />
<!-- Accepts: "hardcore", "focused", "balanced", "chill", "relaxed", or any natural description -->
<!-- Returns: "Switching to chill mode - I'll be more relaxed about deadlines" -->

<!-- Natural language goal update -->
<capability name="goal" action="update_status" description="PR is blocked on API review" />
<!-- Automatically identifies which goal and updates status -->
<!-- Returns: "Updated PR review: blocked on API review" -->

<!-- Get insights from history -->
<capability name="goal" action="reflect" timeframe="this week" />
<!-- Returns: "This week you've completed 5 goals, struggled with 2, and made great progress on React learning. Your most productive time was Tuesday morning." -->

<!-- Quick status -->
<capability name="goal" action="vibe_check" />
<!-- Returns: "You're doing great! 1 goal due soon, but you're on track. Current vibe: focused but not stressed" -->
```

### Natural Language Processing
```typescript
// The tool should understand fuzzy inputs
function parseVibeUpdate(input: string): StrictnessLevel {
  const vibeMap = {
    // Explicit modes
    'hardcore|intense|deadline|crunch': 'maximum_focus',
    'focused|productive|serious': 'focused',
    'balanced|normal|moderate': 'balanced',
    'chill|relaxed|easy': 'relaxed',
    'off|casual|free': 'minimal',
    
    // Natural phrases
    'need.+focus|really.+concentrate': 'maximum_focus',
    'bit.+tired|taking.+easy': 'relaxed',
    'burned.+out|need.+break': 'minimal'
  };
  
  // Use regex to match patterns
  // Return best match or ask for clarification
}
```

## Test Cases

### Test 1: Natural Language Understanding
```javascript
// Various ways to express the same thing
const inputs = [
  "I'm feeling burned out",
  "exhausted and need a break",
  "can't focus anymore",
  "brain is fried"
];

for (const input of inputs) {
  const result = await goalCapability.handler({
    action: 'update_strictness',
    vibe: input
  }, null);
  // All should result in relaxed/minimal strictness
  assert(result.includes('relaxed') || result.includes('easy'));
}
```

### Test 2: Smart Status Updates
```javascript
// Set up goals
await createGoal('Complete PR review', 'today');
await createGoal('Write documentation', 'tomorrow');

// Natural language update
const result = await goalCapability.handler({
  action: 'update_status',
  description: 'PR is waiting on Steve to review the API changes'
}, null);

// Should identify the PR goal and update it
assert(result.includes('PR review'));
assert(result.includes('waiting') || result.includes('blocked'));
```

### Test 3: Helpful Reflections
```javascript
// Create some goal history
await completeGoal('Morning standup');
await completeGoal('Bug fix');
await failGoal('Complex refactor');

// Get reflection
const reflection = await goalCapability.handler({
  action: 'reflect',
  timeframe: 'today'
}, null);

// Should provide useful insights
assert(reflection.includes('completed 2'));
assert(reflection.includes('struggled with') || reflection.includes('didn't complete'));
// Should be encouraging
assert(reflection.includes('good') || reflection.includes('progress') || reflection.includes('well'));
```

## Implementation Notes

1. **File Location**: Extend `/packages/capabilities/src/capabilities/goal.ts` from Issue #43
2. **Tone**: Always encouraging and supportive, never harsh
3. **Intelligence**: Use context to identify which goal user is referring to
4. **Fuzzy Matching**: Accept various phrasings for the same concept
5. **Memory Integration**: Can reference past patterns if memory capability available
6. **User ID**: Always use `user_id` (snake_case) in params
7. **Error Handling**: Return friendly messages, never throw errors
8. **Natural Language**: Parse vibe strings like "I'm exhausted" → relaxed mode

## Response Examples
```
// Check command
"📋 Active Goals:
✅ PR Review (due 2pm) - in progress, looking good!
🎯 Learn React Hooks (due Friday) - not started yet
💭 Build portfolio site (ongoing) - planning phase

You're on track! Focus on the PR for now."

// Vibe update
"Setting vibe to 'chill mode' 🌊 
I'll give you space to work at your own pace. 
The PR can wait if you need a break!"

// Reflection
"Weekly reflection 📊
Crushed it: 12 goals completed! 
Highlights: That complex bug fix on Tuesday
Struggled with: Database migrations (totally normal)
Pattern noticed: You're most productive after coffee breaks
Keep being awesome! 🎉"
```

## Dependencies
- Requires Issue #43 (Goal Capability) as foundation
- Benefits from Issue #46 (Conscience Whisper) for context
- Should coordinate with conscience whisper to avoid redundancy

## Definition of Done
- [ ] All acceptance criteria met
- [ ] Natural language parsing works for common phrases
- [ ] Responses are encouraging and helpful
- [ ] Integration with base goal capability seamless
- [ ] No duplicate goal checking (coordinate with whisper)
- [ ] Performance under 500ms for all operations
- [ ] Edge cases handled gracefully