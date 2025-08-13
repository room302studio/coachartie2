import OpenAI from 'openai';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load from both root and local env files
config({ path: resolve(__dirname, '../../../../.env') });
config({ path: resolve(__dirname, '../../.env') });

import { logger } from '@coachartie/shared';
import { UsageTracker, TokenUsage } from './usage-tracker.js';
import { creditMonitor } from './credit-monitor.js';

class OpenRouterService {
  private client: OpenAI;
  private models: string[];
  private currentModelIndex: number = 0;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    
    // Free models only (claude credits exhausted)
    this.models = [
      'openai/gpt-oss-20b:free',
      'z-ai/glm-4.5-air:free',
      'qwen/qwen3-coder:free',
      'mistralai/mistral-7b-instruct:free',
      'microsoft/phi-3-mini-128k-instruct:free',
      'meta-llama/llama-3.2-3b-instruct:free',
      'google/gemma-2-9b-it:free'
    ];

    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY environment variable is required');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie',
      },
    });

    logger.info(`OpenRouter client initialized with models: ${this.models.join(', ')}`);
  }

  getCurrentModel(): string {
    return this.models[this.currentModelIndex];
  }

  async generateResponse(
    userMessage: string, 
    userId: string, 
    context?: string,
    messageId?: string
  ): Promise<string> {
    // DEPRECATED: This method should NOT exist - OpenRouter should be PURE
    // All message building should happen in Context Alchemy
    logger.error('🚨 generateResponse should NOT be used - OpenRouter must be PURE. Use Context Alchemy!');
    throw new Error('DEPRECATED: Use Context Alchemy to build messages, then call generateFromMessageChain directly');
  }

  async generateFromMessageChain(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userId: string,
    messageId?: string
  ): Promise<string> {
    const startTime = Date.now();
    
    // Try each model in order until one works
    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];
      
      try {
        logger.info(`Attempting to generate response with model: ${model} using ${messages.length} messages`);
        
        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: 1000,
          temperature: 0.7,
        });

        const response = completion.choices[0]?.message?.content;
        
        if (!response) {
          throw new Error('No response generated');
        }

        const responseTime = Date.now() - startTime;
        
        // Extract token usage from API response
        const usage: TokenUsage = {
          prompt_tokens: completion.usage?.prompt_tokens || 0,
          completion_tokens: completion.usage?.completion_tokens || 0,
          total_tokens: completion.usage?.total_tokens || 0
        };

        // Check for credit/billing info in OpenRouter response
        const creditInfo = {
          usage: completion.usage,
          model: completion.model,
          id: completion.id,
          system_fingerprint: completion.system_fingerprint,
          // OpenRouter sometimes includes these fields
          cost: (completion as any).cost,
          credits_used: (completion as any).credits_used,
          credits_remaining: (completion as any).credits_remaining,
          generation_time: (completion as any).generation_time,
          provider: (completion as any).provider
        };
        
        logger.info('💳 OpenRouter Credit Info:', creditInfo);
        
        // Record credit info if available
        if (creditInfo.credits_remaining !== undefined || creditInfo.credits_used !== undefined) {
          await creditMonitor.recordCreditInfo(creditInfo);
        }

        // Calculate cost and record usage
        const estimatedCost = UsageTracker.calculateCost(model, usage);
        
        // Record usage statistics (don't await to avoid blocking)
        if (messageId) {
          UsageTracker.recordUsage({
            model_name: model,
            user_id: userId,
            message_id: messageId,
            input_length: userMessage.length,
            output_length: response.length,
            response_time_ms: responseTime,
            capabilities_detected: 0, // Will be updated by orchestrator
            capabilities_executed: 0, // Will be updated by orchestrator
            capability_types: '',     // Will be updated by orchestrator
            success: true,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            estimated_cost: estimatedCost
          }).catch(error => {
            logger.error('Failed to record usage stats:', error);
          });
        }

        logger.info(`✅ Generated response for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`);
        return response.trim();

      } catch (error: unknown) {
        logger.warn(`❌ Model ${model} failed: ${error instanceof Error ? error.message : String(error)}`);
        
        // If this was a credit/billing error, try free models
        const errorMessage = error instanceof Error ? error.message : '';
        if (errorMessage.includes('credit') || 
            errorMessage.includes('billing') || 
            errorMessage.includes('quota') ||
            (error as { status?: number }).status === 402) {
          logger.info('💳 Billing/credit error detected, skipping to free models...');
          continue;
        }
        
        // For other errors, try next model
        if (i < this.models.length - 1) {
          logger.info(`🔄 Trying next model...`);
          continue;
        }
        
        // Last model failed
        logger.error('All models failed:', error);
      }
    }
    
    // All models failed
    logger.error('🚨 All OpenRouter models failed, using fallback response');
    return "I'm Coach Artie! I'm having some technical difficulties right now, but I'm here to help. What can I assist you with today?";
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Simple health check - try the first model
      const completion = await this.client.chat.completions.create({
        model: this.models[0],
        messages: [
          {
            role: 'user',
            content: 'Say "OK" if you can respond.',
          },
        ],
        max_tokens: 5,
        temperature: 0,
      });

      return !!completion.choices[0]?.message?.content;
    } catch (error) {
      logger.error('OpenRouter health check failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const openRouterService = new OpenRouterService();