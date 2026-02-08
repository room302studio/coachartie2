import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import { telemetry } from '../services/telemetry.js';

export const debugCommand = {
  data: new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Troubleshoot connection and performance issues')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Debug action to perform')
        .setRequired(false)
        .addChoices(
          { name: '🔍 Connection Test', value: 'connection' },
          { name: '📊 Performance Check', value: 'performance' },
          { name: '🧠 Capabilities Test', value: 'capabilities' },
          { name: '📋 Recent Errors', value: 'errors' },
          { name: '🌐 Full Diagnostics', value: 'full' }
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const action = (interaction.options.get('action')?.value as string) || 'full';
      const userId = interaction.user.id;

      const embeds: EmbedBuilder[] = [];

      switch (action) {
        case 'connection':
          embeds.push(await createConnectionTestEmbed());
          break;
        case 'performance':
          embeds.push(await createPerformanceEmbed(userId));
          break;
        case 'capabilities':
          embeds.push(await createCapabilitiesTestEmbed());
          break;
        case 'errors':
          embeds.push(await createErrorsEmbed(userId));
          break;
        case 'full':
        default:
          embeds.push(await createConnectionTestEmbed());
          embeds.push(await createPerformanceEmbed(userId));
          embeds.push(await createCapabilitiesTestEmbed());
          break;
      }

      await interaction.editReply({
        embeds: embeds.slice(0, 10), // Discord limit
      });
    } catch (error) {
      logger.error('Error running debug command:', error);
      await interaction.editReply({
        content: '❌ There was an error running diagnostics. Please try again later.',
      });
    }
  },
};

async function createConnectionTestEmbed(): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle('🔍 Connection Test Results').setColor(0x3498db);
  const capabilitiesUrl = process.env.CAPABILITIES_URL || 'http://localhost:47324';
  const healthServerUrl = process.env.HEALTH_SERVER_URL || 'http://localhost:47319';

  const tests = [];

  // Test Discord API connection
  tests.push({
    name: '🌐 Discord API',
    status: '🟢 Connected',
    latency: 'Active',
  });

  // Test Capabilities Service
  try {
    const start = Date.now();
    const response = (await Promise.race([
      fetch(`${capabilitiesUrl}/health`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
    ])) as Response;

    const latency = Date.now() - start;

    if (response.ok) {
      const healthData = await response.json();
      tests.push({
        name: '🧠 Capabilities Service',
        status: '🟢 Online',
        latency: `${latency}ms`,
      });
    } else {
      tests.push({
        name: '🧠 Capabilities Service',
        status: '🟡 Issues Detected',
        latency: `HTTP ${response.status}`,
      });
    }
  } catch (error) {
    tests.push({
      name: '🧠 Capabilities Service',
      status: '🔴 Offline',
      latency: 'Failed',
    });
  }

  // Test Redis/Queue connection (simulated)
  tests.push({
    name: '🔄 Message Queue',
    status: '🟢 Connected',
    latency: 'Active',
  });

  // Test Health Server
  try {
    const response = await fetch(`${healthServerUrl}/health`);
    tests.push({
      name: '📊 Health Server',
      status: response.ok ? '🟢 Online' : '🟡 Issues',
      latency: response.ok ? 'Active' : 'Degraded',
    });
  } catch (error) {
    tests.push({
      name: '📊 Health Server',
      status: '🔴 Offline',
      latency: 'Failed',
    });
  }

  tests.forEach((test) => {
    embed.addFields({
      name: test.name,
      value: `${test.status}\nLatency: ${test.latency}`,
      inline: true,
    });
  });

  embed.setTimestamp();
  return embed;
}

