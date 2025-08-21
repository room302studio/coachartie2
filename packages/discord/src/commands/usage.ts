import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { getDatabase } from '@coachartie/shared';

export const usageCommand = {
  data: new SlashCommandBuilder()
    .setName('usage')
    .setDescription('View your AI usage statistics and costs')
    .addStringOption(option =>
      option.setName('period')
        .setDescription('Time period to analyze')
        .setRequired(false)
        .addChoices(
          { name: '📅 Today', value: 'today' },
          { name: '📅 This Week', value: 'week' },
          { name: '📅 This Month', value: 'month' },
          { name: '📅 All Time', value: 'all' }
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const period = (interaction.options.get('period')?.value as string) || 'week';
      const userId = interaction.user.id;

      const embed = await createUsageEmbed(userId, period);
      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      logger.error('Error fetching usage stats:', error);
      await interaction.editReply({
        content: '❌ There was an error fetching your usage statistics. Please try again later.'
      });
    }
  }
};

async function createUsageEmbed(userId: string, period: string): Promise<EmbedBuilder> {
  try {
    const db = await getDatabase();
    
    // Calculate date range based on period
    const now = new Date();
    let startDate: Date;
    
    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'all':
      default:
        startDate = new Date(2020, 0, 1); // Very old date to get all records
        break;
    }

    // Query usage statistics from the database
    const usage = await db.get(`
      SELECT 
        COUNT(*) as total_requests,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost) as total_cost,
        AVG(response_time_ms) as avg_response_time,
        COUNT(CASE WHEN success = 1 THEN 1 END) as successful_requests,
        COUNT(CASE WHEN success = 0 THEN 1 END) as failed_requests,
        SUM(capabilities_detected) as total_capabilities_detected,
        SUM(capabilities_executed) as total_capabilities_executed
      FROM model_usage_stats 
      WHERE user_id = ? AND timestamp >= ?
    `, [userId, startDate.toISOString()]);

    // Get model breakdown
    const modelBreakdown = await db.all(`
      SELECT 
        model_name,
        COUNT(*) as requests,
        SUM(total_tokens) as tokens,
        SUM(estimated_cost) as cost
      FROM model_usage_stats 
      WHERE user_id = ? AND timestamp >= ?
      GROUP BY model_name
      ORDER BY requests DESC
      LIMIT 5
    `, [userId, startDate.toISOString()]);

    // Get recent activity
    const recentActivity = await db.get(`
      SELECT 
        model_name,
        timestamp,
        total_tokens,
        estimated_cost,
        success
      FROM model_usage_stats 
      WHERE user_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [userId]);

    const periodLabels = {
      today: '📅 Today',
      week: '📅 This Week', 
      month: '📅 This Month',
      all: '📅 All Time'
    };

    const embed = new EmbedBuilder()
      .setTitle(`💰 Your Usage Statistics - ${periodLabels[period as keyof typeof periodLabels]}`)
      .setColor(0x2ecc71);

    if (!usage || usage.total_requests === 0) {
      embed.setDescription('No usage data found for this period.')
        .addFields({
          name: '🤖 Start chatting!',
          value: 'Send me a message to start tracking your usage statistics.',
          inline: false
        });
      return embed;
    }

    // Calculate success rate
    const successRate = usage.total_requests > 0 
      ? ((usage.successful_requests / usage.total_requests) * 100).toFixed(1)
      : '0';

    // Calculate cost efficiency
    const costPerMessage = usage.total_cost > 0 
      ? (usage.total_cost / usage.total_requests).toFixed(4)
      : '0.0000';

    embed.addFields(
      { name: '📊 Total Requests', value: usage.total_requests.toString(), inline: true },
      { name: '✅ Success Rate', value: `${successRate}%`, inline: true },
      { name: '🎯 Tokens Used', value: usage.total_tokens?.toLocaleString() || '0', inline: true },
      { name: '💰 Total Cost', value: `$${(usage.total_cost || 0).toFixed(4)}`, inline: true },
      { name: '📈 Cost/Message', value: `$${costPerMessage}`, inline: true },
      { name: '⚡ Avg Response', value: `${Math.round(usage.avg_response_time || 0)}ms`, inline: true }
    );

    // Add capabilities usage if available
    if (usage.total_capabilities_detected > 0) {
      embed.addFields({
        name: '🛠️ Capabilities Usage',
        value: `Detected: ${usage.total_capabilities_detected}\nExecuted: ${usage.total_capabilities_executed}`,
        inline: true
      });
    }

    // Add model breakdown
    if (modelBreakdown && modelBreakdown.length > 0) {
      const modelStats = modelBreakdown.map((model: any) => {
        const modelName = model.model_name.split('/')[1]?.split(':')[0] || model.model_name;
        return `**${modelName}**: ${model.requests} requests ($${model.cost.toFixed(4)})`;
      }).join('\n');

      embed.addFields({
        name: '🤖 Model Breakdown',
        value: modelStats,
        inline: false
      });
    }

    // Add recent activity if available
    if (recentActivity) {
      const lastUsed = new Date(recentActivity.timestamp);
      const timeDiff = Date.now() - lastUsed.getTime();
      const timeAgo = formatTimeAgo(timeDiff);
      
      const recentModel = recentActivity.model_name.split('/')[1]?.split(':')[0] || recentActivity.model_name;
      const recentStatus = recentActivity.success ? '✅' : '❌';
      
      embed.addFields({
        name: '🕐 Last Activity',
        value: `${recentStatus} ${recentModel} - ${timeAgo}\n${recentActivity.total_tokens} tokens ($${recentActivity.estimated_cost.toFixed(4)})`,
        inline: false
      });
    }

    // Add cost context
    let costContext = '';
    const totalCost = usage.total_cost || 0;
    if (totalCost < 0.01) {
      costContext = '🎉 All your usage is on free models!';
    } else if (totalCost < 0.10) {
      costContext = '💚 Very economical usage';
    } else if (totalCost < 1.00) {
      costContext = '💛 Moderate usage';
    } else {
      costContext = '💰 Heavy usage - consider optimizing';
    }

    embed.addFields({
      name: '💡 Cost Analysis',
      value: costContext,
      inline: false
    });

    embed.setTimestamp();
    embed.setFooter({ text: 'All costs are estimates based on OpenRouter pricing' });

    return embed;

  } catch (error) {
    logger.error('Database query failed for usage stats:', error);
    
    const errorEmbed = new EmbedBuilder()
      .setTitle('❌ Usage Statistics Unavailable')
      .setDescription('Unable to fetch usage statistics from the database.')
      .setColor(0xff0000)
      .addFields({
        name: '🔧 Possible Issues',
        value: '• Database connection problem\n• Usage tracking not yet initialized\n• Capabilities service offline',
        inline: false
      })
      .setTimestamp();

    return errorEmbed;
  }
}

// Helper function to format relative time
function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (seconds > 30) return `${seconds} seconds ago`;
  return 'Just now';
}