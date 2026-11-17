/**
 * What a GitHub card SAYS. Pure: event (+ optional headline) in, card data out. No Discord I/O,
 * no model calls (poster.ts fetches headlines and sends; this file only renders).
 *
 * The house style (EJ 2026-11-17: "like tufte, any text shown should contain data, no
 * duplication"):
 *   title        `#N <headline or title>`  (the headline REPLACES the title, never sits beside it)
 *   description  ONE facts line joined by " · "  (state, +adds −dels, files, who, labels),
 *                plus at most one quoted line for comments/reviews
 *   footer       the repo, once
 *   color        the state (open/merged/failed …), so no emoji is needed
 *
 * To change how a card reads, edit the matching case in `renderCard` or `batchLine`.
 * To change limits (lines per batch, title lengths, when a headline is worth asking for), edit
 * the constants just below. Every event type has a fixture in tests/gateway/github-cards.test.ts.
 */
import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import type { GitHubSyncEvent, GitHubEventType } from './poller.js';
import type { ProcessedEvent } from './event-batcher.js';

// --- tunables ---------------------------------------------------------------------------

/** Lines shown in a batch card before "+N more". */
export const BATCH_LINES_SHOWN = 5;
/** Max chars of a title inside a one-line list entry. */
const LINE_TITLE_CHARS = 80;
/** Max chars of a comment/review quoted inline when there's no headline. */
const QUOTE_CHARS = 280;
/** Max chars of a comment in a batch line when there's no headline. */
const BATCH_QUOTE_CHARS = 80;
/** Bodies shorter than this aren't worth a headline call: the title already says it all. */
const HEADLINE_MIN_BODY_CHARS = 40;
/** Comments/reviews at or under this length are shown whole instead of summarized. */
const HEADLINE_MIN_COMMENT_CHARS = 160;
/** Commits listed on a push card. */
const PUSH_COMMITS_SHOWN = 5;
/** Base branches whose merges are "live". */
const LIVE_BRANCHES = ['main', 'master', 'beta', 'production', 'prod'];
/** Labels that make a merge read as BREAKING (substring match, case-insensitive). */
const IMPORTANT_LABELS = ['breaking-change', 'breaking', 'security', 'critical', 'urgent', 'hotfix'];

const GRAY = 0x6e7681;
const GREEN = 0x238636;
const BLUE = 0x1f6feb;
const PURPLE = 0x8957e5;
const RED = 0xda3633;
const AMBER = 0xd29922;
const ORANGE = 0xdb6d28;

/** State → color. A card's color is its status light. */
const EVENT_COLORS: Record<GitHubEventType, number> = {
  pr_opened: GREEN,
  pr_ready_for_review: BLUE,
  pr_merged: PURPLE,
  pr_closed: RED,
  pr_approved: GREEN,
  pr_changes_requested: AMBER,
  pr_comment: GRAY,
  pr_review: GRAY,
  ci_success: GREEN,
  ci_failure: RED,
  issue_opened: GREEN,
  issue_closed: PURPLE,
  issue_comment: GRAY,
  issue_labeled: AMBER,
  issue_assigned: BLUE,
  pr_review_requested: AMBER,
  pr_draft: GRAY,
  push: BLUE,
};

/** PR size by total lines changed; L and XL get a "needs extra review" fact and a warmer color. */
const PR_SIZES: Array<{ label: string; maxLines: number; color: number }> = [
  { label: 'XS', maxLines: 10, color: GREEN },
  { label: 'S', maxLines: 50, color: GREEN },
  { label: 'M', maxLines: 200, color: AMBER },
  { label: 'L', maxLines: 500, color: ORANGE },
  { label: 'XL', maxLines: Infinity, color: RED },
];

// --- card data ---------------------------------------------------------------------------

export interface CardData {
  title: string;
  url?: string;
  description?: string;
  footer: string;
  color: number;
  /** ISO time shown by Discord next to the footer. */
  timestamp?: string;
}

/** The one place card data becomes a Discord embed (also used by meeting callouts). */
export function cardToEmbed(card: CardData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(card.color)
    .setTitle(truncate(card.title || card.footer, 256))
    .setFooter({ text: truncate(card.footer, 2048) });
  if (isLinkable(card.url)) {
    embed.setURL(card.url);
  }
  if (card.description) {
    embed.setDescription(truncate(card.description, 4096));
  }
  if (card.timestamp) {
    const when = new Date(card.timestamp);
    if (!Number.isNaN(when.getTime())) {
      embed.setTimestamp(when);
    }
  }
  return embed;
}

