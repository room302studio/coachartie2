import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';

export const memoryCommand = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Search and manage your conversation memories')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('search')
        .setDescription('Search your memories')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('What to search for in your memories')
            .setRequired(true)
        )
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('Number of results to return (1-20)')
            .setMinValue(1)
            .setMaxValue(20)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('recent')
        .setDescription('View your recent memories')
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('Number of recent memories to show (1-20)')
            .setMinValue(1)
            .setMaxValue(20)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('stats').setDescription('View your memory statistics')
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const subcommand = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      switch (subcommand) {
        case 'search':
          await handleMemorySearch(interaction, userId);
          break;
        case 'recent':
          await handleRecentMemories(interaction, userId);
          break;
        case 'stats':
          await handleMemoryStats(interaction, userId);
          break;
        default:
          await interaction.editReply({
            content:
              '❌ Unknown memory command. Use `/memory search`, `/memory recent`, or `/memory stats`.',
          });
      }
    } catch (error) {
      logger.error('Error executing memory command:', error);
      await interaction.editReply({
        content: '❌ There was an error accessing your memories. Please try again later.',
      });
    }
  },
};

async function handleMemorySearch(interaction: ChatInputCommandInteraction, userId: string) {
  const query = interaction.options.get('query')?.value as string;
  const limit = (interaction.options.get('limit')?.value as number) || 10;

  try {
    // Call the existing memories API endpoint
    const response = await fetch(
      `http://localhost:18239/api/memories?userId=${userId}&search=${encodeURIComponent(query)}&limit=${limit}`
    );

    if (!response.ok) {
      throw new Error(`API response: ${response.status}`);
    }

    const result = (await response.json()) as any;

    if (!result.success || !result.data || result.data.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('🔍 Memory Search Results')
        .setDescription(`No memories found for "${query}"`)
        .setColor(0xffaa00)
        .addFields({
          name: '💡 Tips',
          value:
            '• Try broader search terms\n• Check your recent memories with `/memory recent`\n• Try different keywords',
          inline: false,
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔍 Memory Search Results')
      .setDescription(`Found ${result.count} memories for "${query}"`)
      .setColor(0x3498db)
      .setTimestamp();

    // Add memory results as fields (Discord has a 25 field limit)
    const memories = result.data.slice(0, 10); // Limit to first 10 for readability

    memories.forEach((memory: any, index: number) => {
      const timestamp = new Date(memory.timestamp || memory.created_at).toLocaleDateString();
      const content =
        memory.content.length > 200 ? memory.content.substring(0, 200) + '...' : memory.content;

      embed.addFields({
        name: `${index + 1}. ${timestamp}`,
        value: content,
        inline: false,
      });
    });

    if (result.count > 10) {
      embed.addFields({
        name: '📝 Note',
        value: `Showing first 10 of ${result.count} results. Use a more specific search to narrow down.`,
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error('Memory search failed:', error);
    await interaction.editReply({
      content: '❌ Memory search failed. The capabilities service might be unavailable.',
    });
  }
}

async function handleRecentMemories(interaction: ChatInputCommandInteraction, userId: string) {
  const limit = (interaction.options.get('limit')?.value as number) || 10;

  try {
    // Call the existing memories API endpoint
    const response = await fetch(
      `http://localhost:18239/api/memories?userId=${userId}&limit=${limit}`
    );

    if (!response.ok) {
      throw new Error(`API response: ${response.status}`);
    }

    const result = (await response.json()) as any;

    if (!result.success || !result.data || result.data.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('📚 Your Recent Memories')
        .setDescription('No memories found. Start chatting with me to build your memory!')
        .setColor(0xffaa00)
        .addFields({
          name: '🤖 How memories work',
          value:
            'I automatically save important parts of our conversations so I can remember context in future chats.',
          inline: false,
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📚 Your Recent Memories')
      .setDescription(`Your ${result.count} most recent memories`)
      .setColor(0x3498db)
      .setTimestamp();

    // Add memory results as fields
    result.data.forEach((memory: any, index: number) => {
      const timestamp = new Date(memory.timestamp || memory.created_at).toLocaleDateString();
      const content =
        memory.content.length > 200 ? memory.content.substring(0, 200) + '...' : memory.content;

      const importance = memory.importance ? ` (${memory.importance}/10)` : '';

      embed.addFields({
        name: `${index + 1}. ${timestamp}${importance}`,
        value: content,
        inline: false,
      });
    });

    embed.addFields({
      name: '🔍 Search memories',
      value: 'Use `/memory search <query>` to find specific memories',
      inline: false,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error('Recent memories fetch failed:', error);
    await interaction.editReply({
      content: '❌ Failed to fetch recent memories. The capabilities service might be unavailable.',
    });
  }
}

async function handleMemoryStats(interaction: ChatInputCommandInteraction, userId: string) {
  try {
    // Call the existing memories API endpoint to get total count
    const response = await fetch(`http://localhost:18239/api/memories?userId=${userId}&limit=1000`);

    if (!response.ok) {
      throw new Error(`API response: ${response.status}`);
    }

    const result = (await response.json()) as any;

    if (!result.success) {
      throw new Error('API returned error');
    }

    const totalMemories = result.count || 0;
    const memories = result.data || [];

    // Calculate stats
    const now = Date.now();
    const recentMemories = memories.filter((m: any) => {
      const memoryTime = new Date(m.timestamp || m.created_at).getTime();
      return now - memoryTime < 7 * 24 * 60 * 60 * 1000; // Last 7 days
    }).length;

    const oldestMemory =
      memories.length > 0
        ? new Date(
            memories[memories.length - 1].timestamp || memories[memories.length - 1].created_at
          )
        : null;

    const avgImportance =
      memories.length > 0
        ? (
            memories.reduce((sum: number, m: any) => sum + (m.importance || 5), 0) / memories.length
          ).toFixed(1)
        : 'N/A';

    const embed = new EmbedBuilder()
      .setTitle('📊 Your Memory Statistics')
      .setColor(0x9b59b6)
      .addFields(
        { name: '📚 Total Memories', value: totalMemories.toString(), inline: true },
        { name: '🕐 Recent (7 days)', value: recentMemories.toString(), inline: true },
        { name: '⭐ Avg Importance', value: avgImportance, inline: true }
      );

    if (oldestMemory) {
      embed.addFields({
        name: '🗓️ Oldest Memory',
        value: oldestMemory.toLocaleDateString(),
        inline: true,
      });
    }

    // Add memory distribution by tags if available
    const tagCounts: Record<string, number> = {};
    memories.forEach((memory: any) => {
      if (memory.tags) {
        const tags = typeof memory.tags === 'string' ? memory.tags.split(',') : memory.tags;
        tags.forEach((tag: string) => {
          const cleanTag = tag.trim();
          if (cleanTag) {
            tagCounts[cleanTag] = (tagCounts[cleanTag] || 0) + 1;
          }
        });
      }
    });

    if (Object.keys(tagCounts).length > 0) {
      const topTags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([tag, count]) => `${tag} (${count})`)
        .join('\n');

      embed.addFields({
        name: '🏷️ Top Memory Tags',
        value: topTags,
        inline: false,
      });
    }

    embed.addFields({
      name: '💡 Memory Tips',
      value:
        '• Memories help me understand context\n• Higher importance = more likely to be recalled\n• Search your memories anytime with `/memory search`',
      inline: false,
    });

    embed.setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error('Memory stats failed:', error);
    await interaction.editReply({
      content:
        '❌ Failed to fetch memory statistics. The capabilities service might be unavailable.',
    });
  }
}
