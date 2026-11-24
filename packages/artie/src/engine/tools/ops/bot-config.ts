/**
 * bot-config: query and tune Artie's own operating parameters.
 *
 * Merged on 2026-10-23 (wave 4) from `runtime_config` (models, context size)
 * and `model_manager` (model tiers, pricing, cost-aware recommendations). Their actions never
 * collided, so every action keeps its name; each original handler survives unchanged as an
 * internal function. The old names still work through TOOL_ALIASES in 5-tool-loop/registry.ts.
 */

import { logger } from '../../../shared/logger.js';
import { creditMonitor } from '../../budget/openrouter-balance.js';
import { openRouterService } from '../../4-generate/openrouter.js';
import { openRouterModelsService } from '../../4-generate/model-catalog.js';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';

/** Find the value from candidates closest to target. */
function findClosestValue(candidates: number[], target: number): number {
  return candidates.reduce((prev, curr) => {
    const prevDist = Math.abs(prev - target);
    const currDist = Math.abs(curr - target);
    if (currDist < prevDist) {
      return curr;
    }
    return prev;
  });
}

function getOptimizationMode(balance: number): string {
  if (balance < 5) {
    return 'survival';
  }
  if (balance < 25) {
    return 'conservative';
  }
  if (balance < 50) {
    return 'efficient';
  }
  return 'full_power';
}

const RUNTIME_ACTIONS = [
  'get_active_model',
  'set_model_tier',
  'get_context_size',
  'set_context_size',
  'auto_optimize',
];

const MODEL_ACTIONS = ['list_models', 'get_pricing', 'get_recommendation', 'compare_models'];

// =====================================================================================
// runtime settings (was the `runtime_config` tool)
// Query and modify runtime settings on the fly for dynamic adaptation based on conditions.
// =====================================================================================

