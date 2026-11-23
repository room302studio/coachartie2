import { MessageFlags, ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import * as engine from '../../engine/api.js';

/**
 * Status icon for active/inactive model.
 */
function statusIcon(active: boolean): string {
  if (active) return '🟢';
  return '⚪';
}

/**
 * Cost format for model.
 */
function costFormat(isFree: boolean, cost: any): string {
  if (isFree) return 'Free';
  return cost;
}

/**
 * Context format for model.
 */
function contextFormat(ctx: any): string {
  if (typeof ctx === 'number') {
    return `${(ctx / 1000).toFixed(0)}K`;
  }
  return ctx;
}

/**
 * Truncate list with count.
 */
function truncateWithCount(list: string, actual: number, limit: number): string {
  if (actual > limit) {
    return list + `\n...and ${actual - limit} more`;
  }
  return list;
}

/**
 * Format active model status.
 */
function activeStatus(isActive: boolean): string {
  if (isActive) return '🟢 Currently Active';
  return '⚪ Available';
}

/**
 * Format cost info.
 */
function formatCost(isFree: boolean, input: any, output: any): string {
  if (isFree) return '🆓 Free';
  return `💰 ${input}/1K input, ${output}/1K output`;
}

/**
 * Get color for model status.
 */
function modelColor(isActive: boolean): number {
  if (isActive) return 0x00ff00;
  return 0x3498db;
}

export const modelsCommand = {
  data: new SlashCommandBuilder()
    .setName('models')
    .setDescription('List available AI models and their current status')
    .addStringOption((option) =>
      option
        .setName('info')
        .setDescription('Get detailed info about a specific model')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const modelInfo = interaction.options.get('info')?.value as string;

      if (modelInfo) {
        // Show detailed info about a specific model
        const embed = await createModelDetailEmbed(modelInfo);
        await interaction.editReply({ embeds: [embed] });
      } else {
        // Show list of available models
        const embed = await createModelsListEmbed();
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      logger.error('Error fetching models:', error);
      await interaction.editReply({
        content: '❌ There was an error fetching model information. Please try again later.',
      });
    }
  },
};

async function createModelsListEmbed(): Promise<EmbedBuilder> {
  // Get REAL models from the engine's GET /api/models (in-process since wave 9)
  let modelData: any = null;

  try {
    const response = await engine.models();
    if (engine.isOk(response)) {
      const result = response.body as any;

      if (result.success && result.data) {
        modelData = result.data;
      } else {
        throw new Error('Invalid API response');
      }
    } else {
      throw new Error(`API returned ${response.status}`);
    }
  } catch (error) {
    logger.error('Failed to fetch models from API:', error);
  }

  const embed = new EmbedBuilder().setTitle('🤖 AI Model Configuration').setColor(0x3498db);

  if (!modelData) {
    // Try to get error details from the failed API response
    let errorDetails = 'The capabilities service or OpenRouter API is currently unavailable.';
    let configuredModels = '';

    try {
      const response = await engine.models();
      if (!engine.isOk(response)) {
        const errorData = response.body as any;
        if (errorData.hint) {
          errorDetails = errorData.hint;
        }
        if (errorData.configuredModels && Array.isArray(errorData.configuredModels)) {
          configuredModels = `\n\n**Configured Models:**\n\`${errorData.configuredModels.join('`, `')}\``;
        }
      }
    } catch {
      // Ignore error parsing, use default message
    }

    // Fallback when API is unavailable
    embed
      .setDescription('❌ Unable to fetch live model data from OpenRouter API')
      .addFields({
        name: '⚠️ Configuration Issue',
        value: errorDetails + configuredModels,
        inline: false,
      })
      .addFields({
        name: '🔧 How to Fix',
        value:
          '1. Check `OPENROUTER_MODELS` environment variable\n2. Verify model names at https://openrouter.ai/models\n3. Ensure models exist and are spelled correctly\n4. Restart the service after fixing',
        inline: false,
      })
      .addFields({
        name: '📝 Example',
        value: '`OPENROUTER_MODELS=anthropic/claude-3.5-sonnet,openai/gpt-4o`',
        inline: false,
      });

    return embed;
  }

  const { summary, models, currentModel } = modelData;

  // Add summary stats at the top
  embed.setDescription(
    `**Current Model:** \`${currentModel}\`\n**Total Models:** ${summary.totalModels} across ${summary.providers.length} providers`
  );

  embed.addFields({
    name: '📊 Model Pool Summary',
    value:
      `🆓 Free: ${summary.freeModels} | 💰 Paid: ${summary.paidModels}\n` +
      `📄 Total Context: ${summary.totalContextLength.toLocaleString()} tokens\n` +
      `💲 Avg Cost: $${summary.averageInputCost.toFixed(4)}/1K tokens`,
    inline: false,
  });

  // Group models by provider for better organization
  const modelsByProvider: Record<string, any[]> = {};
  models.forEach((model: any) => {
    if (!modelsByProvider[model.provider]) {
      modelsByProvider[model.provider] = [];
    }
    modelsByProvider[model.provider].push(model);
  });

  // Show models by provider (limit to avoid Discord embed limits)
  const providers = Object.keys(modelsByProvider).slice(0, 5); // Max 5 providers

  providers.forEach((provider) => {
    const providerModels = modelsByProvider[provider];
    const providerIcon =
      {
        openai: '🟢',
        anthropic: '🟠',
        'z-ai': '🔵',
        google: '🔴',
        'meta-llama': '🟣',
        microsoft: '🟦',
        mistralai: '⚪',
        qwen: '🟡',
      }[provider] || '⚫';

    const modelList = providerModels
      .slice(0, 3)
      .map((model: any) => {
        // Max 3 models per provider
        const status = statusIcon(model.isActive);
        const cost = costFormat(model.isFree, model.inputCostPer1K);
        const context = contextFormat(model.contextLength);

        return `${status} **${model.name}** | ${cost} | ${context} ctx`;
      })
      .join('\n');

    const fieldValue = truncateWithCount(modelList, providerModels.length, 3);
    embed.addFields({
      name: `${providerIcon} ${provider.toUpperCase()} (${providerModels.length})`,
      value: fieldValue,
      inline: true,
    });
  });

  // Add configuration info
  embed.addFields({
    name: '⚙️ Configuration',
    value:
      'Models configured via `OPENROUTER_MODELS` environment variable\n' +
      'Use `/models info <model>` for detailed specs',
    inline: false,
  });

  embed.setTimestamp();
  embed.setFooter({ text: `Live data from OpenRouter API • ${summary.totalModels} models active` });

  return embed;
}

async function createModelDetailEmbed(modelQuery: string): Promise<EmbedBuilder> {
  // Get live model data from the engine's GET /api/models (in-process since wave 9)
  try {
    const response = await engine.models();
    if (!engine.isOk(response)) {
      throw new Error(`API returned ${response.status}`);
    }

    const result = response.body as any;
    if (!result.success || !result.data) {
      throw new Error('Invalid API response');
    }

    const { models } = result.data;

    // Find matching model by name or ID
    const matchingModel = models.find(
      (model: any) =>
        model.id.toLowerCase().includes(modelQuery.toLowerCase()) ||
        model.name.toLowerCase().includes(modelQuery.toLowerCase()) ||
        model.displayName.toLowerCase().includes(modelQuery.toLowerCase())
    );

    if (!matchingModel) {
      const availableModels = models
        .slice(0, 10)
        .map((m: any) => `\`${m.name}\``)
        .join(', ');

      const modelListValue = truncateWithCount(availableModels, models.length, 10);
      const embed = new EmbedBuilder()
        .setTitle('❌ Model Not Found')
        .setDescription(`Could not find model matching "${modelQuery}"`)
        .setColor(0xff0000)
        .addFields({
          name: '💡 Available Models',
          value: modelListValue,
          inline: false,
        })
        .addFields({
          name: '🔍 Search Tips',
          value:
            'Try searching by:\n• Provider: `openai`, `anthropic`, `google`\n• Model name: `gpt-4o`, `claude`, `gemma`\n• Partial name: `gpt`, `llama`, `mistral`',
          inline: false,
        });
      return embed;
    }

    // Create detailed embed with live OpenRouter data
    const statusEmoji = activeStatus(matchingModel.isActive);
    const costInfo = formatCost(matchingModel.isFree, matchingModel.inputCostPer1K, matchingModel.outputCostPer1K);

    const embed = new EmbedBuilder()
      .setTitle(`🤖 ${matchingModel.displayName}`)
      .setDescription(`**${statusEmoji}**\n\n${matchingModel.description}`)
      .setColor(modelColor(matchingModel.isActive))
      .addFields(
        {
          name: '🏢 Provider',
          value: matchingModel.provider.toUpperCase(),
          inline: true,
        },
        {
          name: '💲 Pricing',
          value: costInfo,
          inline: true,
        },
        {
          name: '📄 Context Length',
          value: contextFormat(matchingModel.contextLength),
          inline: true,
        }
      );

    // Add technical specs if available
    if (matchingModel.maxCompletionTokens && matchingModel.maxCompletionTokens !== 'Unknown') {
      embed.addFields({
        name: '⚡ Max Completion Tokens',
        value: matchingModel.maxCompletionTokens.toLocaleString(),
        inline: true,
      });
    }

    if (matchingModel.modality && matchingModel.modality !== 'text') {
      embed.addFields({
        name: '🎨 Modality',
        value: matchingModel.modality,
        inline: true,
      });
    }

    if (matchingModel.isModerated) {
      embed.addFields({
        name: '🛡️ Content Moderation',
        value: 'Enabled',
        inline: true,
      });
    }

    // Add rate limits if available
    if (
      matchingModel.promptTokenLimit !== 'Unknown' ||
      matchingModel.completionTokenLimit !== 'Unknown'
    ) {
      const limitInfo = [];
      if (matchingModel.promptTokenLimit !== 'Unknown') {
        limitInfo.push(`Input: ${matchingModel.promptTokenLimit}`);
      }
      if (matchingModel.completionTokenLimit !== 'Unknown') {
        limitInfo.push(`Output: ${matchingModel.completionTokenLimit}`);
      }

      embed.addFields({
        name: '🚦 Rate Limits',
        value: limitInfo.join('\n'),
        inline: false,
      });
    }

    embed.addFields({
      name: '🆔 Model ID',
      value: `\`${matchingModel.id}\``,
      inline: false,
    });

    embed.setTimestamp();
    embed.setFooter({ text: 'Live data from OpenRouter API' });

    return embed;
  } catch (error) {
    logger.error('Failed to fetch model details:', error);

    const embed = new EmbedBuilder()
      .setTitle('❌ Unable to Fetch Model Details')
      .setDescription('Could not retrieve live model information from OpenRouter API')
      .setColor(0xff0000)
      .addFields({
        name: '⚠️ Error',
        value: 'The capabilities service or OpenRouter API is currently unavailable.',
        inline: false,
      })
      .addFields({
        name: '🔄 Try Again',
        value: 'Please try again in a few moments, or use `/models` to see the model list.',
        inline: false,
      });

    return embed;
  }
}
