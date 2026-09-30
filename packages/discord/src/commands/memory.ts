import { MessageFlags, ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { logger } from '@coachartie/shared';
import {
  searchOwnMemories,
  recentOwnMemories,
  ownMemoryStats,
  type OwnMemory,
} from '../services/user-memories.js';

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
          await interaction.editReply({
            embeds: [
              rows.length
                ? memoryList('🔍 Memory search', `${rows.length} match${rows.length === 1 ? '' : 'es'} for "${query}"`, rows)
                : new EmbedBuilder()
                    .setTitle('🔍 Memory search')
                    .setDescription(`No memories match "${query}". Try other words, or \`/memory recent\`.`)
                    .setColor(0xffaa00),
            ],
          });
          return;
        }
        case 'recent': {
          const limit = interaction.options.getInteger('limit') ?? 10;
          const rows = recentOwnMemories(userId, limit);
          await interaction.editReply({
            embeds: [
              rows.length
                ? memoryList('📚 Your recent memories', `Your ${rows.length} most recent`, rows)
                : new EmbedBuilder()
                    .setTitle('📚 Your recent memories')
                    .setDescription("I haven't saved anything about you yet. Chat with me and I will.")
                    .setColor(0xffaa00),
            ],
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
                value: s.avgImportance === null ? 'n/a' : s.avgImportance.toFixed(1),
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
    const importance = m.importance ? ` · ${m.importance}/10` : '';
    const text = m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content;
    embed.addFields({ name: `${i + 1}. ${date}${importance}`, value: text || '(empty)' });
  });
  return embed;
}
