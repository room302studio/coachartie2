import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionResponse,
} from 'discord.js';
import { getDb, modelUsageStats, logger } from '@coachartie/shared';
import { eq, desc } from 'drizzle-orm';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the LLM model used for your most recent message'),

  async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<InteractionResponse<boolean> | undefined> {
    try {
      const userId = interaction.user.id;
      const db = getDb();

      // Query for the most recent model usage by this user using Drizzle
      const recentUsageResults = await db
        .select({
          model_name: modelUsageStats.modelName,
          message_id: modelUsageStats.messageId,
          timestamp: modelUsageStats.timestamp,
          total_tokens: modelUsageStats.totalTokens,
          estimated_cost: modelUsageStats.estimatedCost,
          response_time_ms: modelUsageStats.responseTimeMs,
          capabilities_detected: modelUsageStats.capabilitiesDetected,
          capabilities_executed: modelUsageStats.capabilitiesExecuted,
          success: modelUsageStats.success,
        })
        .from(modelUsageStats)
        .where(eq(modelUsageStats.userId, userId))
        .orderBy(desc(modelUsageStats.timestamp))
        .limit(1);

      const recentUsage = recentUsageResults[0];

      if (!recentUsage) {
        const embed = new EmbedBuilder()
          .setColor(0xff9900)
          .setTitle('🤖 Model Status')
          .setDescription('No recent activity found')
          .setFooter({ text: 'Send a message to start tracking!' })
          .setTimestamp();

        return await interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      }

      // Format timestamp
      const timestamp = new Date(recentUsage.timestamp || Date.now());
      const timeDiff = Date.now() - timestamp.getTime();
      const timeAgo = formatTimeAgo(timeDiff);

      // Determine model type
      const isFreeModel = recentUsage.model_name.includes(':free');
      const modelType = isFreeModel ? '(Free)' : '(Paid)';

      // Create embed with actual data
      const totalTokens = Number(recentUsage.total_tokens || 0);
      const estimatedCost = Number(recentUsage.estimated_cost || 0);
      const capDetected = Number(recentUsage.capabilities_detected || 0);
      const capExecuted = Number(recentUsage.capabilities_executed || 0);
      const responseTime = Number(recentUsage.response_time_ms || 0);

      const embed = new EmbedBuilder()
        .setColor(recentUsage.success ? 0x00ff00 : 0xff0000)
        .setTitle('🤖 Model Status')
        .setDescription(`**Current Model:** ${recentUsage.model_name} ${modelType}`)
        .addFields(
          { name: '⏰ When', value: timeAgo, inline: true },
          { name: '🎯 Tokens', value: totalTokens.toString(), inline: true },
          { name: '💰 Cost', value: `$${estimatedCost.toFixed(4)}`, inline: true }
        )
        .setTimestamp(timestamp);

      // Add additional fields if capabilities were used
      if (capDetected > 0) {
        embed.addFields({
          name: '🛠️ Capabilities',
          value: `Detected: ${capDetected}, Executed: ${capExecuted}`,
          inline: false,
        });
      }

      // Add response time if available
      if (responseTime > 0) {
        embed.addFields({
          name: '⚡ Response Time',
          value: `${responseTime}ms`,
          inline: true,
        });
      }

      return await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    } catch (error) {
      logger.error('Failed to fetch model status:', error);

      const errorEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('❌ Error')
        .setDescription('Failed to fetch model status. Please try again later.')
        .setTimestamp();

      return await interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });
    }
  },
};

// Helper function to format relative time
function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (seconds > 0) return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
  return 'Just now';
}
