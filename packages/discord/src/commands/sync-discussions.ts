/**
 * /sync-discussions - Sync Discord forum discussions to GitHub issues
 *
 * Conversational flow:
 * 1. User runs /sync-discussions
 * 2. Bot asks which repo
 * 3. User provides repo (owner/repo format or URL)
 * 4. Bot confirms and syncs all discussions
 * 5. Bot reports results
 */

import { SlashCommandBuilder, ChatInputCommandInteraction, ChannelType } from 'discord.js';
import { logger } from '@coachartie/shared';
import { getForumTraversal } from '../services/forum-traversal.js';
import { getGitHubIntegration } from '../services/github-integration.js';
import { getConversationState } from '../services/conversation-state.js';

export const data = new SlashCommandBuilder()
  .setName('sync-discussions')
  .setDescription('Sync Discord forum discussions to GitHub issues')
  .addStringOption(option =>
    option
      .setName('repo')
      .setDescription('GitHub repository (owner/repo or URL)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('forum')
      .setDescription('Specific forum channel to sync (leave empty for current channel)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const repo = interaction.options.getString('repo');
  const forumOption = interaction.options.getString('forum');

  try {
    // Check if GitHub integration is available
    let githubService;
    try {
      githubService = getGitHubIntegration();
    } catch (error) {
      await interaction.reply({
        content: '❌ GitHub integration is not configured. Please set GITHUB_TOKEN environment variable.',
        ephemeral: true
      });
      return;
    }

    // Determine which forum to sync
    let forumId: string;
    let forumName: string;

    if (forumOption) {
      // Use specified forum
      forumId = forumOption;
      const forum = await interaction.client.channels.fetch(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) {
        await interaction.reply({
          content: '❌ Invalid forum channel specified.',
          ephemeral: true
        });
        return;
      }
      forumName = forum.name;
    } else {
      // Use current channel if it's a forum or forum thread
      // Need to fetch the channel to get full details
      const channel = await interaction.client.channels.fetch(interaction.channelId);

      if (channel?.type === ChannelType.GuildForum) {
        forumId = interaction.channelId;
        forumName = channel.name;
      } else if (
        channel?.type === ChannelType.PublicThread ||
        channel?.type === ChannelType.PrivateThread
      ) {
        // Get parent forum
        if (!('parent' in channel) || !channel.parent || channel.parent.type !== ChannelType.GuildForum) {
          await interaction.reply({
            content: '❌ This thread is not in a forum channel. Please run this command in a forum or specify a forum.',
            ephemeral: true
          });
          return;
        }
        forumId = channel.parent.id;
        forumName = channel.parent.name;
      } else {
        await interaction.reply({
          content: '❌ Please run this command in a forum channel or specify a forum using the `forum` option.',
          ephemeral: true
        });
        return;
      }
    }

    // Defer reply for long operation
    await interaction.deferReply();

    // If repo not provided, start conversational flow
    if (!repo) {
      const conversationState = getConversationState();
      conversationState.startConversation(userId, 'sync-discussions', {
        forumId,
        forumName,
        step: 'awaiting_repo'
      });

      await interaction.editReply({
        content: `📋 Ready to sync discussions from **${forumName}**\n\nWhich GitHub repository should I create issues in? (Format: \`owner/repo\` or full URL)`
      });
      return;
    }

    // Parse and validate repo
    const repoInfo = githubService.parseRepoReference(repo);
    if (!repoInfo) {
      await interaction.editReply({
        content: `❌ Invalid repository format. Please use \`owner/repo\` format (e.g., \`facebook/react\`) or a full GitHub URL.`
      });
      return;
    }

    // Verify repository access
    await interaction.editReply({
      content: `🔍 Verifying access to **${repoInfo.owner}/${repoInfo.repo}**...`
    });

    const hasAccess = await githubService.verifyRepository(repoInfo.owner, repoInfo.repo);
    if (!hasAccess) {
      await interaction.editReply({
        content: `❌ Cannot access repository **${repoInfo.owner}/${repoInfo.repo}**. Please check:\n- Repository exists\n- GitHub token has access\n- Repository name is correct`
      });
      return;
    }

    // Start sync process
    await interaction.editReply({
      content: `✅ Repository verified!\n\n🔄 Fetching discussions from **${forumName}**...`
    });

    const forumTraversal = getForumTraversal();
    const forumSummary = await forumTraversal.getForumSummary(forumId);

    if (forumSummary.threads.length === 0) {
      await interaction.editReply({
        content: `ℹ️ No discussions found in **${forumName}** to sync.`
      });
      return;
    }

    await interaction.editReply({
      content: `📊 Found **${forumSummary.threads.length}** discussions\n\n🚀 Creating GitHub issues in **${repoInfo.owner}/${repoInfo.repo}**...\n\n_This may take a minute..._`
    });

    // Sync threads to GitHub
    const results = await githubService.syncThreadsToGitHub(
      repoInfo.owner,
      repoInfo.repo,
      forumSummary.threads,
      forumName,
      async (current, total, result) => {
        // Update progress every 5 issues
        if (current % 5 === 0 || current === total) {
          await interaction.editReply({
            content: `🚀 Creating GitHub issues... (${current}/${total})\n\n${result.success ? '✅' : '❌'} ${result.issueUrl || 'Processing...'}`
          }).catch(() => { /* Ignore rate limit errors on edits */ });
        }
      }
    );

    // Report results
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    let resultMessage = `## ✅ Sync Complete!\n\n`;
    resultMessage += `**Forum:** ${forumName}\n`;
    resultMessage += `**Repository:** ${repoInfo.owner}/${repoInfo.repo}\n\n`;
    resultMessage += `**Results:**\n`;
    resultMessage += `✅ ${successCount} issues created successfully\n`;

    if (failureCount > 0) {
      resultMessage += `❌ ${failureCount} failed\n`;
    }

    resultMessage += `\n**Created Issues:**\n`;
    const successfulIssues = results.filter(r => r.success && r.issueUrl);
    successfulIssues.slice(0, 10).forEach(result => {
      resultMessage += `- ${result.issueUrl}\n`;
    });

    if (successfulIssues.length > 10) {
      resultMessage += `_...and ${successfulIssues.length - 10} more_\n`;
    }

    await interaction.editReply({ content: resultMessage });

    logger.info(`Sync completed for user ${userId}: ${successCount}/${results.length} issues created`);

  } catch (error) {
    logger.error(`Failed to execute sync-discussions command:`, error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (interaction.deferred) {
      await interaction.editReply({
        content: `❌ Sync failed: ${errorMessage}`
      });
    } else {
      await interaction.reply({
        content: `❌ Sync failed: ${errorMessage}`,
        ephemeral: true
      });
    }
  }
}
