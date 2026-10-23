/**
 * Channel digest refresh: one cheap LLM call folds a batch of new channel messages into the
 * channel's rolling summary, and may lift out ONE thing worth remembering long-term.
 *
 * Cost shape: previous digest (~200 tok) + ≤ DIGEST batch (~40-80 short lines, ~2-4k tok) on
 * DIGEST_MODEL (default deepseek v4 flash, ~$0.04/M in) ≈ $0.0002 per refresh. The discord
 * process decides when (enough new human messages AND enough time since the last refresh);
 * this file only does the call, the parse, and the writes.
 *
 * Memory formation, deliberately strict (the firehose lesson, #91): at most one fact per
 * refresh, importance 5 (recallable but never outranking what people explicitly asked Artie
 * to remember), tagged 'channel-fact' so recall_count can be audited later, and capped per
 * channel per day. Reflection after real conversations stays the main way Artie forms
 * memories; this catches what happens while nobody's talking to him.
 */

import { logger, getSyncDb, saveChannelDigest, getChannelDigest } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';
import { MemoryService } from '../../capabilities/memory/memory.js';

export interface DigestRequest {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  /** "username: text" lines, oldest first, bots and blocked users already removed. */
  lines: string[];
  /** Discord id of the newest message in the batch — becomes the new cursor. */
  lastMessageId: string;
}

export interface DigestResult {
  digest: string;
  remembered: string | null;
}

const DIGEST_MAX_CHARS = 900;
const FACT_MAX_CHARS = 300;
const LINE_MAX_CHARS = 280;

export function digestModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIGEST_MODEL || 'deepseek/deepseek-v4-flash-0731';
}

export function factsPerChannelPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.DIGEST_FACTS_PER_DAY || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

export function buildDigestPrompt(
  previousDigest: string,
  req: Pick<DigestRequest, 'guildName' | 'channelName' | 'lines'>
): string {
  const lines = req.lines.map((l) => (l.length > LINE_MAX_CHARS ? `${l.slice(0, LINE_MAX_CHARS)}…` : l));
  return `You keep the running notes for #${req.channelName} in the ${req.guildName} Discord, so a bot named Artie knows what's going on when someone @'s him.

PREVIOUS NOTES:
${previousDigest.trim() || '(none yet)'}

NEW MESSAGES (oldest first):
${lines.join('\n')}

Return JSON only: {"digest": "...", "remember": "..." or null}

"digest": the updated notes, max 120 words, plain sentences. What's live right now: running bits and in-jokes (name them exactly), open questions nobody answered, who's around and what they're on about, the mood. Fold in the previous notes but let stale stuff go. Use people's usernames. No preamble, no "the users discussed".

"remember": usually null. Only set it for something Artie should still know in a month: a decision or announcement, a durable fact about a specific person (their project, their role, a real preference they stated), a new piece of community canon, or a promise someone made. One sentence, name the person. Gossip, moods, jokes that won't outlive the week, and anything about bots: null.`;
}

export function parseDigestResponse(raw: string): DigestResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { digest?: unknown; remember?: unknown };
    const digest = typeof parsed.digest === 'string' ? parsed.digest.trim() : '';
    if (digest.length < 20) return null;
    const remember =
      typeof parsed.remember === 'string' && parsed.remember.trim().length >= 15
        ? parsed.remember.trim().slice(0, FACT_MAX_CHARS)
        : null;
    return { digest: digest.slice(0, DIGEST_MAX_CHARS), remembered: remember };
  } catch {
    return null;
  }
}

function factsStoredToday(channelId: string): number {
  const row = getSyncDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memories
      WHERE channel_id = ? AND tags LIKE '%channel-fact%'
        AND created_at > datetime('now', '-1 day')`,
    [channelId]
  );
  return row?.n ?? 0;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export async function refreshChannelDigest(req: DigestRequest): Promise<DigestResult | null> {
  if (req.lines.length === 0) return null;
  const previous = getChannelDigest(req.channelId)?.digest ?? '';

  const raw = await openRouterService.generateFromMessageChain(
    [{ role: 'user', content: buildDigestPrompt(previous, req) }],
    'channel-digest',
    undefined,
    digestModel(),
    { guildId: req.guildId, maxTokens: 400, stepType: 'channel_digest' }
  );

  const result = parseDigestResponse(raw);
  if (!result) {
    logger.warn(`📰 Digest for #${req.channelName} unparseable — cursor not advanced`);
    return null;
  }

  saveChannelDigest({
    guildId: req.guildId,
    channelId: req.channelId,
    channelName: req.channelName,
    digest: result.digest,
    lastMessageId: req.lastMessageId,
    newMessages: req.lines.length,
  });

  if (result.remembered && factsStoredToday(req.channelId) < factsPerChannelPerDay()) {
    await MemoryService.getInstance().remember(
      'channel-digest',
      result.remembered,
      `#${req.channelName} in ${req.guildName}`,
      5,
      undefined,
      ['channel-fact', slug(req.guildName), slug(req.channelName)],
      req.guildId,
      req.channelId
    );
  } else if (result.remembered) {
    result.remembered = null; // over today's cap for this channel
  }

  logger.info(
    `📰 Digest #${req.channelName}: ${req.lines.length} msgs folded${result.remembered ? ' + 1 fact' : ''}`
  );
  return result;
}