// --- single-event cards ------------------------------------------------------------------

export function renderCard(event: GitHubSyncEvent, headline: string | null = null): CardData {
  const d = event.data;
  const stats = statFacts(d.additions, d.deletions, d.changedFiles);
  const labels = cleanLabels(d.labels || d.issueLabels || []);
  let labelFact: string | undefined;
  if (labels.length > 0) {
    labelFact = labels.join(', ');
  }

  let title: string;
  let url: string | undefined;
  let facts: Array<string | undefined> = [];
  let quote: string | undefined;
  let color = EVENT_COLORS[event.type] ?? GRAY;

  switch (event.type) {
    case 'pr_opened': {
      title = numbered(d.prNumber, headline || d.prTitle);
      url = d.prUrl;
      const size = prSize(d.additions, d.deletions);
      color = size.color;
      let sizeFact: string | undefined;
      if (size.label === 'L' || size.label === 'XL') {
        sizeFact = `${size.label}, needs extra review`;
      }
      facts = [`opened → ${d.prBaseBranch || 'main'}`, ...stats, sizeFact, d.prAuthor, labelFact];
      break;
    }
    case 'pr_draft':
      title = numbered(d.prNumber, headline || d.prTitle);
      url = d.prUrl;
      facts = ['draft', ...stats, d.prAuthor];
      break;
    case 'pr_ready_for_review': {
      title = numbered(d.prNumber, headline || d.prTitle);
      url = d.prUrl;
      let reviewFact: string | undefined;
      if (d.reviewers && d.reviewers.length > 0) {
        reviewFact = `review: ${d.reviewers.join(', ')}`;
      }
      facts = ['ready for review', ...stats, d.prAuthor, reviewFact];
      break;
    }
    case 'pr_merged': {
      title = numbered(d.prNumber, headline || d.prTitle);
      url = d.prUrl;
      const base = d.prBaseBranch || 'main';
      let mergedFact = `merged → ${base}`;
      if (hasImportantLabel(d.labels)) {
        mergedFact = `BREAKING, merged → ${base}`;
        color = AMBER;
      } else if (LIVE_BRANCHES.includes(base.toLowerCase())) {
        mergedFact = `merged → ${base}, live`;
        color = GREEN;
      }
      let byFact = d.prAuthor;
      if (d.mergedBy && d.prAuthor && d.mergedBy !== d.prAuthor) {
        byFact = `${d.prAuthor}, merged by ${d.mergedBy}`;
      }
      facts = [mergedFact, ...stats, byFact];
      break;
    }
    case 'pr_closed':
      title = numbered(d.prNumber, headline || d.prTitle);
      url = d.prUrl;
      facts = ['closed unmerged', d.prAuthor];
      break;
    case 'pr_approved':
    case 'pr_changes_requested':
    case 'pr_review': {
      title = numbered(d.prNumber, d.prTitle || 'review');
      url = d.prUrl;
      let verdict = `${(d.reviewState || 'reviewed').toLowerCase().replace(/_/g, ' ')} by ${d.reviewAuthor}`;
      if (event.type === 'pr_approved') {
        verdict = `approved by ${d.reviewAuthor}`;
      } else if (event.type === 'pr_changes_requested') {
        verdict = `changes requested by ${d.reviewAuthor}`;
      }
      facts = [verdict];
      if (d.reviewBody) {
        quote = headline || truncate(d.reviewBody, QUOTE_CHARS);
      }
      break;
    }
    case 'pr_review_requested': {
      title = numbered(d.prNumber, d.prTitle);
      url = d.prUrl;
      let byFact: string | undefined;
      if (d.reviewRequestedBy) {
        byFact = `by ${d.reviewRequestedBy}`;
      }
      facts = [`review requested: ${(d.reviewers || []).join(', ') || 'someone'}`, byFact];
      break;
    }
    case 'pr_comment':
    case 'issue_comment': {
      title = numbered(d.prNumber ?? d.issueNumber, d.prTitle || d.issueTitle || 'comment');
      url = d.commentUrl || d.prUrl || d.issueUrl;
      quote = `**${d.commentAuthor || 'someone'}**: ${headline || truncate(d.commentBody || '', QUOTE_CHARS)}`;
      break;
    }
    case 'issue_opened':
      title = numbered(d.issueNumber, headline || d.issueTitle);
      url = d.issueUrl;
      facts = ['new issue', d.issueAuthor, labelFact];
      break;
    case 'issue_closed': {
      title = numbered(d.issueNumber, headline || d.issueTitle);
      url = d.issueUrl;
      let closedFact = 'closed';
      if (d.closedBy) {
        closedFact = `closed by ${d.closedBy}`;
      }
      facts = [closedFact];
      break;
    }
    case 'issue_labeled': {
      title = numbered(d.issueNumber, d.issueTitle);
      url = d.issueUrl;
      let byFact: string | undefined;
      if (d.commentAuthor) {
        byFact = `by ${d.commentAuthor}`;
      }
      facts = [`labeled ${cleanLabels([d.label || '?'])[0]}`, byFact];
      break;
    }
    case 'issue_assigned': {
      title = numbered(d.issueNumber, d.issueTitle);
      url = d.issueUrl;
      let byFact: string | undefined;
      if (d.assignedBy && d.assignedBy !== d.assignee) {
        byFact = `by ${d.assignedBy}`;
      }
      facts = [`assigned → ${d.assignee}`, byFact];
      break;
    }
    case 'ci_success':
    case 'ci_failure': {
      let outcome = 'passed';
      if (event.type === 'ci_failure') {
        outcome = 'failed';
      }
      title = `${d.checkRunName || 'CI'} ${outcome}`;
      url = d.checkRunUrl;
      let prFact: string | undefined;
      if (d.prNumber) {
        prFact = `#${d.prNumber}`;
      }
      facts = [prFact, d.branch];
      break;
    }
    case 'push': {
      const count = d.commitCount || 1;
      title = `${count} ${plural(count, 'commit')} → ${d.branch || 'main'}`;
      url = d.commitUrl;
      const commits = d.commits || [];
      const lines = commits
        .slice(0, PUSH_COMMITS_SHOWN)
        .map((c) => `[\`${c.sha}\`](${c.url}) ${truncate(c.message, LINE_TITLE_CHARS)} · ${c.author}`);
      if (commits.length > PUSH_COMMITS_SHOWN) {
        lines.push(`+${commits.length - PUSH_COMMITS_SHOWN} more`);
      }
      quote = lines.join('\n') || d.commitMessage;
      break;
    }
    default:
      // A type with no case still says something real (2026-11-17: never a raw event type).
      title = fallbackLine(event);
      break;
  }

  return {
    title,
    url,
    description: joinDescription(facts, quote),
    footer: event.repo,
    color,
    timestamp: event.timestamp,
  };
}

