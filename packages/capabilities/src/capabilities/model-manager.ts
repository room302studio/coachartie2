import { logger } from '@coachartie/shared';
import { openRouterModelsService } from '../services/openrouter-models.js';
import { creditMonitor } from '../services/credit-monitor.js';
import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * Model Manager Capability
 * Allows Artie to query available models, check pricing, and get recommendations
 * based on current credit status.
 */
export const modelManagerCapability: RegisteredCapability = {
  name: 'model_manager',
  supportedActions: [
    'list_models',
    'get_pricing',
    'get_recommendation',
    'compare_models',
  ],
  description: 'Query available AI models, pricing, and get cost-aware recommendations',
  handler: async (params, content) => {
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
            recommendation = '🚨 **CRITICAL**: Credits extremely low ($' + balance.toFixed(2) + ')\n\n';
            recommendation += '**Recommendation:** Use FAST_MODEL for ALL tasks\n';
            recommendation += '  • Model: google/gemini-2.5-flash\n';
            recommendation += '  • Cost: ~$0.000075/1K tokens (100x cheaper than Sonnet)\n';
            recommendation += '  • When: All operations until credits are topped up\n\n';
            recommendation += '⚡ **Action Required:** Add more credits ASAP or service will stop!';
          } else if (balance < 25) {
            // WARNING - Be conservative
            suggestedTier = 'fast';
            recommendation = '⚠️ **WARNING**: Credits running low ($' + balance.toFixed(2) + ')\n\n';
            recommendation += '**Recommendation:** Prefer FAST_MODEL, use SMART_MODEL only when necessary\n\n';
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
  },
  examples: [
    '<capability name="model_manager" action="list_models" />',
    '<capability name="model_manager" action="get_pricing" model="google/gemini-2.5-flash" />',
    '<capability name="model_manager" action="get_recommendation" />',
    '<capability name="model_manager" action="compare_models" models=\'["google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5"]\' />',
  ],
};
