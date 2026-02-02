/**
 * Model Harness Types
 * 
 * Abstraction layer for different LLM providers and specialized models.
 * Supports sync (OpenRouter), async/polling (o4-deep-research), and streaming.
 */

export type HarnessType = 'sync' | 'async' | 'streaming';

export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  userId?: string;
  taskId?: string;
}

export interface ToolDefinition {
  type: string;
  name?: string;
  description?: string;
}

export interface ResearchTask {
  id: string;
  prompt: string;
  context?: string;
  tools?: ('web_search' | 'code_interpreter')[];
  maxBudget?: number;
  userId: string;
  createdAt: Date;
}

export interface TaskHandle {
  id: string;
  provider: string;
  createdAt: Date;
}

export interface TaskStatus {
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  toolCalls?: number;
  webSearches?: number;
  codeExecutions?: number;
  elapsedMs?: number;
  error?: string;
}

export interface TaskResult {
  content: string;
  reasoning?: string;
  toolCalls?: Array<{
    type: string;
    input?: unknown;
    output?: unknown;
  }>;
  usage: TokenUsage;
  cost: CostBreakdown;
  completedAt: Date;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface CostBreakdown {
  tokens: number;
  webSearches: number;
  codeInterpreter: number;
  total: number;
  currency: 'USD';
}

export interface CostEstimate {
  min: number;
  max: number;
  typical: number;
  currency: 'USD';
}

export interface UsageStats {
  totalTasks: number;
  totalCost: number;
  totalTokens: number;
  totalWebSearches: number;
  totalCodeExecutions: number;
  periodStart: Date;
}

/**
 * Core Model Harness Interface
 * 
 * All model providers implement this interface.
 */
export interface ModelHarness {
  /** Unique harness name */
  name: string;
  
  /** How this harness operates */
  type: HarnessType;
  
  /** Human-readable description */
  description: string;
  
  /** Check if harness is configured and ready */
  isAvailable(): boolean;
  
  /** For sync/streaming models - direct generation */
  generate?(prompt: string, options?: GenerateOptions): Promise<string>;
  
  /** For streaming models */
  generateStream?(
    prompt: string, 
    options?: GenerateOptions,
    onChunk?: (chunk: string) => void
  ): Promise<string>;
  
  /** For async models - submit task */
  submitTask?(task: ResearchTask): Promise<TaskHandle>;
  
  /** For async models - check status */
  pollTask?(handle: TaskHandle): Promise<TaskStatus>;
  
  /** For async models - get completed result */
  getResult?(handle: TaskHandle): Promise<TaskResult>;
  
  /** For async models - cancel in-progress task */
  cancelTask?(handle: TaskHandle): Promise<boolean>;
  
  /** Estimate cost before running */
  estimateCost(task: ResearchTask): CostEstimate;
  
  /** Get usage stats for this harness */
  getUsage(): UsageStats;
}
