import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, InteractionResponse } from 'discord.js';
import { logger } from '@coachartie/shared';
import { getDatabase } from '@coachartie/shared';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the LLM model used for your most recent message'),

  async execute(interaction: ChatInputCommandInteraction): Promise<InteractionResponse<boolean> | undefined> {
    try {
      const userId = interaction.user.id;

      // Query database for the most recent model usage by this user
      const db = await getDatabase();
      const recentUsage = await db.get(`
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
      `, [userId]);

      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('🤖 Model Status')
        .setTimestamp();

      if (!recentUsage) {
        embed.setDescription('No recent model usage found for your account.')
          .addFields(
            { name: '💡 Info', value: 'Send a message to Coach Artie first to see model usage statistics!', inline: false }
          );
      } else {
        // Format the model name for display
        const modelName = recentUsage.model_name;
        const modelDisplayName = modelName.includes(':free') 
          ? `${modelName.replace(':free', '')} (Free)`
          : modelName;

        // Format timestamp
        const timestamp = new Date(recentUsage.timestamp);
        const timeAgo = formatTimeAgo(timestamp);

        embed.setDescription(`Your most recent message was processed using **${modelDisplayName}**`)
          .addFields(
            { name: '⏰ When', value: `${timeAgo}\n${timestamp.toLocaleString()}`, inline: true },
            { name: '🎯 Tokens', value: `${recentUsage.total_tokens || 0}`, inline: true },
            { name: '💰 Cost', value: `$${(recentUsage.estimated_cost || 0).toFixed(4)}`, inline: true },
            { name: '⚡ Response Time', value: `${recentUsage.response_time_ms || 0}ms`, inline: true },
            { name: '🔧 Capabilities', value: `${recentUsage.capabilities_executed || 0} used`, inline: true },
            { name: '✅ Success', value: recentUsage.success ? 'Yes' : 'No', inline: true }
          );

        // Add message ID if available
        if (recentUsage.message_id) {
          embed.setFooter({ text: `Message ID: ${recentUsage.message_id}` });
        }
      }

      const response = await interaction.reply({
        embeds: [embed],
        ephemeral: true
      });

      logger.info('Status command executed', {
        userId,
        username: interaction.user.username,
        hasUsage: !!recentUsage,
        model: recentUsage?.model_name || 'none',
        service: 'discord'
      });

      return response;

    } catch (error) {
      logger.error('Error in status command:', error);
      return await interaction.reply({
        content: '❌ An error occurred while retrieving your status. Please try again.',
        ephemeral: true
      });
    }
  }
};

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return 'Just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }
}