import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { RegisteredCapability } from '../services/capability-registry.js';

interface GitHubRelease {
  tag_name: string;
  author: string;
  body: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
}

interface GitHubMCPResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface GitHubReleasesData {
  releases: GitHubRelease[];
}

interface DeploymentStats {
  total_commits: number;
  total_releases: number;
  unique_contributors: number;
  contributors: string[];
  latest_release?: {
    tag_name: string;
    author: string;
  };
}

interface GitHubStatsData {
  stats: DeploymentStats;
}

interface DeploymentCheerleaderParams {
  action?: string;
  repo?: string;
  version?: string;
  author?: string;
  description?: string;
  type?: string;
  hours?: number;
  days?: number;
}

interface DeploymentCheerleaderCapability {
  name: 'deployment_cheerleader';
  description: 'Monitors deployments and celebrates achievements';
  actions: {
    monitor_releases: {
      description: 'Monitor recent releases for celebration opportunities';
      parameters: {
        repo: string; // Format: "owner/repo"
        hours?: number; // How far back to check (default: 24)
      };
    };
    celebrate_deployment: {
      description: 'Generate celebration message for a deployment';
      parameters: {
        repo: string;
        version: string;
        author: string;
        description?: string;
        type?: 'release' | 'hotfix' | 'feature' | 'patch';
      };
    };
    check_repo_activity: {
      description: 'Check repository for recent activity worth celebrating';
      parameters: {
        repo: string;
        days?: number; // How far back to check (default: 7)
      };
    };
  };
}

export const deploymentCheerleaderCapability: RegisteredCapability = {
  name: 'deployment_cheerleader',
  supportedActions: ['monitor_releases', 'celebrate_deployment', 'check_repo_activity'],
  description: 'Monitors deployments and celebrates team achievements automatically',
  requiredParams: ['action'],

  handler: async (params: any, _content: string | undefined) => {
    const action = params.action;

    switch (action) {
      case 'monitor_releases':
        return JSON.stringify(await cheerleaderActions.monitor_releases(params));
      case 'celebrate_deployment':
        return JSON.stringify(await cheerleaderActions.celebrate_deployment(params));
      case 'check_repo_activity':
        return JSON.stringify(await cheerleaderActions.check_repo_activity(params));
      default:
        throw new Error(`Unknown deployment_cheerleader action: ${action}`);
    }
  },
};

