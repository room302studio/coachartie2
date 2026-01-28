import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { getGitHubPoller } from '../services/github-poller.js';

export const listWatchesCommand = {
  data: new SlashCommandBuilder()
    .setName('list-watches')
    .setDescription('List all GitHub repos being watched in this server or channel')
    .addBooleanOption((option) =>
      option
        .setName('channel-only')
        .setDescription('Only show watches for this channel (default: show all server watches)')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    try {
      const channelOnly = interaction.options.getBoolean('channel-only') || false;
      const channelId = interaction.channelId;
      const guildId = interaction.guildId;

      if (!guildId) {
        return await interaction.reply({
          content: '❌ This command can only be used in a server.',
          ephemeral: true,
        });
      }

      let watches;
      try {
        const poller = getGitHubPoller();
        watches = channelOnly
          ? await poller.listWatches(guildId, channelId)
          : await poller.listWatches(guildId);
      } catch (error) {
        logger.warn('GitHub poller not initialized');
        return await interaction.reply({
          content: '❌ GitHub sync is not currently active.',
          ephemeral: true,
        });
      }

      if (watches.length === 0) {
        return await interaction.reply({
          content: channelOnly
            ? '📭 No repos are being watched in this channel. Use `/watch-repo` to add one!'
            : '📭 No repos are being watched in this server. Use `/watch-repo` to add one!',
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x1f6feb)
        .setTitle(`👀 Watched Repositories${channelOnly ? ' (This Channel)' : ''}`)
        .setDescription(`${watches.length} repo${watches.length === 1 ? '' : 's'} being watched`);

      // Group by channel
      const byChannel = new Map<string, typeof watches>();
      for (const watch of watches) {
        const existing = byChannel.get(watch.channelId) || [];
        existing.push(watch);
        byChannel.set(watch.channelId, existing);
      }

      for (const [chId, channelWatches] of byChannel) {
        const repoList = channelWatches
          .map((w) => {
            const events = w.events ? JSON.parse(w.events) : ['all'];
            const eventStr = events.includes('all') ? '' : ` (${events.join(', ')})`;
            return `• \`${w.repo}\`${eventStr}`;
          })
          .join('\n');

        embed.addFields({
          name: `<#${chId}>`,
          value: repoList || 'No repos',
          inline: false,
        });
      }

      embed.setFooter({ text: 'Use /watch-repo to add or /unwatch-repo to remove' });

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    } catch (error) {
      logger.error('Error in list-watches command:', error);
      await interaction.reply({
        content: '❌ An error occurred while listing watches. Please try again.',
        ephemeral: true,
      });
    }
  },
};
