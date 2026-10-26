import { MessageFlags, ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '../../shared/logger.js';
import {
  searchOwnMemories,
  recentOwnMemories,
  ownMemoryStats,
  type OwnMemory,
} from './user-memories.js';

/**
 * Pluralize "match/matches".
 */
function matchesPlural(count: number): string {
  if (count === 1) {
    return '';
  }
  return 'es';
}

/**
 * Format average importance or 'n/a'.
 */
function importanceValue(avg: number | null): string {
  if (avg === null) {
    return 'n/a';
  }
  return avg.toFixed(1);
}

/**
 * Truncate text to 200 chars with ellipsis.
 */
function truncateText(text: string): string {
  if (text.length > 200) {
    return `${text.slice(0, 200)}…`;
  }
  return text;
}

/**
 * Create search results embed or empty state.
 */
function createSearchEmbed(query: string, rows: OwnMemory[]): EmbedBuilder {
  if (rows.length) {
    return memoryList('🔍 Memory search', `${rows.length} match${matchesPlural(rows.length)} for "${query}"`, rows);
  }
  const embed = new EmbedBuilder()
    .setTitle('🔍 Memory search')
    .setDescription(`No memories match "${query}". Try other words, or \`/memory recent\`.`)
    .setColor(0xffaa00);
  return embed;
}

/**
 * Create recent memories embed or empty state.
 */
function createRecentEmbed(rows: OwnMemory[]): EmbedBuilder {
  if (rows.length) {
    return memoryList('📚 Your recent memories', `Your ${rows.length} most recent`, rows);
  }
  const embed = new EmbedBuilder()
    .setTitle('📚 Your recent memories')
    .setDescription("I haven't saved anything about you yet. Chat with me and I will.")
    .setColor(0xffaa00);
  return embed;
}

/** /memory: the caller's OWN memories only, always as a private reply (services/user-memories). */
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;

    try {
      switch (interaction.options.getSubcommand()) {
        case 'search': {
          const query = interaction.options.getString('query', true);
          const limit = interaction.options.getInteger('limit') ?? 10;
          const rows = searchOwnMemories(userId, query, limit);
          const embed = createSearchEmbed(query, rows);
          await interaction.editReply({
            embeds: [embed],
          });
          return;
        }
        case 'recent': {
          const limit = interaction.options.getInteger('limit') ?? 10;
          const rows = recentOwnMemories(userId, limit);
          const embed = createRecentEmbed(rows);
          await interaction.editReply({
            embeds: [embed],
          });
          return;
        }
        case 'stats': {
          const s = ownMemoryStats(userId);
          const embed = new EmbedBuilder()
            .setTitle('📊 Your memory stats')
            .setColor(0x9b59b6)
            .addFields(
              { name: '📚 Total', value: String(s.total), inline: true },
              { name: '🕐 Last 7 days', value: String(s.lastWeek), inline: true },
              {
                name: '⭐ Avg importance',
                value: importanceValue(s.avgImportance),
                inline: true,
              }
            );
          if (s.oldest) {
            embed.addFields({ name: '🗓️ Oldest', value: s.oldest.slice(0, 10), inline: true });
          }
          if (s.topTags.length) {
            embed.addFields({
              name: '🏷️ Top tags',
              value: s.topTags.map(([tag, n]) => `${tag} (${n})`).join('\n').slice(0, 1024),
            });
          }
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        default:
          await interaction.editReply('Use `/memory search`, `/memory recent` or `/memory stats`.');
      }
    } catch (error) {
      logger.error('Error executing memory command:', error);
      await interaction.editReply('❌ Could not read your memories. Check the logs.');
    }
  },
};

function memoryList(title: string, description: string, rows: OwnMemory[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x3498db);
  rows.slice(0, 20).forEach((m, i) => {
    const date = (m.timestamp || '').slice(0, 10);
    let importanceStr: string;
    if (m.importance) {
      importanceStr = ` · ${m.importance}/10`;
    } else {
      importanceStr = '';
    }
    const text = truncateText(m.content);
    embed.addFields({ name: `${i + 1}. ${date}${importanceStr}`, value: text || '(empty)' });
  });
  return embed;
}