const cheerleaderActions = {
  monitor_releases: async (params: { repo: string; hours?: number }) => {
    try {
      logger.info(`🔍 Monitoring releases for ${params.repo} (last ${params.hours || 24} hours)`);

      // Use the GitHub MCP capability through the registry
      const githubResult = await executeGitHubMCPAction('get_releases', {
        repo: params.repo,
        limit: 10,
      });

      if (!githubResult.success) {
        throw new Error(`GitHub MCP failed: ${githubResult.error}`);
      }

      const releases = (githubResult.data as GitHubReleasesData).releases;
      const hoursAgo = new Date(Date.now() - (params.hours || 24) * 60 * 60 * 1000);

      // Filter to recent releases
      const recentReleases = releases.filter(
        (release: GitHubRelease) => new Date(release.published_at) > hoursAgo && !release.draft
      );

      if (recentReleases.length === 0) {
        return {
          success: true,
          data: {
            repository: params.repo,
            period_hours: params.hours || 24,
            releases_found: 0,
            message: `No new releases found in the last ${params.hours || 24} hours`,
          },
        };
      }

      // Generate celebrations for each release
      const celebrations = [];
      for (const release of recentReleases) {
        const celebration = await generateReleaseCelebration({
          repo: params.repo,
          version: release.tag_name,
          author: release.author,
          description: release.body,
          type: release.prerelease ? 'prerelease' : 'release',
          url: release.html_url,
          published_at: release.published_at,
        });

        celebrations.push(celebration);

        // Send celebration to Discord
        await publishMessage(
          'deployment-cheerleader',
          celebration.message,
          'general', // default channel
          'Deployment Bot',
          true
        );
      }

      return {
        success: true,
        data: {
          repository: params.repo,
          period_hours: params.hours || 24,
          releases_found: recentReleases.length,
          celebrations,
          message: `🎉 Found ${recentReleases.length} release${recentReleases.length > 1 ? 's' : ''} to celebrate!`,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to monitor releases:', error);
      return {
        success: false,
        error: `Failed to monitor releases: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },

  celebrate_deployment: async (params: {
    repo: string;
    version: string;
    author: string;
    description?: string;
    type?: string;
  }) => {
    try {
      logger.info(`🎉 Generating celebration for ${params.repo} ${params.version}`);

      const celebration = await generateReleaseCelebration(params);

      // Send celebration to Discord
      await publishMessage(
        'deployment-cheerleader',
        celebration.message,
        'general', // default channel
        'Deployment Bot',
        true
      );

      return {
        success: true,
        data: {
          celebration,
          message: `🎉 Celebration sent for ${params.repo} ${params.version}!`,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to generate celebration:', error);
      return {
        success: false,
        error: `Failed to generate celebration: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },

  check_repo_activity: async (params: { repo: string; days?: number }) => {
    try {
      logger.info(`📊 Checking activity for ${params.repo} (last ${params.days || 7} days)`);

      // Get repository stats from GitHub MCP
      const statsResult = await executeGitHubMCPAction('get_deployment_stats', {
        repo: params.repo,
        days: params.days || 7,
      });

      if (!statsResult.success) {
        throw new Error(`GitHub MCP failed: ${statsResult.error}`);
      }

      const stats = (statsResult.data as GitHubStatsData).stats;
      const activitySummary = generateActivitySummary(params.repo, stats, params.days || 7);

      return {
        success: true,
        data: {
          repository: params.repo,
          period_days: params.days || 7,
          stats,
          summary: activitySummary,
          celebration_worthy: stats.total_releases > 0 || stats.total_commits > 10,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to check repository activity:', error);
      return {
        success: false,
        error: `Failed to check repository activity: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

// Helper function to call GitHub MCP actions (will be replaced with actual MCP client calls)
async function executeGitHubMCPAction(
  action: string,
  params: Record<string, unknown>
): Promise<GitHubMCPResult<GitHubReleasesData | GitHubStatsData>> {
  // This is a placeholder - in real implementation, this would call the GitHub MCP server
  // For now, we'll simulate the response structure
  logger.info(`🔗 Calling GitHub MCP: ${action}`, params);

  // Example: return await mcpClient.call('github', action, params);

  return {
    success: false,
    error:
      'GitHub MCP server not yet configured - use <capability name="mcp_installer" action="install_from_template">github</capability> to install',
  };
}

async function generateReleaseCelebration(params: {
  repo: string;
  version: string;
  author: string;
  description?: string;
  type?: string;
  url?: string;
  published_at?: string;
}): Promise<{ message: string; type: string }> {
  const { repo, version, author, description, type = 'release', url } = params;

  const emojis = {
    release: ['🚀', '🎉', '✨', '🎯', '🏆'],
    prerelease: ['🧪', '⚡', '🔬', '🚧'],
    hotfix: ['🚑', '🛠️', '⚡', '🎯'],
    feature: ['✨', '🎉', '🚀', '💫'],
    patch: ['🔧', '✅', '🛠️', '📦'],
  };

  const selectedEmojis = emojis[type as keyof typeof emojis] || emojis.release;
  const emoji = selectedEmojis[Math.floor(Math.random() * selectedEmojis.length)];

  const repoName = repo.split('/')[1] || repo;
  const isPrerelease = type === 'prerelease';
  const releaseType = isPrerelease ? 'pre-release' : type;

  let message = `${emoji} **New ${releaseType}**: ${repoName} ${version} is live!\n\n`;
  message += `👤 Released by **${author}**\n`;

  if (url) {
    message += `🔗 [View release](${url})\n`;
  }

  if (description && description.length < 300) {
    message += `\n📝 **What's new:**\n${description.substring(0, 300)}${description.length > 300 ? '...' : ''}\n`;
  }

  // Add encouraging footer
  const encouragements = [
    'Great work team! 🙌',
    'Another milestone achieved! 💪',
    'Keep up the amazing work! ⭐',
    'Shipping code like champions! 🏆',
    'Progress never stops! 🔥',
  ];

  message += `\n${encouragements[Math.floor(Math.random() * encouragements.length)]}`;

  return {
    message,
    type: releaseType,
  };
}

function generateActivitySummary(repo: string, stats: DeploymentStats, days: number): string {
  const { total_commits, total_releases, unique_contributors, contributors } = stats;

  let summary = `📊 **${repo}** activity summary (last ${days} days):\n\n`;
  summary += `• ${total_commits} commits from ${unique_contributors} contributor${unique_contributors > 1 ? 's' : ''}\n`;
  summary += `• ${total_releases} release${total_releases > 1 ? 's' : ''} published\n`;

  if (contributors.length > 0) {
    summary += `• Active contributors: ${contributors.slice(0, 5).join(', ')}${contributors.length > 5 ? '...' : ''}\n`;
  }

  if (stats.latest_release) {
    summary += `• Latest release: ${stats.latest_release.tag_name} by ${stats.latest_release.author}\n`;
  }

  return summary;
}
