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
const MAX_LABELS_SHOWN = 4;
const DESCRIPTION_MAX = 1000;

/** Words that, said right before a number, mean "this is an issue/PR number". */
const CUE_WORDS = new Set(['issue', 'issues', 'ticket', 'tickets', 'bug', 'bugs', 'pr', 'prs']);
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
 * Whisper writes the hash when people say it). Ordinary numbers ("30 minutes", "request 30
 * minutes") never count.
 */
export function extractIssueRefs(text: string): number[] {
  const words = text
    .toLowerCase()
    // Spaces, commas and slashes all separate words: "#1502,#1503" is two refs.
    .split(/[\s,/]+/)
    .map((w) => w.replace(/[.,!?;:()"']+$/, '').replace(/^[("']+/, ''));
  const out: number[] = [];
  let afterCue = false;
  let previous = '';
  for (const word of words) {
    const n = asIssueNumber(word, afterCue);
    if (n !== null && !out.includes(n)) {
      out.push(n);
    }
    const isPullRequest = (word === 'request' || word === 'requests') && previous === 'pull';
    if (CUE_WORDS.has(word) || isPullRequest) {
      afterCue = true;
    } else if (afterCue && FILLER_WORDS.has(word)) {
      afterCue = true;
    } else {
      afterCue = false;
    }
    previous = word;
  }
  return out.slice(0, MAX_PER_UTTERANCE);
}

/**
 * The repo a meeting's numbers refer to: the one repo watched in its text channel, or (only if
 * the channel has none, or several) SCRIBE_ISSUE_REPO / metro-maker4. Never both: a number
 * missing from the channel's repo must not pull a same-numbered issue from another one.
 */
export function meetingRepo(guildId: string, textChannelId: string): string {
  const inChannel = listGuildWatches(guildId, textChannelId).filter((w) => w.isActive);
  if (inChannel.length === 1) {
    return inChannel[0].repo;
  }
  return process.env.SCRIBE_ISSUE_REPO || DEFAULT_REPO;
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
    facts.push(issue.assignees.slice(0, MAX_LABELS_SHOWN).join(', '));
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
    let labels = issue.labels.slice(0, MAX_LABELS_SHOWN).join(', ');
    if (issue.labels.length > MAX_LABELS_SHOWN) {
      labels += ` +${issue.labels.length - MAX_LABELS_SHOWN}`;
    }
    facts.push(labels);
  }
  let color = 0x8957e5;
  if (issue.state === 'open') {
    color = 0x238636;
  }
  let title = `#${issue.number} ${issue.title}`;
  if (title.length > 256) {
    title = `${title.slice(0, 255)}…`;
  }
  let description = facts.join(' · ');
  if (description.length > DESCRIPTION_MAX) {
    description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
  }
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setURL(issue.url)
    .setDescription(description)
    .setFooter({ text: `${repo} · mentioned in the meeting` });
}

/**
 * Per meeting: numbers already posted, and numbers being looked up right now. A failed lookup
 * or send releases its claim so a later mention can try again. Entries exist only between
 * startMeetingCallouts and clearMeetingCallouts, so a late utterance after stop can't revive one.
 */
interface MeetingState {
  posted: Set<number>;
  inFlight: Set<number>;
}
const meetings = new Map<string, MeetingState>();

export function startMeetingCallouts(sessionId: string): void {
  meetings.set(sessionId, { posted: new Set(), inFlight: new Set() });
}

export function clearMeetingCallouts(sessionId: string): void {
  meetings.delete(sessionId);
}

export async function postIssueCallouts(opts: {
  client: Client;
  sessionId: string;
  guildId: string;
  textChannelId: string;
  text: string;
}): Promise<number> {
  const refs = extractIssueRefs(opts.text);
  const state = meetings.get(opts.sessionId);
  if (refs.length === 0 || !state) {
    return 0;
  }
  const github = getGitHubIntegrationSafe();
  if (!github) {
    return 0;
  }
  const fresh = refs.filter((n) => !state.posted.has(n) && !state.inFlight.has(n));
  if (fresh.length === 0) {
    return 0;
  }
  for (const n of fresh) {
    state.inFlight.add(n);
  }

  const fullRepo = meetingRepo(opts.guildId, opts.textChannelId);
  const [owner, repo] = fullRepo.split('/');
  let posted = 0;
  try {
    const channel = await opts.client.channels.fetch(opts.textChannelId).catch(() => null);
    if (!channel || !channel.isSendable()) {
      return 0;
    }
    for (const n of fresh) {
      const issue = await github.getIssueInfo(owner, repo, n);
      // The meeting ended while we were looking it up: say nothing.
      if (!issue || meetings.get(opts.sessionId) !== state) {
        continue;
      }
      try {
        await channel.send({ embeds: [calloutEmbed(fullRepo, issue)] });
        state.posted.add(n);
        posted++;
        logger.info(`🎙️ Meeting callout: ${fullRepo}#${n} in ${opts.textChannelId}`);
      } catch (error) {
        logger.warn(`🎙️ Meeting callout post failed for ${fullRepo}#${n}:`, error);
      }
    }
  } finally {
    for (const n of fresh) {
      state.inFlight.delete(n);
    }
  }
  return posted;
}
