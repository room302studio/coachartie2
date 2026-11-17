/**
 * Meeting issue callouts (EJ 2026-11-17: "while we are in a meeting, if we mention an issue
 * number he posts it in the chat"). Scribe already transcribes each utterance live; this reads
 * that text for "issue 1502" / "PR 1499" / "#1502", looks the number up on GitHub, and posts a
 * one-line card in the meeting's text channel. Once per number per meeting, no model call.
 */
import { EmbedBuilder, type Client } from 'discord.js';
import { logger } from '../../shared/logger.js';
import { getGitHubIntegrationSafe } from '../watchers/github/issue-sync.js';
import { listGuildWatches } from '../watchers/github/watch-list.js';

const DEFAULT_REPO = 'Subway-Builder/metro-maker4';
const MAX_PER_UTTERANCE = 3;

/** Words that, said right before a number, mean "this is an issue/PR number". */
const CUE_WORDS = new Set(['issue', 'issues', 'ticket', 'tickets', 'bug', 'bugs', 'pr', 'prs', 'request', 'requests']);
/** Filler allowed between the cue and the number: "issue number 1502", "PR no. 12". */
const FILLER_WORDS = new Set(['number', 'no', 'num']);

/** "#1502," → 1502; "1502" → 1502; anything else → null. Two to five digits only. */
function asIssueNumber(word: string, allowBare: boolean): number | null {
  const hasHash = word.startsWith('#');
  if (!hasHash && !allowBare) {
    return null;
  }
  const digits = word.replace('#', '');
  if (digits.length < 2 || digits.length > 5) {
    return null;
  }
  for (const ch of digits) {
    if (ch < '0' || ch > '9') {
      return null;
    }
  }
  return parseInt(digits, 10);
}

/**
 * Walk the transcript word by word. A number counts when it follows a cue word ("issue 1502",
 * "issue number 1502", "PR 1499", "pull request 1501") or carries its own hash ("#1502";
 * Whisper writes the hash when people say it). Ordinary numbers ("30 minutes") never count.
 */
export function extractIssueRefs(text: string): number[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:()"']+$/, '').replace(/^[("']+/, ''));
  const out: number[] = [];
  let afterCue = false;
  for (const word of words) {
    const n = asIssueNumber(word, afterCue);
    if (n !== null && !out.includes(n)) {
      out.push(n);
    }
    if (CUE_WORDS.has(word)) {
      afterCue = true;
    } else if (afterCue && FILLER_WORDS.has(word)) {
      afterCue = true;
    } else {
      afterCue = false;
    }
  }
  return out.slice(0, MAX_PER_UTTERANCE);
}

/** Repos to try, in order: the one watched in this text channel, then the default. */
export function candidateRepos(guildId: string, textChannelId: string): string[] {
  const repos: string[] = [];
  const inChannel = listGuildWatches(guildId, textChannelId).filter((w) => w.isActive);
  if (inChannel.length === 1) {
    repos.push(inChannel[0].repo);
  }
  const fallback = process.env.SCRIBE_ISSUE_REPO || DEFAULT_REPO;
  if (!repos.includes(fallback)) {
    repos.push(fallback);
  }
  return repos;
}

export interface CalloutIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  comments: number;
}

/** Same dense shape as the GitHub feed cards: `#N title`, one facts line, repo footer. */
export function calloutEmbed(repo: string, issue: CalloutIssue): EmbedBuilder {
  const isPull = issue.url.includes('/pull/');
  let kind = 'issue';
  if (isPull) {
    kind = 'PR';
  }
  const facts = [`${kind} ${issue.state}`];
  if (issue.assignees.length > 0) {
    facts.push(issue.assignees.join(', '));
  } else if (!isPull && issue.state === 'open') {
    facts.push('unassigned');
  }
  if (issue.comments > 0) {
    let noun = 'comments';
    if (issue.comments === 1) {
      noun = 'comment';
    }
    facts.push(`${issue.comments} ${noun}`);
  }
  if (issue.labels.length > 0) {
    facts.push(issue.labels.join(', '));
  }
  let color = 0x8957e5;
  if (issue.state === 'open') {
    color = 0x238636;
  }
  let title = `#${issue.number} ${issue.title}`;
  if (title.length > 256) {
    title = `${title.slice(0, 255)}…`;
  }
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setURL(issue.url)
    .setDescription(facts.join(' · '))
    .setFooter({ text: `${repo} · mentioned in the meeting` });
}

const announced = new Map<string, Set<number>>();

/** Forget a finished meeting's numbers. */
export function clearMeetingCallouts(sessionId: string): void {
  announced.delete(sessionId);
}

export async function postIssueCallouts(opts: {
  client: Client;
  sessionId: string;
  guildId: string;
  textChannelId: string;
  text: string;
}): Promise<number> {
  const refs = extractIssueRefs(opts.text);
  if (refs.length === 0) {
    return 0;
  }
  const github = getGitHubIntegrationSafe();
  if (!github) {
    return 0;
  }
  let seen = announced.get(opts.sessionId);
  if (!seen) {
    seen = new Set<number>();
    announced.set(opts.sessionId, seen);
  }
  const channel = await opts.client.channels.fetch(opts.textChannelId).catch(() => null);
  if (!channel || !channel.isSendable()) {
    return 0;
  }

  let posted = 0;
  for (const n of refs) {
    if (seen.has(n)) {
      continue;
    }
    seen.add(n);
    for (const fullRepo of candidateRepos(opts.guildId, opts.textChannelId)) {
      const [owner, repo] = fullRepo.split('/');
      const issue = await github.getIssueInfo(owner, repo, n);
      if (!issue) {
        continue;
      }
      try {
        await channel.send({ embeds: [calloutEmbed(fullRepo, issue)] });
        posted++;
        logger.info(`🎙️ Meeting callout: ${fullRepo}#${n} in ${opts.textChannelId}`);
      } catch (error) {
        logger.warn(`🎙️ Meeting callout post failed for ${fullRepo}#${n}:`, error);
      }
      break;
    }
  }
  return posted;
}
