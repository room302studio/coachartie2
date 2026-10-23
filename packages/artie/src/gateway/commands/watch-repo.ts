import {
  MessageFlags,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import {
  REPO_PATTERN,
  WATCH_EVENTS,
  parseWatchEvents,
  suggestRepos,
  upsertWatch,
} from '../services/github-watches.js';

const EVENT_HELP: Record<string, string> = {
  all: 'everything below',
  pr: 'new / ready / merged PRs',
  review: 'reviews, approvals, review requests',
  issues: 'issues opened, closed, assigned',
  push: 'direct pushes to the default branch',
  ci: 'CI failures',
};

export const watchRepoCommand = {
  data: new SlashCommandBuilder()
    .setName('watch-repo')
    .setDescription('Watch a GitHub repo in this channel, or change what an existing watch posts')
    .addStringOption((option) =>
      option
        .setName('repo')
        .setDescription('owner/repo, e.g. room302studio/coachartie2')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName('events')
        .setDescription(`Comma-separated: ${WATCH_EVENTS.join(', ')} (default: all)`)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.guildId) return interaction.respond([]);
    const typed = String(interaction.options.getFocused() ?? '');
    await interaction.respond(suggestRepos(interaction.guildId, typed).map((r) => ({ name: r, value: r })));
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const repo = interaction.options.getString('repo', true).trim();
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;

    if (!guildId) {
      return interaction.reply({
        content: '❌ This command only works in a server.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!REPO_PATTERN.test(repo)) {
      return interaction.reply({
        content: '❌ Use `owner/repo` format, e.g. `room302studio/coachartie2`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const { events, invalid } = parseWatchEvents(interaction.options.getString('events'));
    if (invalid.length > 0) {
      return interaction.reply({
        content: `❌ Unknown events: ${invalid.join(', ')}. Valid: ${WATCH_EVENTS.join(', ')}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      const { outcome, previousChannelId } = upsertWatch(
        repo,
        guildId,
        channelId,
        events,
        interaction.user.id
      );
      const title = {
        created: '👀 Now watching',
        updated: '⚙️ Watch updated',
        resumed: '▶️ Watch resumed',
      }[outcome];
      const embed = new EmbedBuilder()
        .setColor(0x238636)
        .setTitle(`${title} ${repo}`)
        .addFields(
          { name: '📺 Channel', value: `<#${channelId}>`, inline: true },
          {
            name: '📋 Posts',
            value: events.map((e) => `\`${e}\` ${EVENT_HELP[e]}`).join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: 'Run again to change it · /unwatch-repo pauses · /list-watches' });
      if (previousChannelId) {
        embed.setDescription(`Moved here from <#${previousChannelId}>.`);
      }
      await interaction.reply({ embeds: [embed] });
      logger.info(`GitHub watch ${outcome} via /watch-repo`, {
        repo,
        guildId,
        channelId,
        events,
        userId: interaction.user.id,
      });
    } catch (error) {
      logger.error('Error in watch-repo command:', error);
      await interaction.reply({
        content: '❌ Could not save the watch (nothing changed). Check the logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
