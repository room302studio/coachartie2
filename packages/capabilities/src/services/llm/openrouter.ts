import OpenAI from 'openai';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load from both root and local env files
config({ path: resolve(__dirname, '../../../../.env') });
config({ path: resolve(__dirname, '../../.env') });

import { logger } from '@coachartie/shared';
import { UsageTracker, TokenUsage } from '../monitoring/usage-tracker.js';
import { creditMonitor } from '../monitoring/credit-monitor.js';
import { costMonitor } from '../monitoring/cost-monitor.js';

// Context Alchemy observability
import { traceManager, experimentManager } from '../context-alchemy/index.js';

class OpenRouterService {
  private client: OpenAI;
  private models: string[];
  private currentModelIndex: number = 0;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

    // Primary configuration: comma-separated OPENROUTER_MODELS env var
    if (process.env.OPENROUTER_MODELS) {
      const rawModels = process.env.OPENROUTER_MODELS.split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0); // Remove empty strings

      // Validate model format (should be provider/model or provider/model:variant)
      const validModels: string[] = [];
      const invalidModels: string[] = [];

      rawModels.forEach((model) => {
        // Basic validation: should contain a slash and reasonable format
        if (model.includes('/') && model.length > 3 && !model.includes(' ')) {
          validModels.push(model);
        } else {
          invalidModels.push(model);
        }
      });

      if (invalidModels.length > 0) {
        logger.error(`❌ Invalid model names detected in OPENROUTER_MODELS:`, invalidModels);
        logger.error(
          '💡 Model format should be: provider/model-name or provider/model-name:variant'
        );
        logger.error('🔗 Find valid models at: https://openrouter.ai/models');

        if (validModels.length === 0) {
          logger.error('🚨 No valid models found! Using fallback models to prevent crash');
        } else {
          logger.warn(
            `⚠️ Continuing with ${validModels.length} valid models, ignoring ${invalidModels.length} invalid ones`
          );
        }
      }

      this.models =
        validModels.length > 0
          ? validModels
          : [
              // Emergency fallback if all models are invalid (no openai/gpt-oss-20b:free - outputs internal reasoning)
              'z-ai/glm-4.5-air:free',
              'qwen/qwen3-coder:free',
              'mistralai/mistral-7b-instruct:free',
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
        'google/gemma-2-9b-it:free',
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

    // Validate models against API on startup (async, non-blocking)
    this.validateModelsOnStartup().catch((err) => {
      logger.error('❌ Failed to validate models on startup:', err);
    });

    // Check credit balance on startup
    import('../monitoring/credit-monitor.js').then(({ creditMonitor }) => {
      creditMonitor.proactiveBalanceCheck().then((result) => {
        if (result.error) {
          logger.debug(`Credit check on startup: ${result.error}`);
        }
      });
    });
  }

  /**
   * Validate configured models exist on the API
   * Warns loudly if models don't exist to prevent silent fallback
   */
  private async validateModelsOnStartup(): Promise<void> {
    try {
      const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
      const response = await fetch(`${baseURL}/models`, {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
      });

      if (!response.ok) {
        logger.warn(
          `⚠️ Could not fetch models from API (${response.status}) - skipping validation`
        );
        return;
      }

      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const availableModels = new Set((data.data || []).map((m) => m.id));

      const missingModels: string[] = [];
      const validModels: string[] = [];

      for (const model of this.models) {
        if (availableModels.has(model)) {
          validModels.push(model);
        } else {
          missingModels.push(model);
        }
      }

      if (missingModels.length > 0) {
        logger.error(`\n${'='.repeat(70)}`);
        logger.error(
          `🚨 MODEL VALIDATION FAILED: ${missingModels.length} configured models don't exist on API!`
        );
        logger.error(`   Missing: ${missingModels.join(', ')}`);
        logger.error(`   API has ${availableModels.size} models available.`);
        logger.error(`   Similar models that DO exist:`);

        // Suggest similar models
        for (const missing of missingModels) {
          const prefix = missing.split('/')[0];
          const similar = Array.from(availableModels)
            .filter((m) => (m as string).startsWith(prefix + '/'))
            .slice(0, 3);
          if (similar.length > 0) {
            logger.error(`     ${missing} → try: ${similar.join(', ')}`);
          }
        }

        logger.error(`${'='.repeat(70)}\n`);

        // Update models list to only include valid ones
        if (validModels.length > 0) {
          this.models = validModels;
          logger.warn(
            `⚠️ Continuing with ${validModels.length} valid models: ${validModels.join(', ')}`
          );
        } else {
          logger.error(`🚨 NO VALID MODELS! Requests will likely fail or use fallback.`);
        }
      } else {
        logger.info(`✅ All ${this.models.length} configured models validated against API`);
      }
    } catch (error) {
      logger.warn(`⚠️ Model validation failed (non-critical):`, error);
    }
  }

