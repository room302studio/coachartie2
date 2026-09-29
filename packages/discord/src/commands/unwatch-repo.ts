import {
  MessageFlags,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '@coachartie/shared';
import { REPO_PATTERN, pauseWatch, suggestRepos } from '../services/github-watches.js';

export const unwatchRepoCommand = {
  data: new SlashCommandBuilder()
    .setName('unwatch-repo')
    .setDescription('Pause a GitHub repo watch in this server (resume with /watch-repo)')
    .addStringOption((option) =>
      option
        .setName('repo')
        .setDescription('owner/repo to pause')
        .setRequired(true)
        .setAutocomplete(true)
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
    if (!guildId) {
      return interaction.reply({
        content: '❌ This command only works in a server.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!REPO_PATTERN.test(repo)) {
      return interaction.reply({
        content: '❌ Use `owner/repo` format.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      const { paused, found } = pauseWatch(repo, guildId);
      if (found === 0) {
        return interaction.reply({
          content: `ℹ️ \`${repo}\` isn't watched in this server. \`/list-watches\` shows what is.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (paused === 0) {
        return interaction.reply({
          content: `ℹ️ \`${repo}\` is already paused. \`/watch-repo\` resumes it.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const embed = new EmbedBuilder()
        .setColor(0xda3633)
        .setTitle(`⏸️ Paused ${repo}`)
        .setDescription(
          'No more posts for this repo in this server. It stays paused: the org auto-watcher ' +
            "won't re-add it."
        )
        .setFooter({ text: '/watch-repo resumes it' });
      await interaction.reply({ embeds: [embed] });
      logger.info('GitHub watch paused via /unwatch-repo', {
        repo,
        guildId,
        userId: interaction.user.id,
      });
    } catch (error) {
      logger.error('Error in unwatch-repo command:', error);
      await interaction.reply({
        content: '❌ Could not pause the watch (nothing changed). Check the logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
