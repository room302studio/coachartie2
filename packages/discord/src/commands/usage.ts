import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger, getDb, modelUsageStats } from '@coachartie/shared';
import { desc, eq, gte, count, sum, avg, sql } from 'drizzle-orm';

export const usageCommand = {
  data: new SlashCommandBuilder()
    .setName('usage')
    .setDescription('View your AI usage statistics and costs')
    .addStringOption((option) =>
      option
        .setName('period')
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
        content: '❌ There was an error fetching your usage statistics. Please try again later.',
      });
    }
  },
};

async function createUsageEmbed(userId: string, period: string): Promise<EmbedBuilder> {
  try {
    const db = getDb();

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

    // Query usage statistics from the database using Drizzle
    const usageResults = await db
      .select({
        total_requests: count(),
        total_tokens: sum(modelUsageStats.totalTokens),
        total_cost: sum(modelUsageStats.estimatedCost),
        avg_response_time: avg(modelUsageStats.responseTimeMs),
        successful_requests: sql<number>`COUNT(CASE WHEN ${modelUsageStats.success} = 1 THEN 1 END)`,
        failed_requests: sql<number>`COUNT(CASE WHEN ${modelUsageStats.success} = 0 THEN 1 END)`,
        total_capabilities_detected: sum(modelUsageStats.capabilitiesDetected),
        total_capabilities_executed: sum(modelUsageStats.capabilitiesExecuted),
      })
      .from(modelUsageStats)
      .where(
        sql`${modelUsageStats.userId} = ${userId} AND ${modelUsageStats.timestamp} >= ${startDate.toISOString()}`
      );

    const usage = usageResults[0];

    // Get model breakdown
    const modelBreakdown = await db
      .select({
        model_name: modelUsageStats.modelName,
        requests: count(),
        tokens: sum(modelUsageStats.totalTokens),
        cost: sum(modelUsageStats.estimatedCost),
      })
      .from(modelUsageStats)
      .where(
        sql`${modelUsageStats.userId} = ${userId} AND ${modelUsageStats.timestamp} >= ${startDate.toISOString()}`
      )
      .groupBy(modelUsageStats.modelName)
      .orderBy(desc(count()))
      .limit(5);

    // Get recent activity
    const recentActivityResults = await db
      .select({
        model_name: modelUsageStats.modelName,
        timestamp: modelUsageStats.timestamp,
        total_tokens: modelUsageStats.totalTokens,
        estimated_cost: modelUsageStats.estimatedCost,
        success: modelUsageStats.success,
      })
      .from(modelUsageStats)
      .where(eq(modelUsageStats.userId, userId))
      .orderBy(desc(modelUsageStats.timestamp))
      .limit(1);

    const recentActivity = recentActivityResults[0];

    const periodLabels = {
      today: '📅 Today',
      week: '📅 This Week',
      month: '📅 This Month',
      all: '📅 All Time',
    };

    const embed = new EmbedBuilder()
      .setTitle(`💰 Your Usage Statistics - ${periodLabels[period as keyof typeof periodLabels]}`)
      .setColor(0x2ecc71);

    if (!usage || usage.total_requests === 0) {
      embed.setDescription('No usage data found for this period.').addFields({
        name: '🤖 Start chatting!',
        value: 'Send me a message to start tracking your usage statistics.',
        inline: false,
      });
      return embed;
    }

    // Calculate success rate
    const totalReqs = Number(usage.total_requests || 0);
    const successReqs = Number(usage.successful_requests || 0);
    const successRate = totalReqs > 0 ? ((successReqs / totalReqs) * 100).toFixed(1) : '0';

    // Calculate cost efficiency
    const totalCost = Number(usage.total_cost || 0);
    const costPerMessage = totalReqs > 0 ? (totalCost / totalReqs).toFixed(4) : '0.0000';

    embed.addFields(
      { name: '📊 Total Requests', value: (usage.total_requests || 0).toString(), inline: true },
      { name: '✅ Success Rate', value: `${successRate}%`, inline: true },
      { name: '🎯 Tokens Used', value: Number(usage.total_tokens || 0).toLocaleString(), inline: true },
      { name: '💰 Total Cost', value: `$${Number(usage.total_cost || 0).toFixed(4)}`, inline: true },
      { name: '📈 Cost/Message', value: `$${costPerMessage}`, inline: true },
      {
        name: '⚡ Avg Response',
        value: `${Math.round(Number(usage.avg_response_time || 0))}ms`,
        inline: true,
      }
    );

    // Add capabilities usage if available
    const capDetected = Number(usage.total_capabilities_detected || 0);
    const capExecuted = Number(usage.total_capabilities_executed || 0);
    if (capDetected > 0) {
      embed.addFields({
        name: '🛠️ Capabilities Usage',
        value: `Detected: ${capDetected}\nExecuted: ${capExecuted}`,
        inline: true,
      });
    }

    // Add model breakdown
    if (modelBreakdown && modelBreakdown.length > 0) {
      const modelStats = modelBreakdown
        .map((model) => {
          const modelName = model.model_name.split('/')[1]?.split(':')[0] || model.model_name;
          const modelRequests = Number(model.requests || 0);
          const modelCost = Number(model.cost || 0);
          return `**${modelName}**: ${modelRequests} requests ($${modelCost.toFixed(4)})`;
        })
        .join('\n');

      embed.addFields({
        name: '🤖 Model Breakdown',
        value: modelStats,
        inline: false,
      });
    }

    // Add recent activity if available
    if (recentActivity) {
      const lastUsed = new Date(recentActivity.timestamp || Date.now());
      const timeDiff = Date.now() - lastUsed.getTime();
      const timeAgo = formatTimeAgo(timeDiff);

      const recentModel =
        recentActivity.model_name.split('/')[1]?.split(':')[0] || recentActivity.model_name;
      const recentStatus = recentActivity.success ? '✅' : '❌';
      const recentTokens = Number(recentActivity.total_tokens || 0);
      const recentCost = Number(recentActivity.estimated_cost || 0);

      embed.addFields({
        name: '🕐 Last Activity',
        value: `${recentStatus} ${recentModel} - ${timeAgo}\n${recentTokens} tokens ($${recentCost.toFixed(4)})`,
        inline: false,
      });
    }

    // Add cost context
    let costContext = '';
    if (totalCost < 0.01) {
      costContext = '🎉 All your usage is on free models!';
    } else if (totalCost < 0.1) {
      costContext = '💚 Very economical usage';
    } else if (totalCost < 1.0) {
      costContext = '💛 Moderate usage';
    } else {
      costContext = '💰 Heavy usage - consider optimizing';
    }

    embed.addFields({
      name: '💡 Cost Analysis',
      value: costContext,
      inline: false,
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
        value:
          '• Database connection problem\n• Usage tracking not yet initialized\n• Capabilities service offline',
        inline: false,
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
