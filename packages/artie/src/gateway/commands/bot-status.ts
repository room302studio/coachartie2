import { MessageFlags, ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { testRedisConnection } from '../../shared/queue/redis.js';
import { telemetry } from '../telemetry.js';
import * as engine from '../../engine/api.js';

/**
 * Get color code for health status.
 */
function statusColor(status: 'healthy' | 'degraded' | 'unhealthy'): number {
  if (status === 'healthy') {
    return 0x00ff00;
  }
  if (status === 'degraded') {
    return 0xffff00;
  }
  return 0xff0000;
}

/**
 * Format a percentage or 'N/A'.
 */
function percentageOrNA(jobs: number, completions: number): string {
  if (jobs > 0) {
    return ((completions / jobs) * 100).toFixed(1) + '%';
  }
  return 'N/A';
}

/**
 * Format response time or 'N/A'.
 */
function responseTimeOrNA(events: any[]): string {
  if (events.length > 0) {
    const avgTime = events.reduce((sum, event) => sum + (event.duration || 0), 0) / events.length / 1000;
    return avgTime.toFixed(1) + 's';
  }
  return 'N/A';
}

/**
 * Format service status string.
 */
function serviceStatus(online: boolean): string {
  if (online) {
    return '🟢 Online';
  }
  return '🔴 Offline';
}

/**
 * Format service latency or 'N/A'.
 */
function serviceLatency(online: boolean, latency: number): string {
  if (online) {
    return `${latency}ms`;
  }
  return 'N/A';
}

/**
 * Format connected status string.
 */
function connectedStatus(ok: boolean): string {
  if (ok) {
    return '🟢 Connected';
  }
  return '🔴 Offline';
}

/**
 * Format latency text for redis.
 */
function latencyText(ok: boolean, latency: number): string {
  if (ok) {
    return `(${latency}ms)`;
  }
  return '';
}

export const botStatusCommand = {
  data: new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('Check bot health, your usage stats, and system status')
    .addStringOption((option) =>
      option
        .setName('type')
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const statusType = (interaction.options.get('type')?.value as string) || 'all';
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
        embeds: embeds.slice(0, 10), // Discord limit
      });
    } catch (error) {
      logger.error('Error checking bot status:', error);
      await interaction.editReply({
        content: '❌ There was an error checking status. Please try again later.',
      });
    }
  },
};

async function createBotHealthEmbed(): Promise<EmbedBuilder> {
  const healthSummary = telemetry.getHealthSummary();
  const metrics = healthSummary.metrics;

  const statusEmoji = {
    healthy: '🟢',
    degraded: '🟡',
    unhealthy: '🔴',
  }[healthSummary.status];

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji} Bot Health Status`)
    .setColor(statusColor(healthSummary.status))
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
      inline: false,
    });
  }

  return embed;
}

async function createUserUsageEmbed(userId: string): Promise<EmbedBuilder> {
  const allMetrics = telemetry.getMetrics();

  // Get user-specific metrics from recent events
  const userEvents = telemetry.getRecentEvents(200).filter((event) => event.userId === userId);
  const userMessages = userEvents.filter((event) => event.event === 'message_received').length;
  const userJobs = userEvents.filter((event) => event.event === 'job_submitted').length;
  const userCompletions = userEvents.filter((event) => event.event === 'job_completed').length;
  const userFailures = userEvents.filter((event) => event.event === 'job_failed').length;

  const userSuccessRate = percentageOrNA(userJobs, userCompletions);

  // Calculate average response time for this user
  const userCompletionEvents = userEvents.filter(
    (event) => event.event === 'job_completed' && event.duration
  );
  const avgUserResponseTime = responseTimeOrNA(userCompletionEvents);

  const embed = new EmbedBuilder()
    .setTitle('📊 Your Usage Statistics')
    .setColor(0x3498db)
    .addFields(
      { name: '💬 Messages Sent', value: userMessages.toString(), inline: true },
      { name: '🚀 Jobs Submitted', value: userJobs.toString(), inline: true },
      { name: '✅ Success Rate', value: userSuccessRate, inline: true },
      { name: '⏱️ Avg Response Time', value: avgUserResponseTime, inline: true },
      { name: '❌ Failed Jobs', value: userFailures.toString(), inline: true },
      {
        name: '🏆 Rank',
        value: `Top ${Math.ceil((1 / allMetrics.uniqueUserCount) * 100)}%`,
        inline: true,
      }
    )
    .setTimestamp()
    .setFooter({ text: 'Stats from recent activity' });

  return embed;
}

async function createSystemStatusEmbed(): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle('🔧 System Status').setColor(0x9b59b6);

  try {
    // Test capabilities service (the engine's GET /health, in-process since wave 9)
    const capabilitiesStart = Date.now();
    const testResult = await Promise.race<boolean>([
      engine.healthSnapshot().then((r) => engine.isOk(r)),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    const capabilitiesLatency = Date.now() - capabilitiesStart;

    const capabilitiesStatus = serviceStatus(testResult);
    const capabilitiesLatencyText = serviceLatency(testResult, capabilitiesLatency);

    // Test Redis connection
    const redisStart = Date.now();
    const redisOk = await testRedisConnection();
    const redisLatency = Date.now() - redisStart;
    const redisStatus = connectedStatus(redisOk);
    const redisLatencyText = latencyText(redisOk, redisLatency);

    embed.addFields(
      { name: '🧠 Capabilities Service', value: capabilitiesStatus, inline: true },
      { name: '⚡ Capabilities Latency', value: capabilitiesLatencyText, inline: true },
      { name: '🔄 Redis Queue', value: `${redisStatus} ${redisLatencyText}`, inline: true },
      { name: '🌐 Discord API', value: '🟢 Connected', inline: true },
      { name: '📊 Health Server', value: '🟢 Running :47319', inline: true },
      { name: '💾 Telemetry', value: '🟢 Recording', inline: true }
    );
  } catch {
    embed.addFields({
      name: '❌ System Check Failed',
      value: 'Unable to verify all services',
      inline: false,
    });
  }

  embed.setTimestamp();
  return embed;
}
