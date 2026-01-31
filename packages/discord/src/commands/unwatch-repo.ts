import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { getGitHubPoller } from '../services/github-poller.js';

export const unwatchRepoCommand = {
  data: new SlashCommandBuilder()
    .setName('unwatch-repo')
    .setDescription('Stop watching a GitHub repo in this channel')
    .addStringOption((option) =>
      option
        .setName('repo')
        .setDescription('GitHub repo to stop watching (owner/repo format)')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      const repo = interaction.options.getString('repo', true);
      const channelId = interaction.channelId;

      // Validate repo format
      const repoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
      if (!repoRegex.test(repo)) {
        return await interaction.reply({
          content: '❌ Invalid repo format. Please use `owner/repo` format.',
          ephemeral: true,
        });
      }

      // Remove the watch
      try {
        const poller = getGitHubPoller();
        await poller.removeWatch(repo, channelId);
      } catch (error) {
        logger.warn('GitHub poller not initialized, watch removed from database only');
      }

      const embed = new EmbedBuilder()
        .setColor(0xda3633)
        .setTitle('🔕 Stopped Watching Repository')
        .setDescription(`This channel will no longer receive notifications for **${repo}**`)
        .addFields(
          { name: '📦 Repository', value: `\`${repo}\``, inline: true },
          { name: '📺 Channel', value: `<#${channelId}>`, inline: true }
        )
        .setFooter({ text: 'Use /watch-repo to start watching again' });

      await interaction.reply({
        embeds: [embed],
      });

      logger.info('Removed repo watch via command', {
        repo,
        channelId,
        userId: interaction.user.id,
      });
    } catch (error) {
      logger.error('Error in unwatch-repo command:', error);
      await interaction.reply({
        content: '❌ An error occurred while removing the repo watch. Please try again.',
        ephemeral: true,
      });
    }
  },
};
