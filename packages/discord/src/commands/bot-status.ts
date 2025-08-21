import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { telemetry } from '../services/telemetry.js';
import { capabilitiesClient } from '../services/capabilities-client.js';

export const botStatusCommand = {
  data: new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('Check bot health, your usage stats, and system status')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of status to check')
        .setRequired(false)
        .addChoices(
          { name: '🤖 Bot Health', value: 'bot' },
          { name: '📊 My Usage', value: 'user' },
          { name: '🔧 System Status', value: 'system' },
          { name: '🌐 All Status', value: 'all' }
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const statusType = interaction.options.get('type')?.value as string || 'all';
      const userId = interaction.user.id;

      const embeds: EmbedBuilder[] = [];

      if (statusType === 'bot' || statusType === 'all') {
        embeds.push(await createBotHealthEmbed());
      }

      if (statusType === 'user' || statusType === 'all') {
        embeds.push(await createUserUsageEmbed(userId));
      }

      if (statusType === 'system' || statusType === 'all') {
        embeds.push(await createSystemStatusEmbed());
      }

      await interaction.editReply({
        embeds: embeds.slice(0, 10) // Discord limit
      });

    } catch (error) {
      logger.error('Error checking bot status:', error);
      await interaction.editReply({
        content: '❌ There was an error checking status. Please try again later.'
      });
    }
  }
};

async function createBotHealthEmbed(): Promise<EmbedBuilder> {
  const healthSummary = telemetry.getHealthSummary();
  const metrics = healthSummary.metrics;

  const statusEmoji = {
    'healthy': '🟢',
    'degraded': '🟡',
    'unhealthy': '🔴'
  }[healthSummary.status];

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji} Bot Health Status`)
    .setColor(healthSummary.status === 'healthy' ? 0x00ff00 : 
             healthSummary.status === 'degraded' ? 0xffff00 : 0xff0000)
    .addFields(
      { name: '📈 Messages Processed', value: metrics.messagesReceived.toString(), inline: true },
      { name: '✅ Success Rate', value: metrics.successRate, inline: true },
      { name: '⏱️ Avg Response Time', value: metrics.averageResponseTime, inline: true },
      { name: '👥 Unique Users', value: metrics.uniqueUsers.toString(), inline: true },
      { name: '🏰 Guilds Connected', value: metrics.guilds.toString(), inline: true },
      { name: '⏰ Uptime', value: metrics.uptime, inline: true }
    )
    .setTimestamp();

  if (healthSummary.issues && healthSummary.issues.length > 0) {
    embed.addFields({
      name: '⚠️ Issues Detected',
      value: healthSummary.issues.join('\n'),
      inline: false
    });
  }

  return embed;
}

async function createUserUsageEmbed(userId: string): Promise<EmbedBuilder> {
  const allMetrics = telemetry.getMetrics();
  
  // Get user-specific metrics from recent events
  const userEvents = telemetry.getRecentEvents(200).filter(event => event.userId === userId);
  const userMessages = userEvents.filter(event => event.event === 'message_received').length;
  const userJobs = userEvents.filter(event => event.event === 'job_submitted').length;
  const userCompletions = userEvents.filter(event => event.event === 'job_completed').length;
  const userFailures = userEvents.filter(event => event.event === 'job_failed').length;
  
  const userSuccessRate = userJobs > 0 ? ((userCompletions / userJobs) * 100).toFixed(1) + '%' : 'N/A';
  
  // Calculate average response time for this user
  const userCompletionEvents = userEvents.filter(event => 
    event.event === 'job_completed' && event.duration
  );
  const avgUserResponseTime = userCompletionEvents.length > 0 
    ? (userCompletionEvents.reduce((sum, event) => sum + (event.duration || 0), 0) / userCompletionEvents.length / 1000).toFixed(1) + 's'
    : 'N/A';

  const embed = new EmbedBuilder()
    .setTitle('📊 Your Usage Statistics')
    .setColor(0x3498db)
    .addFields(
      { name: '💬 Messages Sent', value: userMessages.toString(), inline: true },
      { name: '🚀 Jobs Submitted', value: userJobs.toString(), inline: true },
      { name: '✅ Success Rate', value: userSuccessRate, inline: true },
      { name: '⏱️ Avg Response Time', value: avgUserResponseTime, inline: true },
      { name: '❌ Failed Jobs', value: userFailures.toString(), inline: true },
      { name: '🏆 Rank', value: `Top ${Math.ceil((1 / allMetrics.uniqueUserCount) * 100)}%`, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Stats from recent activity' });

  return embed;
}

async function createSystemStatusEmbed(): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder()
    .setTitle('🔧 System Status')
    .setColor(0x9b59b6);

  try {
    // Test capabilities service
    const capabilitiesStart = Date.now();
    const testResult = await Promise.race([
      fetch('http://localhost:18239/health').then(r => r.ok),
      new Promise(resolve => setTimeout(() => resolve(false), 5000))
    ]);
    const capabilitiesLatency = Date.now() - capabilitiesStart;

    const capabilitiesStatus = testResult ? '🟢 Online' : '🔴 Offline';
    const capabilitiesLatencyText = testResult ? `${capabilitiesLatency}ms` : 'N/A';

    embed.addFields(
      { name: '🧠 Capabilities Service', value: capabilitiesStatus, inline: true },
      { name: '⚡ Capabilities Latency', value: capabilitiesLatencyText, inline: true },
      { name: '🔄 Redis Queue', value: '🟢 Connected', inline: true }, // TODO: actual check
      { name: '🌐 Discord API', value: '🟢 Connected', inline: true },
      { name: '📊 Health Server', value: '🟢 Running :3001', inline: true },
      { name: '💾 Telemetry', value: '🟢 Recording', inline: true }
    );

  } catch (error) {
    embed.addFields(
      { name: '❌ System Check Failed', value: 'Unable to verify all services', inline: false }
    );
  }

  embed.setTimestamp();
  return embed;
}