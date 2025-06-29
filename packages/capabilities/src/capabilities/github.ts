import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

export const githubCapability: RegisteredCapability = {
  name: 'github',
  supportedActions: ['get_releases', 'get_recent_commits', 'get_deployment_stats'],
  description: 'GitHub integration for repository monitoring and celebration',
  requiredParams: ['repo'],
  
  handler: async (params: any, content: string | undefined) => {
    const action = params.action;
    
    switch (action) {
      case 'get_releases':
        return await getReleases(params);
      case 'get_recent_commits':
        return await getRecentCommits(params);
      case 'get_deployment_stats':
        return await getDeploymentStats(params);
      default:
        throw new Error(`Unknown GitHub action: ${action}`);
    }
  }
};

async function getReleases(params: { repo: string; limit?: number }) {
  try {
    logger.info(`📦 Fetching releases for ${params.repo}`);
    
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    const response = await fetch(`https://api.github.com/repos/${params.repo}/releases`, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CoachArtie-Bot/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const releases = await response.json();
    const limitedReleases = releases.slice(0, params.limit || 10);

    const releaseList = limitedReleases.map((release: any) => 
      `• ${release.tag_name} by ${release.author.login} (${new Date(release.published_at).toLocaleDateString()})`
    ).join('\n');
    
    return `Found ${releases.length} releases for ${params.repo}:\n${releaseList}`;
  } catch (error) {
    logger.error('❌ Failed to fetch GitHub releases:', error);
    return `Failed to fetch releases: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

async function getRecentCommits(params: { repo: string; limit?: number }) {
  try {
    logger.info(`📝 Fetching recent commits for ${params.repo}`);
    
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    const response = await fetch(`https://api.github.com/repos/${params.repo}/commits?sha=main&per_page=${params.limit || 10}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CoachArtie-Bot/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const commits = await response.json();

    const commitList = commits.map((commit: any) => 
      `• ${commit.sha.substring(0, 7)} by ${commit.commit.author.name}: ${commit.commit.message.split('\n')[0]}`
    ).join('\n');
    
    return `Found ${commits.length} recent commits for ${params.repo}:\n${commitList}`;
  } catch (error) {
    logger.error('❌ Failed to fetch GitHub commits:', error);
    return `Failed to fetch commits: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

async function getDeploymentStats(params: { repo: string; days?: number }) {
  try {
    logger.info(`📊 Fetching deployment stats for ${params.repo}`);
    
    const days = params.days || 30;
    const since = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
    
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    // Get commits in the time period
    const commitsResponse = await fetch(`https://api.github.com/repos/${params.repo}/commits?sha=main&since=${since}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CoachArtie-Bot/1.0'
      }
    });

    // Get releases in the time period
    const releasesResponse = await fetch(`https://api.github.com/repos/${params.repo}/releases`, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CoachArtie-Bot/1.0'
      }
    });

    if (!commitsResponse.ok || !releasesResponse.ok) {
      throw new Error('GitHub API error fetching stats');
    }

    const commits = await commitsResponse.json();
    const releases = await releasesResponse.json();

    // Filter releases by date
    const recentReleases = releases.filter((release: any) => 
      new Date(release.published_at) >= new Date(since)
    );

    // Get unique contributors
    const contributors = new Set(commits.map((commit: any) => commit.commit.author.name));

    const latestRelease = recentReleases[0] ? `Latest: ${recentReleases[0].tag_name} by ${recentReleases[0].author.login}` : 'No recent releases';
    
    return `📊 ${params.repo} stats (last ${days} days):\n• ${commits.length} commits\n• ${recentReleases.length} releases\n• ${contributors.size} contributors\n• ${latestRelease}`;
  } catch (error) {
    logger.error('❌ Failed to fetch GitHub deployment stats:', error);
    return `Failed to fetch deployment stats: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}