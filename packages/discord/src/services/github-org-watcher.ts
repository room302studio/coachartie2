/**
 * GitHub Org Auto-Watcher
 *
 * Automatically discovers new repos in configured GitHub orgs
 * and creates repo watches, mapping them to appropriate Discord channels
 * by name similarity. Runs periodically to stay current.
 *
 * Fully generic — works for any org/guild combination.
 */

import { Client, TextChannel } from 'discord.js';
import { Octokit } from '@octokit/rest';
import {
  logger,
  getDb,
  githubRepoWatches,
  eq,
  and,
} from '@coachartie/shared';

interface OrgWatchConfig {
  org: string;
  guildId: string;
  defaultChannelId: string; // Fallback channel if no match found
  channelMappings?: Record<string, string>; // repo name pattern → channel ID overrides
}

// Configured orgs to watch
const ORG_CONFIGS: OrgWatchConfig[] = [
  {
    org: 'Subway-Builder',
    guildId: '932719842522443928', // Room 302
    defaultChannelId: '1480600810743267420', // #subwaybuilder-robot
  },
  {
    org: 'room302studio',
    guildId: '932719842522443928', // Room 302
    defaultChannelId: '1088992214853615626', // #studio-github
  },
];

// Repos to ignore (archived, forks, templates, etc.)
const IGNORE_PATTERNS = [
  /template/i,
  /\.github/i,
  /archived/i,
];

export class GitHubOrgWatcher {
  private client: Client;
  private octokit: Octokit;
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(client: Client, githubToken: string) {
    this.client = client;
    this.octokit = new Octokit({ auth: githubToken });
  }

  start(): void {
    // Check every 6 hours for new repos
    this.watchTimer = setInterval(() => {
      this.syncAllOrgs().catch((err) =>
        logger.error('Org watcher sync error:', err)
      );
    }, 6 * 60 * 60 * 1000);

    // Initial sync after 45 seconds (let other services start first)
    setTimeout(() => {
      this.syncAllOrgs().catch((err) =>
        logger.error('Org watcher initial sync error:', err)
      );
    }, 45 * 1000);

    logger.info('GitHub org watcher started');
    console.log('🔭 GitHub org watcher started');
  }

  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  async syncAllOrgs(): Promise<void> {
    for (const config of ORG_CONFIGS) {
      try {
        await this.syncOrg(config);
      } catch (error) {
        logger.error(`Org watcher error for ${config.org}:`, error);
      }
    }
  }

