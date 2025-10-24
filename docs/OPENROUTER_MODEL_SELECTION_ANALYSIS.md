# OpenRouter Service & Model Selection Analysis
## Coach Artie 2 Codebase

---

## Executive Summary

The Coach Artie 2 system uses OpenRouter as its primary LLM provider with a simple **round-robin rotation** model selection strategy. Currently, there is **no intelligent model selection** based on task complexity - all LLM calls use the same pool of models on a rotating basis.

**Key Finding:** The three-tier model strategy (FAST, SMART, MANAGER) is not currently implemented. Integration points are clearly defined, and the architecture supports this enhancement with minimal changes.

---

## Current Architecture

### 1. OpenRouter Service Layer
**File:** `/packages/capabilities/src/services/openrouter.ts`

#### Current Model Selection Strategy
```typescript
class OpenRouterService {
  private currentModelIndex: number = 0;  // Simple rotation counter
  
  // Models configured via OPENROUTER_MODELS env var (comma-separated)
  // Falls back to free models if not set
  private models: string[] = [...];
}
```

**Current Behavior:**
- Models are loaded from `OPENROUTER_MODELS` environment variable (comma-separated list)
- **No differentiation between model types** - all models used for all tasks
- Simple **round-robin rotation**: each call increments `currentModelIndex`
- Fallback to free models if no configuration provided
- All calls use the same configuration parameters (max_tokens: 1000, temperature: 0.7)

#### Key Methods:
```typescript
getCurrentModel(): string              // Returns current model
getAvailableModels(): string[]        // Returns all models
generateFromMessageChain(...)          // Non-streaming LLM calls
generateFromMessageChainStreaming(...) // Streaming LLM calls
```

**Problem:** Both methods call `generateFromMessageChain()` which cycles through models sequentially without understanding task requirements.

---

### 2. Where LLM Calls Occur

#### A. Capability Extraction
**File:** `/packages/capabilities/src/services/capability-orchestrator.ts`

**Flow:**
```
orchestrateMessage()
  └─> assembleMessageOrchestration()
      └─> getLLMResponseWithCapabilities()
          ├─> promptManager.getCapabilityInstructions()
          ├─> contextAlchemy.buildMessageChain()
          ├─> modelAwarePrompter.generateCapabilityPrompt()
          └─> openRouterService.generateFromMessageChain/Streaming()
              ↑ INTEGRATION POINT #1: FAST_MODEL EXTRACTION
```

**Current Model Used:** Whatever model is next in rotation
- Line 310: `const llmResponse = await this.getLLMResponseWithCapabilities(...)`
- Line 564-573: Model selection happens via round-robin

#### B. Capability Review (Safety Check)
**File:** `/packages/capabilities/src/services/conscience.ts`

```typescript
// Hardcoded to weak model for safety
private conscienceModel = 'microsoft/phi-3-mini-128k-instruct:free';

async review(userMessage: string, capability: CapabilityRequest): Promise<string>
  // Uses conscienceModel directly - NOT part of rotation
```

**Current:** Uses dedicated free model, separate from main rotation.

#### C. Goal Context Generation
**File:** `/packages/capabilities/src/services/conscience.ts`

```typescript
async getGoalWhisper(userMessage: string, userId: string): Promise<string>
  └─> generateWhisper()
      └─> openRouterService.generateFromMessageChain()
          ↑ Uses whatever model is next in rotation
```

#### D. Response Synthesis/Generation
**File:** `/packages/capabilities/src/services/capability-orchestrator.ts`

```
generateFinalResponse(context, llmResponse)
  ├─> contextAlchemy.generateCapabilitySynthesisPrompt()
  ├─> contextAlchemy.buildMessageChain()
  └─> openRouterService.generateFromMessageChain()
      ↑ INTEGRATION POINT #2: SMART_MODEL FINAL RESPONSE
```

Line 2314: After capability execution, uses the same rotating model for synthesis.

#### E. Simple AI Response (when capabilities disabled)
**File:** `/packages/capabilities/src/handlers/process-message.ts`

```typescript
async processMessage(message: IncomingMessage, onPartialResponse?: (partial: string) => void)
  └─> [IF CAPABILITIES DISABLED]
      ├─> promptManager.getCapabilityInstructions()
      ├─> contextAlchemy.buildMessageChain()
      └─> openRouterService.generateFromMessageChain/Streaming()
          ↑ Also uses rotation
```

---

## Model Selection Flow Diagram

