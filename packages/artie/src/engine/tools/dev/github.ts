import { logger } from '../../../shared/logger.js';

import { RegisteredCapability } from '../../5-tool-loop/registry.js';

// =====================================================
// Issue-clerk helpers (2026-11-13). Shared by the write actions and the triage reads.
// =====================================================

const GITHUB_API = 'https://api.github.com';

/** Headers for every GitHub REST call. Content-Type matters on POST/PATCH: fetch defaults a
 *  string body to text/plain, which GitHub tolerates today but isn't promised to. */
function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'CoachArtie-Bot/1.0',
  };
}

function requireToken(): void {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
  }
}

/** "owner/repo" from any of the synonyms models reach for, or a thrown, model-readable error. */
function requireRepo(params: Record<string, unknown>, action: string): string {
  const raw = params.repo ?? params.repository ?? params.project;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing required parameter "repo" (owner/repository) for github:${action}.`);
  }
  const repo = raw.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid repo "${repo}". Use "owner/repository", e.g. "Subway-Builder/metro-maker4".`);
  }
  return repo;
}

/** A positive issue number from issueNumber/issue/number, or a thrown error. */
function requireIssueNumber(params: Record<string, unknown>, action: string): number {
  const raw = params.issueNumber ?? params.issue ?? params.number;
  const n = Number(String(raw ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Missing or invalid "issueNumber" for github:${action} (got "${String(raw ?? '')}").`);
  }
  return n;
}

/**
 * Labels arrive as strings from the native tool loop (every schema param is typed string) and
 * as attributes from the XML loop, so accept a real array, a JSON array string, or a csv.
 * Before this, create/update_issue called .join/.length on whatever came in, and a csv string
 * went to GitHub as a bare string (422).
 */
export function normalizeLabels(raw: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items = parsed;
        }
      } catch {
        items = text.slice(1, -1).split(',');
      }
    } else {
      items = text.split(',');
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const label = String(item ?? '').trim().replace(/^["']|["']$/g, '');
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

/** Hidden marker on everything Artie writes, so tools (and the echo filter) can recognize it. */
export const ARTIE_WRITE_MARKER = '<!-- coachartie -->';

/**
 * Provenance on every issue and comment Artie writes. The token's login (`coachartie`) already
 * shows who posted, but agent-filed issues were indistinguishable from EJ's (backlog survey,
 * 2026-11-13), and a reader should know a human signed off. Only EJ can approve (approvals.ts),
 * so "approved by EJ" is a fact, not a guess. Idempotent: a body already carrying the marker
 * is left alone.
 */
export function withProvenance(body: string): string {
  if (body.includes(ARTIE_WRITE_MARKER)) {
    return body;
  }
  return `${body.trimEnd()}\n\n---\n<sub>Posted by Coach Artie (Room 302's Discord bot), approved by EJ.</sub>\n${ARTIE_WRITE_MARKER}`;
}

async function ghError(response: Response, what: string): Promise<Error> {
  let message = response.statusText;
  try {
    const data = (await response.json()) as { message?: string };
    if (data.message) {
      message = data.message;
    }
  } catch {
    // non-JSON error body; statusText is all we have
  }
  if (response.status === 404) {
    return new Error(`${what}: not found (404). Check the repo and issue number, and that Artie's account can see it.`);
  }
  if (response.status === 403) {
    return new Error(`${what}: forbidden (403). Artie's GitHub account may lack write access to this repo. ${message}`);
  }
  return new Error(`${what}: GitHub API error ${response.status} ${message}`);
}

/** Words that say nothing about which bug an issue is, dropped before similarity matching. */
const STOPWORDS = new Set(
  (
    'a an the and or but if then else when of in on at to for from by with without into onto is are was were be ' +
    'been being it its this that these those i you he she we they my your our their me us them not no yes can ' +
    'cant cannot could should would will wont do does did doesnt dont didnt have has had get gets got after before ' +
    'while so too very just also some any all more most other such than up down out over under again still ' +
    'when where why how what which who issue bug error problem feature request please fix fixed broken working ' +
    'doesnt works work game'
  ).split(' ')
);

/** Lowercased content words of a title, for similarity scoring. Exported for tests. */
export function titleTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[`'’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

/** Overlap of two term sets, 0..1 (Jaccard). Exported for tests. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const setB = new Set(b);
  let shared = 0;
  for (const term of a) {
    if (setB.has(term)) shared += 1;
  }
  return shared / (a.length + b.length - shared);
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function searchCount(q: string): Promise<number | null> {
  const response = await fetch(`${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=1`, {
    headers: ghHeaders(),
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { total_count?: number };
  return data.total_count ?? null;
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
  emoji: '🐙',
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
    'find_similar_issues',
    'list_triage',
    'add_comment',
    'add_labels',
    'remove_label',
  ],
  description:
    'GitHub repos and issues: read, search, find duplicates (find_similar_issues), triage counts (list_triage); ' +
    'writes (create_issue, update_issue, add_comment, add_labels, remove_label) wait for EJ\'s approval',
  requiredParams: ['action'],
  // The first example is the one the native tool schema shows; all of them teach param names.
  examples: [
    '<capability name="github" action="find_similar_issues" repo="owner/repo" title="Trains vanish after save" />',
    '<capability name="github" action="list_triage" repo="owner/repo" filter="unassigned" staleDays="60" limit="10" />',
    '<capability name="github" action="add_comment" repo="owner/repo" issueNumber="12" body="Possible duplicate of #9" />',
    '<capability name="github" action="add_labels" repo="owner/repo" issueNumber="12" labels="bug,P2" />',
    '<capability name="github" action="remove_label" repo="owner/repo" issueNumber="12" label="needs-triage" />',
    '<capability name="github" action="update_issue" repo="owner/repo" issueNumber="12" state="closed" state_reason="duplicate" duplicateOf="9" assignees="ejfox" />',
    '<capability name="github" action="create_issue" repo="owner/repo" title="Bug title" body="Details" labels="bug" />',
  ],

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
        return JSON.stringify(await githubActions.create_issue(params, _content));
      case 'update_issue':
        return JSON.stringify(await githubActions.update_issue(params));
      case 'get_issues_by_label':
        return JSON.stringify(await githubActions.get_issues_by_label(params));
      case 'get_issue_details':
        return JSON.stringify(await githubActions.get_issue_details(params));
      case 'get_related_prs':
        return JSON.stringify(await githubActions.get_related_prs(params));
      case 'find_similar_issues':
        return JSON.stringify(await issueClerk.find_similar_issues(params, _content));
      case 'list_triage':
        return JSON.stringify(await issueClerk.list_triage(params));
      case 'add_comment':
        return JSON.stringify(await issueClerk.add_comment(params, _content));
      case 'add_labels':
        return JSON.stringify(await issueClerk.add_labels(params));
      case 'remove_label':
        return JSON.stringify(await issueClerk.remove_label(params));
      default:
        throw new Error(
          `Missing or unknown github "action" (you sent action="${action ?? '(none)'}"). You MUST include an action attribute, e.g. <capability name="github" action="create_issue" repo="owner/repo" title="Bug title" body="Details" />. Available actions: ${githubCapability.supportedActions.join(', ')}`
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

      // Build latest_release info
      let latestRelease: { tag_name: string; published_at: string; author: string } | null;
      if (recentReleases[0]) {
        const release = recentReleases[0];
        latestRelease = {
          tag_name: release.tag_name,
          published_at: release.published_at,
          author: release.author.login,
        };
      } else {
        latestRelease = null;
      }

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
            latest_release: latestRelease,
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

  list_issues: async (params: {
    repo?: string;
    query?: string;
    state?: string;
    limit?: number;
  }) => {
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

  search_issues: async (params: {
    repo?: string;
    query?: string;
    keywords?: string;
    limit?: number;
    state?: string;
  }) => {
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

  create_issue: async (
    params: {
      repo?: string;
      query?: string;
      project?: string;
      repository?: string;
      title?: string;
      body?: string;
      description?: string;
      labels?: unknown;
    },
    content?: string
  ) => {
    try {
      // The LLM frequently reaches for synonyms (project/repository for repo,
      // description for body) or dumps the whole body into the tag's content.
      // Accept all of those instead of failing with "missing parameter".
      const repoName = params.repo || params.repository || params.project || params.query;
      const title = params.title;
      const body = params.body || params.description || content;

      logger.info(`📝 Creating GitHub issue for ${repoName}`);

      if (!repoName) {
        throw new Error(
          'Missing required parameter "repo". Example: <capability name="github" action="create_issue" repo="owner/repository" title="Bug report" body="Description here" />'
        );
      }

      if (!title) {
        throw new Error('Missing required parameter "title".');
      }

      if (!body) {
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
        title: title,
        body: withProvenance(body),
      };

      const labels = normalizeLabels(params.labels);
      if (labels.length > 0) {
        issuePayload.labels = labels;
      }

      const response = await fetch(`https://api.github.com/repos/${repoName}/issues`, {
        method: 'POST',
        headers: ghHeaders(),
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
    labels?: unknown;
    description?: string;
    body?: string;
    title?: string;
    assignees?: unknown;
    state_reason?: string;
    stateReason?: string;
    duplicateOf?: string | number;
  }) => {
    try {
      const repoName = params.repo || params.query;
      // Scribe update proposals send `body` alongside `description`; both mean the issue body.
      const newBody = params.description || params.body;
      const labels = normalizeLabels(params.labels);
      const assignees = normalizeLabels(params.assignees).map((login) => login.replace(/^@/, ''));
      const stateReason = params.state_reason || params.stateReason;
      let duplicateOf: number | null = null;
      if (params.duplicateOf !== undefined && params.duplicateOf !== '') {
        duplicateOf = Number(String(params.duplicateOf).replace(/^#/, ''));
        if (!Number.isInteger(duplicateOf) || duplicateOf <= 0) {
          throw new Error(`Invalid duplicateOf "${String(params.duplicateOf)}": use the other issue's number.`);
        }
      }

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
      if (
        !params.state &&
        labels.length === 0 &&
        !newBody &&
        !params.title &&
        assignees.length === 0 &&
        !stateReason &&
        duplicateOf === null
      ) {
        throw new Error(
          'At least one field to update must be provided: state, state_reason, duplicateOf, labels, assignees, description, or title.'
        );
      }

      // Validate state if provided
      if (params.state && params.state !== 'open' && params.state !== 'closed') {
        throw new Error('Invalid state. Must be either "open" or "closed".');
      }

      // GitHub's accepted close reasons (REST api.github.com description, checked 2026-11-13).
      const STATE_REASONS = ['completed', 'not_planned', 'duplicate', 'reopened'];
      if (stateReason && !STATE_REASONS.includes(stateReason)) {
        throw new Error(`Invalid state_reason "${stateReason}". Use one of: ${STATE_REASONS.join(', ')}.`);
      }

      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN not configured. Set GITHUB_TOKEN environment variable.');
      }

      // Build the update payload
      const updatePayload: {
        state?: string;
        state_reason?: string;
        duplicate_issue_id?: number;
        labels?: string[];
        assignees?: string[];
        body?: string;
        title?: string;
      } = {};

      if (params.state) {
        updatePayload.state = params.state;
      }

      if (duplicateOf !== null) {
        // "Close as duplicate of #N" — GitHub links the two issues when it gets the other
        // issue's database id (not its number), so look that up first.
        const dupResponse = await fetch(`${GITHUB_API}/repos/${repoName}/issues/${duplicateOf}`, {
          headers: ghHeaders(),
        });
        if (!dupResponse.ok) {
          throw await ghError(dupResponse, `Looking up duplicate target #${duplicateOf}`);
        }
        const dup = (await dupResponse.json()) as { id: number };
        updatePayload.state = 'closed';
        updatePayload.state_reason = 'duplicate';
        updatePayload.duplicate_issue_id = dup.id;
      } else if (stateReason) {
        updatePayload.state_reason = stateReason;
        // A reason implies the state it belongs to, so "reopened" alone actually reopens.
        if (!updatePayload.state && stateReason === 'reopened') {
          updatePayload.state = 'open';
        } else if (!updatePayload.state) {
          updatePayload.state = 'closed';
        }
      }

      // Replaces the whole label set (PATCH semantics). add_labels / remove_label change one
      // label without needing to know the rest.
      if (labels.length > 0) {
        updatePayload.labels = labels;
      }

      if (assignees.length > 0) {
        updatePayload.assignees = assignees;
      }

      if (newBody) {
        updatePayload.body = newBody;
      }

      if (params.title) {
        updatePayload.title = params.title;
      }

      const response = await fetch(
        `https://api.github.com/repos/${repoName}/issues/${params.issueNumber}`,
        {
          method: 'PATCH',
          headers: ghHeaders(),
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
      if (updatePayload.state) updatedFields.push(`state to "${updatePayload.state}"`);
      if (updatePayload.state_reason) updatedFields.push(`reason "${updatePayload.state_reason}"`);
      if (duplicateOf !== null) updatedFields.push(`duplicate of #${duplicateOf}`);
      if (params.title) updatedFields.push('title');
      if (newBody) updatedFields.push('description');
      if (labels.length > 0) updatedFields.push(`labels to [${labels.join(', ')}]`);
      if (assignees.length > 0) updatedFields.push(`assignees to [${assignees.join(', ')}]`);

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
      let labelsArray: string[];
      if (Array.isArray(params.labels)) {
        labelsArray = params.labels;
      } else {
        labelsArray = params.labels.split(',').map((l) => l.trim());
      }

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

      const [_owner, _repo] = repoName.split('/');

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
          .filter(
            (event: any) => event.source && event.source.issue && event.source.issue.pull_request
          )
          .map((event: any) => event.source.issue);
      }

      // Combine search results and linked PRs, removing duplicates
      const allPRs = [...searchData.items, ...linkedPRs];
      const uniquePRs = Array.from(new Map(allPRs.map((pr: any) => [pr.number, pr])).values());

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
              if (prDetail.merged) {
                status = 'merged';
              } else {
                status = 'closed';
              }
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

      // Build milestone info
      let milestoneInfo: { title: string; state: string; due_on: string } | null;
      if (issue.milestone) {
        milestoneInfo = {
          title: issue.milestone.title,
          state: issue.milestone.state,
          due_on: issue.milestone.due_on,
        };
      } else {
        milestoneInfo = null;
      }

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
            milestone: milestoneInfo,
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

// =====================================================
// Issue clerk (2026-11-13): duplicate search, triage lists, and small reversible writes.
// The writes are gated in approval-gate.ts; nothing here checks approval itself.
// =====================================================

interface SearchItem {
  number: number;
  title: string;
  state: string;
  html_url: string;
  updated_at: string;
  created_at: string;
  comments: number;
  user?: { login: string };
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  pull_request?: unknown;
}

function summarizeIssue(item: SearchItem) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.html_url,
    author: item.user?.login,
    labels: (item.labels ?? []).map((l) => l.name),
    assignees: (item.assignees ?? []).map((a) => a.login),
    comments: item.comments,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

const TRIAGE_FILTERS: Record<string, (staleDays: number) => string> = {
  unassigned: () => 'no:assignee',
  unlabeled: () => 'no:label',
  stale: (days) => `updated:<${isoDaysAgo(days)}`,
};

export const issueClerk = {
  /**
   * Likely duplicates of a title (or free text) among a repo's issues, open and closed. No LLM:
   * GitHub search on the strongest title terms (OR'd, so one odd word doesn't sink recall), then
   * a local term-overlap score so the best match is first, not the most recently updated.
   */
  find_similar_issues: async (params: Record<string, unknown>, content?: string) => {
    requireToken();
    const repo = requireRepo(params, 'find_similar_issues');
    const text = String(params.title ?? params.text ?? params.keywords ?? content ?? '').trim();
    if (!text) {
      throw new Error('find_similar_issues needs "title" (the bug report or issue title to match).');
    }
    const terms = titleTerms(text);
    if (terms.length === 0) {
      return { success: true, data: { repo, query: text, matches: [], note: 'No distinctive words to match on.' } };
    }
    const limit = clampInt(params.limit, 5, 1, 20);
    let stateFilter = '';
    if (params.state === 'open' || params.state === 'closed') {
      stateFilter = ` is:${params.state}`;
    }
    // Longest terms first: they're usually the most specific (e.g. "pathfinding" over "save").
    const searchTerms = [...terms].sort((a, b) => b.length - a.length).slice(0, 6);
    const q = `repo:${repo} is:issue${stateFilter} ${searchTerms.join(' OR ')} in:title`;
    const response = await fetch(`${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=50`, {
      headers: ghHeaders(),
    });
    if (!response.ok) {
      throw await ghError(response, `Searching ${repo}`);
    }
    const data = (await response.json()) as { items?: SearchItem[] };
    const exclude = Number(params.excludeNumber ?? params.issueNumber ?? 0);
    const matches = (data.items ?? [])
      .filter((item) => !item.pull_request && item.number !== exclude)
      .map((item) => ({ item, score: similarity(terms, titleTerms(item.title)) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => ({ ...summarizeIssue(m.item), score: Math.round(m.score * 100) / 100 }));
    return {
      success: true,
      data: {
        repo,
        query: text,
        terms,
        matches,
        note: 'score is title-word overlap (0-1); 0.5+ is a strong duplicate candidate, but read both before calling it one.',
      },
    };
  },

  /**
   * Open issues needing a human, by facet: unassigned, unlabeled, stale (no update in staleDays).
   * Always returns the three counts (cheap: one search each), plus a list for the asked filter.
   */
  list_triage: async (params: Record<string, unknown>) => {
    requireToken();
    const repo = requireRepo(params, 'list_triage');
    const staleDays = clampInt(params.staleDays, 60, 7, 730);
    const limit = clampInt(params.limit, 10, 1, 50);
    const base = `repo:${repo} is:issue is:open`;
    const counts: Record<string, number | null> = {};
    for (const [name, facet] of Object.entries(TRIAGE_FILTERS)) {
      counts[name] = await searchCount(`${base} ${facet(staleDays)}`);
    }
    counts.open = await searchCount(base);

    let filter = String(params.filter ?? 'stale');
    if (!(filter in TRIAGE_FILTERS)) {
      filter = 'stale';
    }
    let sort = 'updated&order=asc';
    if (filter !== 'stale') {
      sort = 'created&order=desc';
    }
    const q = `${base} ${TRIAGE_FILTERS[filter](staleDays)}`;
    const response = await fetch(
      `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}&sort=${sort}`,
      { headers: ghHeaders() }
    );
    if (!response.ok) {
      throw await ghError(response, `Listing ${filter} issues in ${repo}`);
    }
    const data = (await response.json()) as { items?: SearchItem[] };
    return {
      success: true,
      data: {
        repo,
        staleDays,
        counts,
        filter,
        issues: (data.items ?? []).map(summarizeIssue),
      },
    };
  },

  /** Comment on an issue or PR. Gated. Carries the provenance footer. */
  add_comment: async (params: Record<string, unknown>, content?: string) => {
    requireToken();
    const repo = requireRepo(params, 'add_comment');
    const issueNumber = requireIssueNumber(params, 'add_comment');
    const body = String(params.body ?? params.comment ?? params.text ?? content ?? '').trim();
    if (!body) {
      throw new Error('add_comment needs "body" (the comment text).');
    }
    const response = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({ body: withProvenance(body) }),
    });
    if (!response.ok) {
      throw await ghError(response, `Commenting on ${repo}#${issueNumber}`);
    }
    const comment = (await response.json()) as { id: number; html_url: string };
    return { success: true, data: { repo, issueNumber, commentId: comment.id, url: comment.html_url } };
  },

  /** Add labels without touching the rest (POST is additive). Gated. */
  add_labels: async (params: Record<string, unknown>) => {
    requireToken();
    const repo = requireRepo(params, 'add_labels');
    const issueNumber = requireIssueNumber(params, 'add_labels');
    const labels = normalizeLabels(params.labels ?? params.label);
    if (labels.length === 0) {
      throw new Error('add_labels needs "labels" (comma-separated, e.g. "bug,P2").');
    }
    const response = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({ labels }),
    });
    if (!response.ok) {
      throw await ghError(response, `Labeling ${repo}#${issueNumber}`);
    }
    const now = (await response.json()) as Array<{ name: string }>;
    return { success: true, data: { repo, issueNumber, added: labels, labelsNow: now.map((l) => l.name) } };
  },

  /** Remove one label. Gated. A label that isn't on the issue is reported, not an error. */
  remove_label: async (params: Record<string, unknown>) => {
    requireToken();
    const repo = requireRepo(params, 'remove_label');
    const issueNumber = requireIssueNumber(params, 'remove_label');
    const [label] = normalizeLabels(params.label ?? params.labels);
    if (!label) {
      throw new Error('remove_label needs "label" (one label name).');
    }
    const response = await fetch(
      `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE', headers: ghHeaders() }
    );
    if (response.status === 404) {
      // GitHub 404s both "label not on this issue" and "no such issue/repo". Only the first
      // is a harmless no-op; the second must surface as an error.
      let message = '';
      try {
        message = String(((await response.clone().json()) as { message?: string }).message ?? '');
      } catch {
        // fall through to the error below
      }
      if (/label does not exist/i.test(message)) {
        return { success: true, data: { repo, issueNumber, removed: null, note: `"${label}" was not on the issue.` } };
      }
    }
    if (!response.ok) {
      throw await ghError(response, `Unlabeling ${repo}#${issueNumber}`);
    }
    const now = (await response.json()) as Array<{ name: string }>;
    return { success: true, data: { repo, issueNumber, removed: label, labelsNow: now.map((l) => l.name) } };
  },
};
