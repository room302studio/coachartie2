import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { getGitHubPoller } from '../services/github-poller.js';

export const watchRepoCommand = {
  data: new SlashCommandBuilder()
    .setName('watch-repo')
    .setDescription('Start watching a GitHub repo for PR and CI activity in this channel')
    .addStringOption((option) =>
      option
        .setName('repo')
        .setDescription('GitHub repo in owner/repo format (e.g., room302studio/coachartie2)')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('events')
        .setDescription('Events to watch (comma-separated: pr,review,ci or "all")')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      const repo = interaction.options.getString('repo', true);
      const eventsStr = interaction.options.getString('events') || 'all';
      const channelId = interaction.channelId;
      const guildId = interaction.guildId;

      if (!guildId) {
        return await interaction.reply({
          content: '❌ This command can only be used in a server.',
          ephemeral: true,
        });
      }

      // Validate repo format
      const repoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
      if (!repoRegex.test(repo)) {
        return await interaction.reply({
          content: '❌ Invalid repo format. Please use `owner/repo` format (e.g., `room302studio/coachartie2`).',
          ephemeral: true,
        });
      }

      // Parse events
      const events = eventsStr.toLowerCase().split(',').map((e) => e.trim());
      const validEvents = ['pr', 'review', 'ci', 'all'];
      const invalidEvents = events.filter((e) => !validEvents.includes(e));
      if (invalidEvents.length > 0) {
        return await interaction.reply({
          content: `❌ Invalid events: ${invalidEvents.join(', ')}. Valid options: pr, review, ci, all`,
          ephemeral: true,
        });
      }

      // Add the watch
      try {
        const poller = getGitHubPoller();
        await poller.addWatch(repo, guildId, channelId, events, interaction.user.id);
      } catch (error) {
        // Poller might not be initialized yet
        logger.warn('GitHub poller not initialized, watch added to database only');
      }

      const embed = new EmbedBuilder()
        .setColor(0x238636)
        .setTitle('👀 Now Watching Repository')
        .setDescription(`This channel will receive notifications for **${repo}**`)
        .addFields(
          { name: '📦 Repository', value: `\`${repo}\``, inline: true },
          { name: '📺 Channel', value: `<#${channelId}>`, inline: true },
          {
            name: '📋 Events',
            value: events.includes('all')
              ? 'All events (PRs, reviews, CI)'
              : events.map((e) => `\`${e}\``).join(', '),
            inline: false,
          },
          {
            name: '🔔 You\'ll be notified about',
            value: [
              '• New pull requests',
              '• PRs ready for review',
              '• Reviews and approvals',
              '• CI status changes',
              '• PR merges',
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: 'Use /unwatch-repo to stop watching' });

      await interaction.reply({
        embeds: [embed],
      });

      logger.info('Added repo watch via command', {
        repo,
        channelId,
        guildId,
        events,
        userId: interaction.user.id,
      });
    } catch (error) {
      logger.error('Error in watch-repo command:', error);
      await interaction.reply({
        content: '❌ An error occurred while setting up the repo watch. Please try again.',
        ephemeral: true,
      });
    }
  },
};
