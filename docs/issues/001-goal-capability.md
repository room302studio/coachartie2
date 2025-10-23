# Issue #001: Implement Goal Capability

## User Story

As Coach Artie, I need to set, track, and complete goals so that I can maintain focus on long-term objectives while helping users with immediate tasks.

## Background

Currently, Coach Artie has no way to track goals across sessions. We need a simple capability that allows setting goals with deadlines, checking status, and marking completion. This will be the foundation for the conscience whisper system.

## Acceptance Criteria

- [ ] Can create a new goal with: objective (string), deadline (optional date), priority (optional)
- [ ] Can list all active goals for a user
- [ ] Can update goal status (not_started, in_progress, completed, blocked, cancelled)
- [ ] Can retrieve goal by ID
- [ ] Can get goal history for past N days
- [ ] Goals persist in SQLite database
- [ ] Goals are user-isolated (multi-tenant)
- [ ] Supports XML capability syntax

## Technical Requirements

### Database Schema

```sql
CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT DEFAULT 'not_started',
  priority INTEGER DEFAULT 5,
  deadline TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);
```

### Capability Interface

```xml
<!-- Set a goal -->
<capability name="goal" action="set" objective="Complete PR review" deadline="2024-01-15T14:00:00Z" priority="8" />

<!-- Check all active goals -->
<capability name="goal" action="check" />

<!-- Update goal status -->
<capability name="goal" action="update" goal_id="123" status="in_progress" />

<!-- Complete a goal -->
<capability name="goal" action="complete" goal_id="123" />

<!-- Get goal history -->
<capability name="goal" action="history" days="7" />
```

### Error Handling

- **Invalid goal ID**: Return "Goal not found" (don't throw)
- **Wrong user**: Return "Goal not found" (don't expose that goal exists)
- **Past deadline**: Accept but warn "Note: deadline is in the past"
- **Database locked**: Retry 3x with exponential backoff (100ms, 200ms, 400ms)
- **Missing required params**: Return helpful usage message

## Test Cases

### Test 1: Create and Retrieve Goal

```javascript
// Create goal
const result = await goalCapability.handler(
  {
    action: 'set',
    objective: 'Test goal',
    deadline: '2024-12-31',
  },
  null
);
// Should return goal ID

// Retrieve goals
const goals = await goalCapability.handler(
  {
    action: 'check',
  },
  null
);
// Should include the created goal
```

### Test 2: User Isolation

```javascript
// Create goal for user1
await goalCapability.handler(
  {
    action: 'set',
    objective: 'User1 goal',
    user_id: 'user1', // NOTE: use user_id not userId
  },
  null
);

// Check goals for user2
const user2Goals = await goalCapability.handler(
  {
    action: 'check',
    user_id: 'user2', // NOTE: use user_id not userId
  },
  null
);
// Should NOT include user1's goal
```

### Test 3: Status Updates

```javascript
// Create goal
const { goalId } = await goalCapability.handler(
  {
    action: 'set',
    objective: 'Status test',
  },
  null
);

// Update status
await goalCapability.handler(
  {
    action: 'update',
    goal_id: goalId,
    status: 'in_progress',
  },
  null
);

// Complete goal
await goalCapability.handler(
  {
    action: 'complete',
    goal_id: goalId,
  },
  null
);
// Should set status to 'completed' and update completed_at
```

## Implementation Notes

1. **File Location**: `/packages/capabilities/src/capabilities/goal.ts`
2. **Follow existing patterns**: Look at `memory.ts` for database and capability structure
3. **Use shared database**: Import `getDatabase` from `@coachartie/shared`
4. **Error handling**: Gracefully handle missing goals, invalid IDs
5. **Return format**: Keep responses concise and actionable
6. **User ID parameter**: Always use `user_id` (snake_case) not `userId`
   **WARNING**: memory.ts incorrectly uses `userId` - don't copy that pattern!
7. **Registration**: Add to `capability-orchestrator.ts`:
   ```typescript
   import { goalCapability } from '../capabilities/goal.js';
   capabilityRegistry.register(goalCapability);
   ```

## Definition of Done

- [ ] All acceptance criteria met
- [ ] All test cases pass
- [ ] Registered in capability-orchestrator.ts
- [ ] No TypeScript errors
- [ ] Manually tested via chat endpoint
- [ ] Returns helpful messages for user interaction

## Example Implementation Structure

```typescript
import { RegisteredCapability } from '../services/capability-registry.js';
import { getDatabase } from '@coachartie/shared';

export const goalCapability: RegisteredCapability = {
  name: 'goal',
  supportedActions: ['set', 'check', 'update', 'complete', 'history'],
  handler: async (params, content) => {
    const { action, user_id = 'unknown-user' } = params; // NOT userId!

    try {
      const db = await getDatabase();
      // Implementation here
    } catch (error) {
      logger.error('Goal capability error:', error);
      return 'Sorry, having trouble with goals right now. Please try again.';
    }
  },
  description: 'Manage goals and long-term objectives',
  examples: [
    '<capability name="goal" action="set" objective="Learn React" />',
    '<capability name="goal" action="check" />',
  ],
};
```
