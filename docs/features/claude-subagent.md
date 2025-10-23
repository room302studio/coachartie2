# Coach Artie Subagent Task Delegation Plan

## Overview

This document outlines atomic, implementable features that can be delegated to subagents as GitHub issues. Each task is designed to be completed independently, following our LEGO-block architecture philosophy.

## Core Principles for Subagents

- Each task should be completable in 1-2 days
- No deep system knowledge required
- Clear acceptance criteria and test cases provided
- Follow existing patterns in the codebase
- Every feature is independently testable

## Task Assignments

### 🎯 Issue #43: Goal Capability

**GitHub**: https://github.com/room302studio/coachartie2/issues/43
**File**: `ISSUE_001_GOAL_CAPABILITY.md`
**Priority**: High (Foundation)
**Estimated Time**: 1-2 days

**Summary**: Implement the foundational goal management system. This capability allows Coach Artie to set, track, and complete long-term objectives. Includes database schema, CRUD operations, and user isolation.

**Why It Matters**: This is the foundation for all goal-aware features. Without it, Coach Artie can't maintain focus on long-term objectives.

**Key Deliverables**:

- SQLite table for goals
- XML capability interface for goal operations
- User isolation (multi-tenant support)
- Status tracking (not_started, in_progress, completed, blocked)

---

### 📝 Issue #44: Todo Capability

**GitHub**: https://github.com/room302studio/coachartie2/issues/44
**File**: `ISSUE_002_TODO_CAPABILITY.md`
**Priority**: High (Core Feature)
**Estimated Time**: 1-2 days
**Dependencies**: Issue #43

**Summary**: Build a todo list management system that breaks down goals into actionable tasks. Supports creating lists, checking off items, and tracking progress. Can be linked to goals from Issue #001.

**Why It Matters**: Goals are high-level, but Coach Artie needs to track specific steps to achieve them. This enables autonomous task completion.

**Key Deliverables**:

- Todo lists with items
- Progress tracking (X/Y completed)
- Bulk operations support
- Optional goal linking
- Smart "next task" selection

---

### 💾 Issue #45: Variable Store Capability

**GitHub**: https://github.com/room302studio/coachartie2/issues/45
**File**: `ISSUE_003_VARIABLE_STORE.md`
**Priority**: High (Enabler)
**Estimated Time**: 1 day

**Summary**: Create a session-scoped variable store that allows passing data between capability calls. Enables complex workflows where output from one tool becomes input for another.

**Why It Matters**: Currently, capabilities can't share data. This is THE key feature that enables true workflow orchestration.

**Key Deliverables**:

- Session-scoped key-value store
- Variable interpolation with {{syntax}}
- Support for complex data types
- Automatic session cleanup
- Thread-safe implementation

---

### 🧠 Issue #46: Conscience Whisper Integration

**GitHub**: https://github.com/room302studio/coachartie2/issues/46
**File**: `ISSUE_004_CONSCIENCE_WHISPER.md`
**Priority**: Medium (Enhancement)
**Estimated Time**: 1-2 days
**Dependencies**: Issue #43

**Summary**: Implement the parallel conscience system that adds goal context to every LLM response. Uses a cheap/fast model to generate contextual whispers that are injected into the main LLM prompt.

**Why It Matters**: This creates natural goal awareness without annoying reminders. Coach Artie stays aware of objectives while maintaining natural conversation.

**Key Deliverables**:

- Parallel LLM call on every interaction
- Sub-200ms whisper generation
- Automatic prompt injection
- Configurable via environment variables
- Comprehensive logging

---

### 🔧 Issue #47: Goal Tools for Main Thread

**GitHub**: https://github.com/room302studio/coachartie2/issues/47
**File**: `ISSUE_005_GOAL_TOOLS.md`
**Priority**: Medium (UX Enhancement)
**Estimated Time**: 1 day
**Dependencies**: Issue #43

**Summary**: Add explicit goal management tools that the main LLM can call when needed. Includes checking goals, updating "vibe", and getting reflections. Uses natural language, not strict parameters.

**Why It Matters**: While conscience whisper provides ambient awareness, sometimes Coach Artie needs to explicitly check or update goals. These tools make that natural and conversational.

**Key Deliverables**:

- Natural language goal commands
- Vibe-based strictness updates
- Helpful reflections and insights
- Fuzzy parameter matching
- Encouraging, supportive responses

---

## Implementation Order

### Phase 1: Foundation (Do First)

1. **Issue #43** - Goal Capability (enables everything else)
2. **Issue #45** - Variable Store (enables workflows)

### Phase 2: Core Features (Do Second)

3. **Issue #44** - Todo Capability (builds on goals)
4. **Issue #47** - Goal Tools (enhances goal UX)

### Phase 3: Magic (Do Third)

5. **Issue #46** - Conscience Whisper (adds the magic)

## Success Criteria for Subagents

Each issue should:

- ✅ Pass all defined test cases
- ✅ Follow existing code patterns
- ✅ Include helpful error messages
- ✅ Be registered in capability-orchestrator.ts
- ✅ Work via the chat API endpoint
- ✅ Have no TypeScript errors
- ✅ Include example usage in responses

## Testing Instructions

After implementing each capability:

1. **Unit Tests**: Run the test cases defined in the issue
2. **Integration Test**: Test via chat endpoint:
   ```bash
   curl -X POST http://localhost:18239/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"<capability name=\"goal\" action=\"check\" />","userId":"test"}'
   ```
3. **End-to-End**: Test the complete workflow the capability enables

## Code Patterns to Follow

Look at existing capabilities for patterns:

- `/packages/capabilities/src/capabilities/memory.ts` - Database integration
- `/packages/capabilities/src/capabilities/calculator.ts` - Simple capability structure
- `/packages/capabilities/src/capabilities/filesystem.ts` - File operations

## Questions?

If a subagent has questions, they should:

1. First check existing similar code
2. Look for patterns in the codebase
3. Ask for clarification on acceptance criteria
4. Propose a solution and ask for validation

## The Vision

When all 5 issues are complete, Coach Artie will have:

- 🎯 Goal awareness and tracking
- 📝 Task breakdown and management
- 🔄 Complex workflow orchestration
- 🧠 Natural goal-aware conversations
- 💫 The ability to work autonomously toward objectives

Each piece is simple. Together, they create intelligence.
