/**
 * One-line "headlines" for GitHub cards (EJ 2026-11-17: "very short summaries … like tufte, any
 * text shown should contain data, no duplication"). A cheap model reads the title plus the
 * body and writes at most ~12 words of what actually changed, with the specifics (numbers,
 * components, causes) that make a card worth scanning. The card shows the headline INSTEAD of the
 * title, never both.
 *
 * Never blocks a post: out of credits, muted, slow, or unparseable → null, and the caller
 * shows the plain title. Cached per item so a batch and a single card don't pay twice.
 */
import { logger } from '../../shared/logger.js';
import { openRouterService } from '../4-generate/openrouter.js';
import { creditMonitor } from '../budget/openrouter-balance.js';
import { isGenerationMuted } from '../../shared/kill-switch.js';

export interface HeadlineRequest {
  /** Stable cache key, e.g. "owner/repo#1499:merged". */
  key: string;
  /** What the item is: "pull request", "issue", "comment on #12 …", "review". */
  kind: string;
  title: string;
  body?: string;
  guildId?: string;
}

const HEADLINE_MAX_CHARS = 110;
const BODY_MAX_CHARS = 2500;
const CACHE_MAX = 500;
const TIMEOUT_MS = 8000;

/** Successful headlines only (a failure retries next time). Insertion-ordered, oldest evicted. */
const cache = new Map<string, string | null>();
/** Calls in progress, shared so a batch and a single post for the same item make one call. */
const inFlight = new Map<string, Promise<string | null>>();

export function headlineModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEADLINE_MODEL || env.DIGEST_MODEL || 'deepseek/deepseek-v4-flash-0731';
}

export function buildHeadlinePrompt(req: HeadlineRequest): string {
  const body = (req.body || '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, BODY_MAX_CHARS);
  let bodyBlock: string;
  if (body) {
    bodyBlock = `Body:\n${body}`;
  } else {
    bodyBlock = 'Body: (none)';
  }
  return [
    `Write a one-line summary of this GitHub ${req.kind} for a team chat feed.`,
    'Rules:',
    '- At most 12 words. Plain text: no markdown, no emoji, no quotes, no trailing period.',
    '- Say what changes or what is wrong, with the most specific data available: numbers, versions, components, causes.',
    '- It replaces the title, so fold the title in; never just repeat it word for word if the body adds anything.',
    '- Never mention the author, the repo, or "this PR"/"this issue".',
    '- If there is nothing beyond the title, return the title tightened.',
    '',
    `Title: ${req.title}`,
    bodyBlock,
  ].join('\n');
}

/** Trim a model reply to one clean line; null if it's empty or junk. */
export function cleanHeadline(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  let line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  line = line.replace(/^(summary|headline)\s*:\s*/i, '');
  line = line.replace(/^["'`*_]+|["'`*_]+$/g, '').replace(/\.$/, '').trim();
  if (line.length < 4) {
    return null;
  }
  if (line.length > HEADLINE_MAX_CHARS) {
    line = `${line.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return line;
}

function remember(key: string, value: string | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

export async function githubHeadline(req: HeadlineRequest): Promise<string | null> {
  if (!req.title) {
    return null;
  }
  if (cache.has(req.key)) {
    return cache.get(req.key) ?? null;
  }
  if (isGenerationMuted() || creditMonitor.areCreditsExhausted()) {
    return null;
  }
  // One paid call per key: concurrent posts share it, and an answer that lands after the
  // timeout is still cached for the next card instead of being paid for again.
  let call = inFlight.get(req.key);
  if (!call) {
    call = openRouterService
      .generateFromMessageChain(
        [{ role: 'user', content: buildHeadlinePrompt(req) }],
        'github-headline',
        undefined,
        headlineModel(),
        // Reasoning off: with it on, DeepSeek Flash spent even a 400-token budget thinking and
        // returned no content on 2 of 3 real PRs (probe, 2026-11-17). Off: 3/3, ~$0.00004 each.
        { guildId: req.guildId, maxTokens: 120, stepType: 'github_headline', reasoning: { enabled: false } }
      )
      .then((raw) => {
        const headline = cleanHeadline(raw);
        // Only cache real answers: an outage should get another try next post.
        if (headline) {
          remember(req.key, headline);
        }
        return headline;
      })
      .catch((error) => {
        logger.debug(`GitHub headline failed for ${req.key}: ${error}`);
        return null;
      })
      .finally(() => {
        inFlight.delete(req.key);
      });
    inFlight.set(req.key, call);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
  });
  const headline = await Promise.race([call, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return headline;
}

/** Test hook. */
export function clearHeadlineCache(): void {
  cache.clear();
}
