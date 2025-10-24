# Implementation Code Examples

## Step 1: Enhance OpenRouter Service

**File:** `/packages/capabilities/src/services/openrouter.ts`

### Add to Constructor (after line 103)
```typescript
// Load model tier configurations from environment
this.fastModel = process.env.FAST_MODEL || 'qwen/qwen3-coder:free';
this.smartModel = process.env.SMART_MODEL || 'anthropic/claude-3.5-sonnet';
this.managerModel = process.env.MANAGER_MODEL || 'anthropic/claude-3.5-sonnet';

logger.info(`🎯 MODEL TIERS CONFIGURED:`);
logger.info(`  FAST: ${this.fastModel}`);
logger.info(`  SMART: ${this.smartModel}`);
logger.info(`  MANAGER: ${this.managerModel}`);
```

### Add Class Properties (after line 18)
```typescript
private fastModel: string;
private smartModel: string;
private managerModel: string;
```

### Add Methods (after line 112)
```typescript
selectFastModel(): string {
  logger.info(`🚀 FAST MODEL SELECTED: ${this.fastModel} (for extraction)`);
  return this.fastModel;
}

selectSmartModel(): string {
  logger.info(`🧠 SMART MODEL SELECTED: ${this.smartModel} (for response synthesis)`);
  return this.smartModel;
}

selectManagerModel(): string {
  logger.info(`👑 MANAGER MODEL SELECTED: ${this.managerModel} (for complex planning)`);
  return this.managerModel;
}

selectModelForTask(taskType: 'extraction' | 'response' | 'planning'): string {
  switch (taskType) {
    case 'extraction':
      return this.selectFastModel();
    case 'response':
      return this.selectSmartModel();
    case 'planning':
      return this.selectManagerModel();
    default:
      return this.getCurrentModel();
  }
}
```

### Modify generateFromMessageChain (line 130)
**Add optional selectedModel parameter:**
```typescript
async generateFromMessageChain(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  userId: string,
  messageId?: string,
  selectedModel?: string  // ← NEW PARAMETER
): Promise<string> {
  const startTime = Date.now();

  // Use selected model if provided, otherwise use rotation
  const startIndex = selectedModel 
    ? this.models.indexOf(selectedModel)
    : this.currentModelIndex;
  
  // Fallback to current model if selection not found
  const actualStartIndex = startIndex >= 0 ? startIndex : this.currentModelIndex;

  // Try each model starting from specified position
  for (let i = 0; i < this.models.length; i++) {
    const modelIndex = (actualStartIndex + i) % this.models.length;
    const model = this.models[modelIndex];

    try {
      logger.info(
        `🤖 MODEL SELECTION: Using ${model} (${i + 1}/${this.models.length}) for ${messages.length} messages`
      );
      // ... rest of method remains the same
```

---

## Step 2: Update Capability Orchestrator - Extraction

**File:** `/packages/capabilities/src/services/capability-orchestrator.ts`

### Change Method at Line 564 in getLLMResponseWithCapabilities()

**Before:**
```typescript
// Apply model-aware prompting to the system message
const currentModel = openRouterService.getCurrentModel();
const modelAwareMessages = messages.map((msg) => {
  if (msg.role === 'system') {
    return {
      ...msg,
      content: modelAwarePrompter.generateCapabilityPrompt(currentModel, msg.content),
    };
  }
  return msg;
});

logger.info(
  `🎯 Using Context Alchemy with model-aware prompting for ${currentModel} (${modelAwareMessages.length} messages)`
);

// Use streaming if callback provided, otherwise regular generation
return onPartialResponse
  ? await openRouterService.generateFromMessageChainStreaming(
      modelAwareMessages,
      message.userId,
      onPartialResponse,
      message.id
    )
  : await openRouterService.generateFromMessageChain(
      modelAwareMessages,
      message.userId,
      message.id
    );
```

**After:**
```typescript
// Apply model-aware prompting to the system message
const fastModel = openRouterService.selectFastModel();  // ← USE FAST MODEL
const modelAwareMessages = messages.map((msg) => {
  if (msg.role === 'system') {
    return {
      ...msg,
      content: modelAwarePrompter.generateCapabilityPrompt(fastModel, msg.content),
    };
  }
  return msg;
});

logger.info(
  `🎯 Using FAST MODEL for capability extraction: ${fastModel} (${modelAwareMessages.length} messages)`
);

// Use streaming if callback provided, otherwise regular generation
return onPartialResponse
  ? await openRouterService.generateFromMessageChainStreaming(
      modelAwareMessages,
      message.userId,
      onPartialResponse,
      message.id,
      fastModel  // ← PASS FAST MODEL (if you add this parameter)
    )
  : await openRouterService.generateFromMessageChain(
      modelAwareMessages,
      message.userId,
      message.id,
      fastModel  // ← PASS FAST MODEL
    );
```

---

