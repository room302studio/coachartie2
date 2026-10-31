/**
 * GitHub Studio Manager
 *
 * Proactive daily digests with studio manager energy.
 * Synthesizes repo activity into actionable summaries,
 * nudges about stale PRs, and highlights what needs attention.
 *
 * Posts to the configured channel once each weekday morning (9 AM ET).
 */

import { Client, EmbedBuilder } from 'discord.js';
import { Octokit } from '@octokit/rest';
import { octokitLog } from './octokit-log.js';
import { logger } from '../../../shared/logger.js';
import { getDb, eq } from '../../../shared/db/client.js';
import { readState, writeState } from '../../../shared/db/kv-state.js';
import { easternDayKey, easternHour, isEasternWeekend } from '../../../shared/eastern-day.js';
import { githubRepoWatches, githubIdentityMappings } from '../../../shared/db/schema.js';

function pluralS(count: number): string {
  if (count > 1) {
    return 's';
  }
  return '';
}

function formatLabels(labels: any[]): string {
  if (labels.length > 0) {
    return ` \`${labels.join('` `')}\``;
  }
  return '';
}

function getAgeString(ageHours: number): string {
  if (ageHours < 24) {
    return `${ageHours}h`;
  }
  return `${Math.round(ageHours / 24)}d`;
}

const DIGEST_DAY_KEY = 'studio_digest_last_day';

/** The ET day the morning digest last went out (survives restarts). */
export function lastDigestDay(): string {
  return readState(DIGEST_DAY_KEY) ?? '';
}

export function rememberDigestDay(day: string): void {
  writeState(DIGEST_DAY_KEY, day);
}

function extractLabelName(label: any): string {
  if (typeof label === 'string') {
    return label;
  }
  return label.name;
}

interface RepoDigest {
  repo: string;
  channelId: string;
  guildId: string;
  prsNeedingReview: Array<{ number: number; title: string; url: string; author: string; age: number; reviewers: string[] }>;
  stalePrs: Array<{ number: number; title: string; url: string; author: string; daysSinceUpdate: number }>;
  draftPrs: Array<{ number: number; title: string; url: string; author: string }>;
  recentMerges: Array<{ number: number; title: string; author: string; mergedBy: string }>;
  recentCommits: Array<{ sha: string; message: string; author: string }>;
  openIssues: { total: number; unassigned: number; recent: Array<{ number: number; title: string; author: string; labels: string[] }> };
}

export class GitHubStudioManager {
  private client: Client;
  private octokit: Octokit;
  private digestTimer: NodeJS.Timeout | null = null;

  constructor(client: Client, githubToken: string) {
    this.client = client;
    this.octokit = new Octokit({ auth: githubToken, log: octokitLog });
  }

  start(): void {
    // Check every 30 min if it's time for the morning digest
    this.digestTimer = setInterval(() => {
      this.checkAndPostDigest().catch((err) =>
        logger.error('Studio manager digest error:', err)
      );
    }, 30 * 60 * 1000);

    // Initial check after 60 seconds
    setTimeout(
      () =>
        this.checkAndPostDigest().catch((err) =>
          logger.error('Studio manager initial digest error:', err)
        ),
      60 * 1000
    );


    logger.info('GitHub studio manager started');
    console.log('📋 GitHub studio manager started');
  }

  stop(): void {
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
  }

  private async checkAndPostDigest(): Promise<void> {
    const now = new Date();
    // Weekdays only: it's a work digest, and weekends are Artie's off days (EJ, 2026-10-31).
    if (isEasternWeekend(now)) return;
    // Post at 9 AM ET, once per ET day. The "once" is persisted: kept in memory, every restart
    // inside the 9 o'clock hour posted it again (twice on 2026-10-31, from two deploys).
    const today = easternDayKey(now);
    if (easternHour(now) !== 9 || lastDigestDay() === today) return;
    rememberDigestDay(today);
    await this.postMorningDigest();
  }

  async postMorningDigest(): Promise<void> {
    const db = getDb();
    const watches = await db.select().from(githubRepoWatches);

    for (const watch of watches) {
      try {
        const digest = await this.buildDigest(watch);
        if (digest) {
          await this.postDigestToChannel(digest);
        }
      } catch (error) {
        logger.error(`Studio manager error for ${watch.repo}:`, error);
      }
    }
  }