```
USER MESSAGE
    ↓
processMessage() ─────────────┐
    ├─► capabilityOrchestrator.orchestrateMessage()
    │       ├─► getLLMResponseWithCapabilities()
    │       │   └─► openRouter.generateFromMessageChain() [MODEL N]
    │       │       ├─ TASK: Capability extraction (can be FAST)
    │       │       └─ CURRENT: Round-robin model
    │       │
    │       ├─► conscienceLLM.review() [hardcoded phi-3-mini]
    │       │   └─ TASK: Safety verification (already specialized)
    │       │
    │       ├─► executeCapabilityChain()
    │       │   └─ (No LLM calls)
    │       │
    │       └─► generateFinalResponse()
    │           └─► openRouter.generateFromMessageChain() [MODEL N+1]
    │               ├─ TASK: Synthesize results (can be SMART)
    │               └─ CURRENT: Round-robin model
    │
    └─► [IF NO CAPABILITIES]
        └─► openRouter.generateFromMessageChain() [MODEL N]
            └─ TASK: Direct response (standard SMART)
```

---

## Model Information Service

**File:** `/packages/capabilities/src/services/openrouter-models.ts`

```typescript
class OpenRouterModelsService {
  async fetchLiveModelInfo(): Promise<Map<string, OpenRouterModelInfo>>
  async getModelInfo(modelIds: string[]): Promise<Record<string, OpenRouterModelInfo>>
  async getEnhancedModelData(activeModels: string[], currentModel: string)
}
```

**Current Usage:** Read-only for API endpoint `/packages/capabilities/src/routes/models.ts`
- **NOT used** for intelligent model selection
- Only provides model metadata (pricing, context length, provider)

---

## Model-Aware Prompting

**File:** `/packages/capabilities/src/utils/model-aware-prompter.ts`

```typescript
class ModelAwarePrompter {
  getModelCapabilities(modelName: string): ModelCapabilities {
    // Detects if model is weak/medium/strong
    // Returns: supportsXML, prefersSimpleSyntax, needsExplicitExamples, maxComplexity
  }
  
  generateCapabilityPrompt(modelName: string, basePrompt: string): string
  // CURRENTLY: Returns basePrompt unchanged (debug mode)
  // Should adapt prompts per model tier
}
```

**Current State:** 
- Line 55-56: Force returns base prompt unchanged
- Classification logic exists but isn't used for model selection
- Could be extended to select model based on capability detection

---

## Context Management

**File:** `/packages/capabilities/src/services/context-alchemy.ts`

```typescript
async buildMessageChain(
  userMessage: string,
  userId: string,
  baseSystemPrompt: string,
  // ... builds optimal message chain for LLM
): Promise<{ messages: ..., contextSources: ... }>

async generateCapabilitySynthesisPrompt(
  originalMessage: string,
  capabilityResults: string
): Promise<string>
```

**Current:** Context building is **model-agnostic** - doesn't know which model will process the messages.

---

## Environment Configuration

**File:** `.env` (or `.env.example`)

Current configuration:
```bash
# List of models to rotate through (comma-separated)
OPENROUTER_MODELS="anthropic/claude-3.5-sonnet,..."

# API Configuration
OPENROUTER_API_KEY="sk-or-..."
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"

# Feature Flags
ENABLE_CONSCIENCE=true          # Safety review (hardcoded phi-3-mini)
ENABLE_CAPABILITIES=true        # Capability orchestration
ENABLE_AUTO_REFLECTION=false    # Cost control (disabled)
```

**Missing:** No separate configuration for FAST_MODEL, SMART_MODEL, MANAGER_MODEL

---

## Integration Points for Three-Tier Strategy

### INTEGRATION POINT #1: Capability Extraction (FAST_MODEL)
**Location:** `/packages/capabilities/src/services/capability-orchestrator.ts` line 545-596
```typescript
private async getLLMResponseWithCapabilities(
  message: IncomingMessage,
  onPartialResponse?: (partial: string) => void
): Promise<string> {
  // ...
  const currentModel = openRouterService.getCurrentModel(); // ← SELECT FAST_MODEL HERE
  // ...
  return onPartialResponse
    ? await openRouterService.generateFromMessageChainStreaming(...)
    : await openRouterService.generateFromMessageChain(...);
}
```

**Why FAST_MODEL works here:**
- Extracting XML capabilities from text is relatively simple
- Don't need complex reasoning - just pattern matching
- Could use smaller models with lower latency/cost
- Only critical if extraction format is clear

---

### INTEGRATION POINT #2: Response Synthesis (SMART_MODEL)
**Location:** `/packages/capabilities/src/services/capability-orchestrator.ts` line 2273-2344
```typescript
private async generateFinalResponse(
  context: OrchestrationContext,
  originalLLMResponse: string
): Promise<string> {
  // ...
  const finalResponse = await openRouterService.generateFromMessageChain(
    messages,
    context.userId,
    context.messageId
  ); // ← SELECT SMART_MODEL HERE
  // ...
}
```

**Why SMART_MODEL works here:**
- Synthesizing capability results requires nuanced language
- Need to present technical data in conversational way
- Benefits from strong reasoning for complex results
- Standard conversation quality level needed

---

### INTEGRATION POINT #3: Complex Planning (MANAGER_MODEL)
**Location:** Multiple potential locations:

