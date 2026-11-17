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

function formatLabels(labels: any[]): string {
  if (labels.length > 0) {
    return ` \`${labels.join('` `')}\``;
  }
  return '';
}

const MERGES_SHOWN = 8;
const LIST_SHOWN = 5;
const TITLE_CHARS = 72;

/** Show the first `max` lines, then one "+N more" link instead of a mid-list cut. */
export function capped(lines: string[], max: number, moreUrl: string): string[] {
  if (lines.length <= max) {
    return lines;
  }
  return [...lines.slice(0, max), `[+${lines.length - max} more](${moreUrl})`];
}

export function shortTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_CHARS) {
    return clean;
  }
  return `${clean.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/** "metro-maker4 · 9 merged · 3 awaiting review · 42 open issues": the counts are the headline. */
export function digestTitle(digest: {
  repo: string;
  recentMerges: unknown[];
  prsNeedingReview: unknown[];
  stalePrs: unknown[];
  openIssues: { total: number };
}): string {
  const [, repo] = digest.repo.split('/');
  const bits = [repo || digest.repo];
  if (digest.recentMerges.length > 0) {
    bits.push(`${digest.recentMerges.length} merged`);
  }
  if (digest.prsNeedingReview.length > 0) {
    bits.push(`${digest.prsNeedingReview.length} awaiting review`);
  }
  if (digest.stalePrs.length > 0) {
    bits.push(`${digest.stalePrs.length} stale`);
  }
  if (digest.openIssues.total > 0) {
    bits.push(`${digest.openIssues.total} open issues`);
  }
  return bits.join(' · ');
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
  /** Search API totals; absent when the searches failed. */
  needsHuman?: NeedsHumanCounts;
}

export interface NeedsHumanCounts {
  unassigned: number;
  unlabeled: number;
  stale: number;
}

const STALE_ISSUE_DAYS = 60;

/** One compact line, or null when there is nothing to say. Zero counts are left out. */
export function formatNeedsHumanLine(counts: NeedsHumanCounts | undefined): string | null {
  if (!counts) {
    return null;
  }
  const bits: string[] = [];
  if (counts.unassigned > 0) bits.push(`${counts.unassigned} unassigned`);
  if (counts.unlabeled > 0) bits.push(`${counts.unlabeled} unlabeled`);
  if (counts.stale > 0) bits.push(`${counts.stale} stale ${STALE_ISSUE_DAYS}d+`);
  if (bits.length === 0) {
    return null;
  }
  return `Needs a human: ${bits.join(' / ')}`;
}

/** 10 pages of 100 open issues; a repo past that gets no line rather than a wrong count. */
export const NEEDS_HUMAN_MAX_PAGES = 10;

/**
 * Counted from the open-issue list, not the search API (2026-11-13). Search has a secondary
 * limit that trips on short bursts and stays tripped for minutes; the live e2e hit it twice,
 * and the morning digest firing 3 searches per watched repo would have dropped this line on
 * most days. The list endpoint uses the 5000/hr core quota and has no index lag. Any failure
 * omits the whole line instead of showing partial counts, and says so at warn so a line that
 * silently vanishes from the digest is findable.
 */
export async function fetchNeedsHumanCounts(
  octokit: Octokit,
  owner: string,
  repo: string,
  now: Date = new Date()
): Promise<NeedsHumanCounts | undefined> {
  // Same day-granular cutoff the search qualifier updated:<YYYY-MM-DD used.
  const cutoffDay = new Date(now.getTime() - STALE_ISSUE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoffMs = new Date(`${cutoffDay}T00:00:00Z`).getTime();
  const counts: NeedsHumanCounts = { unassigned: 0, unlabeled: 0, stale: 0 };
  try {
    for (let page = 1; page <= NEEDS_HUMAN_MAX_PAGES; page++) {
      const { data } = await octokit.issues.listForRepo({ owner, repo, state: 'open', per_page: 100, page });
      for (const item of data as any[]) {
        if (item.pull_request) continue;
        if ((item.assignees ?? []).length === 0) counts.unassigned += 1;
        if ((item.labels ?? []).length === 0) counts.unlabeled += 1;
        if (new Date(item.updated_at).getTime() < cutoffMs) counts.stale += 1;
      }
      if (data.length < 100) {
        return counts;
      }
    }
    logger.warn(`Needs-a-human line dropped for ${owner}/${repo}: more than ${NEEDS_HUMAN_MAX_PAGES * 100} open items`);
    return undefined;
  } catch (error) {
    logger.warn(`Needs-a-human line dropped for ${owner}/${repo}: ${String(error)}`);
    return undefined;
  }
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

    digest.needsHuman = await fetchNeedsHumanCounts(this.octokit, owner, repo);

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

    // Dense standup (EJ 2026-11-17, "like tufte … no duplication"): the title carries the
    // counts, each section is capped with a "+N more" link instead of truncating mid-list,
    // and there's no greeting/filler line or emoji.
    const gh = `https://github.com/${digest.repo}`;
    const parts: string[] = [];

    if (digest.recentMerges.length > 0) {
      const commitAuthors = [...new Set(digest.recentCommits.map((c) => c.author))];
      let commitsClause = '';
      if (digest.recentCommits.length > 0) {
        commitsClause = ` · ${digest.recentCommits.length} commits · ${commitAuthors.join(', ')}`;
      }
      parts.push(`**merged yesterday** ${digest.recentMerges.length}${commitsClause}`);
      parts.push(
        ...capped(
          digest.recentMerges.map((pr) => {
            let by = pr.author;
            if (pr.mergedBy && pr.mergedBy !== pr.author) {
              by = `${pr.author} → ${pr.mergedBy}`;
            }
            return `[#${pr.number}](${gh}/pull/${pr.number}) ${shortTitle(pr.title)} · ${by}`;
          }),
          MERGES_SHOWN,
          `${gh}/pulls?q=is%3Apr+is%3Amerged`
        )
      );
    } else if (digest.recentCommits.length > 0) {
      const commitAuthors = [...new Set(digest.recentCommits.map((c) => c.author))];
      parts.push(`**commits yesterday** ${digest.recentCommits.length} · ${commitAuthors.join(', ')}`);
    }

    if (digest.prsNeedingReview.length > 0) {
      const lines: string[] = [];
      for (const pr of digest.prsNeedingReview) {
        const reviewerMentions = await Promise.all(pr.reviewers.map(mention));
        let needs = '';
        if (reviewerMentions.length > 0) {
          needs = ` · ${reviewerMentions.join(', ')}`;
        }
        lines.push(`[#${pr.number}](${pr.url}) ${shortTitle(pr.title)} · ${getAgeString(pr.age)}${needs}`);
      }
      parts.push(`\n**awaiting review** ${digest.prsNeedingReview.length}`);
      parts.push(...capped(lines, LIST_SHOWN, `${gh}/pulls?q=is%3Apr+is%3Aopen+review%3Arequired`));
    }

    if (digest.stalePrs.length > 0) {
      const lines: string[] = [];
      for (const pr of digest.stalePrs) {
        const authorMention = await mention(pr.author);
        lines.push(`[#${pr.number}](${pr.url}) ${shortTitle(pr.title)} · ${authorMention} · ${pr.daysSinceUpdate}d idle`);
      }
      parts.push(`\n**stale, 3+ days** ${digest.stalePrs.length}`);
      parts.push(...capped(lines, LIST_SHOWN, `${gh}/pulls?q=is%3Apr+is%3Aopen+sort%3Aupdated-asc`));
    }

    if (digest.draftPrs.length > 0) {
      parts.push(`\n**drafts** ${digest.draftPrs.length}`);
      parts.push(
        ...capped(
          digest.draftPrs.map((pr) => `[#${pr.number}](${pr.url}) ${shortTitle(pr.title)} · ${pr.author}`),
          LIST_SHOWN,
          `${gh}/pulls?q=is%3Apr+is%3Aopen+draft%3Atrue`
        )
      );
    }

    if (digest.openIssues.total > 0) {
      let issueStr = `\n**issues** ${digest.openIssues.total} open`;
      if (digest.openIssues.unassigned > 0) {
        issueStr += ` · ${digest.openIssues.unassigned} unassigned`;
      }
      parts.push(issueStr);

      const needsLine = formatNeedsHumanLine(digest.needsHuman);
      if (needsLine) {
        parts.push(needsLine);
      }

      if (digest.openIssues.recent.length > 0) {
        parts.push(`new this week ${digest.openIssues.recent.length}`);
        parts.push(
          ...capped(
            digest.openIssues.recent.map((issue) => {
              const labels = formatLabels(issue.labels);
              return `[#${issue.number}](${gh}/issues/${issue.number}) ${shortTitle(issue.title)}${labels}`;
            }),
            LIST_SHOWN,
            `${gh}/issues?q=is%3Aissue+is%3Aopen+sort%3Acreated-desc`
          )
        );
      }
    }

    // Safety net only: the caps above keep it far under Discord's 4096.
    let description = parts.join('\n');
    if (description.length > 4096) {
      const more = `\n[more on GitHub](${gh}/pulls)`;
      const budget = 4096 - more.length;
      const lines = description.split('\n');
      let kept = '';
      for (const line of lines) {
        if ((kept + line + '\n').length > budget) break;
        kept += line + '\n';
      }
      description = `${kept.trimEnd()}${more}`;
    }

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b) // Amber
      .setTitle(digestTitle(digest))
      .setURL(gh)
      .setDescription(description || 'quiet: no merges, reviews or new issues')
      .setFooter({ text: digest.repo })
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
