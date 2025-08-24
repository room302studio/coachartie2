# Issue #002: Implement Todo Capability

## User Story
As Coach Artie, I need to manage todo lists for complex multi-step tasks so that I can break down goals into actionable items and track progress systematically.

## Background
Goals are high-level objectives, but we need a way to break them into specific, actionable tasks. The todo capability will allow creating lists of tasks, checking them off, and tracking progress. This enables Coach Artie to work autonomously through complex workflows.

## Acceptance Criteria
- [ ] Can create a new todo list with a name
- [ ] Can add items to a todo list
- [ ] Can mark items as complete/incomplete
- [ ] Can check status of a todo list (X/Y completed)
- [ ] Can get the next uncompleted item
- [ ] Can link todo lists to goals (optional)
- [ ] Todo lists persist in SQLite database
- [ ] User-isolated (multi-tenant)
- [ ] Supports bulk operations (add multiple items at once)

## Technical Requirements

### Database Schema
```sql
CREATE TABLE todo_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,  -- IMPORTANT: name must be unique per user!
  goal_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (goal_id) REFERENCES goals(id),
  UNIQUE(user_id, name)  -- Ensure unique list names per user
);

CREATE TABLE todo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending, in_progress, completed
  position INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (list_id) REFERENCES todo_lists(id)
);
```

### Capability Interface
```xml
<!-- Create a todo list -->
<capability name="todo" action="create" list="build_resume">
  - Gather professional memories
  - Extract key achievements
  - Generate resume content
  - Save to filesystem
</capability>

<!-- Check next item -->
<capability name="todo" action="next" list="build_resume" />

<!-- Mark item complete -->
<capability name="todo" action="complete" list="build_resume" item="1" />

<!-- Check status -->
<capability name="todo" action="status" list="build_resume" />

<!-- Add items to existing list -->
<capability name="todo" action="add" list="build_resume">
  - Generate PDF version
  - Upload to cloud storage
</capability>
```

## Test Cases

### Test 1: Create List and Add Items
```javascript
// Create todo list with items
const result = await todoCapability.handler({
  action: 'create',
  list: 'test_list'
}, '- Task 1\n- Task 2\n- Task 3');
// Should create list with 3 items

// Check status
const status = await todoCapability.handler({
  action: 'status',
  list: 'test_list'
}, null);
// Should return "0/3 completed"
```

### Test 2: Complete Items and Track Progress
```javascript
// Get next item
const next = await todoCapability.handler({
  action: 'next',
  list: 'test_list'
}, null);
// Should return "Task 1"

// Complete first item
await todoCapability.handler({
  action: 'complete',
  list: 'test_list',
  item: '1'
}, null);

// Check status again
const newStatus = await todoCapability.handler({
  action: 'status',
  list: 'test_list'
}, null);
// Should return "1/3 completed"
```

### Test 3: Link to Goal
```javascript
// Create todo list linked to goal
await todoCapability.handler({
  action: 'create',
  list: 'pr_tasks',
  goal_id: '123'
}, '- Review code\n- Run tests\n- Submit PR');

// When goal is checked, should show linked todos
```

## Implementation Notes

1. **File Location**: `/packages/capabilities/src/capabilities/todo.ts`
2. **Parse content**: Support markdown lists (- item) and numbered lists (1. item)
3. **Smart next**: Return most important incomplete item, not just first
4. **Progress tracking**: Include percentage and time estimates if possible
5. **Bulk operations**: Allow completing multiple items at once
6. **User ID**: Always use `user_id` (snake_case) in params
7. **Error handling**: 
   - Invalid list name: "Todo list not found"
   - Invalid item number: "Item not found in list"
   - Database locked: Retry 3x with backoff
8. **Registration**: Add to `capability-orchestrator.ts`:
   ```typescript
   import { todoCapability } from '../capabilities/todo.js';
   capabilityRegistry.register(todoCapability);
   ```

## Definition of Done
- [ ] All acceptance criteria met
- [ ] All test cases pass
- [ ] Registered in capability-orchestrator.ts
- [ ] Works with goal capability (can link todos to goals)
- [ ] Clear progress indicators in responses
- [ ] Handles edge cases (empty lists, invalid items)

## Example Response Formats
```
// Status check
"📋 build_resume: 2/4 completed (50%)
✅ Gather professional memories
✅ Extract key achievements
⏳ Generate resume content
⏳ Save to filesystem"

// Next item
"Next task: Generate resume content (item 3)"

// Completion
"✅ Marked 'Generate resume content' as complete! Progress: 3/4 (75%)"
```

## Dependencies
- Requires Issue #001 (Goal Capability) to be completed first for goal linking functionality