// --- batch cards -------------------------------------------------------------------------

/** Batch lines that render a headline; the others ("X approved", "CI passed") don't pay for one. */
export const BATCH_HEADLINE_TYPES: ReadonlySet<GitHubEventType> = new Set<GitHubEventType>([
  'issue_opened',
  'issue_closed',
  'issue_comment',
  'pr_comment',
  'pr_opened',
  'pr_draft',
  'pr_ready_for_review',
  'pr_merged',
  'pr_closed',
]);

/** `headlines[i]` belongs to `events[i]` (only the first BATCH_LINES_SHOWN are read). */
export function renderBatchCard(events: ProcessedEvent[], headlines: Array<string | null> = []): CardData {
  const first = events[0].event;
  const lines = events.slice(0, BATCH_LINES_SHOWN).map((e, i) => batchLine(e.event, headlines[i] ?? null));
  if (events.length > BATCH_LINES_SHOWN) {
    lines.push(`+${events.length - BATCH_LINES_SHOWN} more`);
  }
  const top = [...events].sort((a, b) => b.priority - a.priority)[0].event;
  return {
    title: batchTitle(events),
    description: lines.join('\n'),
    footer: first.repo,
    color: EVENT_COLORS[top.type] ?? GRAY,
  };
}

/** "4 new issues opened by ejfox", "CI: 3 passed, 1 failed": the counts are the headline. */
export function batchTitle(events: ProcessedEvent[]): string {
  const first = events[0].event;
  const count = events.length;
  const authorsOf = (pick: (e: GitHubSyncEvent) => string | undefined): string =>
    [...new Set(events.map((e) => pick(e.event)).filter(Boolean))].join(', ');

  switch (first.type) {
    case 'pr_comment':
      return `${count} comments on PR #${first.data.prNumber} · ${authorsOf((e) => e.data.commentAuthor)}`;
    case 'issue_comment':
      return `${count} comments on #${first.data.issueNumber} · ${authorsOf((e) => e.data.commentAuthor)}`;
    case 'ci_success':
    case 'ci_failure': {
      const passed = events.filter((e) => e.event.type === 'ci_success').length;
      const failed = count - passed;
      const parts: string[] = [];
      if (passed > 0) {
        parts.push(`${passed} passed`);
      }
      if (failed > 0) {
        parts.push(`${failed} failed`);
      }
      return `CI: ${parts.join(', ')}`;
    }
    case 'pr_review':
    case 'pr_approved':
    case 'pr_changes_requested': {
      const approved = events.filter((e) => e.event.type === 'pr_approved').length;
      const changes = events.filter((e) => e.event.type === 'pr_changes_requested').length;
      const parts: string[] = [];
      if (approved > 0) {
        parts.push(`${approved} approved`);
      }
      if (changes > 0) {
        parts.push(`${changes} requested changes`);
      }
      if (parts.length === 0) {
        parts.push(`${count} reviews`);
      }
      // The PR title once, here, so the per-review lines don't each repeat it.
      return `${numbered(first.data.prNumber, truncate(first.data.prTitle || '', LINE_TITLE_CHARS))}: ${parts.join(', ')}`;
    }
    case 'issue_opened':
      return `${count} new issues · ${authorsOf((e) => e.data.issueAuthor)}`;
    case 'issue_closed':
      return `${count} issues closed`;
    default:
      return `${count} ${plural(count, 'event')} · ${first.repo}`;
  }
}