**Option A - Multi-step Reasoning:**
```typescript
// In capability-orchestrator.ts - when capabilities trigger new workflows
private async executeCapabilityChainWithStreaming(...) {
  // When orchestrating multiple capabilities...
  // Could use MANAGER_MODEL for deciding capability sequence
}
```

**Option B - Goal Whisper Enhancement:**
```typescript
// In conscience.ts - getGoalWhisper()
async getGoalWhisper(userMessage: string, userId: string): Promise<string> {
  // Currently uses rotation
  // Could use MANAGER_MODEL for strategic context
}
```

**Option C - Interactive Conversation:**
```typescript
// For multi-turn interactions requiring planning
// Could detect "planning" conversation type and route to MANAGER
```

---

## Conscience Model

**Current Implementation:**
```typescript
// conscience.ts line 19
private conscienceModel = 'microsoft/phi-3-mini-128k-instruct:free';
```

**Why it's hardcoded:**
- Safety review needs to be fast and deterministic
- Uses a cheap free model to avoid blocking main flow
- Has timeout mechanism (line 31: CONSCIENCE_TIMEOUT_MS)

**Relationship to three-tier:**
- This is similar to "MANAGER" decision-making (safety verification)
- Separate from main model rotation (appropriate isolation)
- Could remain separate OR use MANAGER_MODEL for stronger safety

---

## Current Model Rotation (Example)

With `OPENROUTER_MODELS="model-a,model-b,model-c"`:

```
Request 1: Capability extraction     → model-a (rotate to index 1)
Request 2: Goal whisper              → model-b (rotate to index 2)
Request 3: Safety review             → phi-3-mini (hardcoded, no rotation)
Request 4: Capability synthesis      → model-c (rotate to index 0)
Request 5: Next capability extract   → model-a (rotate to index 1)
                                       ↑ Back to start
```

**Problem:** Each task type gets random models. Extraction might get a complex model when it needs speed.

---

## Summary: Current Limitations

| Aspect | Current | Limitation |
|--------|---------|-----------|
| **Model Selection** | Round-robin rotation | No task-specific intelligence |
| **Extraction** | Random model from pool | Slow models waste resources |
| **Synthesis** | Random model from pool | Small models fail at good output |
| **Planning** | Random model from pool | No strategic reasoning tier |
| **Configuration** | Single OPENROUTER_MODELS var | Can't separate model tiers |
| **Prompting** | Model-aware code exists but unused | Prompts don't adapt to model |
| **Cost** | All calls use same profile | Can't optimize cost vs quality |
| **Safety** | Conscience hardcoded (good) | Can't upgrade safety model |

---

## Architecture Ready for Enhancement

The codebase **already has**:

1. ✅ **Modular LLM call sites** - Clear integration points
2. ✅ **Model capability detection** - `ModelAwarePrompter.getModelCapabilities()`
3. ✅ **Context separation** - Context Alchemy builds independently
4. ✅ **Task identification** - Code knows "extraction vs synthesis"
5. ✅ **Streaming support** - Both streaming and non-streaming paths
6. ✅ **Error handling** - Fallback models already implemented
7. ✅ **Cost monitoring** - UsageTracker and CostMonitor services

**Missing:**
- Model selection logic based on task type
- Environment variables for FAST/SMART/MANAGER models
- Router to dispatch tasks to appropriate model

---

## Recommended Integration Steps

### Step 1: Extend OpenRouter Service
Add model tier selection methods:
```typescript
selectModelForTask(taskType: 'extraction' | 'response' | 'planning'): string
selectFastModel(): string
selectSmartModel(): string  
selectManagerModel(): string
```

### Step 2: Add Environment Configuration
```bash
FAST_MODEL="qwen/qwen3-coder:free"           # Fast extraction
SMART_MODEL="anthropic/claude-3.5-sonnet"    # Quality responses
MANAGER_MODEL="anthropic/claude-3.5-sonnet"  # Complex planning
```

### Step 3: Update Integration Points
```typescript
// In getLLMResponseWithCapabilities (line 545)
const model = this.openRouterService.selectFastModel(); // ← Change this

// In generateFinalResponse (line 2314)  
const model = this.openRouterService.selectSmartModel(); // ← Change this

// In conscience.ts (optional upgrade)
const model = this.openRouterService.selectManagerModel(); // ← Change this
```

### Step 4: Update Model-Aware Prompting
Enable adaptive prompting based on selected model tier.

---

## Files Reference

| File | Purpose | Integration Points |
|------|---------|-------------------|
| `services/openrouter.ts` | LLM API wrapper | Core selection logic |
| `services/capability-orchestrator.ts` | Main orchestration | 2 LLM call sites |
| `services/context-alchemy.ts` | Context building | Message preparation |
| `services/conscience.ts` | Safety review | 1 LLM call (hardcoded) |
| `utils/model-aware-prompter.ts` | Prompt adaptation | Model capability detection |
| `handlers/process-message.ts` | Entry point | Message routing |
| `routes/models.ts` | Model info API | Metadata only |

