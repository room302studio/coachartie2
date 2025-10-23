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
import { costMonitor } from './cost-monitor.js';

class OpenRouterService {
  private client: OpenAI;
  private models: string[];
  private currentModelIndex: number = 0;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    
    // Primary configuration: comma-separated OPENROUTER_MODELS env var
    if (process.env.OPENROUTER_MODELS) {
      const rawModels = process.env.OPENROUTER_MODELS
        .split(',')
        .map(m => m.trim())
        .filter(m => m.length > 0); // Remove empty strings
      
      // Validate model format (should be provider/model or provider/model:variant)
      const validModels: string[] = [];
      const invalidModels: string[] = [];
      
      rawModels.forEach(model => {
        // Basic validation: should contain a slash and reasonable format
        if (model.includes('/') && model.length > 3 && !model.includes(' ')) {
          validModels.push(model);
        } else {
          invalidModels.push(model);
        }
      });
      
      if (invalidModels.length > 0) {
        logger.error(`❌ Invalid model names detected in OPENROUTER_MODELS:`, invalidModels);
        logger.error('💡 Model format should be: provider/model-name or provider/model-name:variant');
        logger.error('🔗 Find valid models at: https://openrouter.ai/models');
        
        if (validModels.length === 0) {
          logger.error('🚨 No valid models found! Using fallback models to prevent crash');
        } else {
          logger.warn(`⚠️ Continuing with ${validModels.length} valid models, ignoring ${invalidModels.length} invalid ones`);
        }
      }
      
      this.models = validModels.length > 0 ? validModels : [
        // Emergency fallback if all models are invalid (no openai/gpt-oss-20b:free - outputs internal reasoning)
        'z-ai/glm-4.5-air:free',
        'qwen/qwen3-coder:free',
        'mistralai/mistral-7b-instruct:free'
      ];
      
      logger.info(`🎯 Using ${this.models.length} models:`, this.models);
      
      if (validModels.length !== rawModels.length) {
        logger.warn(`⚠️ ${rawModels.length - validModels.length} invalid models were ignored`);
      }
      
    } else {
      // Fallback to current free models for development (removed openai/gpt-oss-20b:free - outputs internal reasoning)
      this.models = [
        'z-ai/glm-4.5-air:free',
        'qwen/qwen3-coder:free', 
        'mistralai/mistral-7b-instruct:free',
        'microsoft/phi-3-mini-128k-instruct:free',
        'meta-llama/llama-3.2-3b-instruct:free',
        'google/gemma-2-9b-it:free'
      ];
      
      logger.warn('⚠️ OPENROUTER_MODELS not set, using fallback free models');
      logger.info('💡 Set OPENROUTER_MODELS="model1,model2,model3" for full control');
    }

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

  getAvailableModels(): string[] {
    return [...this.models];
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
    
    // Rotate through models for testing different tool usage performance
    const startIndex = this.currentModelIndex;
    
    // Try each model starting from current rotation position
    for (let i = 0; i < this.models.length; i++) {
      const modelIndex = (startIndex + i) % this.models.length;
      const model = this.models[modelIndex];
      
      try {
        logger.info(`🤖 MODEL SELECTION: Using ${model} (${i+1}/${this.models.length}) for ${messages.length} messages`);

        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: 1000,
          temperature: 0.7,
        });

        const response = completion.choices[0]?.message?.content;

        logger.info(`✅ MODEL RESPONSE: ${model} generated ${response?.length || 0} chars successfully`);
        
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

        // Track costs in real-time cost monitor
        const { shouldCheckCredits, warnings } = costMonitor.trackCall(usage.prompt_tokens, usage.completion_tokens, model);

        // Log warnings if any
        if (warnings.length > 0) {
          logger.warn(`💸 Cost warnings for this call:`, warnings);
        }

        // Record usage statistics (don't await to avoid blocking)
        if (messageId) {
          UsageTracker.recordUsage({
            model_name: model,
            user_id: userId,
            message_id: messageId,
            input_length: messages.reduce((total, msg) => total + msg.content.length, 0),
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

        // Rotate to next model for testing different models' tool usage
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;
        
        logger.info(`✅ Generated response for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`);
        logger.info(`🔄 Rotated to next model: ${this.getCurrentModel()}`);
        return response.trim();

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStatus = (error as { status?: number }).status;
        
        logger.warn(`❌ Model ${model} failed:`, {
          error: errorMessage,
          status: errorStatus,
          modelIndex: i + 1,
          totalModels: this.models.length
        });
        
        // Detect specific error types
        if (errorStatus === 404 || errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
          logger.error(`🚨 Model "${model}" does not exist on OpenRouter! Check https://openrouter.ai/models`);
        } else if (errorMessage.includes('credit') || 
                   errorMessage.includes('billing') || 
                   errorMessage.includes('quota') ||
                   errorStatus === 402) {
          logger.info('💳 Billing/credit error detected, trying next model...');
        } else if (errorStatus === 429) {
          logger.warn('🚦 Rate limit hit, trying next model...');
        } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
          logger.warn('🔧 Server error, trying next model...');
        } else {
          logger.warn('🔄 Unknown error, trying next model...');
        }
        
        // For other errors, try next model
        if (i < this.models.length - 1) {
          continue;
        }
        
        // Last model failed
        logger.error('💥 All models failed. Last error:', error);
      }
    }
    
    // All models failed
    logger.error('🚨 All OpenRouter models failed, using fallback response');
    return "I'm Coach Artie! I'm having some technical difficulties right now, but I'm here to help. What can I assist you with today?";
  }