/** One list line for a batch card: `[#N](url) title`, plus who/what where that's the data. */
export function batchLine(event: GitHubSyncEvent, headline: string | null = null): string {
  const d = event.data;
  switch (event.type) {
    case 'pr_comment':
      return `${d.commentAuthor}: ${headline || truncate(d.commentBody || '', BATCH_QUOTE_CHARS)}`;
    case 'issue_comment':
      return `${linked(d.issueNumber, d.issueUrl)} ${d.commentAuthor}: ${headline || truncate(d.commentBody || '', BATCH_QUOTE_CHARS)}`;
    case 'pr_approved':
      return `${d.reviewAuthor} approved`;
    case 'pr_changes_requested':
      return `${d.reviewAuthor} requested changes`;
    case 'pr_review':
      return `${linked(d.prNumber, d.prUrl)} ${d.reviewAuthor} reviewed`;
    case 'pr_review_requested':
      return `${linked(d.prNumber, d.prUrl)} review requested: ${(d.reviewers || []).join(', ') || 'someone'}`;
    case 'push': {
      const count = d.commitCount || 1;
      return `${count} ${plural(count, 'commit')} → ${d.branch || 'main'}`;
    }
    case 'ci_success':
      return `${d.checkRunName} passed`;
    case 'ci_failure':
      return `${d.checkRunName} failed`;
    case 'issue_opened':
    case 'issue_closed':
      return listEntry(d.issueNumber, d.issueUrl, headline || d.issueTitle);
    case 'issue_labeled':
      return `${linked(d.issueNumber, d.issueUrl)} +\`${cleanLabels([d.label || '?'])[0]}\``;
    case 'issue_assigned':
      return `${linked(d.issueNumber, d.issueUrl)} → ${d.assignee}`;
    case 'pr_opened':
    case 'pr_draft':
    case 'pr_ready_for_review':
    case 'pr_merged':
    case 'pr_closed':
      return listEntry(d.prNumber, d.prUrl, headline || d.prTitle);
    default:
      return fallbackLine(event);
  }
}

// --- headlines -------------------------------------------------------------------------------

export interface HeadlineRequest {
  key: string;
  kind: string;
  title: string;
  body: string;
}

/**
 * What to send the headline model for this event, or null when the plain text is already the best
 * data (no body to distill, or a comment short enough to show whole). The key carries a content
 * hash so an edited title/body gets a fresh headline instead of a cached stale one.
 */
