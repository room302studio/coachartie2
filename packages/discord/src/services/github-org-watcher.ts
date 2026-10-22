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
  GITHUB_FEED_CHANNEL_ID,
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
    // Every repo in the org, including new ones (EJ 2026-10-22). Explicit routes; anything
    // new and unmapped goes to #subwaybuilder-engineering, never the studio-wide #robot.
    org: 'Subway-Builder',
    guildId: '932719842522443928', // Room 302
    defaultChannelId: '1467952594671632647', // #subwaybuilder-engineering
    channelMappings: {
      'metro-maker4': '1467952594671632647', // #subwaybuilder-engineering
      'sb-unity': '1467952594671632647', // #subwaybuilder-engineering
      'subway-builder-2': '1560347074715979816', // #subwaybuilder-2
      sbat: '1480985884676587620', // #subwaybuilder-sbat
    },
  },
  {
    org: 'room302studio',
    guildId: '932719842522443928', // Room 302
    defaultChannelId: GITHUB_FEED_CHANNEL_ID,
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
    // Check hourly for new repos: orgs are spinning up repos and a new one shouldn't sit
    // unwatched for half a day. One list call per org per hour; trivial against the API limit.
    this.watchTimer = setInterval(() => {
      this.syncAllOrgs().catch((err) =>
        logger.error('Org watcher sync error:', err)
      );
    }, 60 * 60 * 1000);

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
    const repos: Array<{
      name: string;
      full_name: string;
      archived: boolean;
      fork: boolean;
      pushed_at: string | null;
      description: string | null;
      language: string | null;
    }> = [];
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
        description: r.description || null,
        language: r.language || null,
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
      const route = await this.findBestChannel(repo, config, existingWatches);
      const channelId = route.channelId;

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

      console.log(`🔭 Auto-watching ${repo.full_name} → #${channelName} (${route.how})`);
      logger.info(`Org watcher: added ${repo.full_name} → #${channelName} via ${route.how}`);
      newWatches++;

      // When Artie chose the room himself, say so where it'll be seen, so a wrong pick gets
      // caught in a day instead of never. Explicit routes and fallbacks stay quiet.
      if (route.how === 'artie' && channel && 'send' in channel) {
        await (channel as TextChannel)
          .send(
            `📡 New repo **${repo.full_name}**: I'll post its PRs and reviews here` +
              (route.reason ? ` (${route.reason.replace(/\.$/, '')})` : '') +
              `. Wrong room? \`/unwatch-repo\` here and \`/watch-repo\` in the right one.`
          )
          .catch((err) => logger.warn(`Org watcher: couldn't announce ${repo.full_name}:`, err));
      }
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
   * Find the best Discord channel for a repo.
   *
   * Strategy:
   * 1. Explicit channel mapping overrides (config)
   * 2. Artie picks, from channel names/topics/categories and how existing repos are routed
   * 3. Name matching (channel contains the repo name, or shares a 4+ letter word)
   * 4. The org's default channel
   */
  private async findBestChannel(
    repo: { name: string; full_name: string; description: string | null; language: string | null },
    config: OrgWatchConfig,
    existingWatches: Array<{ repo: string; channelId: string; isActive: boolean | null }>
  ): Promise<{ channelId: string; how: 'mapping' | 'artie' | 'name-match' | 'default'; reason?: string }> {
    const repoName = repo.name;
    // 1. Explicit overrides
    if (config.channelMappings?.[repoName]) {
      return { channelId: config.channelMappings[repoName], how: 'mapping' };
    }

    // 2. Artie decides: a cheap model sees the repo, the guild's channels (names, topics,
    //    categories) and how existing repos are routed, and picks one. Any failure falls
    //    through to the old name matching below.
    const picked = await this.askArtieForChannel(repo, config, existingWatches);
    if (picked) return { channelId: picked.channelId, how: 'artie', reason: picked.reason };

    const fallback = this.matchChannelByName(repoName, config);
    return fallback
      ? { channelId: fallback, how: 'name-match' }
      : { channelId: config.defaultChannelId, how: 'default' };
  }

  private async askArtieForChannel(
    repo: { full_name: string; description: string | null; language: string | null },
    config: OrgWatchConfig,
    existingWatches: Array<{ repo: string; channelId: string; isActive: boolean | null }>
  ): Promise<{ channelId: string; reason: string } | null> {
    const guild = this.client.guilds.cache.get(config.guildId);
    const me = guild?.members.me;
    if (!guild || !me) return null;
    const channels = [...guild.channels.cache.values()]
      .filter((ch): ch is TextChannel => ch.type === 0 && !!ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']))
      .map((ch) => ({ id: ch.id, name: ch.name, topic: ch.topic, category: ch.parent?.name ?? null }));
    const nameOf = (id: string) => (guild.channels.cache.get(id) as TextChannel | undefined)?.name ?? id;
    const existing = existingWatches
      .filter((w) => w.isActive)
      .map((w) => ({ repo: w.repo, channel: nameOf(w.channelId) }));
    try {
      const res = await fetch(`${process.env.CAPABILITIES_URL || 'http://localhost:47324'}/api/route-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: { fullName: repo.full_name, description: repo.description, language: repo.language },
          channels,
          existing,
          guildId: config.guildId,
        }),
      });
      if (!res.ok) return null;
      const pick = (await res.json()) as { channelId?: string; reason?: string };
      return pick.channelId && channels.some((c) => c.id === pick.channelId)
        ? { channelId: pick.channelId, reason: pick.reason || '' }
        : null;
    } catch (error) {
      logger.warn(`Org watcher: Artie couldn't route ${repo.full_name}, using name match:`, error);
      return null;
    }
  }

  /** The old heuristic: channel name contains the repo name, or shares a 4+ letter word. */
  private matchChannelByName(repoName: string, config: OrgWatchConfig): string | null {
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

    return null;
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
