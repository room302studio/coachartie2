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
  supportedActions: [
    'get_releases',
    'get_recent_commits',
    'get_deployment_stats',
    'search_repositories',
    'list_issues',
  ],
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
        throw new Error(
          `Unknown github action: ${action}. Available actions: get_releases, get_recent_commits, get_deployment_stats, search_repositories, list_issues`
        );
    }
  },
};

const githubActions = {
  get_releases: async (params: { repo?: string; query?: string; limit?: number }) => {
    try {
      // Support both 'repo' and 'query' parameters for flexibility
      const repoName = params.repo || params.query;

      logger.info(`📦 Fetching releases for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="get_releases" repo="owner/repository" />'
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const response = await fetch(`https://api.github.com/repos/${repoName}/releases`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CoachArtie-Bot/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const releases = (await response.json()) as GitHubRelease[];
      const limitedReleases = releases.slice(0, params.limit || 10);

      return {
        success: true,
        data: {
          repository: repoName,
          releases: limitedReleases.map((release: GitHubRelease) => ({
            tag_name: release.tag_name,
            name: release.name,
            published_at: release.published_at,
            author: release.author.login,
            html_url: release.html_url,
            prerelease: release.prerelease,
            draft: release.draft,
          })),
          total_count: releases.length,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch GitHub releases:', error);
      throw error;
    }
  },

  get_recent_commits: async (params: { repo?: string; query?: string; limit?: number }) => {
    try {
      // Support both 'repo' and 'query' parameters for flexibility
      const repoName = params.repo || params.query;

      logger.info(`📝 Fetching recent commits for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="get_recent_commits" repo="owner/repository" />'
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured');
      }

      const response = await fetch(
        `https://api.github.com/repos/${repoName}/commits?sha=main&per_page=${params.limit || 10}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const commits = (await response.json()) as GitHubCommit[];

      return {
        success: true,
        data: {
          repository: repoName,
          commits: commits.map((commit: GitHubCommit) => ({
            sha: commit.sha.substring(0, 7),
            message: commit.commit.message,
            author: commit.commit.author.name,
            date: commit.commit.author.date,
            html_url: commit.html_url,
          })),
          total_count: commits.length,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch GitHub commits:', error);
      throw error;
    }
  },

  get_deployment_stats: async (params: { repo?: string; query?: string; days?: number }) => {
    try {
      // Support both 'repo' and 'query' parameters for flexibility
      const repoName = params.repo || params.query;

      logger.info(`📊 Fetching deployment stats for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="get_deployment_stats" repo="owner/repository" />'
        );
      }

      const days = params.days || 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      // Get commits in the time period
      const commitsResponse = await fetch(
        `https://api.github.com/repos/${repoName}/commits?sha=main&since=${since}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      // Get releases in the time period
      const releasesResponse = await fetch(`https://api.github.com/repos/${repoName}/releases`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CoachArtie-Bot/1.0',
        },
      });

      if (!commitsResponse.ok || !releasesResponse.ok) {
        throw new Error('GitHub API error fetching stats');
      }

      const commits = (await commitsResponse.json()) as GitHubCommit[];
      const releases = (await releasesResponse.json()) as GitHubRelease[];

      // Filter releases by date
      const recentReleases = releases.filter(
        (release: GitHubRelease) => new Date(release.published_at) >= new Date(since)
      );

      // Get unique contributors
      const contributors = new Set(
        commits.map((commit: GitHubCommit) => commit.commit.author.name)
      );

      return {
        success: true,
        data: {
          repository: repoName,
          period_days: days,
          stats: {
            total_commits: commits.length,
            total_releases: recentReleases.length,
            unique_contributors: contributors.size,
            contributors: Array.from(contributors),
            latest_release: recentReleases[0]
              ? {
                  tag_name: recentReleases[0].tag_name,
                  published_at: recentReleases[0].published_at,
                  author: recentReleases[0].author.login,
                }
              : null,
          },
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch GitHub deployment stats:', error);
      throw error;
    }
  },

  search_repositories: async (params: { query: string; limit?: number }) => {
    try {
      logger.info(`🔍 Searching GitHub repositories for: ${params.query}`);

      if (!params.query) {
        throw new Error(
          'Missing required parameter "query". Example: <capability name="github" action="search_repositories" query="subway builder" />'
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const limit = params.limit || 10;
      const response = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(params.query)}&per_page=${limit}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as any;

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
            open_issues_count: repo.open_issues_count,
          })),
        },
      };
    } catch (error) {
      logger.error('❌ Failed to search GitHub repositories:', error);
      throw error;
    }
  },

  list_issues: async (params: { repo?: string; query?: string; state?: string; limit?: number }) => {
    try {
      // Support both 'repo' and 'query' parameters for flexibility
      const repoName = params.repo || params.query;

      logger.info(`📋 Fetching issues for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="list_issues" repo="owner/repository" state="open" />\n\nThe repo must be in "owner/repository" format. Use search_repositories first if you don\'t know the full path.'
        );
      }

      // Validate repo format
      if (!repoName.includes('/')) {
        throw new Error(
          `Invalid repo format: "${repoName}". The repo parameter must be in "owner/repository" format (e.g., "owner/SubwayBuilder").\n\nTip: Use search_repositories to find the correct repository path.\nExample: <capability name="github" action="search_repositories" query="subway builder" />`
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const state = params.state || 'open';
      const limit = params.limit || 30;

      const response = await fetch(
        `https://api.github.com/repos/${repoName}/issues?state=${state}&per_page=${limit}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(
            `Repository "${repoName}" not found. Make sure the repository path is correct and you have access to it.\n\nTip: Use search_repositories to find the correct repository path.\nExample: <capability name="github" action="search_repositories" query="subway builder" />`
          );
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const issues = (await response.json()) as any;

      return {
        success: true,
        data: {
          repository: repoName,
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
            user: issue.user.login,
          })),
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch GitHub issues:', error);
      throw error;
    }
  },
};