  private async buildDigest(watch: any): Promise<RepoDigest | null> {
    const [owner, repo] = watch.repo.split('/');
    if (!owner || !repo) return null;

    const digest: RepoDigest = {
      repo: watch.repo,
      channelId: watch.channelId,
      guildId: watch.guildId,
      prsNeedingReview: [],
      stalePrs: [],
      draftPrs: [],
      recentMerges: [],
      recentCommits: [],
      openIssues: { total: 0, unassigned: 0, recent: [] },
    };

    // Fetch open PRs
    try {
      const { data: prs } = await this.octokit.pulls.list({
        owner, repo, state: 'open', per_page: 30,
      });

      const now = Date.now();

      for (const pr of prs) {
        const ageHours = (now - new Date(pr.created_at).getTime()) / (1000 * 60 * 60);
        const daysSinceUpdate = (now - new Date(pr.updated_at).getTime()) / (1000 * 60 * 60 * 24);

        if (pr.draft) {
          digest.draftPrs.push({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            author: pr.user?.login || 'unknown',
          });
        } else if (pr.requested_reviewers && pr.requested_reviewers.length > 0) {
          digest.prsNeedingReview.push({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            author: pr.user?.login || 'unknown',
            age: Math.round(ageHours),
            reviewers: pr.requested_reviewers.map((r: any) => r.login),
          });
        }

        if (!pr.draft && daysSinceUpdate > 3) {
          digest.stalePrs.push({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            author: pr.user?.login || 'unknown',
            daysSinceUpdate: Math.round(daysSinceUpdate),
          });
        }
      }
    } catch (error) {
      logger.debug(`Failed to fetch PRs for ${watch.repo}:`, error);
    }

    // Fetch recent merges (last 24h)
    try {
      const { data: closedPrs } = await this.octokit.pulls.list({
        owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 10,
      });

      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

      for (const pr of closedPrs) {
        if (pr.merged_at && new Date(pr.merged_at).getTime() > oneDayAgo) {
          digest.recentMerges.push({
            number: pr.number,
            title: pr.title,
            author: pr.user?.login || 'unknown',
            mergedBy: (pr as any).merged_by?.login || 'unknown',
          });
        }
      }
    } catch (error) {
      logger.debug(`Failed to fetch merged PRs for ${watch.repo}:`, error);
    }

    // Fetch recent commits (last 24h on default branch)
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: commits } = await this.octokit.repos.listCommits({
        owner, repo, since, per_page: 20,
      });