  /**
   * Generate streaming response with partial updates on double linebreaks
   */
  async generateFromMessageChainStreaming(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userId: string,
    onPartialResponse?: (partial: string) => void,
    messageId?: string
  ): Promise<string> {
    if (messages.length === 0) {
      throw new Error('No messages provided');
    }

    const startTime = Date.now();

    // Start with first model
    const currentModel = this.getCurrentModel();
    logger.info(`🤖 Starting streaming generation for user ${userId} using model ${currentModel}`);

    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[(this.currentModelIndex + i) % this.models.length];

      try {
        logger.info(`📡 Attempting streaming with model ${model} (${i + 1}/${this.models.length})`);

        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: 4000,
          temperature: 0.7,
          stream: true, // Enable streaming
          stream_options: { include_usage: true } // Request usage data in stream
        });

        let fullResponse = '';
        let lastSentLength = 0;
        let usage: TokenUsage | undefined;

        // Process streaming chunks - send new paragraphs as they complete
        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            fullResponse += delta;

            // Check for completed paragraphs (double newline indicates paragraph end)
            if (delta.includes('\n\n') && onPartialResponse) {
              // Find the new content since last sent
              if (fullResponse.length > lastSentLength) {
                // Look for complete paragraphs in the new content
                const newContent = fullResponse.slice(lastSentLength);
                const paragraphEndIndex = newContent.indexOf('\n\n');

                if (paragraphEndIndex !== -1) {
                  // We have at least one complete paragraph
                  const completeParagraph = newContent.slice(0, paragraphEndIndex).trim();
                  if (completeParagraph) {
                    onPartialResponse(completeParagraph);
                    lastSentLength = lastSentLength + paragraphEndIndex + 2; // +2 for '\n\n'
                  }
                }
              }
            }
          }

          // Capture usage data from final chunk (OpenRouter sends it at the end)
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens || 0,
              completion_tokens: chunk.usage.completion_tokens || 0,
              total_tokens: chunk.usage.total_tokens || 0
            };
          }
        }

        const responseTime = Date.now() - startTime;

        // If we didn't get usage data from stream, estimate it
        if (!usage) {
          logger.warn('⚠️ No usage data received from streaming API, estimating tokens');
          const estimatedPromptTokens = Math.ceil(messages.reduce((total, msg) => total + msg.content.length, 0) / 4);
          const estimatedCompletionTokens = Math.ceil(fullResponse.length / 4);
          usage = {
            prompt_tokens: estimatedPromptTokens,
            completion_tokens: estimatedCompletionTokens,
            total_tokens: estimatedPromptTokens + estimatedCompletionTokens
          };
        }

        // Calculate cost and track usage
        const estimatedCost = UsageTracker.calculateCost(model, usage);

        // Track costs in real-time cost monitor
        const { shouldCheckCredits, warnings } = costMonitor.trackCall(usage.prompt_tokens, usage.completion_tokens, model);

        // Log warnings if any
        if (warnings.length > 0) {
          logger.warn(`💸 Cost warnings for streaming call:`, warnings);
        }

        // Record usage statistics (don't await to avoid blocking)
        if (messageId) {
          UsageTracker.recordUsage({
            model_name: model,
            user_id: userId,
            message_id: messageId,
            input_length: messages.reduce((total, msg) => total + msg.content.length, 0),
            output_length: fullResponse.length,
            response_time_ms: responseTime,
            capabilities_detected: 0,
            capabilities_executed: 0,
            capability_types: '',
            success: true,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            estimated_cost: estimatedCost
          }).catch(error => {
            logger.error('Failed to record streaming usage stats:', error);
          });
        }

        // Rotate to next model for testing different models' tool usage
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;

        logger.info(`✅ Streaming completed for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`);
        logger.info(`🔄 Rotated to next model: ${this.getCurrentModel()}`);
        return fullResponse.trim();

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStatus = (error as { status?: number }).status;
        
        logger.warn(`❌ Streaming with model ${model} failed:`, {
          error: errorMessage,
          status: errorStatus,
          modelIndex: i + 1,
          totalModels: this.models.length
        });
        
        // Try next model on failure
        if (i < this.models.length - 1) {
          continue;
        }
        
        // Last model failed - fallback to regular generation
        logger.warn('📡 Streaming failed, falling back to regular generation');
        return await this.generateFromMessageChain(messages, userId);
      }
    }
    
    // Fallback response
    logger.error('🚨 All streaming attempts failed');
    return "I'm Coach Artie! I'm having some technical difficulties with streaming, but I'm here to help. What can I assist you with today?";
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