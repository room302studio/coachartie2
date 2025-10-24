# Three-Tier Model Strategy Integration Points

## Quick Reference for Integration

### Core Service File
**`/packages/capabilities/src/services/openrouter.ts`**

Current structure:
```typescript
class OpenRouterService {
  private models: string[];
  private currentModelIndex: number = 0;
  
  // Current methods (keep these)
  getCurrentModel(): string
  getAvailableModels(): string[]
  generateFromMessageChain(messages, userId, messageId)
  generateFromMessageChainStreaming(messages, userId, onPartialResponse, messageId)
}
```

Methods to ADD:
```typescript
selectFastModel(): string           // FAST_MODEL for capability extraction
selectSmartModel(): string          // SMART_MODEL for response synthesis
selectManagerModel(): string        // MANAGER_MODEL for complex planning
selectModelForTask(taskType: 'extraction' | 'response' | 'planning'): string
```

---

## Integration Point #1: Capability Extraction

**File:** `/packages/capabilities/src/services/capability-orchestrator.ts`

**Method:** `getLLMResponseWithCapabilities()` (lines 545-596)

**Current Code:**
```typescript
private async getLLMResponseWithCapabilities(
  message: IncomingMessage,
  onPartialResponse?: (partial: string) => void
): Promise<string> {
  // ... setup code ...
  
  const currentModel = openRouterService.getCurrentModel();  // ← CHANGE THIS LINE
  
  // ... more code ...
}
```

**Change Required:**
```typescript
// BEFORE:
const currentModel = openRouterService.getCurrentModel();

// AFTER:
const currentModel = openRouterService.selectFastModel();
```

**Context:** This is where the LLM first reads the user message and extracts what capabilities (calculator, memory, web search, etc.) are needed. A FAST_MODEL is appropriate because:
- Capability detection is mostly pattern matching
- Smaller/faster models can handle this well
- Saves on tokens and latency
- Reduces cost for routine requests

---

## Integration Point #2: Response Synthesis

**File:** `/packages/capabilities/src/services/capability-orchestrator.ts`

**Method:** `generateFinalResponse()` (lines 2273-2344)

**Current Code (lines 2314-2318):**
```typescript
private async generateFinalResponse(
  context: OrchestrationContext,
  originalLLMResponse: string
): Promise<string> {
  // ... setup code ...
  
  const finalResponse = await openRouterService.generateFromMessageChain(
    messages,
    context.userId,
    context.messageId
  );  // ← NEED TO SELECT MODEL BEFORE THIS CALL
  
  // ... rest of method ...
}
```

**Change Required:**

Method 1 - Inject selected model into generateFromMessageChain:
```typescript
// Add optional parameter to generateFromMessageChain signature:
async generateFromMessageChain(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  userId: string,
  messageId?: string,
  selectedModel?: string  // ← ADD THIS
): Promise<string> {
  const model = selectedModel || this.getCurrentModel();
  // ... rest of method ...
}

// Then in generateFinalResponse:
const finalResponse = await openRouterService.generateFromMessageChain(
  messages,
  context.userId,
  context.messageId,
  openRouterService.selectSmartModel()  // ← PASS SMART_MODEL
);
```

Method 2 - Extend method signatures:
```typescript
async generateFromMessageChainWithModel(
  messages: Array<...>,
  userId: string,
  selectedModel: string,
  messageId?: string
): Promise<string>
```

**Context:** After capabilities execute (calculator results, web searches, etc.), the LLM synthesizes these results into a coherent response. A SMART_MODEL is appropriate because:
- Needs nuanced language understanding
- Must convert technical data to conversational output
- Quality of final response matters most to user
- Justifies higher cost for better user experience

---

## Integration Point #3: Planning/Conscience (Optional)

**File:** `/packages/capabilities/src/services/conscience.ts`

**Current Implementation (line 19):**
```typescript
private conscienceModel = 'microsoft/phi-3-mini-128k-instruct:free';
```

**Option A - Keep Current (Recommended)**
The conscience model is intentionally hardcoded because:
- Safety verification should be lightweight
- Separate from main model rotation (good isolation)
- Timeout mechanism prevents blocking (200ms default)
- Works well with free model

**Option B - Make It Configurable**
```typescript
private conscienceModel: string;

constructor() {
  this.conscienceModel = process.env.CONSCIENCE_MODEL || 'microsoft/phi-3-mini-128k-instruct:free';
}
```

