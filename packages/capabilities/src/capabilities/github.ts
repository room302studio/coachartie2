import { logger } from '@coachartie/shared';

import { RegisteredCapability } from '../services/capability-registry.js';

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
  supportedActions: ['get_releases', 'get_recent_commits', 'get_deployment_stats', 'search_repositories', 'list_issues'],
  description: 'GitHub integration for repository monitoring, issue tracking, and celebration',
  requiredParams: ['action'],

  handler: async (params: any, _content: string | undefined) => {
    const action = params.action;

    switch (action) {
      case 'get_releases':
        return JSON.stringify(await githubActions.get_releases(params));
      case 'get_recent_commits':
        return JSON.stringify(await githubActions.get_recent_commits(params));
      case 'get_deployment_stats':
        return JSON.stringify(await githubActions.get_deployment_stats(params));
      case 'search_repositories':
        return JSON.stringify(await githubActions.search_repositories(params));
      case 'list_issues':
        return JSON.stringify(await githubActions.list_issues(params));
      default:
        throw new Error(`Unknown github action: ${action}. Available actions: get_releases, get_recent_commits, get_deployment_stats, search_repositories, list_issues`);
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
    },

    search_repositories: async (params: { query: string; limit?: number }) => {
      try {
        logger.info(`🔍 Searching GitHub repositories for: ${params.query}`);

        if (!params.query) {
          return {
            success: false,
            error: 'Missing required parameter "query". Usage: <capability name="github" action="search_repositories" query="subway builder" />'
          };
        }

        if (!process.env.GITHUB_TOKEN) {
          throw new Error('GITHUB_TOKEN not configured');
        }

        const limit = params.limit || 10;
        const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(params.query)}&per_page=${limit}`, {
          headers: {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0'
          }
        });

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as any;

        return {
          success: true,
          data: {
            total_count: data.total_count,
            repositories: data.items.map((repo: any) => ({
              full_name: repo.full_name,
              description: repo.description,
              stars: repo.stargazers_count,
              language: repo.language,
              html_url: repo.html_url,
              open_issues_count: repo.open_issues_count
            }))
          }
        };
      } catch (error) {
        logger.error('❌ Failed to search GitHub repositories:', error);
        return {
          success: false,
          error: `Failed to search repositories: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    },

    list_issues: async (params: { repo: string; state?: string; limit?: number }) => {
      try {
        logger.info(`📋 Fetching issues for ${params.repo}`);

        if (!params.repo) {
          return {
            success: false,
            error: 'Missing required parameter "repo". Usage: <capability name="github" action="list_issues" repo="owner/repository" state="open" />\n\nThe repo must be in "owner/repository" format. If you don\'t know the full path, use search_repositories first.'
          };
        }

        // Validate repo format
        if (!params.repo.includes('/')) {
          return {
            success: false,
            error: `Invalid repo format: "${params.repo}". The repo parameter must be in "owner/repository" format (e.g., "colindm/SubwayBuilderIssues").\n\nTip: Use search_repositories to find the full repository path first.\nExample: <capability name="github" action="search_repositories" query="subway builder" />`
          };
        }

        if (!process.env.GITHUB_TOKEN) {
          throw new Error('GITHUB_TOKEN not configured');
        }

        const state = params.state || 'open';
        const limit = params.limit || 30;

        const response = await fetch(`https://api.github.com/repos/${params.repo}/issues?state=${state}&per_page=${limit}`, {
          headers: {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0'
          }
        });

        if (!response.ok) {
          if (response.status === 404) {
            return {
              success: false,
              error: `Repository "${params.repo}" not found. Make sure the repository path is correct and you have access to it.\n\nTip: Use search_repositories to find the correct repository path.\nExample: <capability name="github" action="search_repositories" query="subway builder" />`
            };
          }
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const issues = await response.json() as any;

        return {
          success: true,
          data: {
            repository: params.repo,
            state: state,
            total_count: issues.length,
            issues: issues.map((issue: any) => ({
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels.map((l: any) => l.name),
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              comments: issue.comments,
              html_url: issue.html_url,
              user: issue.user.login
            }))
          }
        };
      } catch (error) {
        logger.error('❌ Failed to fetch GitHub issues:', error);
        return {
          success: false,
          error: `Failed to fetch issues: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
      }
    }
};