## Step 3: Update Capability Orchestrator - Synthesis

**File:** `/packages/capabilities/src/services/capability-orchestrator.ts`

### Change generateFinalResponse() at Line 2314

**Before:**
```typescript
private async generateFinalResponse(
  context: OrchestrationContext,
  originalLLMResponse: string
): Promise<string> {
  logger.info(`🎯 Generating final response with ${context.results.length} capability results`);

  // If no capabilities were executed, return original response
  if (context.results.length === 0) {
    return originalLLMResponse;
  }

  // Build capability results summary for LLM
  const capabilityResults = context.results
    .map((result) => {
      const capability = result.capability;
      if (result.success && result.data) {
        return `${capability.name}:${capability.action} → ${result.data}`;
      } else if (result.error) {
        return `${capability.name}:${capability.action} → Error: ${result.error}`;
      } else {
        return `${capability.name}:${capability.action} → No result`;
      }
    })
    .join('\n');

  try {
    // Use Context Alchemy for synthesis prompt and final response generation
    const { contextAlchemy } = await import('./context-alchemy.js');
    const finalPrompt = await contextAlchemy.generateCapabilitySynthesisPrompt(
      context.originalMessage,
      capabilityResults
    );
    const { promptManager } = await import('./prompt-manager.js');

    const baseSystemPrompt = await promptManager.getCapabilityInstructions(finalPrompt);
    const { messages } = await contextAlchemy.buildMessageChain(
      finalPrompt,
      context.userId,
      baseSystemPrompt
    );

    const finalResponse = await openRouterService.generateFromMessageChain(  // ← OLD
      messages,
      context.userId,
      context.messageId
    );
```

**After:**
```typescript
private async generateFinalResponse(
  context: OrchestrationContext,
  originalLLMResponse: string
): Promise<string> {
  logger.info(`🎯 Generating final response with ${context.results.length} capability results`);

  // If no capabilities were executed, return original response
  if (context.results.length === 0) {
    return originalLLMResponse;
  }

  // Build capability results summary for LLM
  const capabilityResults = context.results
    .map((result) => {
      const capability = result.capability;
      if (result.success && result.data) {
        return `${capability.name}:${capability.action} → ${result.data}`;
      } else if (result.error) {
        return `${capability.name}:${capability.action} → Error: ${result.error}`;
      } else {
        return `${capability.name}:${capability.action} → No result`;
      }
    })
    .join('\n');

  try {
    // Use Context Alchemy for synthesis prompt and final response generation
    const { contextAlchemy } = await import('./context-alchemy.js');
    const finalPrompt = await contextAlchemy.generateCapabilitySynthesisPrompt(
      context.originalMessage,
      capabilityResults
    );
    const { promptManager } = await import('./prompt-manager.js');

    const baseSystemPrompt = await promptManager.getCapabilityInstructions(finalPrompt);
    const { messages } = await contextAlchemy.buildMessageChain(
      finalPrompt,
      context.userId,
      baseSystemPrompt
    );

    // ← NEW: Select SMART MODEL for final response synthesis
    const smartModel = openRouterService.selectSmartModel();
    logger.info(`🧠 SYNTHESIS: Using SMART MODEL for final response generation`);
    
    const finalResponse = await openRouterService.generateFromMessageChain(
      messages,
      context.userId,
      context.messageId,
      smartModel  // ← PASS SMART MODEL
    );
```

---

## Step 4: Update Environment Configuration

**File:** `.env`

**Add these new variables:**
```bash
# Three-tier model configuration for intelligent task routing
# FAST_MODEL: Quick capability extraction (small/cheap model)
FAST_MODEL="qwen/qwen3-coder:free"

# SMART_MODEL: High-quality response synthesis (balanced model)
SMART_MODEL="anthropic/claude-3.5-sonnet"

# MANAGER_MODEL: Complex planning and reasoning (strongest model)
MANAGER_MODEL="anthropic/claude-3.5-sonnet"
```

**File:** `.env.example`

**Add documentation:**
```bash
# ============================================================
# OPENROUTER - Three-Tier Model Configuration
# ============================================================
# Strategy: Use different models for different tasks to optimize
# cost, speed, and quality.

# FAST_MODEL: Lightweight model for capability extraction
#   - Used to detect what capabilities user needs
#   - Should be fast and cheap
#   - Examples: qwen/qwen3-coder:free, mistral-7b, llama-3.2-3b
# Default: qwen/qwen3-coder:free
FAST_MODEL="qwen/qwen3-coder:free"

# SMART_MODEL: High-quality model for response synthesis
#   - Used to generate final user-facing response
#   - Should be capable and produce good output
#   - Examples: anthropic/claude-3.5-sonnet, gpt-4, command-r-plus
# Default: anthropic/claude-3.5-sonnet
SMART_MODEL="anthropic/claude-3.5-sonnet"

# MANAGER_MODEL: Reasoning model for complex planning
#   - Used for multi-step reasoning and strategic decisions
#   - Should be the strongest/most capable model
#   - Examples: anthropic/claude-3.5-sonnet, gpt-4-turbo, llama-3.1-405b
# Default: anthropic/claude-3.5-sonnet
MANAGER_MODEL="anthropic/claude-3.5-sonnet"

# Legacy: Keep this for fallback/rotation (can be deprecated)
# OPENROUTER_MODELS="model1,model2,model3"
```