  private async syncOrg(config: OrgWatchConfig): Promise<void> {
    const db = getDb();

    // Fetch all repos in the org
    const repos: Array<{ name: string; full_name: string; archived: boolean; fork: boolean; pushed_at: string | null }> = [];
    let page = 1;
    while (true) {
      const { data } = await this.octokit.repos.listForOrg({
        org: config.org,
        per_page: 100,
        page,
        sort: 'pushed',
        direction: 'desc',
      });
      if (data.length === 0) break;
      repos.push(...data.map((r) => ({
        name: r.name,
        full_name: r.full_name,
        archived: r.archived || false,
        fork: r.fork || false,
        pushed_at: r.pushed_at || null,
      })));
      if (data.length < 100) break;
      page++;
    }

    // Get existing watches for this org
    const existingWatches = await db.select().from(githubRepoWatches);
    const watchedRepos = new Set(existingWatches.map((w) => w.repo));

    // Filter to active, non-archived, non-fork repos with recent activity
    const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const activeRepos = repos.filter((r) => {
      if (r.archived || r.fork) return false;
      if (IGNORE_PATTERNS.some((p) => p.test(r.name))) return false;
      // Only auto-watch repos with activity in last 6 months
      if (r.pushed_at && new Date(r.pushed_at).getTime() < sixMonthsAgo) return false;
      return true;
    });

    let newWatches = 0;

    for (const repo of activeRepos) {
      if (watchedRepos.has(repo.full_name)) continue;

      // Find the best Discord channel for this repo
      const channelId = await this.findBestChannel(repo.name, config);

      // Create the watch
      await db.insert(githubRepoWatches).values({
        repo: repo.full_name,
        guildId: config.guildId,
        channelId,
        events: JSON.stringify(['all']),
        isActive: true,
        createdBy: 'org-watcher',
      });

      const channel = this.client.channels.cache.get(channelId);
      const channelName = (channel as TextChannel)?.name || channelId;

      console.log(`🔭 Auto-watching ${repo.full_name} → #${channelName}`);
      logger.info(`Org watcher: added ${repo.full_name} → #${channelName}`);
      newWatches++;
    }

    // Deactivate watches for repos that no longer exist or are archived
    const orgRepoNames = new Set(repos.map((r) => r.full_name));
    const archivedNames = new Set(repos.filter((r) => r.archived).map((r) => r.full_name));

    for (const watch of existingWatches) {
      if (!watch.repo.startsWith(`${config.org}/`)) continue;

      if (!orgRepoNames.has(watch.repo) || archivedNames.has(watch.repo)) {
        if (watch.isActive) {
          await db
            .update(githubRepoWatches)
            .set({ isActive: false })
            .where(eq(githubRepoWatches.id, watch.id));
          console.log(`🔭 Deactivated watch for ${watch.repo} (archived/deleted)`);
        }
      }
    }

    if (newWatches > 0) {
      console.log(`🔭 ${config.org}: ${newWatches} new repo watches added`);
    }

    logger.info(`Org watcher sync: ${config.org} — ${activeRepos.length} active repos, ${newWatches} new watches`);
  }

  /**
   * Find the best Discord channel for a repo based on name matching.
   *
   * Strategy:
   * 1. Check explicit channel mapping overrides
   * 2. Look for a channel containing the repo name (e.g., "metro-maker4" → #subwaybuilder-robot)
   * 3. Look for a channel in the same category as other project channels
   * 4. Fall back to default channel
   */
  private async findBestChannel(repoName: string, config: OrgWatchConfig): Promise<string> {
    // 1. Explicit overrides
    if (config.channelMappings?.[repoName]) {
      return config.channelMappings[repoName];
    }

    // 2. Search guild channels for name match
    const guild = this.client.guilds.cache.get(config.guildId);
    if (guild) {
      const textChannels = guild.channels.cache.filter(
        (ch) => ch.type === 0 // text channel
      ) as any;

      const repoLower = repoName.toLowerCase().replace(/[-_]/g, '');

      // Direct name match: channel name contains repo name or vice versa
      for (const [, channel] of textChannels) {
        const chName = channel.name.toLowerCase().replace(/[-_]/g, '');

        // "connectology2" matches "#collab-connectology" or "#connectology2"
        if (chName.includes(repoLower) || repoLower.includes(chName.replace(/collab/g, '').replace(/robot/g, ''))) {
          // Prefer "-robot" or "-engineering" channels over general project channels
          if (channel.name.includes('robot') || channel.name.includes('engineering')) {
            return channel.id;
          }
        }
      }

      // Looser match: look for channels with shared words (≥4 chars)
      const repoWords = repoName.toLowerCase().split(/[-_]/).filter((w: string) => w.length >= 4);
      for (const [, channel] of textChannels) {
        const chName = channel.name.toLowerCase();
        if (repoWords.some((word: string) => chName.includes(word))) {
          return channel.id;
        }
      }
    }

    // 3. Fall back to default
    return config.defaultChannelId;
  }
}

// Singleton
let orgWatcher: GitHubOrgWatcher | null = null;

export function initializeOrgWatcher(client: Client): void {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  orgWatcher = new GitHubOrgWatcher(client, token);
  orgWatcher.start();
}

export function getOrgWatcher(): GitHubOrgWatcher | null {
  return orgWatcher;
}
