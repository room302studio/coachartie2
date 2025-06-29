import { logger } from '@coachartie/shared';
import { publishMessage } from '../queues/publisher.js';
import { RegisteredCapability } from '../services/capability-registry.js';

export const deploymentCheerleaderCapability: RegisteredCapability = {
  name: 'deployment_cheerleader',
  supportedActions: ['monitor_releases', 'celebrate_deployment', 'check_repo_activity'],
  description: 'Monitors deployments and celebrates team achievements automatically',
  requiredParams: ['repo'],
  
  handler: async (params: any, content: string | undefined) => {
    const action = params.action;
    
    switch (action) {
      case 'monitor_releases':
        return await monitorReleases(params);
      case 'celebrate_deployment':
        return await celebrateDeployment(params);
      case 'check_repo_activity':
        return await checkRepoActivity(params);
      default:
        throw new Error(`Unknown deployment cheerleader action: ${action}`);
    }
  }
};

async function monitorReleases(params: { repo: string; hours?: number }) {
  try {
    logger.info(`🔍 Monitoring releases for ${params.repo} (last ${params.hours || 24} hours)`);
    
    // For now, return a placeholder until GitHub MCP is installed
    return {
      success: true,
      data: {
        repository: params.repo,
        period_hours: params.hours || 24,
        releases_found: 0,
        message: `GitHub monitoring not yet configured. Use MCP installer to set up GitHub integration first.`
      }
    };
  } catch (error) {
    logger.error('❌ Failed to monitor releases:', error);
    return {
      success: false,
      error: `Failed to monitor releases: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

async function celebrateDeployment(params: { 
  repo: string; 
  version: string; 
  author: string; 
  description?: string;
  type?: string;
}) {
  try {
    logger.info(`🎉 Generating celebration for ${params.repo} ${params.version}`);
    
    const celebration = await generateReleaseCelebration(params);
    
    // Send celebration to Discord
    await publishMessage('OUTGOING_DISCORD', {
      message: celebration.message,
      userId: 'deployment-cheerleader',
      source: 'manual-celebration',
      metadata: {
        event: 'manual_celebration',
        repository: params.repo,
        version: params.version,
        author: params.author
      }
    });

    return {
      success: true,
      data: {
        celebration,
        message: `🎉 Celebration sent for ${params.repo} ${params.version}!`
      }
    };

  } catch (error) {
    logger.error('❌ Failed to generate celebration:', error);
    return {
      success: false,
      error: `Failed to generate celebration: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

async function checkRepoActivity(params: { repo: string; days?: number }) {
  try {
    logger.info(`📊 Checking activity for ${params.repo} (last ${params.days || 7} days)`);
    
    // For now, return a placeholder until GitHub integration is set up
    return {
      success: true,
      data: {
        repository: params.repo,
        period_days: params.days || 7,
        stats: {
          total_commits: 0,
          total_releases: 0,
          unique_contributors: 0,
          contributors: [],
          latest_release: null
        },
        summary: `Activity monitoring not yet configured for ${params.repo}. Set up GitHub integration first.`,
        celebration_worthy: false
      }
    };

  } catch (error) {
    logger.error('❌ Failed to check repository activity:', error);
    return {
      success: false,
      error: `Failed to check repository activity: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
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
    'release': ['🚀', '🎉', '✨', '🎯', '🏆'],
    'prerelease': ['🧪', '⚡', '🔬', '🚧'],
    'hotfix': ['🚑', '🛠️', '⚡', '🎯'],
    'feature': ['✨', '🎉', '🚀', '💫'],
    'patch': ['🔧', '✅', '🛠️', '📦']
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
    "Great work team! 🙌",
    "Another milestone achieved! 💪",
    "Keep up the amazing work! ⭐",
    "Shipping code like champions! 🏆",
    "Progress never stops! 🔥"
  ];
  
  message += `\n${encouragements[Math.floor(Math.random() * encouragements.length)]}`;
  
  return {
    message,
    type: releaseType
  };
}