**Option C - Use MANAGER_MODEL**
```typescript
// In getGoalWhisper() method, around line 77:
// BEFORE:
const response = await openRouterService.generateFromMessageChain(messages, userId);

// AFTER:
const response = await openRouterService.generateFromMessageChainWithModel(
  messages,
  userId,
  openRouterService.selectManagerModel()
);
```

---

## Environment Configuration

**File:** `.env` (add these new variables)

```bash
# Existing configuration
OPENROUTER_API_KEY="sk-or-..."
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"

# NEW: Three-tier model configuration
# FAST_MODEL: For capability extraction (small, quick, cheap)
FAST_MODEL="qwen/qwen3-coder:free"

# SMART_MODEL: For response synthesis (balanced, high quality)
SMART_MODEL="anthropic/claude-3.5-sonnet"

# MANAGER_MODEL: For complex planning and reasoning (strongest model)
MANAGER_MODEL="anthropic/claude-3.5-sonnet"

# Optional: Keep existing OPENROUTER_MODELS for fallback/rotation
# (could be deprecated after three-tier is fully implemented)
OPENROUTER_MODELS="anthropic/claude-3.5-sonnet,qwen/qwen3-coder:free"

# Optional: Upgrade conscience model if desired
CONSCIENCE_MODEL="microsoft/phi-3-mini-128k-instruct:free"
```

---

## Implementation Checklist

- [ ] **OpenRouter Service Enhancement**
  - [ ] Add `selectFastModel()` method
  - [ ] Add `selectSmartModel()` method
  - [ ] Add `selectManagerModel()` method
  - [ ] Add optional `selectedModel` parameter to `generateFromMessageChain()`
  - [ ] Load model tier configs from environment

- [ ] **Capability Orchestrator Updates**
  - [ ] Line 545-596: Change `getLLMResponseWithCapabilities()` to use `selectFastModel()`
  - [ ] Line 2314-2318: Change `generateFinalResponse()` to use `selectSmartModel()`
  - [ ] Test with different models per tier

- [ ] **Environment Configuration**
  - [ ] Add FAST_MODEL to .env
  - [ ] Add SMART_MODEL to .env
  - [ ] Add MANAGER_MODEL to .env
  - [ ] Update .env.example with documentation

- [ ] **Optional Enhancements**
  - [ ] Enable model-aware prompting (model-aware-prompter.ts line 55-56)
  - [ ] Add MANAGER_MODEL usage to conscience.ts
  - [ ] Add metrics tracking by model tier
  - [ ] Add cost breakdown by task type

- [ ] **Testing**
  - [ ] Test capability extraction with FAST_MODEL
  - [ ] Test response synthesis with SMART_MODEL
  - [ ] Test fallback if model unavailable
  - [ ] Verify cost savings from tier strategy
  - [ ] Check response quality at each tier

---

## Code Locations Quick Index

| Task | File | Lines | Method |
|------|------|-------|--------|
| Load models | openrouter.ts | 21-104 | constructor() |
| Rotate models | openrouter.ts | 106-112 | getCurrentModel(), getAvailableModels() |
| Call LLM | openrouter.ts | 130-290 | generateFromMessageChain() |
| Stream LLM | openrouter.ts | 295-452 | generateFromMessageChainStreaming() |
| Extract capabilities | capability-orchestrator.ts | 545-596 | getLLMResponseWithCapabilities() |
| Review capabilities | conscience.ts | 18-151 | review(), getGoalWhisper() |
| Synthesize response | capability-orchestrator.ts | 2273-2344 | generateFinalResponse() |
| Model awareness | model-aware-prompter.ts | 11-194 | getModelCapabilities(), generateCapabilityPrompt() |
| Process message | process-message.ts | 6-114 | processMessage() |

---

## Performance Expectations

With three-tier strategy:

```
Current (Round-robin):
- All tasks use same models
- Latency: Variable (depends which model selected)
- Cost: High (using premium models for simple tasks)
- Quality: Inconsistent (small models fail at synthesis)

Three-Tier Strategy:
- Extraction: FAST (smaller/free model) → ~2-3s latency, ~1/10 cost
- Synthesis: SMART (premium model) → ~5-10s latency, full quality
- Planning: MANAGER (premium model) → When needed only

Estimated Impact:
- Average latency: +5-10% (synthesis takes longer)
- Average cost: -40-60% (if FAST is free model)
- Quality improvement: +20-30% (SMART for final output)
- User experience: +30-50% (consistent, fast initial response)
```