  getCurrentModel(): string {
    return this.models[this.currentModelIndex];
  }

  getAvailableModels(): string[] {
    return [...this.models];
  }

  // THREE-TIER MODEL STRATEGY: Speed + Cost Optimization
  // Fast model extracts capabilities → Smart model responds → Manager plans complex tasks

  /**
   * Select FAST_MODEL for capability extraction (fast, cheap, simple pattern matching)
   */
  selectFastModel(): string {
    const fastModel = process.env.FAST_MODEL;
    if (fastModel && fastModel.trim().length > 0) {
      logger.info(`🚀 FAST MODEL SELECTED: ${fastModel} (capability extraction)`);
      return fastModel;
    }
    // Fallback to rotation if not configured
    logger.warn('⚠️ FAST_MODEL not configured, using rotation');
    return this.getCurrentModel();
  }

  /**
   * Select SMART_MODEL for response synthesis (balanced, high quality)
   */
  selectSmartModel(): string {
    const smartModel = process.env.SMART_MODEL;
    if (smartModel && smartModel.trim().length > 0) {
      logger.info(`🧠 SMART MODEL SELECTED: ${smartModel} (response synthesis)`);
      return smartModel;
    }
    // Fallback to rotation if not configured
    logger.warn('⚠️ SMART_MODEL not configured, using rotation');
    return this.getCurrentModel();
  }

  /**
   * Select MANAGER_MODEL for complex planning and reasoning (strongest model)
   */
  selectManagerModel(): string {
    const managerModel = process.env.MANAGER_MODEL;
    if (managerModel && managerModel.trim().length > 0) {
      logger.info(`🎯 MANAGER MODEL SELECTED: ${managerModel} (complex planning)`);
      return managerModel;
    }
    // Fallback to SMART_MODEL if not configured
    const smartModel = process.env.SMART_MODEL;
    if (smartModel && smartModel.trim().length > 0) {
      logger.info(`🧠 MANAGER fallback to SMART_MODEL: ${smartModel}`);
      return smartModel;
    }
    // Fallback to rotation if neither configured
    logger.warn('⚠️ MANAGER_MODEL not configured, using rotation');
    return this.getCurrentModel();
  }

  /**
   * Task-aware model selection (convenience method)
   */
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

  /**
   * Determine model tier for observability tracking
   * Returns 'fast', 'smart', or 'manager' based on model configuration
   */
  getModelTier(model: string): string {
    const fastModel = process.env.FAST_MODEL;
    const smartModel = process.env.SMART_MODEL;
    const managerModel = process.env.MANAGER_MODEL;

    if (fastModel && model === fastModel) return 'fast';
    if (smartModel && model === smartModel) return 'smart';
    if (managerModel && model === managerModel) return 'manager';

    // Infer from model name patterns
    if (model.includes('mini') || model.includes('flash') || model.includes('fast')) return 'fast';
    if (model.includes('opus') || model.includes('4o') || model.includes('large')) return 'manager';

    return 'smart'; // Default tier
  }

  async generateResponse(
    _userMessage: string,
    _userId: string,
    _context?: string,
    _messageId?: string
  ): Promise<string> {
    // DEPRECATED: This method should NOT exist - OpenRouter should be PURE
    // All message building should happen in Context Alchemy
    logger.error(
      '🚨 generateResponse should NOT be used - OpenRouter must be PURE. Use Context Alchemy!'
    );
    throw new Error(
      'DEPRECATED: Use Context Alchemy to build messages, then call generateFromMessageChain directly'
    );
  }

