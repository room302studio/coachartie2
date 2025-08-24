# Issue #003: Implement Variable Store Capability

## User Story
As Coach Artie, I need to pass data between capability calls within a single orchestration session so that I can build complex multi-step workflows where outputs from one tool become inputs to another.

## Background
Currently, capabilities execute in isolation. We need a lightweight session-scoped variable store that allows the output of one capability to be used as input for subsequent capabilities. This enables true workflow orchestration.

## Acceptance Criteria
- [ ] Can store variables with key-value pairs during a session
- [ ] Can retrieve variables by key
- [ ] Can interpolate variables in strings using {{variable}} syntax
- [ ] Variables are session-scoped (cleared after workflow completes)
- [ ] Supports storing complex data types (objects, arrays)
- [ ] Can list all variables in current session
- [ ] Can clear specific variables or all variables
- [ ] Thread-safe for concurrent workflows

## Technical Requirements

### Session Management
```typescript
// In-memory store, not database (session-scoped)
class VariableStore {
  private sessions: Map<string, Map<string, any>> = new Map();
  private sessionMetadata: Map<string, { created: number; lastAccess: number }> = new Map();
  
  // Session ID should be passed from orchestrator or generated as:
  // `${user_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  
  getSession(sessionId: string): Map<string, any> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map());
      this.sessionMetadata.set(sessionId, {
        created: Date.now(),
        lastAccess: Date.now()
      });
    }
    // Update last access
    const metadata = this.sessionMetadata.get(sessionId);
    if (metadata) metadata.lastAccess = Date.now();
    
    return this.sessions.get(sessionId)!;
  }
  
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionMetadata.delete(sessionId);
  }
}
```

### Capability Interface
```xml
<!-- Store a variable -->
<capability name="variable" action="set" key="memories" value="[output from memory recall]" />

<!-- Get a variable -->
<capability name="variable" action="get" key="memories" />

<!-- Interpolate variables in content -->
<capability name="variable" action="interpolate">
  Generate a resume based on: {{memories}}
  Include skills: {{skills}}
</capability>

<!-- List all variables -->
<capability name="variable" action="list" />

<!-- Clear variables -->
<capability name="variable" action="clear" key="memories" />
<capability name="variable" action="clear_all" />
```

### Integration with Other Capabilities
```xml
<!-- Modified capability calls with output_var -->
<capability name="memory" action="recall" query="achievements" output_var="achievements" />
<capability name="web" action="generate" output_var="resume">
  Format these achievements as a resume: {{achievements}}
</capability>
<capability name="filesystem" action="write" path="/tmp/resume.md">{{resume}}</capability>
```

## Test Cases

### Test 1: Basic Store and Retrieve
```javascript
const sessionId = 'test-session-1';

// Store variable
await variableCapability.handler({
  action: 'set',
  key: 'test_var',
  value: 'Hello World',
  sessionId
}, null);

// Retrieve variable
const result = await variableCapability.handler({
  action: 'get',
  key: 'test_var',
  sessionId
}, null);
// Should return "Hello World"
```

### Test 2: Interpolation
```javascript
// Store multiple variables
await variableCapability.handler({
  action: 'set',
  key: 'name',
  value: 'Coach Artie',
  sessionId
}, null);

await variableCapability.handler({
  action: 'set',
  key: 'role',
  value: 'AI Assistant',
  sessionId
}, null);

// Interpolate
const interpolated = await variableCapability.handler({
  action: 'interpolate',
  sessionId
}, 'I am {{name}}, your {{role}}');
// Should return "I am Coach Artie, your AI Assistant"
```

### Test 3: Session Isolation
```javascript
// Set variable in session 1
await variableCapability.handler({
  action: 'set',
  key: 'data',
  value: 'Session 1 Data',
  sessionId: 'session-1'
}, null);

// Try to get from session 2
const result = await variableCapability.handler({
  action: 'get',
  key: 'data',
  sessionId: 'session-2'
}, null);
// Should return null or "Variable not found"
```

## Implementation Notes

1. **File Location**: `/packages/capabilities/src/capabilities/variable-store.ts`
2. **Session Management**: Use messageId from orchestrator context or generate: `${user_id}-${timestamp}-${random}`
3. **Memory Management**: Implement TTL to auto-clear old sessions (e.g., 1 hour)
4. **Complex Data**: Support JSON serialization for objects/arrays
5. **Error Handling**: 
   - Missing variable: Return empty string or "Variable not found"
   - Invalid interpolation: Leave {{var}} unchanged if not found
   - Session not found: Create new session automatically
6. **Integration**: Modify capability orchestrator to support output_var parameter
7. **Critical**: Make this a singleton service to ensure session consistency
8. **Registration**: Add to `capability-orchestrator.ts`:
   ```typescript
   import { variableStoreCapability } from '../capabilities/variable-store.js';
   capabilityRegistry.register(variableStoreCapability);
   ```

## Special Considerations

### Orchestrator Integration
The capability orchestrator needs modification to:
1. Generate and maintain session IDs
2. Parse `output_var` parameter from capability calls
3. Automatically store capability outputs when `output_var` is specified
4. Pass sessionId to all capability handlers

### Memory Management
```typescript
// Auto-cleanup old sessions
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, metadata] of sessionMetadata) {
    if (now - metadata.lastAccess > 3600000) { // 1 hour
      variableStore.clearSession(sessionId);
    }
  }
}, 300000); // Check every 5 minutes
```

## Definition of Done
- [ ] All acceptance criteria met
- [ ] All test cases pass
- [ ] Registered in capability-orchestrator.ts
- [ ] Session cleanup implemented
- [ ] Interpolation handles missing variables gracefully
- [ ] Documentation includes workflow examples
- [ ] No memory leaks with long-running sessions

## Example Workflow
```xml
<!-- Complete workflow with variables -->
<capability name="memory" action="recall" query="professional experience" output_var="experience" />
<capability name="memory" action="recall" query="skills" output_var="skills" />
<capability name="variable" action="interpolate" output_var="prompt">
  Create a professional summary combining:
  Experience: {{experience}}
  Skills: {{skills}}
</capability>
<capability name="web" action="generate" output_var="summary">{{prompt}}</capability>
<capability name="filesystem" action="write" path="/tmp/summary.md">{{summary}}</capability>
```