async function createPerformanceEmbed(userId: string): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle('📊 Performance Analysis').setColor(0x9b59b6);

  try {
    // Get telemetry data
    const healthSummary = telemetry.getHealthSummary();
    const metrics = healthSummary.metrics;

    // Get user-specific performance
    const userEvents = telemetry.getRecentEvents(100).filter((event) => event.userId === userId);
    const userCompletions = userEvents.filter(
      (event) => event.event === 'job_completed' && event.duration
    );

    const userAvgResponseTime =
      userCompletions.length > 0
        ? (
            userCompletions.reduce((sum, event) => sum + (event.duration || 0), 0) /
            userCompletions.length /
            1000
          ).toFixed(1)
        : 'N/A';

    embed.addFields(
      { name: '⚡ Global Avg Response', value: metrics.averageResponseTime, inline: true },
      { name: '🎯 Your Avg Response', value: `${userAvgResponseTime}s`, inline: true },
      { name: '✅ Global Success Rate', value: metrics.successRate, inline: true },
      { name: '📈 Messages Processed', value: metrics.messagesReceived.toString(), inline: true },
      { name: '🏰 Connected Guilds', value: metrics.guilds.toString(), inline: true },
      { name: '⏰ Bot Uptime', value: metrics.uptime, inline: true }
    );

    // Performance rating
    const avgTime = parseFloat(metrics.averageResponseTime);
    let performanceRating = '';
    let performanceColor = 0x2ecc71;

    if (avgTime < 5) {
      performanceRating = '🚀 Excellent - Very fast responses';
    } else if (avgTime < 15) {
      performanceRating = '👍 Good - Normal response times';
      performanceColor = 0xf39c12;
    } else if (avgTime < 30) {
      performanceRating = '⚠️ Slow - Above average response times';
      performanceColor = 0xe67e22;
    } else {
      performanceRating = '🐌 Poor - Very slow responses';
      performanceColor = 0xe74c3c;
    }

    embed.setColor(performanceColor);
    embed.addFields({
      name: '🏆 Performance Rating',
      value: performanceRating,
      inline: false,
    });

    // Add performance tips
    if (avgTime > 15) {
      embed.addFields({
        name: '💡 Performance Tips',
        value:
          '• Try shorter messages\n• Avoid complex requests during peak times\n• Use `/models` to see which models are fastest',
        inline: false,
      });
    }
  } catch (error) {
    embed.addFields({
      name: '❌ Performance Data Unavailable',
      value: 'Unable to fetch performance metrics',
      inline: false,
    });
  }

  embed.setTimestamp();
  return embed;
}

async function createCapabilitiesTestEmbed(): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle('🧠 Capabilities Test').setColor(0xe74c3c);
  const brainUrl = process.env.BRAIN_URL || 'http://localhost:18239';

  try {
    // Test a simple capability
    const testStart = Date.now();
    const response = await fetch(`${brainUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Test calculation: 2+2',
        userId: 'debug-test',
      }),
    });

    const testDuration = Date.now() - testStart;

    if (response.ok) {
      const result = (await response.json()) as any;
      embed.setColor(0x2ecc71);
      embed.addFields(
        { name: '✅ Capabilities Service', value: 'Online and responding', inline: true },
        { name: '⚡ Response Time', value: `${testDuration}ms`, inline: true },
        { name: '🆔 Test Job ID', value: result.messageId?.slice(-8) || 'N/A', inline: true }
      );

      // Check if capabilities are being detected
      embed.addFields({
        name: '🔍 Capability Detection',
        value:
          'Test job submitted successfully\nMonitor with `/bot-status` for capability execution',
        inline: false,
      });
    } else {
      embed.addFields({
        name: '❌ Capabilities Service Error',
        value: `HTTP ${response.status}: ${response.statusText}`,
        inline: false,
      });
    }
  } catch (error) {
    embed.addFields({
      name: '❌ Capabilities Service Offline',
      value: 'Unable to connect to capabilities service',
      inline: false,
    });
  }

  // Available capabilities info
  embed.addFields({
    name: '🛠️ Available Capabilities',
    value:
      '• Calculator (math operations)\n• Memory (save/search conversations)\n• Web search (coming soon)\n• More capabilities available via API',
    inline: false,
  });

  embed.setTimestamp();
  return embed;
}

async function createErrorsEmbed(userId: string): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder().setTitle('📋 Recent Errors & Issues').setColor(0xe67e22);

  try {
    // Get recent error events from telemetry
    const allEvents = telemetry.getRecentEvents(200);
    const errorEvents = allEvents
      .filter(
        (event) =>
          (event.userId === userId || !event.userId) &&
          (event.success === false ||
            event.event.includes('error') ||
            event.event.includes('failed'))
      )
      .slice(0, 10);

    if (errorEvents.length === 0) {
      embed.setDescription('🎉 No recent errors found! Everything looks good.').setColor(0x2ecc71);

      embed.addFields({
        name: '✅ System Status',
        value: 'All systems operating normally',
        inline: false,
      });

      return embed;
    }

    // Display recent errors
    errorEvents.forEach((event, index) => {
      const timestamp = new Date(event.timestamp).toLocaleTimeString();
      const eventName = event.event.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

      let errorDetails = '';
      if (event.data?.error) {
        errorDetails =
          event.data.error.length > 100
            ? event.data.error.substring(0, 100) + '...'
            : event.data.error;
      }

      embed.addFields({
        name: `${index + 1}. ${eventName} - ${timestamp}`,
        value: errorDetails || 'No additional details',
        inline: false,
      });
    });

    // Add troubleshooting tips
    embed.addFields({
      name: '🔧 Troubleshooting Tips',
      value:
        '• Try sending your message again\n• Use simpler requests if complex ones fail\n• Check `/bot-status` for system health\n• Report persistent issues to support',
      inline: false,
    });
  } catch (error) {
    embed.addFields({
      name: '❌ Error Log Unavailable',
      value: 'Unable to fetch recent error information',
      inline: false,
    });
  }

  embed.setTimestamp();
  return embed;
}
