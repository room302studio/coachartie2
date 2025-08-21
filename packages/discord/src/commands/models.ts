import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';

export const modelsCommand = {
  data: new SlashCommandBuilder()
    .setName('models')
    .setDescription('List available AI models and their current status')
    .addStringOption(option =>
      option.setName('info')
        .setDescription('Get detailed info about a specific model')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

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
        content: '❌ There was an error fetching model information. Please try again later.'
      });
    }
  }
};

async function createModelsListEmbed(): Promise<EmbedBuilder> {
  // Get REAL models from capabilities service API with OpenRouter data
  let modelData: any = null;
  
  try {
    const response = await fetch('http://localhost:18239/api/models');
    if (response.ok) {
      const result = await response.json() as any;
      
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

  const embed = new EmbedBuilder()
    .setTitle('🤖 AI Model Configuration')
    .setColor(0x3498db);

  if (!modelData) {
    // Try to get error details from the failed API response
    let errorDetails = 'The capabilities service or OpenRouter API is currently unavailable.';
    let configuredModels = '';
    
    try {
      const response = await fetch('http://localhost:18239/api/models');
      if (!response.ok) {
        const errorData = await response.json() as any;
        if (errorData.hint) {
          errorDetails = errorData.hint;
        }
        if (errorData.configuredModels && Array.isArray(errorData.configuredModels)) {
          configuredModels = `\n\n**Configured Models:**\n\`${errorData.configuredModels.join('`, `')}\``;
        }
      }
    } catch (e) {
      // Ignore error parsing, use default message
    }
    
    // Fallback when API is unavailable
    embed.setDescription('❌ Unable to fetch live model data from OpenRouter API')
      .addFields({
        name: '⚠️ Configuration Issue',
        value: errorDetails + configuredModels,
        inline: false
      })
      .addFields({
        name: '🔧 How to Fix',
        value: '1. Check `OPENROUTER_MODELS` environment variable\n2. Verify model names at https://openrouter.ai/models\n3. Ensure models exist and are spelled correctly\n4. Restart the service after fixing',
        inline: false
      })
      .addFields({
        name: '📝 Example',
        value: '`OPENROUTER_MODELS=anthropic/claude-3.5-sonnet,openai/gpt-4o`',
        inline: false
      });
    
    return embed;
  }

  const { summary, models, currentModel } = modelData;
  
  // Add summary stats at the top
  embed.setDescription(`**Current Model:** \`${currentModel}\`\n**Total Models:** ${summary.totalModels} across ${summary.providers.length} providers`);
  
  embed.addFields({
    name: '📊 Model Pool Summary',
    value: `🆓 Free: ${summary.freeModels} | 💰 Paid: ${summary.paidModels}\n` +
           `📄 Total Context: ${summary.totalContextLength.toLocaleString()} tokens\n` +
           `💲 Avg Cost: $${summary.averageInputCost.toFixed(4)}/1K tokens`,
    inline: false
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
  
  providers.forEach(provider => {
    const providerModels = modelsByProvider[provider];
    const providerIcon = {
      'openai': '🟢',
      'anthropic': '🟠', 
      'z-ai': '🔵',
      'google': '🔴',
      'meta-llama': '🟣',
      'microsoft': '🟦',
      'mistralai': '⚪',
      'qwen': '🟡'
    }[provider] || '⚫';
    
    const modelList = providerModels.slice(0, 3).map((model: any) => { // Max 3 models per provider
      const status = model.isActive ? '🟢' : '⚪';
      const cost = model.isFree ? 'Free' : model.inputCostPer1K;
      const context = typeof model.contextLength === 'number' 
        ? `${(model.contextLength / 1000).toFixed(0)}K` 
        : model.contextLength;
      
      return `${status} **${model.name}** | ${cost} | ${context} ctx`;
    }).join('\n');
    
    embed.addFields({
      name: `${providerIcon} ${provider.toUpperCase()} (${providerModels.length})`,
      value: modelList + (providerModels.length > 3 ? `\n...and ${providerModels.length - 3} more` : ''),
      inline: true
    });
  });

  // Add configuration info
  embed.addFields({
    name: '⚙️ Configuration',
    value: 'Models configured via `OPENROUTER_MODELS` environment variable\n' +
           'Use `/models info <model>` for detailed specs',
    inline: false
  });

  embed.setTimestamp();
  embed.setFooter({ text: `Live data from OpenRouter API • ${summary.totalModels} models active` });

  return embed;
}

async function createModelDetailEmbed(modelQuery: string): Promise<EmbedBuilder> {
  // Get live model data from API
  try {
    const response = await fetch('http://localhost:18239/api/models');
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const result = await response.json() as any;
    if (!result.success || !result.data) {
      throw new Error('Invalid API response');
    }

    const { models } = result.data;
    
    // Find matching model by name or ID
    const matchingModel = models.find((model: any) => 
      model.id.toLowerCase().includes(modelQuery.toLowerCase()) ||
      model.name.toLowerCase().includes(modelQuery.toLowerCase()) ||
      model.displayName.toLowerCase().includes(modelQuery.toLowerCase())
    );

    if (!matchingModel) {
      const availableModels = models.slice(0, 10).map((m: any) => `\`${m.name}\``).join(', ');
      
      const embed = new EmbedBuilder()
        .setTitle('❌ Model Not Found')
        .setDescription(`Could not find model matching "${modelQuery}"`)
        .setColor(0xff0000)
        .addFields({
          name: '💡 Available Models',
          value: availableModels + (models.length > 10 ? `\n...and ${models.length - 10} more` : ''),
          inline: false
        })
        .addFields({
          name: '🔍 Search Tips',
          value: 'Try searching by:\n• Provider: `openai`, `anthropic`, `google`\n• Model name: `gpt-4o`, `claude`, `gemma`\n• Partial name: `gpt`, `llama`, `mistral`',
          inline: false
        });
      return embed;
    }

    // Create detailed embed with live OpenRouter data
    const statusEmoji = matchingModel.isActive ? '🟢 Currently Active' : '⚪ Available';
    const costInfo = matchingModel.isFree ? '🆓 Free' : `💰 ${matchingModel.inputCostPer1K}/1K input, ${matchingModel.outputCostPer1K}/1K output`;
    
    const embed = new EmbedBuilder()
      .setTitle(`🤖 ${matchingModel.displayName}`)
      .setDescription(`**${statusEmoji}**\n\n${matchingModel.description}`)
      .setColor(matchingModel.isActive ? 0x00ff00 : 0x3498db)
      .addFields(
        { 
          name: '🏢 Provider', 
          value: matchingModel.provider.toUpperCase(), 
          inline: true 
        },
        { 
          name: '💲 Pricing', 
          value: costInfo, 
          inline: true 
        },
        { 
          name: '📄 Context Length', 
          value: typeof matchingModel.contextLength === 'number' 
            ? `${matchingModel.contextLength.toLocaleString()} tokens`
            : matchingModel.contextLength.toString(), 
          inline: true 
        }
      );

    // Add technical specs if available
    if (matchingModel.maxCompletionTokens && matchingModel.maxCompletionTokens !== 'Unknown') {
      embed.addFields({
        name: '⚡ Max Completion Tokens',
        value: matchingModel.maxCompletionTokens.toLocaleString(),
        inline: true
      });
    }

    if (matchingModel.modality && matchingModel.modality !== 'text') {
      embed.addFields({
        name: '🎨 Modality',
        value: matchingModel.modality,
        inline: true
      });
    }

    if (matchingModel.isModerated) {
      embed.addFields({
        name: '🛡️ Content Moderation',
        value: 'Enabled',
        inline: true
      });
    }

    // Add rate limits if available
    if (matchingModel.promptTokenLimit !== 'Unknown' || matchingModel.completionTokenLimit !== 'Unknown') {
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
        inline: false
      });
    }

    embed.addFields({
      name: '🆔 Model ID',
      value: `\`${matchingModel.id}\``,
      inline: false
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
        inline: false
      })
      .addFields({
        name: '🔄 Try Again',
        value: 'Please try again in a few moments, or use `/models` to see the model list.',
        inline: false
      });
    
    return embed;
  }
}