/**
 * Trend Watcher Capability
 *
 * Monitor GitHub Trending, Hacker News, and tech communities for emerging patterns.
 * Inspired by Clawdbot's "trend-watcher" skill.
 *
 * Usage:
 * - "what's trending on github?"
 * - "show me trending repos in typescript"
 * - "what's hot on hacker news?"
 * - "tech trends this week"
 */

import { logger } from '@coachartie/shared';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

interface TrendWatcherParams {
  action: string;
  source?: 'github' | 'hackernews' | 'all';
  language?: string;
  timeRange?: 'daily' | 'weekly' | 'monthly';
  limit?: number;
  [key: string]: unknown;
}

interface GitHubRepo {
  name: string;
  fullName: string;
  description: string;
  stars: number;
  todayStars: number;
  language: string;
  url: string;
}

interface HNStory {
  title: string;
  url: string;
  score: number;
  comments: number;
  author: string;
}

/**
 * Fetch trending GitHub repositories using GitHub Search API
 * Searches for repos created in the last week, sorted by stars
 */
async function fetchGitHubTrending(language?: string, since: string = 'daily'): Promise<GitHubRepo[]> {
  try {
    // Calculate date range based on 'since' parameter
    const now = new Date();
    const daysBack = since === 'monthly' ? 30 : since === 'weekly' ? 7 : 1;
    const dateFrom = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const dateStr = dateFrom.toISOString().split('T')[0];

    // Build GitHub search query
    let query = `created:>${dateStr}`;
    if (language) {
      query += ` language:${encodeURIComponent(language)}`;
    }

    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=15`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CoachArtie-TrendWatcher',
      },
    });

    if (!response.ok) {
      logger.warn(`GitHub API returned ${response.status}, using fallback`);
      return getFallbackTrending(language);
    }

    const data = await response.json() as any;
    if (!data.items || data.items.length === 0) {
      return getFallbackTrending(language);
    }

    return data.items.map((repo: any) => ({
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description || 'No description',
      stars: repo.stargazers_count || 0,
      todayStars: 0, // GitHub search API doesn't provide daily stars
      language: repo.language || 'Unknown',
      url: repo.html_url,
    }));
  } catch (error) {
    logger.error('GitHub trending fetch error:', error);
    return getFallbackTrending(language);
  }
}

/**
 * Fallback trending repos when API fails
 */
function getFallbackTrending(language?: string): GitHubRepo[] {
  // Return a helpful message instead of empty
  return [{
    name: 'API-unavailable',
    fullName: 'github/trending',
    description: `GitHub API is rate-limited. Visit https://github.com/trending${language ? `/${language}` : ''} directly.`,
    stars: 0,
    todayStars: 0,
    language: language || 'All',
    url: `https://github.com/trending${language ? `/${language}` : ''}`,
  }];
}

/**
 * Fetch Hacker News top stories
 */
async function fetchHackerNews(limit: number = 15): Promise<HNStory[]> {
  try {
    // Get top story IDs
    const topResponse = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!topResponse.ok) throw new Error('Failed to fetch HN top stories');

    const storyIds = await topResponse.json() as number[];
    const topIds = storyIds.slice(0, limit);

    // Fetch story details in parallel
    const stories = await Promise.all(
      topIds.map(async (id) => {
        try {
          const storyResponse = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (!storyResponse.ok) return null;
          const story = await storyResponse.json() as any;
          return {
            title: story.title || 'Untitled',
            url: story.url || `https://news.ycombinator.com/item?id=${id}`,
            score: story.score || 0,
            comments: story.descendants || 0,
            author: story.by || 'unknown',
          };
        } catch {
          return null;
        }
      })
    );

    return stories.filter((s): s is HNStory => s !== null);
  } catch (error) {
    logger.error('Hacker News fetch error:', error);
    return [];
  }
}

/**
 * Format GitHub repos for display
 */
function formatGitHubTrending(repos: GitHubRepo[]): string {
  if (repos.length === 0) {
    return '⚠️ Could not fetch GitHub trending. API may be rate-limited.';
  }

  const lines = repos.map((repo, i) => {
    const stars = repo.todayStars > 0 ? ` (+${repo.todayStars} today)` : '';
    return `**${i + 1}. [${repo.fullName}](${repo.url})**\n   ⭐ ${repo.stars.toLocaleString()}${stars} • ${repo.language}\n   ${repo.description?.slice(0, 100) || 'No description'}`;
  });

  return lines.join('\n\n');
}

/**
 * Format HN stories for display
 */
function formatHackerNews(stories: HNStory[]): string {
  if (stories.length === 0) {
    return '⚠️ Could not fetch Hacker News.';
  }

  const lines = stories.map((story, i) => {
    return `**${i + 1}. ${story.title}**\n   🔼 ${story.score} points • 💬 ${story.comments} comments\n   ${story.url}`;
  });

  return lines.join('\n\n');
}

/**
 * Trend watcher capability handler
 */
async function handleTrendWatcher(
  params: TrendWatcherParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action, source = 'all', language, timeRange = 'daily', limit = 10 } = params;

  logger.info(`📈 Trend watcher - Action: ${action}, Source: ${source}, Language: ${language || 'all'}`);

  try {
    switch (action) {
      case 'github':
      case 'repos': {
        const repos = await fetchGitHubTrending(language, timeRange);
        const langLabel = language ? ` (${language})` : '';
        return `🔥 **GitHub Trending${langLabel} - ${timeRange}**\n\n${formatGitHubTrending(repos.slice(0, limit))}`;
      }

      case 'hackernews':
      case 'hn':
      case 'news': {
        const stories = await fetchHackerNews(limit);
        return `📰 **Hacker News Top Stories**\n\n${formatHackerNews(stories)}`;
      }

      case 'all':
      case 'trends':
      case 'overview':
      default: {
        const [repos, stories] = await Promise.all([
          fetchGitHubTrending(language, timeRange),
          fetchHackerNews(5),
        ]);

        const langLabel = language ? ` (${language})` : '';
        const githubSection = `🔥 **GitHub Trending${langLabel}**\n\n${formatGitHubTrending(repos.slice(0, 5))}`;
        const hnSection = `📰 **Hacker News**\n\n${formatHackerNews(stories)}`;

        return `📈 **Tech Trends Overview**\n\n${githubSection}\n\n---\n\n${hnSection}`;
      }
    }
  } catch (error) {
    logger.error('Trend watcher error:', error);
    return `❌ Error fetching trends: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export const trendWatcherCapability: RegisteredCapability = {
  name: 'trend-watcher',
  emoji: '📈',
  supportedActions: ['github', 'repos', 'hackernews', 'hn', 'news', 'all', 'trends', 'overview'],
  description: `Monitor tech trends from GitHub and Hacker News. Actions:
- github/repos: Show trending GitHub repositories (optional: language filter)
- hackernews/hn/news: Show top Hacker News stories
- all/trends/overview: Combined overview of both

Parameters:
- language: Filter GitHub repos by language (e.g., "typescript", "rust")
- timeRange: "daily", "weekly", or "monthly" for GitHub
- limit: Number of items to show (default 10)`,
  handler: handleTrendWatcher,
};