  async generateFromMessageChain(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userId: string,
    messageId?: string,
    selectedModel?: string,
    options?: {
      traceId?: string | null;
      guildId?: string;
      maxTokens?: number; // Dynamic token limit from preflight analysis
      stepType?: string; // Cost attribution: 'response' | 'observational_learning' | 'capability' | 'planning'
    }
  ): Promise<string> {
    // SHORT-CIRCUIT: If credits are exhausted, don't even try the API
    if (creditMonitor.areCreditsExhausted()) {
      logger.info('💳 Skipping API call - credits exhausted (in cooldown period)');
      throw new Error(
        '💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.'
      );
    }

    const startTime = Date.now();
    const traceId = options?.traceId;
    const guildId = options?.guildId;

    // Context Alchemy: Check for experiment variant assignment
    let experimentId: string | null = null;
    let variantId: string | null = null;
    let variantModelOverride: string | undefined;
    let variantTemperature: number | undefined;

    if (traceId) {
      try {
        const variant = await experimentManager.getVariantForUser(userId, guildId);
        experimentId = variant.experimentId;
        variantId = variant.variantId;

        // Apply model override if experiment specifies one
        if (variant.config.smartModel && !selectedModel) {
          variantModelOverride = variant.config.smartModel;
          logger.info(
            `🧪 Experiment ${experimentId}: Using model override ${variantModelOverride}`
          );
        }

        // Apply temperature override if experiment specifies one
        if (variant.config.temperature !== undefined) {
          variantTemperature = variant.config.temperature;
          logger.info(`🧪 Experiment ${experimentId}: Using temperature ${variantTemperature}`);
        }
      } catch (error) {
        // Experiment lookup failed, continue without experiment
        logger.debug('[experiment] Variant lookup failed, continuing normally');
      }
    }

    // If a specific model was selected (three-tier strategy), use it
    // Otherwise check for experiment override, then rotate through models
    const effectiveModel = selectedModel || variantModelOverride;
    const useSpecificModel = effectiveModel && effectiveModel.trim().length > 0;
    const startIndex = this.currentModelIndex;

    // Try each model starting from current rotation position (or just the selected model)
    const modelsToTry = useSpecificModel ? [effectiveModel] : this.models;

    for (let i = 0; i < modelsToTry.length; i++) {
      const model = useSpecificModel
        ? effectiveModel
        : this.models[(startIndex + i) % this.models.length];

      try {
        logger.info(
          `🤖 MODEL SELECTION: Using ${model} ${useSpecificModel ? '(SPECIFIC)' : `(${i + 1}/${modelsToTry.length})`} for ${messages.length} messages`
        );

        // Use dynamic maxTokens from preflight analysis, or fall back to env default
        const maxTokens = options?.maxTokens || parseInt(process.env.LLM_MAX_TOKENS || '400', 10);
        logger.debug(
          `📏 Using max_tokens: ${maxTokens}${options?.maxTokens ? ' (preflight)' : ' (default)'}`
        );

        // Use experiment temperature if set, otherwise default
        const temperature = variantTemperature ?? 0.7;

        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
        });

        const response = completion.choices[0]?.message?.content;

        logger.info(
          `✅ MODEL RESPONSE: ${model} generated ${response?.length || 0} chars successfully`
        );

        if (!response) {
          throw new Error('No response generated');
        }

        const responseTime = Date.now() - startTime;

        // Extract token usage from API response
        const usage: TokenUsage = {
          prompt_tokens: completion.usage?.prompt_tokens || 0,
          completion_tokens: completion.usage?.completion_tokens || 0,
          total_tokens: completion.usage?.total_tokens || 0,
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
          provider: (completion as any).provider,
        };

        logger.info('💳 OpenRouter Credit Info:', creditInfo);

        // Record credit info if available
        if (creditInfo.credits_remaining !== undefined || creditInfo.credits_used !== undefined) {
          await creditMonitor.recordCreditInfo(creditInfo);
        }

        // Calculate cost and record usage
        const estimatedCost = UsageTracker.calculateCost(model, usage);

        // Track costs in real-time cost monitor
        const { warnings } = costMonitor.trackCall(
          usage.prompt_tokens,
          usage.completion_tokens,
          model
        );

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
            capability_types: '', // Will be updated by orchestrator
            success: true,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            estimated_cost: estimatedCost,
            step_type: options?.stepType || (userId === 'observational-system' ? 'observational_learning' : 'response'),
          }).catch((error) => {
            logger.error('Failed to record usage stats:', error);
          });
        }

        // Rotate to next model for testing different models' tool usage
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;

        // Context Alchemy: Update trace with model and cost info
        if (traceId) {
          await traceManager.updateTrace(traceId, {
            modelUsed: model,
            modelTier: this.getModelTier(model),
            responseTokens: usage.completion_tokens,
            estimatedCost,
            experimentId: experimentId || undefined,
            variantId: variantId || undefined,
          });
        }

        logger.info(
          `✅ Generated response for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`
        );
        logger.info(`🔄 Rotated to next model: ${this.getCurrentModel()}`);
        return response.trim();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStatus = (error as { status?: number }).status;

        logger.warn(`❌ Model ${model} failed:`, {
          error: errorMessage,
          status: errorStatus,
          modelIndex: i + 1,
          totalModels: modelsToTry.length,
        });

        // Track if this is a credit/billing error
        const isCreditError =
          errorMessage.includes('credit') ||
          errorMessage.includes('billing') ||
          errorMessage.includes('quota') ||
          errorStatus === 402;

        const isLastModel = i === modelsToTry.length - 1;

        // Detect specific error types and throw clear errors on last model
        if (
          errorStatus === 404 ||
          errorMessage.includes('not found') ||
          errorMessage.includes('does not exist')
        ) {
          logger.error(
            `🚨 Model "${model}" does not exist on OpenRouter! Check https://openrouter.ai/models`
          );
          if (isLastModel) {
            throw new Error(
              `🚨 MODEL NOT FOUND: "${model}" does not exist. Check https://openrouter.ai/models`
            );
          }
        } else if (isCreditError) {
          logger.info(
            '💳 Billing/credit error detected' + (isLastModel ? '' : ', trying next model...')
          );
          // Mark credits as exhausted to prevent repeated API calls
          creditMonitor.markCreditsExhausted();
          if (isLastModel) {
            throw new Error(
              '💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.'
            );
          }
        } else if (errorStatus === 429) {
          logger.warn('🚦 Rate limit hit' + (isLastModel ? '' : ', trying next model...'));
          if (isLastModel) {
            throw new Error(
              '⏱️ RATE LIMITED: Too many requests to OpenRouter. Please wait and try again.'
            );
          }
        } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
          logger.warn('🔧 Server error' + (isLastModel ? '' : ', trying next model...'));
          if (isLastModel) {
            throw new Error(
              `🔧 SERVER ERROR: OpenRouter returned ${errorStatus}. The service may be temporarily unavailable.`
            );
          }
        } else {
          logger.warn('🔄 Unknown error' + (isLastModel ? '' : ', trying next model...'));
          if (isLastModel) {
            throw new Error(`❌ LLM ERROR: ${errorMessage.substring(0, 200)}`);
          }
        }

        // Try next model
        if (!isLastModel) {
          continue;
        }

        // Last model failed - should have thrown above, but fallback just in case
        logger.error('💥 All models failed. Last error:', error);
        throw error;
      }
    }

    // All models failed
    logger.error('🚨 All OpenRouter models failed');
    throw new Error(
      'All OpenRouter models failed. This may be due to service issues or configuration problems.'
    );
  }

  /**
   * Generate streaming response with partial updates on double linebreaks
   */
  async generateFromMessageChainStreaming(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userId: string,
    onPartialResponse?: (partial: string) => void,
    messageId?: string,
    selectedModel?: string,
    options?: {
      traceId?: string | null;
      guildId?: string;
      maxTokens?: number; // Dynamic token limit from preflight analysis
      stepType?: string; // Cost attribution: 'response' | 'observational_learning' | 'capability' | 'planning'
    }
  ): Promise<string> {
    if (messages.length === 0) {
      throw new Error('No messages provided');
    }

    const startTime = Date.now();
    const traceId = options?.traceId;
    const guildId = options?.guildId;
    const requestedMaxTokens = options?.maxTokens;

    // Context Alchemy: Check for experiment variant assignment
    let experimentId: string | null = null;
    let variantId: string | null = null;
    let variantModelOverride: string | undefined;
    let variantTemperature: number | undefined;

    if (traceId) {
      try {
        const variant = await experimentManager.getVariantForUser(userId, guildId);
        experimentId = variant.experimentId;
        variantId = variant.variantId;

        if (variant.config.smartModel && !selectedModel) {
          variantModelOverride = variant.config.smartModel;
          logger.info(
            `🧪 Experiment ${experimentId}: Using model override ${variantModelOverride}`
          );
        }

        if (variant.config.temperature !== undefined) {
          variantTemperature = variant.config.temperature;
          logger.info(`🧪 Experiment ${experimentId}: Using temperature ${variantTemperature}`);
        }
      } catch (error) {
        logger.debug('[experiment] Variant lookup failed, continuing normally');
      }
    }

    // If a specific model was selected (three-tier strategy), use it
    // Otherwise check for experiment override, then rotate through models
    const effectiveModel = selectedModel || variantModelOverride;
    const useSpecificModel = effectiveModel && effectiveModel.trim().length > 0;
    const startIndex = this.currentModelIndex;

    // Try each model starting from current rotation position (or just the selected model)
    const modelsToTry = useSpecificModel ? [effectiveModel] : this.models;

    logger.info(
      `🤖 Starting streaming generation for user ${userId} ${useSpecificModel ? `using SPECIFIC model ${effectiveModel}` : `using model rotation`}`
    );

    for (let i = 0; i < modelsToTry.length; i++) {
      const model = useSpecificModel
        ? effectiveModel
        : this.models[(startIndex + i) % this.models.length];

      try {
        logger.info(
          `📡 Attempting streaming with model ${model} ${useSpecificModel ? '(SPECIFIC)' : `(${i + 1}/${modelsToTry.length})`}`
        );

        // Use preflight-analyzed maxTokens if provided, otherwise fall back to env default
        const maxTokens = requestedMaxTokens || parseInt(process.env.LLM_MAX_TOKENS || '400', 10);
        const temperature = variantTemperature ?? 0.7;

        const completion = await this.client.chat.completions.create({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: true, // Enable streaming
          stream_options: { include_usage: true }, // Request usage data in stream
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
              total_tokens: chunk.usage.total_tokens || 0,
            };
          }
        }

        const responseTime = Date.now() - startTime;

        // If we didn't get usage data from stream, estimate it
        if (!usage) {
          logger.warn('⚠️ No usage data received from streaming API, estimating tokens');
          const estimatedPromptTokens = Math.ceil(
            messages.reduce((total, msg) => total + msg.content.length, 0) / 4
          );
          const estimatedCompletionTokens = Math.ceil(fullResponse.length / 4);
          usage = {
            prompt_tokens: estimatedPromptTokens,
            completion_tokens: estimatedCompletionTokens,
            total_tokens: estimatedPromptTokens + estimatedCompletionTokens,
          };
        }

        // Calculate cost and track usage
        const estimatedCost = UsageTracker.calculateCost(model, usage);

        // Track costs in real-time cost monitor
        const { warnings: streamWarnings } = costMonitor.trackCall(
          usage.prompt_tokens,
          usage.completion_tokens,
          model
        );

        // Log warnings if any
        if (streamWarnings.length > 0) {
          logger.warn(`💸 Cost warnings for streaming call:`, streamWarnings);
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
            estimated_cost: estimatedCost,
            step_type: options?.stepType || (userId === 'observational-system' ? 'observational_learning' : 'response'),
          }).catch((error) => {
            logger.error('Failed to record streaming usage stats:', error);
          });
        }

        // Rotate to next model for testing different models' tool usage
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;

        // Context Alchemy: Update trace with model and cost info
        if (traceId) {
          await traceManager.updateTrace(traceId, {
            modelUsed: model,
            modelTier: this.getModelTier(model),
            responseTokens: usage.completion_tokens,
            estimatedCost,
            experimentId: experimentId || undefined,
            variantId: variantId || undefined,
          });
        }

        logger.info(
          `✅ Streaming completed for user ${userId} using ${model} (${usage.total_tokens} tokens, $${estimatedCost.toFixed(4)})`
        );
        logger.info(`🔄 Rotated to next model: ${this.getCurrentModel()}`);
        return fullResponse.trim();
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStatus = (error as { status?: number }).status;

        logger.warn(`❌ Streaming with model ${model} failed:`, {
          error: errorMessage,
          status: errorStatus,
          modelIndex: i + 1,
          totalModels: modelsToTry.length,
        });

        // Track if this is a credit/billing error
        const isCreditError =
          errorMessage.includes('credit') ||
          errorMessage.includes('billing') ||
          errorMessage.includes('quota') ||
          errorStatus === 402;

        const isLastModel = i === modelsToTry.length - 1;

        // Throw clear errors on last model failure
        if (isLastModel) {
          if (isCreditError) {
            throw new Error(
              '💳 OUT OF CREDITS: OpenRouter account needs more credits. Visit https://openrouter.ai/settings/credits to add funds.'
            );
          } else if (errorStatus === 429) {
            throw new Error(
              '⏱️ RATE LIMITED: Too many requests to OpenRouter. Please wait and try again.'
            );
          } else if (errorStatus === 500 || errorStatus === 502 || errorStatus === 503) {
            throw new Error(
              `🔧 SERVER ERROR: OpenRouter returned ${errorStatus}. The service may be temporarily unavailable.`
            );
          } else {
            throw new Error(`❌ LLM ERROR: ${errorMessage.substring(0, 200)}`);
          }
        }

        // Try next model on failure
        continue;
      }
    }

    // Fallback response - should not reach here
    logger.error('🚨 All streaming attempts failed');
    throw new Error('❌ All LLM models failed. Check OpenRouter status and credits.');
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
