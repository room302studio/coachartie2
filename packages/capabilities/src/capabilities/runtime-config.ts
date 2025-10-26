import { logger } from '@coachartie/shared';
import { creditMonitor } from '../services/credit-monitor.js';
import { openRouterService } from '../services/openrouter.js';
import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * Runtime Configuration Capability
 * Allows Artie to query and modify runtime settings on the fly
 * for dynamic adaptation based on conditions
 */
export const runtimeConfigCapability: RegisteredCapability = {
  name: 'runtime_config',
  supportedActions: [
    'get_active_model',
    'set_model_tier',
    'get_context_size',
    'set_context_size',
    'get_iteration_limits',
    'set_iteration_limits',
    'auto_optimize',
  ],
  description: 'Dynamically adjust runtime configuration (models, context size, iterations)',
  handler: async (params, content) => {
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
          const recommendedSize = validSizes.reduce((prev, curr) =>
            Math.abs(curr - newSize) < Math.abs(prev - newSize) ? curr : prev
          );

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

      case 'get_iteration_limits':
        try {
          const maxIterations = parseInt(process.env.EXPLORATION_MAX_ITERATIONS || '8');
          const minIterations = parseInt(process.env.EXPLORATION_MIN_ITERATIONS || '1');
          const maxCostPerHour = parseFloat(process.env.MAX_COST_PER_HOUR || '10.0');

          let response = `🔄 **Iteration Limits:**\n\n`;
          response += `  • Max iterations: ${maxIterations}\n`;
          response += `  • Min iterations: ${minIterations}\n`;
          response += `  • Max cost/hour: $${maxCostPerHour}\n\n`;
          response += `💡 Lower iterations = faster + cheaper\n`;
          response += `💡 Higher iterations = deeper exploration + more expensive`;

          return JSON.stringify({
            success: true,
            data: {
              max_iterations: maxIterations,
              min_iterations: minIterations,
              max_cost_per_hour: maxCostPerHour,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to get iteration limits:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to retrieve iteration limits',
          });
        }

      case 'set_iteration_limits':
        try {
          const { max_iterations, min_iterations } = params;

          if (max_iterations !== undefined) {
            const maxIter = parseInt(max_iterations);
            if (isNaN(maxIter) || maxIter < 1 || maxIter > 24) {
              return JSON.stringify({
                success: false,
                error: 'max_iterations must be between 1 and 24',
              });
            }
            process.env.EXPLORATION_MAX_ITERATIONS = maxIter.toString();
          }

          if (min_iterations !== undefined) {
            const minIter = parseInt(min_iterations);
            if (isNaN(minIter) || minIter < 1 || minIter > 5) {
              return JSON.stringify({
                success: false,
                error: 'min_iterations must be between 1 and 5',
              });
            }
            process.env.EXPLORATION_MIN_ITERATIONS = minIter.toString();
          }

          const finalMax = parseInt(process.env.EXPLORATION_MAX_ITERATIONS || '8');
          const finalMin = parseInt(process.env.EXPLORATION_MIN_ITERATIONS || '1');

          logger.warn(`🔧 Iteration limits changed: min=${finalMin}, max=${finalMax}`);

          let response = `✅ **Iteration limits updated:**\n`;
          response += `  • Max iterations: ${finalMax}\n`;
          response += `  • Min iterations: ${finalMin}\n\n`;
          response += `⚠️ Changes apply to new messages only`;

          return JSON.stringify({
            success: true,
            data: {
              max_iterations: finalMax,
              min_iterations: finalMin,
              session_only: true,
            },
            message: response,
          });
        } catch (error) {
          logger.error('❌ Failed to set iteration limits:', error);
          return JSON.stringify({
            success: false,
            error: 'Failed to update iteration limits',
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
            process.env.EXPLORATION_MAX_ITERATIONS = '3';
            process.env.EXPLORATION_MIN_ITERATIONS = '1';
            process.env.CONTEXT_WINDOW_SIZE = '16000';
            changes.push('🚨 SURVIVAL MODE ACTIVATED');
            changes.push('  • Max iterations: 24 → 3');
            changes.push('  • Context window: 32000 → 16000');
            changes.push('  • Using FAST_MODEL for everything');
            logger.error(`🚨 SURVIVAL MODE: Credits critically low ($${balance})`);
          }
          // WARNING: Conservative mode (<$25)
          else if (balance < 25) {
            process.env.EXPLORATION_MAX_ITERATIONS = '5';
            process.env.EXPLORATION_MIN_ITERATIONS = '1';
            process.env.CONTEXT_WINDOW_SIZE = '24000';
            changes.push('⚠️ CONSERVATIVE MODE ACTIVATED');
            changes.push('  • Max iterations: 24 → 5');
            changes.push('  • Context window: 32000 → 24000');
            changes.push('  • Preferring FAST_MODEL');
            logger.warn(`⚠️ CONSERVATIVE MODE: Credits low ($${balance})`);
          }
          // MODERATE: Efficient mode (<$50)
          else if (balance < 50) {
            process.env.EXPLORATION_MAX_ITERATIONS = '8';
            process.env.EXPLORATION_MIN_ITERATIONS = '1';
            process.env.CONTEXT_WINDOW_SIZE = '32000';
            changes.push('💡 EFFICIENT MODE');
            changes.push('  • Max iterations: 8 (default)');
            changes.push('  • Context window: 32000 (default)');
            changes.push('  • Standard tier usage');
            logger.info(`💡 EFFICIENT MODE: Credits moderate ($${balance})`);
          }
          // HEALTHY: Full power (>$50)
          else {
            process.env.EXPLORATION_MAX_ITERATIONS = '12';
            process.env.EXPLORATION_MIN_ITERATIONS = '1';
            process.env.CONTEXT_WINDOW_SIZE = '64000';
            changes.push('✅ FULL POWER MODE');
            changes.push('  • Max iterations: 12 (enhanced)');
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
              mode:
                balance < 5
                  ? 'survival'
                  : balance < 25
                    ? 'conservative'
                    : balance < 50
                      ? 'efficient'
                      : 'full_power',
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
  },
  examples: [
    '<capability name="runtime_config" action="get_active_model" />',
    '<capability name="runtime_config" action="set_model_tier" tier="fast" model="google/gemini-2.5-flash" />',
    '<capability name="runtime_config" action="get_context_size" />',
    '<capability name="runtime_config" action="set_context_size" size="16000" />',
    '<capability name="runtime_config" action="get_iteration_limits" />',
    '<capability name="runtime_config" action="set_iteration_limits" max_iterations="5" min_iterations="1" />',
    '<capability name="runtime_config" action="auto_optimize" />',
  ],
};
