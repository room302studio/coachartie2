import { logger } from '@coachartie/shared';

import { RegisteredCapability } from '../services/capability-registry.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface GitHubParams {
  action?: string;
  repo?: string;
  limit?: number;
  days?: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  author: {
    login: string;
  };
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  html_url: string;
}

export const githubCapability: RegisteredCapability = {
  name: 'github',
  supportedActions: ['get_releases', 'get_recent_commits', 'get_deployment_stats'],
  description: 'GitHub integration for repository monitoring and celebration',
  requiredParams: ['action'],
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async (params: any, _content: string | undefined) => {
    const action = params.action;
    
    switch (action) {
      case 'get_releases':
        return JSON.stringify(await githubActions.get_releases(params));
      case 'get_recent_commits':
        return JSON.stringify(await githubActions.get_recent_commits(params));
      case 'get_deployment_stats':
        return JSON.stringify(await githubActions.get_deployment_stats(params));
      default:
        throw new Error(`Unknown github action: ${action}`);
    }
  }
};

const githubActions = {
    get_releases: async (params: { repo: string; limit?: number }) => {
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

        const releases = await response.json() as GitHubRelease[];
        const limitedReleases = releases.slice(0, params.limit || 10);

        return {
          success: true,
          data: {
            repository: params.repo,
            releases: limitedReleases.map((release: GitHubRelease) => ({
              tag_name: release.tag_name,
              name: release.name,
              published_at: release.published_at,
              author: release.author.login,
              html_url: release.html_url,
              prerelease: release.prerelease,
              draft: release.draft
            })),
            total_count: releases.length
          }
        };
      } catch (error) {
        logger.error('❌ Failed to fetch GitHub releases:', error);
        return {
          success: false,
          error: `Failed to fetch releases: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    },

    get_recent_commits: async (params: { repo: string; limit?: number }) => {
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

        const commits = await response.json() as GitHubCommit[];

        return {
          success: true,
          data: {
            repository: params.repo,
            commits: commits.map((commit: GitHubCommit) => ({
              sha: commit.sha.substring(0, 7),
              message: commit.commit.message,
              author: commit.commit.author.name,
              date: commit.commit.author.date,
              html_url: commit.html_url
            })),
            total_count: commits.length
          }
        };
      } catch (error) {
        logger.error('❌ Failed to fetch GitHub commits:', error);
        return {
          success: false,
          error: `Failed to fetch commits: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    },

    get_deployment_stats: async (params: { repo: string; days?: number }) => {
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

        const commits = await commitsResponse.json() as GitHubCommit[];
        const releases = await releasesResponse.json() as GitHubRelease[];

        // Filter releases by date
        const recentReleases = releases.filter((release: GitHubRelease) => 
          new Date(release.published_at) >= new Date(since)
        );

        // Get unique contributors
        const contributors = new Set(commits.map((commit: GitHubCommit) => commit.commit.author.name));

        return {
          success: true,
          data: {
            repository: params.repo,
            period_days: days,
            stats: {
              total_commits: commits.length,
              total_releases: recentReleases.length,
              unique_contributors: contributors.size,
              contributors: Array.from(contributors),
              latest_release: recentReleases[0] ? {
                tag_name: recentReleases[0].tag_name,
                published_at: recentReleases[0].published_at,
                author: recentReleases[0].author.login
              } : null
            }
          }
        };
      } catch (error) {
        logger.error('❌ Failed to fetch GitHub deployment stats:', error);
        return {
          success: false,
          error: `Failed to fetch deployment stats: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    }
};
