import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionResponse,
} from 'discord.js';
import { getDatabase } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the LLM model used for your most recent message'),

  async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<InteractionResponse<boolean> | undefined> {
    try {
      const userId = interaction.user.id;
      const db = await getDatabase();

      // Query for the most recent model usage by this user
      const recentUsage = await db.get(
        `
        SELECT 
          model_name,
          message_id,
          timestamp,
          total_tokens,
          estimated_cost,
          response_time_ms,
          capabilities_detected,
          capabilities_executed,
          success
        FROM model_usage_stats 
        WHERE user_id = ? 
        ORDER BY timestamp DESC 
        LIMIT 1
      `,
        [userId]
      );

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
      const timestamp = new Date(recentUsage.timestamp);
      const timeDiff = Date.now() - timestamp.getTime();
      const timeAgo = formatTimeAgo(timeDiff);

      // Determine model type
      const isFreeModel = recentUsage.model_name.includes(':free');
      const modelType = isFreeModel ? '(Free)' : '(Paid)';

      // Create embed with actual data
      const embed = new EmbedBuilder()
        .setColor(recentUsage.success ? 0x00ff00 : 0xff0000)
        .setTitle('🤖 Model Status')
        .setDescription(`**Current Model:** ${recentUsage.model_name} ${modelType}`)
        .addFields(
          { name: '⏰ When', value: timeAgo, inline: true },
          { name: '🎯 Tokens', value: recentUsage.total_tokens.toString(), inline: true },
          { name: '💰 Cost', value: `$${recentUsage.estimated_cost.toFixed(4)}`, inline: true }
        )
        .setTimestamp(timestamp);

      // Add additional fields if capabilities were used
      if (recentUsage.capabilities_detected > 0) {
        embed.addFields({
          name: '🛠️ Capabilities',
          value: `Detected: ${recentUsage.capabilities_detected}, Executed: ${recentUsage.capabilities_executed}`,
          inline: false,
        });
      }

      // Add response time if available
      if (recentUsage.response_time_ms) {
        embed.addFields({
          name: '⚡ Response Time',
          value: `${recentUsage.response_time_ms}ms`,
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
