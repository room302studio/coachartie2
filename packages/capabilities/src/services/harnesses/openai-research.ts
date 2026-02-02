/**
 * OpenAI Deep Research Harness
 * 
 * Integrates with o4-mini-deep-research model for complex research tasks.
 * Uses async/polling pattern - submit task, poll for status, get results.
 * 
 * Pricing (as of Jan 2026):
 * - Tokens: $2/$8 per million input/output
 * - Web search: $0.01 per call
 * - Code interpreter: $0.03 per session
 */

import { logger } from '@coachartie/shared';
import type {
  ModelHarness,
  ResearchTask,
  TaskHandle,
  TaskStatus,
  TaskResult,
  CostEstimate,
  UsageStats,
  GenerateOptions,
} from './types.js';

// OpenAI Responses API response types
interface OpenAIToolCall {
  type: string;
  input?: unknown;
  output?: unknown;
}

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
}

interface OpenAIResponseData {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  output?: string;
  content?: string;
  reasoning?: string;
  tool_calls?: OpenAIToolCall[];
  usage?: OpenAIUsage;
  error?: string;
}

// In-memory tracking (would move to DB for production)
const activeTasks = new Map<string, TaskHandle>();
const usageStats: UsageStats = {
  totalTasks: 0,
  totalCost: 0,
  totalTokens: 0,
  totalWebSearches: 0,
  totalCodeExecutions: 0,
  periodStart: new Date(),
};

export class OpenAIResearchHarness implements ModelHarness {
  name = 'openai-deep-research';
  type = 'async' as const;
  description = 'OpenAI o4-mini-deep-research for complex research tasks with web search and code execution';
  
  private apiKey: string | null = null;
  private baseUrl = 'https://api.openai.com/v1';
  
  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || null;
    if (!this.apiKey) {
      logger.warn('🔬 OpenAI Research Harness: No OPENAI_API_KEY configured');
    } else {
      logger.info('🔬 OpenAI Research Harness: Ready');
    }
  }
  
  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey !== 'sk-your-openai-key-here';
  }
  
  async submitTask(task: ResearchTask): Promise<TaskHandle> {
    if (!this.isAvailable()) {
      throw new Error('OpenAI Research Harness not configured - missing OPENAI_API_KEY');
    }
    
    logger.info(`🔬 Submitting research task: ${task.id}`);
    logger.info(`   Prompt: ${task.prompt.slice(0, 100)}...`);
    
    const tools = (task.tools || ['web_search', 'code_interpreter']).map(t => ({ type: t }));
    
    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'o4-mini-deep-research',
          input: task.context 
            ? `Context: ${task.context}\n\nResearch task: ${task.prompt}`
            : task.prompt,
          background: true,
          tools,
        }),
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }
      
      const data = (await response.json()) as OpenAIResponseData;

      const handle: TaskHandle = {
        id: data.id,
        provider: 'openai',
        createdAt: new Date(),
      };
      
      activeTasks.set(task.id, handle);
      usageStats.totalTasks++;
      
      logger.info(`🔬 Research task submitted: ${handle.id}`);
      return handle;
      
    } catch (error) {
      logger.error('🔬 Failed to submit research task:', error);
      throw error;
    }
  }
  
  async pollTask(handle: TaskHandle): Promise<TaskStatus> {
    if (!this.isAvailable()) {
      throw new Error('OpenAI Research Harness not configured');
    }
    
    try {
      const response = await fetch(`${this.baseUrl}/responses/${handle.id}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
      
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }
      
      const data = (await response.json()) as OpenAIResponseData;

      const status: TaskStatus = {
        status: data.status,
        progress: data.progress,
        toolCalls: data.tool_calls?.length || 0,
        webSearches: data.tool_calls?.filter((t) => t.type === 'web_search').length || 0,
        codeExecutions: data.tool_calls?.filter((t) => t.type === 'code_interpreter').length || 0,
        elapsedMs: Date.now() - handle.createdAt.getTime(),
      };
      
      logger.debug(`🔬 Task ${handle.id} status: ${status.status} (${status.toolCalls} tool calls)`);
      return status;
      
    } catch (error) {
      logger.error('🔬 Failed to poll task:', error);
      throw error;
    }
  }
  
  async getResult(handle: TaskHandle): Promise<TaskResult> {
    if (!this.isAvailable()) {
      throw new Error('OpenAI Research Harness not configured');
    }
    
    try {
      const response = await fetch(`${this.baseUrl}/responses/${handle.id}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
      
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }
      
      const data = (await response.json()) as OpenAIResponseData;

      if (data.status !== 'completed') {
        throw new Error(`Task not completed: ${data.status}`);
      }

      const webSearches = data.tool_calls?.filter((t) => t.type === 'web_search').length || 0;
      const codeExecutions = data.tool_calls?.filter((t) => t.type === 'code_interpreter').length || 0;

      const cost = {
        tokens: ((data.usage?.input_tokens || 0) * 2 + (data.usage?.output_tokens || 0) * 8) / 1_000_000,
        webSearches: webSearches * 0.01,
        codeInterpreter: codeExecutions * 0.03,
        total: 0,
        currency: 'USD' as const,
      };
      cost.total = cost.tokens + cost.webSearches + cost.codeInterpreter;

      // Update usage stats
      usageStats.totalCost += cost.total;
      usageStats.totalTokens += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
      usageStats.totalWebSearches += webSearches;
      usageStats.totalCodeExecutions += codeExecutions;

      const result: TaskResult = {
        content: data.output || data.content || '',
        reasoning: data.reasoning,
        toolCalls: data.tool_calls,
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          reasoningTokens: data.usage?.reasoning_tokens,
        },
        cost,
        completedAt: new Date(),
      };
      
      logger.info(`🔬 Research complete: ${handle.id} - $${cost.total.toFixed(2)}`);
      return result;
      
    } catch (error) {
      logger.error('🔬 Failed to get result:', error);
      throw error;
    }
  }
  
  async cancelTask(handle: TaskHandle): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }
    
    try {
      const response = await fetch(`${this.baseUrl}/responses/${handle.id}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
      
      return response.ok;
    } catch {
      return false;
    }
  }
  
  estimateCost(task: ResearchTask): CostEstimate {
    // Rough estimates based on typical research tasks
    const hasWebSearch = !task.tools || task.tools.includes('web_search');
    const hasCode = !task.tools || task.tools.includes('code_interpreter');
    
    return {
      min: 0.30, // Just tokens, minimal tools
      max: 3.00, // Heavy research, many searches
      typical: hasWebSearch && hasCode ? 1.10 : 0.50,
      currency: 'USD',
    };
  }
  
  getUsage(): UsageStats {
    return { ...usageStats };
  }
  
  // Not used for async harness, but required by interface
  async generate(_prompt: string, _options?: GenerateOptions): Promise<string> {
    throw new Error('OpenAI Research Harness is async-only. Use submitTask/pollTask/getResult.');
  }
}

// Singleton instance
export const openaiResearchHarness = new OpenAIResearchHarness();
