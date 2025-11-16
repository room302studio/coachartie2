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
    'search_issues',
    'create_issue',
    'update_issue',
    'get_issues_by_label',
    'get_issue_details',
    'get_related_prs',
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
      case 'search_issues':
        return JSON.stringify(await githubActions.search_issues(params));
      case 'create_issue':
        return JSON.stringify(await githubActions.create_issue(params));
      case 'update_issue':
        return JSON.stringify(await githubActions.update_issue(params));
      case 'get_issues_by_label':
        return JSON.stringify(await githubActions.get_issues_by_label(params));
      case 'get_issue_details':
        return JSON.stringify(await githubActions.get_issue_details(params));
      case 'get_related_prs':
        return JSON.stringify(await githubActions.get_related_prs(params));
      default:
        throw new Error(
          `Unknown github action: ${action}. Available actions: get_releases, get_recent_commits, get_deployment_stats, search_repositories, list_issues, search_issues, create_issue, update_issue, get_issues_by_label, get_issue_details, get_related_prs`
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

  search_issues: async (params: { repo?: string; query?: string; keywords?: string; limit?: number; state?: string }) => {
    try {
      const repoName = params.repo || params.query;
      const searchKeywords = params.keywords || params.query;

      logger.info(`🔍 Searching issues in ${repoName} for: ${searchKeywords}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="search_issues" repo="owner/repository" keywords="crash" />'
        );
      }

      if (!searchKeywords) {
        throw new Error(
          'Missing required parameter "keywords". Example: <capability name="github" action="search_issues" repo="owner/repository" keywords="save error" />'
        );
      }

      if (!repoName.includes('/')) {
        throw new Error(
          `Invalid repo format: "${repoName}". The repo parameter must be in "owner/repository" format (e.g., "owner/SubwayBuilder").`
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const state = params.state || 'open';
      const limit = params.limit || 10;
      const searchQuery = `repo:${repoName} ${searchKeywords} state:${state}`;

      const response = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=updated&order=desc`,
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
          query: searchKeywords,
          repository: repoName,
          total_count: data.total_count,
          issues: data.items.map((issue: any) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            labels: issue.labels.map((l: any) => l.name),
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            html_url: issue.html_url,
            user: issue.user.login,
            comments: issue.comments,
          })),
        },
      };
    } catch (error) {
      logger.error('❌ Failed to search GitHub issues:', error);
      throw error;
    }
  },

  create_issue: async (params: {
    repo?: string;
    query?: string;
    title?: string;
    body?: string;
    labels?: string[];
  }) => {
    try {
      const repoName = params.repo || params.query;

      logger.info(`📝 Creating GitHub issue for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="create_issue" repo="owner/repository" title="Bug report" body="Description here" />'
        );
      }

      if (!params.title) {
        throw new Error('Missing required parameter "title".');
      }

      if (!params.body) {
        throw new Error('Missing required parameter "body".');
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const issuePayload: {
        title: string;
        body: string;
        labels?: string[];
      } = {
        title: params.title,
        body: params.body,
      };

      if (params.labels && params.labels.length > 0) {
        issuePayload.labels = params.labels;
      }

      const response = await fetch(`https://api.github.com/repos/${repoName}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CoachArtie-Bot/1.0',
        },
        body: JSON.stringify(issuePayload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = (errorData as any).message || response.statusText;
        throw new Error(`GitHub API error: ${response.status} ${errorMessage}`);
      }

      const createdIssue = (await response.json()) as any;

      return {
        success: true,
        data: {
          issueNumber: createdIssue.number,
          issueTitle: createdIssue.title,
          issueUrl: createdIssue.html_url,
          createdAt: createdIssue.created_at,
          repository: repoName,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to create GitHub issue:', error);
      throw error;
    }
  },

  update_issue: async (params: {
    repo?: string;
    query?: string;
    issueNumber?: number;
    state?: string;
    labels?: string[];
    description?: string;
    title?: string;
  }) => {
    try {
      const repoName = params.repo || params.query;

      logger.info(`✏️ Updating GitHub issue #${params.issueNumber} for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="update_issue" repo="owner/repository" issueNumber="123" state="closed" />'
        );
      }

      if (!params.issueNumber) {
        throw new Error('Missing required parameter "issueNumber".');
      }

      if (!repoName.includes('/')) {
        throw new Error(
          `Invalid repo format: "${repoName}". The repo parameter must be in "owner/repository" format (e.g., "owner/SubwayBuilder").`
        );
      }

      // Validate that at least one field to update is provided
      if (!params.state && !params.labels && !params.description && !params.title) {
        throw new Error(
          'At least one field to update must be provided: state, labels, description, or title.'
        );
      }

      // Validate state if provided
      if (params.state && params.state !== 'open' && params.state !== 'closed') {
        throw new Error('Invalid state. Must be either "open" or "closed".');
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      // Build the update payload
      const updatePayload: {
        state?: string;
        labels?: string[];
        body?: string;
        title?: string;
      } = {};

      if (params.state) {
        updatePayload.state = params.state;
      }

      if (params.labels && params.labels.length > 0) {
        updatePayload.labels = params.labels;
      }

      if (params.description) {
        updatePayload.body = params.description;
      }

      if (params.title) {
        updatePayload.title = params.title;
      }

      const response = await fetch(
        `https://api.github.com/repos/${repoName}/issues/${params.issueNumber}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
          body: JSON.stringify(updatePayload),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = (errorData as any).message || response.statusText;
        if (response.status === 404) {
          throw new Error(
            `Issue #${params.issueNumber} not found in repository "${repoName}". Make sure the issue number is correct and you have access to it.`
          );
        }
        throw new Error(`GitHub API error: ${response.status} ${errorMessage}`);
      }

      const updatedIssue = (await response.json()) as any;

      // Build a summary of what was updated
      const updatedFields: string[] = [];
      if (params.state) updatedFields.push(`state to "${params.state}"`);
      if (params.title) updatedFields.push('title');
      if (params.description) updatedFields.push('description');
      if (params.labels) updatedFields.push(`labels to [${params.labels.join(', ')}]`);

      return {
        success: true,
        data: {
          issueNumber: updatedIssue.number,
          issueTitle: updatedIssue.title,
          issueState: updatedIssue.state,
          issueUrl: updatedIssue.html_url,
          updatedAt: updatedIssue.updated_at,
          repository: repoName,
          updatedFields: updatedFields,
          message: `Successfully updated issue #${updatedIssue.number}: ${updatedFields.join(', ')}`,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to update GitHub issue:', error);
      throw error;
    }
  },

  get_issues_by_label: async (params: {
    repo?: string;
    query?: string;
    labels?: string | string[];
    state?: string;
    limit?: number;
  }) => {
    try {
      const repoName = params.repo || params.query;

      logger.info(`🏷️  Fetching issues by label for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="get_issues_by_label" repo="owner/repository" labels="bug,enhancement" />'
        );
      }

      if (!params.labels) {
        throw new Error(
          'Missing required parameter "labels". Example: <capability name="github" action="get_issues_by_label" repo="owner/repository" labels="bug,enhancement" />'
        );
      }

      if (!repoName.includes('/')) {
        throw new Error(
          `Invalid repo format: "${repoName}". The repo parameter must be in "owner/repository" format (e.g., "owner/SubwayBuilder").`
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const state = params.state || 'open';
      const limit = params.limit || 30;

      // Convert labels to array if it's a comma-separated string
      const labelsArray = Array.isArray(params.labels)
        ? params.labels
        : params.labels.split(',').map((l) => l.trim());

      // Fetch issues for each label and organize by label
      const issuesByLabel: Record<string, any[]> = {};
      let totalIssues = 0;

      for (const label of labelsArray) {
        const searchQuery = `repo:${repoName} label:"${label}" state:${state}`;

        const response = await fetch(
          `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=updated&order=desc`,
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
              `Repository "${repoName}" not found. Make sure the repository path is correct and you have access to it.`
            );
          }
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as any;

        issuesByLabel[label] = data.items.map((issue: any) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels.map((l: any) => l.name),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          html_url: issue.html_url,
          user: issue.user.login,
          comments: issue.comments,
        }));

        totalIssues += data.items.length;
      }

      return {
        success: true,
        data: {
          repository: repoName,
          state: state,
          labels: labelsArray,
          total_count: totalIssues,
          issues_by_label: issuesByLabel,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch GitHub issues by label:', error);
      throw error;
    }
  },

  get_related_prs: async (params: { repo?: string; query?: string; issueNumber?: number }) => {
    try {
      const repoName = params.repo || params.query;

      logger.info(`🔗 Fetching related PRs for issue #${params.issueNumber} in ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="get_related_prs" repo="owner/repository" issueNumber="123" />'
        );
      }

      if (!params.issueNumber) {
        throw new Error(
          'Missing required parameter "issueNumber". Example: <capability name="github" action="get_related_prs" repo="owner/repository" issueNumber="123" />'
        );
      }

      if (!repoName.includes('/')) {
        throw new Error(
          `Invalid repo format: "${repoName}". The repo parameter must be in "owner/repository" format.`
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      const [owner, repo] = repoName.split('/');

      // Search for PRs that reference this issue
      const searchQuery = `repo:${repoName} type:pr #${params.issueNumber}`;
      const searchResponse = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      if (!searchResponse.ok) {
        throw new Error(`GitHub API error: ${searchResponse.status} ${searchResponse.statusText}`);
      }

      const searchData = (await searchResponse.json()) as any;

      // Get issue timeline to find linked PRs
      const timelineResponse = await fetch(
        `https://api.github.com/repos/${repoName}/issues/${params.issueNumber}/timeline`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.mockingbird-preview+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      let linkedPRs: any[] = [];
      if (timelineResponse.ok) {
        const timelineData = (await timelineResponse.json()) as any;
        // Extract cross-referenced PRs from timeline
        linkedPRs = timelineData
          .filter((event: any) => event.source && event.source.issue && event.source.issue.pull_request)
          .map((event: any) => event.source.issue);
      }

      // Combine search results and linked PRs, removing duplicates
      const allPRs = [...searchData.items, ...linkedPRs];
      const uniquePRs = Array.from(
        new Map(allPRs.map((pr: any) => [pr.number, pr])).values()
      );

      // Determine PR status (open/merged/closed)
      const prsWithStatus = await Promise.all(
        uniquePRs.map(async (pr: any) => {
          let status = pr.state;

          // If PR is closed, check if it was merged
          if (pr.state === 'closed' && pr.pull_request) {
            const prDetailResponse = await fetch(pr.pull_request.url, {
              headers: {
                Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'CoachArtie-Bot/1.0',
              },
            });

            if (prDetailResponse.ok) {
              const prDetail = (await prDetailResponse.json()) as any;
              status = prDetail.merged ? 'merged' : 'closed';
            }
          }

          return {
            number: pr.number,
            title: pr.title,
            status: status,
            author: pr.user.login,
            link: pr.html_url,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
          };
        })
      );

      return {
        success: true,
        data: {
          repository: repoName,
          issue_number: params.issueNumber,
          total_count: prsWithStatus.length,
          related_prs: prsWithStatus,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch related PRs:', error);
      throw error;
    }
  },

  get_issue_details: async (params: { repo?: string; issueNumber?: number | string }) => {
    try {
      const repoName = params.repo;
      const issueNumber = params.issueNumber;

      logger.info(`🔍 Fetching details for issue #${issueNumber} in ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="get_issue_details" repo="owner/repository" issueNumber="123" />'
        );
      }

      if (!issueNumber) {
        throw new Error(
          'Missing required parameter "issueNumber". Example: <capability name="github" action="get_issue_details" repo="owner/repository" issueNumber="123" />'
        );
      }

      // Validate repo format
      if (!repoName.includes('/')) {
        throw new Error(
          `Invalid repo format: "${repoName}". The repo parameter must be in "owner/repository" format (e.g., "owner/SubwayBuilder").`
        );
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      // Fetch the issue details
      const issueResponse = await fetch(
        `https://api.github.com/repos/${repoName}/issues/${issueNumber}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      if (!issueResponse.ok) {
        if (issueResponse.status === 404) {
          throw new Error(
            `Issue #${issueNumber} not found in repository "${repoName}". Make sure the issue number is correct and you have access to it.`
          );
        }
        throw new Error(`GitHub API error: ${issueResponse.status} ${issueResponse.statusText}`);
      }

      const issue = (await issueResponse.json()) as any;

      // Fetch all comments for the issue
      const commentsResponse = await fetch(
        `https://api.github.com/repos/${repoName}/issues/${issueNumber}/comments`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'CoachArtie-Bot/1.0',
          },
        }
      );

      if (!commentsResponse.ok) {
        throw new Error(
          `GitHub API error fetching comments: ${commentsResponse.status} ${commentsResponse.statusText}`
        );
      }

      const comments = (await commentsResponse.json()) as any[];

      return {
        success: true,
        data: {
          repository: repoName,
          issue: {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels.map((l: any) => ({
              name: l.name,
              color: l.color,
              description: l.description,
            })),
            assignees: issue.assignees.map((a: any) => a.login),
            milestone: issue.milestone
              ? {
                  title: issue.milestone.title,
                  state: issue.milestone.state,
                  due_on: issue.milestone.due_on,
                }
              : null,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            closed_at: issue.closed_at,
            html_url: issue.html_url,
            user: {
              login: issue.user.login,
              html_url: issue.user.html_url,
            },
            comments_count: issue.comments,
          },
          comments: comments.map((comment: any) => ({
            id: comment.id,
            body: comment.body,
            user: {
              login: comment.user.login,
              html_url: comment.user.html_url,
            },
            created_at: comment.created_at,
            updated_at: comment.updated_at,
            html_url: comment.html_url,
          })),
          total_comments: comments.length,
        },
      };
    } catch (error) {
      logger.error('❌ Failed to fetch GitHub issue details:', error);
      throw error;
    }
  },
};
