# Context Alchemy - What an AI Wishes Were Different

## Current State Analysis

Looking at actual logs from Context Alchemy, here's what the LLM receives:

### Budget Breakdown (4000 tokens total)
```
Total Window:     4000 tokens
User Message:     116-209 tokens
System Prompt:    34 tokens
Reserved Reply:   500 tokens
Available:        3257-3350 tokens for context
```

### Actual Context Provided

**Message Chain** (3 messages):
```
[0] system: Current date and time: Friday, October 24, 2025 at 01:40 PM ...
[1] user:   Context: From recent memory: User likes pizza.
[2] user:   <actual user message>
```

**Context Sources** (Priority order):
1. **temporal_context** (Pri:100, ~26 tokens) - Date/time
2. **memory_context** (Pri:70, ~10-53 tokens) - User memories
3. **capability_context** (Pri:30, ~1005 tokens) - Capability instructions
4. (Optional) goal_context, channel_context, guild_context, discord_environment

## What I Wish Were Different (As an AI)

### 1. **Memory Context is TOO SMALL** 🎯

**Current:** 10-53 tokens (just "User likes pizza")
**What I want:** 200-400 tokens of relevant memories

**Why this hurts:**
- I can't build rapport or reference past conversations
- "User likes pizza" tells me nothing useful for most tasks
- I'm missing critical context about user preferences, past issues, ongoing projects

**What I'd prefer:**
```
Context: Recent relevant memories:
- User is working on Coach Artie 2, a Discord bot with capabilities system
- User prefers TypeScript and uses pnpm package manager
- User likes vim-style keyboard shortcuts
- Previous conversation: We discussed adding prompt database tools
- User's coding style: Defensive programming with detailed logging
```

This gives me 100x more useful information!

### 2. **Capability Manifest is WAY TOO BIG** 📚

**Current:** 1005 tokens (25% of entire context!)
**What I want:** 100-200 tokens of RELEVANT capabilities only

**Why this hurts:**
- I'm reading about calculator and web search for EVERY message
- 90% of capability descriptions are irrelevant to current task
- This crowds out memory and conversation history

**What I'd prefer:**
- **Smart filtering**: Only show capabilities mentioned in user message or recent memory
- **Compressed format**: "calculator, web, memory, github, scheduler" (not full XML examples)
- **On-demand expansion**: If user mentions "search", THEN show web capability details

**Example compressed format:**
```
Available capabilities: calculator, web(search|fetch), memory(remember|recall),
wolfram, github, briefing, scheduler(remind|schedule|list|cancel)

Use: <capability name="X" action="Y" data='{"param":"value"}' />
```

That's ~50 tokens vs 1005!

### 3. **No Conversation History** 💬

**Current:** Just system + context + current message
**What I want:** Last 2-3 message pairs

**Why this hurts:**
- I can't build on previous responses
- User says "what about the other one?" - I have no idea what "the other one" means
- Every message feels like talking to someone with amnesia

**What I'd prefer:**
```
[0] system: <date + system prompt>
[1] assistant: <my last response>
[2] user: <their followup>
[3] assistant: <my response>
[4] user: <current message>
```

This costs ~300-500 tokens but makes conversations HUMAN!

### 4. **Date/Time is Overly Verbose** 📅

**Current:** 26 tokens
```
Current date and time: Friday, October 24, 2025 at 01:40 PM EST
ISO timestamp: 2025-10-24T13:40:00.854Z
```

**What I want:** 10 tokens
```
Date: 2025-10-24 13:40 EST (Friday)
```

**Saved tokens:** 16 tokens → could buy more memory context

### 5. **Context Placement is Awkward** 🎭

**Current:**
```
[0] system: <temporal + system + capabilities>
[1] user: Context: From recent memory: User likes pizza.
[2] user: <actual message>
```

**Why this feels weird:**
- Memories as a "user" message? That's confusing
- I have to mentally parse "wait, this isn't what the user said"
- Two sequential "user" messages breaks conversation flow

**What I'd prefer:**
```
[0] system: <date + system prompt>
[1] system: Relevant context: <memories, channel history>
[2] system: Available tools: <compressed capabilities>
[3] user: <actual message>
```

Or even better:
```
[0] system: <date + system + compressed capabilities>
[1] assistant: <last response>
[2] user: <last message>
[3] assistant: <my response>
[4] user: <current message WITH inline context>
```