---

## Step 5: Optional - Update Streaming Support

**File:** `/packages/capabilities/src/services/openrouter.ts`

### Modify generateFromMessageChainStreaming (line 295)

**Add optional parameter:**
```typescript
async generateFromMessageChainStreaming(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  userId: string,
  onPartialResponse?: (partial: string) => void,
  messageId?: string,
  selectedModel?: string  // ← NEW PARAMETER
): Promise<string> {
  if (messages.length === 0) {
    throw new Error('No messages provided');
  }

  const startTime = Date.now();

  // Use selected model if provided, otherwise use current
  const currentModel = selectedModel || this.getCurrentModel();
  logger.info(
    `📡 Starting streaming generation for user ${userId} using model ${currentModel}`
  );

  for (let i = 0; i < this.models.length; i++) {
    // If specific model selected, use it first
    let model = currentModel;
    if (selectedModel && i > 0) {
      // Fall back to rotation if selected model fails
      model = this.models[(this.currentModelIndex + i - 1) % this.models.length];
    } else if (!selectedModel) {
      // Normal rotation behavior
      model = this.models[(this.currentModelIndex + i) % this.models.length];
    }

    try {
      logger.info(`📡 Attempting streaming with model ${model} (${i + 1}/${this.models.length})`);
      // ... rest of method
```

---

## Step 6: Optional - Upgrade Conscience Model

**File:** `/packages/capabilities/src/services/conscience.ts`

### Make Conscience Model Configurable (line 19)

**Before:**
```typescript
private conscienceModel = 'microsoft/phi-3-mini-128k-instruct:free';
```

**After:**
```typescript
private conscienceModel: string;

constructor() {
  this.conscienceModel = process.env.CONSCIENCE_MODEL || 'microsoft/phi-3-mini-128k-instruct:free';
  logger.info(`🧠 Conscience model configured: ${this.conscienceModel}`);
}
```

### Update .env
```bash
# Optional: Upgrade conscience safety model if desired
# Default: microsoft/phi-3-mini-128k-instruct:free
CONSCIENCE_MODEL="microsoft/phi-3-mini-128k-instruct:free"
```

---

## Testing the Implementation

### Test 1: Verify Model Selection

```typescript
// In a test file or debug endpoint
import { openRouterService } from './services/openrouter.js';

async function testModelSelection() {
  const fastModel = openRouterService.selectFastModel();
  const smartModel = openRouterService.selectSmartModel();
  const managerModel = openRouterService.selectManagerModel();

  console.log('Model Tiers Configured:');
  console.log(`  FAST: ${fastModel}`);
  console.log(`  SMART: ${smartModel}`);
  console.log(`  MANAGER: ${managerModel}`);

  // Verify models are in available models or are valid
  const available = openRouterService.getAvailableModels();
  console.log(`Available models: ${available.join(', ')}`);
}
```

### Test 2: Verify Capability Extraction Uses FAST

```bash
# Should see in logs:
# "🚀 FAST MODEL SELECTED: qwen/qwen3-coder:free (for extraction)"
# "🎯 Using FAST MODEL for capability extraction..."
```

### Test 3: Verify Synthesis Uses SMART

```bash
# Should see in logs:
# "🧠 SMART MODEL SELECTED: anthropic/claude-3.5-sonnet (for response synthesis)"
# "🧠 SYNTHESIS: Using SMART MODEL for final response generation"
```

---

## Rollback Strategy

If something goes wrong, you can quickly revert:

1. Remove model tier environment variables from `.env`
2. OpenRouter service will fall back to `getCurrentModel()` (rotation)
3. Everything continues working with simple rotation

The changes are backwards compatible because:
- New parameters are optional
- Fallback to rotation if not specified
- Conscience remains independent
- All error handling remains the same

---

## Performance Metrics to Monitor

After implementation, track these in logs:

```
Model Tier Usage:
- Count of FAST model calls
- Count of SMART model calls  
- Count of MANAGER model calls
- Success rate per tier

Cost Breakdown:
- Cost per FAST model call
- Cost per SMART model call
- Cost per MANAGER model call
- Total savings vs. rotation

Latency Breakdown:
- Average latency for extraction (FAST)
- Average latency for synthesis (SMART)
- Average latency for planning (MANAGER)

Quality Metrics:
- Capability extraction success rate
- Final response quality scores
- User satisfaction with response quality
```