export function headlineRequestFor(event: GitHubSyncEvent): HeadlineRequest | null {
  const d = event.data;
  switch (event.type) {
    case 'pr_opened':
    case 'pr_draft':
    case 'pr_ready_for_review':
    case 'pr_merged':
    case 'pr_closed':
      if (!d.prTitle || !d.prBody || d.prBody.trim().length < HEADLINE_MIN_BODY_CHARS) {
        return null;
      }
      return {
        key: `${event.repo}#${d.prNumber}:pr:${contentHash(d.prTitle, d.prBody)}`,
        kind: 'pull request',
        title: d.prTitle,
        body: d.prBody,
      };
    case 'issue_opened':
    case 'issue_closed':
      if (!d.issueTitle || !d.issueBody || d.issueBody.trim().length < HEADLINE_MIN_BODY_CHARS) {
        return null;
      }
      return {
        key: `${event.repo}#${d.issueNumber}:issue:${contentHash(d.issueTitle, d.issueBody)}`,
        kind: 'issue',
        title: d.issueTitle,
        body: d.issueBody,
      };
    case 'pr_comment':
    case 'issue_comment': {
      const body = d.commentBody || '';
      if (body.length <= HEADLINE_MIN_COMMENT_CHARS) {
        return null;
      }
      return {
        key: `${event.repo}#${d.prNumber ?? d.issueNumber}:comment:${d.commentId ?? contentHash('', body)}`,
        kind: 'comment (summarize only what the comment says)',
        title: truncate(body.split('\n')[0], 120),
        body,
      };
    }
    case 'pr_approved':
    case 'pr_changes_requested':
    case 'pr_review': {
      const body = d.reviewBody || '';
      if (body.length <= HEADLINE_MIN_COMMENT_CHARS) {
        return null;
      }
      return {
        key: `${event.repo}#${d.prNumber}:review:${d.reviewId ?? contentHash('', body)}`,
        kind: 'code review (summarize only what the reviewer asks for)',
        title: truncate(body.split('\n')[0], 120),
        body,
      };
    }
    default:
      return null;
  }
}

// --- small shared helpers ----------------------------------------------------------------

/** `#1502 Title`, or just the text when there's no number. */
export function numbered(num: number | undefined, text: string | undefined): string {
  if (num === undefined) {
    return text || '';
  }
  return `#${num} ${text || ''}`.trim();
}

/** "+412 −88", "14 files": only what's known. */
export function statFacts(additions?: number, deletions?: number, files?: number): string[] {
  const out: string[] = [];
  if (additions !== undefined || deletions !== undefined) {
    out.push(`+${additions || 0} −${deletions || 0}`);
  }
  if (files) {
    out.push(`${files} ${plural(files, 'file')}`);
  }
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Only real http(s) URLs: discord.js throws on anything else, which would drop the post. */
export function isLinkable(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function joinDescription(facts: Array<string | undefined>, quote: string | undefined): string | undefined {
  const factLine = facts.filter((f): f is string => Boolean(f)).join(' · ');
  const text = [factLine, quote].filter((s): s is string => Boolean(s)).join('\n');
  return text || undefined;
}

function linked(num: number | undefined, url: string | undefined): string {
  if (isLinkable(url)) {
    return `[#${num}](${url})`;
  }
  return `#${num}`;
}

function listEntry(num: number | undefined, url: string | undefined, title: string | undefined): string {
  if (!title) {
    return linked(num, url);
  }
  return `${linked(num, url)} ${truncate(title, LINE_TITLE_CHARS)}`;
}

function fallbackLine(event: GitHubSyncEvent): string {
  const kind = event.type.replace(/_/g, ' ');
  const d = event.data;
  if (d.issueNumber) {
    return `${listEntry(d.issueNumber, d.issueUrl, d.issueTitle)} (${kind})`;
  }
  if (d.prNumber) {
    return `${listEntry(d.prNumber, d.prUrl, d.prTitle)} (${kind})`;
  }
  return kind;
}

/** Labels go inside backticks in some lines; a backtick in a label would break out. */
function cleanLabels(labels: string[]): string[] {
  return labels.map((l) => l.replace(/`/g, "'"));
}

function hasImportantLabel(labels?: string[]): boolean {
  if (!labels || labels.length === 0) {
    return false;
  }
  return labels.some((label) => IMPORTANT_LABELS.some((important) => label.toLowerCase().includes(important)));
}

function prSize(additions?: number, deletions?: number): { label: string; color: number } {
  const total = (additions || 0) + (deletions || 0);
  return PR_SIZES.find((s) => total <= s.maxLines) ?? PR_SIZES[PR_SIZES.length - 1];
}

function plural(n: number, noun: string): string {
  if (n === 1) {
    return noun;
  }
  return `${noun}s`;
}

function contentHash(title: string, body: string): string {
  return createHash('sha1').update(title).update('\0').update(body).digest('hex').slice(0, 10);
}