      for (const commit of commits) {
        if (commit.author?.login?.includes('[bot]')) continue;
        digest.recentCommits.push({
          sha: commit.sha.slice(0, 7),
          message: commit.commit.message.split('\n')[0].slice(0, 80),
          author: commit.author?.login || commit.commit.author?.name || 'unknown',
        });
      }
    } catch (error) {
      logger.debug(`Failed to fetch commits for ${watch.repo}:`, error);
    }

    // Fetch open issues
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner, repo, state: 'open', per_page: 50,
      });

      // Filter out PRs
      const realIssues = issues.filter((i) => !i.pull_request);
      digest.openIssues.total = realIssues.length;
      digest.openIssues.unassigned = realIssues.filter((i) => !i.assignees || i.assignees.length === 0).length;

      // Recent (last 7 days)
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      digest.openIssues.recent = realIssues
        .filter((i) => new Date(i.created_at).getTime() > oneWeekAgo)
        .slice(0, 5)
        .map((i) => ({
          number: i.number,
          title: i.title,
          author: i.user?.login || 'unknown',
          labels: (i.labels?.map((l: any) => extractLabelName(l))) || [],
        }));
    } catch (error) {
      logger.debug(`Failed to fetch issues for ${watch.repo}:`, error);
    }

    // Only post if there's something worth saying
    const hasContent = digest.prsNeedingReview.length > 0 ||
      digest.stalePrs.length > 0 ||
      digest.recentMerges.length > 0 ||
      digest.recentCommits.length > 0 ||
      digest.openIssues.recent.length > 0 ||
      digest.draftPrs.length > 0;

    if (hasContent) {
      return digest;
    }
    return null;
  }

  private async postDigestToChannel(digest: RepoDigest): Promise<void> {
    const channel = this.client.channels.cache.get(digest.channelId);
    if (!channel || !channel.isTextBased()) return;

    const db = getDb();

    // Helper: resolve GitHub username to Discord mention
    const mention = async (ghUser: string): Promise<string> => {
      const mappings = await db
        .select()
        .from(githubIdentityMappings)
        .where(eq(githubIdentityMappings.githubUsername, ghUser.toLowerCase()))
        .limit(1);
      if (mappings[0]?.discordUserId) {
        return `<@${mappings[0].discordUserId}>`;
      }
      return `**${ghUser}**`;
    };

    const parts: string[] = [];
    const [, repo] = digest.repo.split('/');

    // Header
    parts.push(`Good morning! Here's what's going on with **${repo}**:\n`);

    // Yesterday's activity
    if (digest.recentCommits.length > 0 || digest.recentMerges.length > 0) {
      const commitAuthors = [...new Set(digest.recentCommits.map((c) => c.author))];
      const authorMentions = await Promise.all(commitAuthors.map(mention));

      if (digest.recentMerges.length > 0) {
        parts.push(`**Shipped yesterday:** ${digest.recentMerges.length} PR${pluralS(digest.recentMerges.length)} merged`);
        for (const pr of digest.recentMerges) {
          parts.push(`  → [#${pr.number}](https://github.com/${digest.repo}/pull/${pr.number}) ${pr.title}`);
        }
      }

      if (digest.recentCommits.length > 0) {
        parts.push(`\n${digest.recentCommits.length} commits from ${authorMentions.join(', ')}`);
      }
    }

    // Needs attention
    if (digest.prsNeedingReview.length > 0) {
      parts.push(`\n**Waiting for review:**`);
      for (const pr of digest.prsNeedingReview) {
        const reviewerMentions = await Promise.all(pr.reviewers.map(mention));
        const ageStr = getAgeString(pr.age);
        parts.push(`  → [#${pr.number}](${pr.url}) ${pr.title} (${ageStr} old, needs ${reviewerMentions.join(', ')})`);
      }
    }

    // Stale PRs
    if (digest.stalePrs.length > 0) {
      parts.push(`\n**Getting stale** (no updates in 3+ days):`);
      for (const pr of digest.stalePrs) {
        const authorMention = await mention(pr.author);
        parts.push(`  → [#${pr.number}](${pr.url}) ${pr.title} — ${authorMention}, ${pr.daysSinceUpdate}d idle`);
      }
    }

    // Draft PRs (lighter touch)
    if (digest.draftPrs.length > 0) {
      parts.push(`\n**In progress** (${digest.draftPrs.length} draft${pluralS(digest.draftPrs.length)}):`);
      for (const pr of digest.draftPrs) {
        parts.push(`  → [#${pr.number}](${pr.url}) ${pr.title} — ${pr.author}`);
      }
    }

    // Open issues
    if (digest.openIssues.total > 0) {
      let issueStr = `\n**Issues:** ${digest.openIssues.total} open`;
      if (digest.openIssues.unassigned > 0) {
        issueStr += ` (${digest.openIssues.unassigned} unassigned)`;
      }
      parts.push(issueStr);

      if (digest.openIssues.recent.length > 0) {
        parts.push(`New this week:`);
        for (const issue of digest.openIssues.recent) {
          const labels = formatLabels(issue.labels);
          parts.push(`  → [#${issue.number}](https://github.com/${digest.repo}/issues/${issue.number}) ${issue.title}${labels}`);
        }
      }
    }

    // Nothing needs attention
    if (digest.prsNeedingReview.length === 0 && digest.stalePrs.length === 0) {
      parts.push(`\nNothing blocking — keep building! 🚇`);
    }

    // Discord embed description limit is 4096 chars — truncate at line boundaries
    let description = parts.join('\n');
    if (description.length > 4096) {
      const lines = description.split('\n');
      let truncated = '';
      for (const line of lines) {
        if ((truncated + line + '\n').length > 4000) break;
        truncated += line + '\n';
      }
      description = truncated.trimEnd() + '\n\n...(truncated — full digest too long for embed)';
    }

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b) // Amber
      .setTitle(`📋 Morning Standup — ${repo}`)
      .setDescription(description)
      .setFooter({ text: 'Daily digest from Coach Artie' })
      .setTimestamp();

    try {
      await (channel as any).send({ embeds: [embed] });
      console.log(`📋 Posted morning digest for ${digest.repo}`);
      logger.info(`Posted studio manager digest for ${digest.repo}`);
    } catch (error) {
      logger.error(`Failed to post studio manager digest:`, error);
    }
  }
}

// Singleton
let studioManager: GitHubStudioManager | null = null;

export function initializeStudioManager(client: Client): void {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  studioManager = new GitHubStudioManager(client, token);
  studioManager.start();
}

export function getStudioManager(): GitHubStudioManager | null {
  return studioManager;
}