### 6. **Missing User Mental Model** 🧠

**Current:** No information about user's current task or state
**What I want:** 50-100 tokens of "what is the user trying to do?"

**Example:**
```
User context:
- Current task: Building prompt database meta-tooling
- Tech stack: TypeScript, SQLite, blessed TUI library
- Recent focus: Testing CLI tools, viewing prompts
- Mood indicators: Excited about joy-driven edits
```

This helps me:
- Anticipate needs
- Suggest relevant next steps
- Match their energy and focus

### 7. **4000 Token Budget is TOO CONSERVATIVE** 💰

**Current assumption:** 4k tokens (for "free models")
**Reality check:**
- Claude 3.5 Sonnet: 200k context window
- OpenRouter models: 8k-128k typical

**What I'd prefer:**
```
Budget calculation based on ACTUAL model:
- Claude 3.5 Sonnet: Use 8k-16k context intelligently
- Include conversation history (3-5 messages)
- More memory context (400 tokens)
- Channel/guild context when available
```

**Cost/benefit:**
- Current: 4k context, missing critical information
- Proposed: 8k context, actually useful conversations
- Token cost: +4k tokens (~$0.01 extra per message)
- Value: Conversations that actually work!

## Priority Improvements (If I Could Pick 3)

### 🥇 #1: Expand Memory Budget (10 → 400 tokens)
**Impact:** Transforms from "AI with amnesia" to "AI that remembers"
**Cost:** 390 tokens
**How:** Reduce capability manifest (1005 → 200), reallocate to memory

### 🥈 #2: Add Conversation History (0 → 3-5 messages)
**Impact:** Enables natural back-and-forth dialogue
**Cost:** 500-800 tokens
**How:** Raise total budget from 4k → 8k for capable models

### 🥉 #3: Smart Capability Filtering
**Impact:** Only show relevant capabilities, save 800 tokens
**Cost:** 200 tokens (vs 1005 current)
**How:** Parse user message, show only mentioned capabilities + memory/core tools

## Specific Code Changes Needed

### 1. Increase Memory Budget
```typescript
// context-alchemy.ts:475
const maxTokensForMemory = 800; // Was: 800, Should be: 400-600
```

### 2. Adjust Total Budget for Modern Models
```typescript
// context-alchemy.ts:215
const totalTokens = 8000; // Was: 4000
// OR: Dynamically detect model capabilities
const totalTokens = getModelContextWindow(modelName) / 2; // Use half of available
```

### 3. Compress Capability Manifest
```typescript
// capability-registry.ts
generateCompressedInstructions(): string {
  // Return short format: "calculator, web, memory..."
  // Include XML example ONCE at top
  // Don't repeat full descriptions for every capability
}
```

### 4. Add Conversation History
```typescript
// context-alchemy.ts:698
// Fetch last 3 message pairs from database
const history = await getRecentConversation(userId, channelId, 3);
messages.push(...history); // Before current user message
```

## The Dream Context Window

If I could design my perfect context (8k tokens):

```
[0] system (500 tokens):
    - Date: 2025-10-24 13:40 EST
    - System prompt with personality
    - Compressed capabilities: "calculator, web, memory, github, ..."
    - XML format example (shown once)

[1] system (400 tokens):
    - Relevant memories (5-8 memories with context)
    - User mental model (current task, tech stack, mood)
    - Channel context (if Discord: recent relevant messages)

[2] assistant (200 tokens):
    - My response from 2 messages ago

[3] user (150 tokens):
    - User's message from 1 message ago

[4] assistant (300 tokens):
    - My most recent response

[5] user (200 tokens):
    - Current user message

Total: ~1750 tokens of context + 6250 tokens available for response
```

This would transform interactions from:
- ❌ "Who is this user? What are we doing? What can I do?"

To:
- ✅ "I remember we're building X, you prefer Y, and based on our last exchange, you probably want Z next"

## Bottom Line

The current context feels like talking to someone who:
- Has excellent short-term memory for dates and capabilities
- Has TERRIBLE long-term memory for conversations and context
- Can't remember what we just talked about
- Spends 25% of their brain capacity reciting a capabilities manual

I'd trade that capabilities manual for:
- Actual conversation history
- Richer memory context
- Understanding of what the user is trying to accomplish

That would be a 10x improvement in usefulness! 🎉