async function runRuntimeConfig(params: any, _content?: string): Promise<string> {
    const { action = 'get_active_model' } = params;

    switch (action) {
      case 'get_active_model':
        try {
          const models = openRouterService.getAvailableModels();
          const fastModel = process.env.FAST_MODEL || 'Not configured';
          const smartModel = process.env.SMART_MODEL || 'Not configured';
          const managerModel = process.env.MANAGER_MODEL || 'Not configured';
          const contextSize = process.env.CONTEXT_WINDOW_SIZE || '32000';

          let response = '🎛️ **Current Runtime Configuration:**\n\n';
          response += '**Model Tiers:**\n';
          response += `  • FAST: ${fastModel}\n`;
          response += `  • SMART: ${smartModel}\n`;
          response += `  • MANAGER: ${managerModel}\n\n`;
          response += `**Context Window:** ${contextSize} tokens\n`;
          response += `**Rotation Models:** ${models.join(', ')}\n`;

          return JSON.stringify({
            success: true,
            data: {
              fast_model: fastModel,
              smart_model: smartModel,
              manager_model: managerModel,
              context_size: parseInt(contextSize),
              rotation_models: models,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get active model:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve model configuration',
          });
        }

      case 'set_model_tier':
        try {
          const { tier, model } = params;
          if (!tier || !model) {
            return JSON.stringify({
              success: false,
              error: 'Missing required parameters: tier, model',
            });
          }

          const validTiers = ['fast', 'smart', 'manager'];
          if (!validTiers.includes(tier.toLowerCase())) {
            return JSON.stringify({
              success: false,
              error: `Invalid tier. Must be one of: ${validTiers.join(', ')}`,
            });
          }

          // Set environment variable for this session
          const envVar = `${tier.toUpperCase()}_MODEL`;
          process.env[envVar] = model;

          logger.warn(`🔧 Runtime config changed: ${envVar} = ${model}`);

          let response = `✅ **Model tier updated:**\n`;
          response += `  • Tier: ${tier.toUpperCase()}\n`;
          response += `  • Model: ${model}\n\n`;
          response += `⚠️ This change is temporary (session only)\n`;
          response += `💡 Update .env file for permanent change`;

          return JSON.stringify({
            success: true,
            data: {
              tier,
              model,
              env_var: envVar,
              session_only: true,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to set model tier:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to update model configuration',
          });
        }

      case 'get_context_size':
        try {
          const contextSize = parseInt(process.env.CONTEXT_WINDOW_SIZE || '32000');

          let response = `📏 **Context Window Configuration:**\n\n`;
          response += `Current size: ${contextSize.toLocaleString()} tokens\n\n`;
          response += `**Breakdown:**\n`;
          response += `  • System prompt: ~500 tokens\n`;
          response += `  • User message: variable\n`;
          response += `  • Response reserve: ${Math.floor(contextSize * 0.25).toLocaleString()} tokens (25%)\n`;
          response += `  • Available for context: ${Math.floor(contextSize * 0.75).toLocaleString()} tokens`;

          return JSON.stringify({
            success: true,
            data: {
              context_size: contextSize,
              response_reserve: Math.floor(contextSize * 0.25),
              available_context: Math.floor(contextSize * 0.75),
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get context size:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve context size',
          });
        }

      case 'set_context_size':
        try {
          const { size } = params;
          if (!size || isNaN(size)) {
            return JSON.stringify({
              success: false,
              error: 'Missing or invalid parameter: size (must be number)',
            });
          }

          const newSize = parseInt(size);
          const validSizes = [8000, 16000, 32000, 64000, 128000, 200000];
          const recommendedSize = findClosestValue(validSizes, newSize);

          process.env.CONTEXT_WINDOW_SIZE = newSize.toString();

          logger.warn(`🔧 Context size changed: ${newSize} tokens`);

          let response = `✅ **Context window updated:**\n`;
          response += `  • New size: ${newSize.toLocaleString()} tokens\n`;

          if (recommendedSize !== newSize) {
            response += `\n💡 Recommended sizes: ${validSizes.map((s) => s.toLocaleString()).join(', ')} tokens\n`;
            response += `  Closest match: ${recommendedSize.toLocaleString()}`;
          }

          return JSON.stringify({
            success: true,
            data: {
              context_size: newSize,
              recommended_size: recommendedSize,
              session_only: true,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to set context size:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to update context size',
          });
        }

      case 'auto_optimize':
        try {
          const creditInfo = await creditMonitor.getCurrentBalance();
          if (!creditInfo) {
            return JSON.stringify({
              success: false,
              error: 'Unable to check credit status',
            });
          }

          const balance = creditInfo.credits_remaining || 0;
          const changes: string[] = [];

          // CRITICAL: Survival mode (<$5)
          if (balance < 5) {
            process.env.CONTEXT_WINDOW_SIZE = '16000';
            changes.push('🚨 SURVIVAL MODE ACTIVATED');
            changes.push('  • Context window: 32000 → 16000');
            changes.push('  • Using FAST_MODEL for everything');
            logger.error(`🚨 SURVIVAL MODE: Credits critically low ($${balance})`);
          }
          // WARNING: Conservative mode (<$25)
          else if (balance < 25) {
            process.env.CONTEXT_WINDOW_SIZE = '24000';
            changes.push('⚠️ CONSERVATIVE MODE ACTIVATED');
            changes.push('  • Context window: 32000 → 24000');
            changes.push('  • Preferring FAST_MODEL');
            logger.warn(`⚠️ CONSERVATIVE MODE: Credits low ($${balance})`);
          }
          // MODERATE: Efficient mode (<$50)
          else if (balance < 50) {
            process.env.CONTEXT_WINDOW_SIZE = '32000';
            changes.push('💡 EFFICIENT MODE');
            changes.push('  • Context window: 32000 (default)');
            changes.push('  • Standard tier usage');
            logger.info(`💡 EFFICIENT MODE: Credits moderate ($${balance})`);
          }
          // HEALTHY: Full power (>$50)
          else {
            process.env.CONTEXT_WINDOW_SIZE = '64000';
            changes.push('✅ FULL POWER MODE');
            changes.push('  • Context window: 64000 (enhanced)');
            changes.push('  • All model tiers available');
            logger.info(`✅ FULL POWER: Credits healthy ($${balance})`);
          }

          let response = `🎛️ **Auto-Optimization Complete:**\n\n`;
          response += `💰 Current balance: $${balance.toFixed(2)}\n\n`;
          response += changes.join('\n');

          return JSON.stringify({
            success: true,
            data: {
              balance,
              mode: getOptimizationMode(balance),
              changes,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to auto-optimize:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to auto-optimize configuration',
          });
        }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
        });
    }
}

// =====================================================================================
// models (was the `model_manager` tool)
// Query available models, check pricing, and get recommendations based on credit status.
// =====================================================================================

async function runModelManager(params: any, _content?: string): Promise<string> {
    const { action = 'list_models' } = params;

    switch (action) {
      case 'list_models':
        try {
          // Get configured model tiers from environment
          const fastModel = process.env.FAST_MODEL || 'google/gemini-2.5-flash';
          const smartModel = process.env.SMART_MODEL || 'anthropic/claude-sonnet-4.5';
          const managerModel = process.env.MANAGER_MODEL || 'anthropic/claude-opus-4';

          const modelIds = [fastModel, smartModel, managerModel];
          const modelInfo = await openRouterModelsService.getModelInfo(modelIds);

          let response = '🤖 **Available Model Tiers:**\n\n';

          // Format each tier
          for (const [tier, modelId] of [
            ['FAST', fastModel],
            ['SMART', smartModel],
            ['MANAGER', managerModel],
          ]) {
            const info = modelInfo[modelId];
            response += `**${tier} MODEL**: ${modelId}\n`;

            if (info) {
              const inputCost = parseFloat(info.pricing.prompt);
              const outputCost = parseFloat(info.pricing.completion);

              response += `  • Name: ${info.name}\n`;
              response += `  • Input: $${(inputCost * 1_000_000).toFixed(2)}/1M tokens\n`;
              response += `  • Output: $${(outputCost * 1_000_000).toFixed(2)}/1M tokens\n`;
              response += `  • Context: ${info.context_length.toLocaleString()} tokens\n`;
            } else {
              response += `  • ⚠️ Model info unavailable\n`;
            }
            response += '\n';
          }

          return JSON.stringify({
            success: true,
            data: {
              fast_model: fastModel,
              smart_model: smartModel,
              manager_model: managerModel,
              model_info: modelInfo,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to list models:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve model information',
          });
        }

      case 'get_pricing':
        try {
          const { model } = params;
          if (!model) {
            return JSON.stringify({
              success: false,
              error: 'Missing required parameter: model',
            });
          }

          const modelInfo = await openRouterModelsService.getModelInfo([model]);
          const info = modelInfo[model];

          if (!info) {
            return JSON.stringify({
              success: false,
              error: `Model not found: ${model}`,
            });
          }

          const inputCost = parseFloat(info.pricing.prompt);
          const outputCost = parseFloat(info.pricing.completion);

          // Calculate cost examples
          const cost1k = {
            input: (inputCost * 1000).toFixed(6),
            output: (outputCost * 1000).toFixed(6),
          };
          const cost1m = {
            input: (inputCost * 1_000_000).toFixed(2),
            output: (outputCost * 1_000_000).toFixed(2),
          };

          let response = `💰 **Pricing for ${info.name}**\n\n`;
          response += `**Per 1K tokens:**\n`;
          response += `  • Input: $${cost1k.input}\n`;
          response += `  • Output: $${cost1k.output}\n\n`;
          response += `**Per 1M tokens:**\n`;
          response += `  • Input: $${cost1m.input}\n`;
          response += `  • Output: $${cost1m.output}\n\n`;
          response += `**Context Window:** ${info.context_length.toLocaleString()} tokens\n`;

          return JSON.stringify({
            success: true,
            data: {
              model,
              name: info.name,
              pricing: info.pricing,
              context_length: info.context_length,
              cost_examples: { cost1k, cost1m },
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get pricing:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve pricing information',
          });
        }

      case 'get_recommendation':
        try {
          const creditInfo = await creditMonitor.getCurrentBalance();
          const alerts = await creditMonitor.getActiveAlerts();

          if (!creditInfo) {
            return JSON.stringify({
              success: false,
              error: 'Unable to check credit status',
            });
          }

          const balance = creditInfo.credits_remaining || 0;
          let recommendation = '';
          let suggestedTier = 'smart';

          // Determine recommendation based on balance
          if (balance < 5) {
            // CRITICAL - Use cheapest possible
            suggestedTier = 'fast';
            recommendation =
              '🚨 **CRITICAL**: Credits extremely low ($' + balance.toFixed(2) + ')\n\n';
            recommendation += '**Recommendation:** Use FAST_MODEL for ALL tasks\n';
            recommendation += '  • Model: google/gemini-2.5-flash\n';
            recommendation += '  • Cost: ~$0.000075/1K tokens (100x cheaper than Sonnet)\n';
            recommendation += '  • When: All operations until credits are topped up\n\n';
            recommendation += '⚡ **Action Required:** Add more credits ASAP or service will stop!';
          } else if (balance < 25) {
            // WARNING - Be conservative
            suggestedTier = 'fast';
            recommendation =
              '⚠️ **WARNING**: Credits running low ($' + balance.toFixed(2) + ')\n\n';
            recommendation +=
              '**Recommendation:** Prefer FAST_MODEL, use SMART_MODEL only when necessary\n\n';
            recommendation += '**Use FAST for:**\n';
            recommendation += '  • Simple questions\n';
            recommendation += '  • Capability extraction\n';
            recommendation += '  • Basic responses\n\n';
            recommendation += '**Use SMART only for:**\n';
            recommendation += '  • Complex reasoning\n';
            recommendation += '  • Code generation\n';
            recommendation += '  • Important synthesis\n\n';
            recommendation += '💡 Consider adding more credits soon';
          } else if (balance < 50) {
            // MODERATE - Be mindful
            suggestedTier = 'smart';
            recommendation = '💰 Balance: $' + balance.toFixed(2) + ' - Operating normally\n\n';
            recommendation += '**Recommendation:** Current tier strategy is fine\n';
            recommendation += '  • FAST: Capability extraction\n';
            recommendation += '  • SMART: Response synthesis\n';
            recommendation += '  • MANAGER: Complex planning (rarely)\n\n';
            recommendation += '💡 Monitor spending, balance is moderate';
          } else {
            // HEALTHY - All systems go
            suggestedTier = 'smart';
            recommendation = '✅ Balance: $' + balance.toFixed(2) + ' - Healthy\n\n';
            recommendation += '**Recommendation:** All model tiers available\n';
            recommendation += '  • Use MANAGER_MODEL when complex reasoning needed\n';
            recommendation += '  • SMART_MODEL for standard operations\n';
            recommendation += '  • FAST_MODEL for quick tasks\n\n';
            recommendation += '🎯 Operating at full capacity';
          }

          // Add active alerts if any
          if (alerts.length > 0) {
            recommendation += '\n\n🚨 **Active Alerts:**\n';
            alerts.forEach((alert) => {
              recommendation += `  • ${alert.message}\n`;
            });
          }

          return JSON.stringify({
            success: true,
            data: {
              balance,
              suggested_tier: suggestedTier,
              alerts: alerts.length,
              should_conserve: balance < 25,
              critical: balance < 5,
            },
            message: recommendation,
          });
        } catch (error) {
          logger.error('❌ Failed to get recommendation:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to generate recommendation',
          });
        }

      case 'compare_models':
        try {
          const { models } = params;
          if (!models || !Array.isArray(models) || models.length < 2) {
            return JSON.stringify({
              success: false,
              error: 'Provide at least 2 models to compare',
            });
          }

          const modelInfo = await openRouterModelsService.getModelInfo(models);

          let response = '⚖️ **Model Comparison:**\n\n';

          models.forEach((modelId) => {
            const info = modelInfo[modelId];
            if (info) {
              const inputCost = parseFloat(info.pricing.prompt);
              const outputCost = parseFloat(info.pricing.completion);

              response += `**${modelId}**\n`;
              response += `  • Name: ${info.name}\n`;
              response += `  • Input: $${(inputCost * 1_000_000).toFixed(2)}/1M tokens\n`;
              response += `  • Output: $${(outputCost * 1_000_000).toFixed(2)}/1M tokens\n`;
              response += `  • Context: ${info.context_length.toLocaleString()} tokens\n`;
            } else {
              response += `**${modelId}** - ⚠️ Info unavailable\n`;
            }
            response += '\n';
          });

          return JSON.stringify({
            success: true,
            data: modelInfo,
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to compare models:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to compare models',
          });
        }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}`,
        });
    }
}

// =====================================================================================
// The one registered tool
// =====================================================================================

export const botConfigCapability: RegisteredCapability = {
  name: 'bot-config',
  emoji: '⚙️',
  supportedActions: [...RUNTIME_ACTIONS, ...MODEL_ACTIONS],
  description: `Query and tune Artie's own operating parameters.

Runtime settings: get_active_model, set_model_tier, get_context_size, set_context_size,
auto_optimize.
Models: list_models (configured tiers), get_pricing (model=), get_recommendation (cost-aware,
from the credit balance), compare_models (models=[...], at least 2).`,
  handler: async (params, content) => {
    const action = params?.action;
    if (MODEL_ACTIONS.includes(action)) {
      return runModelManager(params, content);
    }
    if (RUNTIME_ACTIONS.includes(action)) {
      return runRuntimeConfig(params, content);
    }
    return JSON.stringify({
      success: false,
      error: `Unknown action: ${action}`,
    });
  },
  examples: [
    '<capability name="bot-config" action="get_active_model" />',
    '<capability name="bot-config" action="set_model_tier" tier="fast" model="google/gemini-2.5-flash" />',
    '<capability name="bot-config" action="get_context_size" />',
    '<capability name="bot-config" action="set_context_size" size="16000" />',
    '<capability name="bot-config" action="auto_optimize" />',
    '<capability name="bot-config" action="list_models" />',
    '<capability name="bot-config" action="get_pricing" model="google/gemini-2.5-flash" />',
    '<capability name="bot-config" action="get_recommendation" />',
    '<capability name="bot-config" action="compare_models" models=\'["google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5"]\' />',
  ],
};
