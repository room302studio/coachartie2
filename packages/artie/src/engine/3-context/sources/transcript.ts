/**
 * Pure transcript / formatting helpers extracted verbatim from ContextAlchemy.
 *
 * These functions depend only on their arguments (no `this`, no module state),
 * so they live here as plain functions for testability and to shrink the
 * ContextAlchemy monolith. Behavior is byte-for-byte identical to the original
 * private methods — do not change wording, regexes, or output shape.
 */

import { estimateTokens } from '../../../shared/async.js';
import {
  isSilent,
  stripChatPrefixes,
  stripInternalMarkup,
  stripSilentMarkers,
  stripToolCalls,
} from '../../../shared/clean-llm-output.js';
import type { IncomingMessage } from '../../../shared/queue/types.js';
import type { ContextSource } from './types.js';

export interface DiscordHistoryEntry {
  author: string;
  content: string;
  timestamp: string;
  isBot: boolean;
  isSelf?: boolean;
  /** Display name of whoever this line is a Discord reply to (if any). */
  replyToAuthor?: string;
  /** True when replyToAuthor is Artie himself — pairs with replyToExcerpt. */
  replyToIsSelf?: boolean;
  /** Short excerpt of Artie's own message, only set when replyToIsSelf. */
  replyToExcerpt?: string;
  /** Display names this line @-mentions (Artie excluded). */
  mentions?: string[];
  /** This line is a reply/@-mention aimed at someone other than Artie. */
  addressedElsewhere?: boolean;
}

/**
 * Compact "who's talking to whom" suffix for one transcript line — a reply arrow, an
 * @-mention list, and an "not to you" flag when the line is addressed elsewhere. Pure
 * and cheap on purpose: this rides on every line of every turn's transcript, so each
 * added token here is paid on every reply (see MULTIPLAYER-NOTES.md for the measured cost).
 */
export function formatAddressingSuffix(
  entry: Pick<DiscordHistoryEntry, 'replyToAuthor' | 'replyToIsSelf' | 'replyToExcerpt' | 'mentions' | 'addressedElsewhere'>
): string {
  const parts: string[] = [];
  if (entry.replyToAuthor) {
    if (entry.replyToIsSelf) {
      const excerpt = entry.replyToExcerpt
        ? ` ("${entry.replyToExcerpt.slice(0, 60)}${entry.replyToExcerpt.length > 60 ? '…' : ''}")`
        : '';
      parts.push(`↳you${excerpt}`);
    } else {
      parts.push(`↳@${entry.replyToAuthor}`);
    }
  }
  if (entry.mentions && entry.mentions.length > 0) {
    parts.push(`→@${entry.mentions.join(',@')}`);
  }
  if (entry.addressedElsewhere) {
    parts.push('(not to you)');
  }
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

/**
 * Strip conversation-history poisoning from a stored assistant turn.
 * Returns '' when the turn sanitizes to nothing (pure [SILENT]/scaffolding),
 * which signals the caller to drop the turn from history.
 */
export function sanitizeAssistantMessage(content: string): string {
  // Patterns that indicate conversation history poisoning
  // These are formats the model should NEVER use, so strip them from history
  // (the 'history' prefix set in shared/clean-llm-output.ts).
  let sanitized = stripChatPrefixes(content, 'history');

  // Stored assistant turns carry orchestration scaffolding that must never be
  // replayed as "something Artie said": capability invocations/results, step
  // markers from the multi-step loop, and injected wrapper blocks. Replaying
  // these made Artie describe his own prompts as "a mess of fragments stitched
  // together" and refuse live questions as jailbreak attempts.
  sanitized = stripInternalMarkup(stripToolCalls(sanitized, { capability: 'self-then-paired' }), [
    'security_reminder',
    'user_message',
    'step-markers',
  ]).trim();

  // A refusal-spiral breaker: [SILENT] markers (and pure-meta parentheticals
  // that ride with them) must not replay — each replayed refusal teaches the
  // next generation to refuse too. Returning '' drops the turn from history.
  const silentStripped = stripSilentMarkers(sanitized)
    .replace(/^\((?:that|this)['’a-z ,.-]*\)$/gim, '')
    .trim();
  if (silentStripped.length === 0) {
    return '';
  }
  if (isSilent(sanitized)) {
    return '';
  }

  return sanitized;
}

/** Token ceiling for the rendered transcript. See the note in renderDiscordTranscript. */
export const DEFAULT_TRANSCRIPT_MAX_TOKENS = 2000;

/**
 * Render Discord channel history as ONE labeled transcript. Every line names its
 * speaker — including Artie's own lines ("Coach Artie (you)") — so a weak model can
 * tell a group chat apart and never attributes one person's history to another.
 *
 * Capped by TOKENS, not just message count. A count-only cap prices the transcript in
 * whatever people happened to type: Subway Builder averages 269 chars per message against
 * Room 302's 78, with single messages up to 6K chars, so the same "50 messages" was worth
 * ~3.4K tokens in one guild and ~1K in another — and a few pasted walls of text could blow
 * past both. This block is also appended after the context budget has already been spent,
 * so nothing downstream would catch it. Newest messages are kept; oldest are dropped first.
 */
export function renderDiscordTranscript(
  discordHistory: DiscordHistoryEntry[],
  limit: number,
  maxTokens: number = DEFAULT_TRANSCRIPT_MAX_TOKENS
): string {
  const recent = discordHistory.slice(-(limit * 2));
  const lines = recent
    // A line with no content is only noise when it ALSO has nothing to say about who it
    // was addressed to — otherwise "who replied to whom" is worth a line on its own
    // (the non-privileged-intents case: other people's messages arrive content-blank).
    .filter(
      (msg) =>
        (msg.content && msg.content.trim().length > 0) ||
        msg.replyToAuthor !== undefined ||
        (msg.mentions?.length ?? 0) > 0
    )
    .map((msg) => {
      const isSelf = msg.isSelf ?? msg.isBot;
      const suffix = formatAddressingSuffix(msg);
      if (isSelf) {
        const sanitized = sanitizeAssistantMessage(msg.content);
        return sanitized ? `Coach Artie (you)${suffix}: ${sanitized}` : '';
      }
      // msg.author already carries "Display (@username)[staff]/[bot]" labeling
      // from the discord side. No content (non-privileged intents) still gets a line so
      // the reply-chain / @-mention metadata isn't lost.
      const body = msg.content && msg.content.trim().length > 0 ? msg.content : '[no text]';
      return `${msg.author}${suffix}: ${body}`;
    })
    .filter((l) => l.split(': ').slice(1).join(': ').trim().length > 0);

  if (maxTokens <= 0) {
    return lines.join('\n');
  }

  // Walk backwards from the most recent line, keeping what fits. A single line longer than
  // the whole budget is truncated rather than dropped — losing the message that was just
  // sent would be worse than shortening it.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(lines[i]);
    if (used + cost > maxTokens) {
      if (kept.length === 0) {
        kept.unshift(`${lines[i].slice(0, maxTokens * 4)}…`);
      }
      break;
    }
    kept.unshift(lines[i]);
    used += cost;
  }
  return kept.join('\n');
}

/**
 * Format learned community-feedback rules into a context block, grouped by tag
 * and thresholded by confidence. Returns '' when there are no rules.
 */
export function formatLearnedRulesForContext(
  rules: Array<{ id: number; ruleText: string; sourceTag: string; confidence: number }>,
  guildId?: string
): string {
  if (rules.length === 0) return '';

  const lines: string[] = ['📚 LEARNED RESPONSE GUIDELINES (from community feedback):'];

  // Group rules by sourceTag for organization
  const rulesByTag: Record<string, typeof rules> = {};
  for (const rule of rules) {
    const tag = rule.sourceTag || 'general';
    if (!rulesByTag[tag]) rulesByTag[tag] = [];
    rulesByTag[tag].push(rule);
  }

  // Format each group
  for (const [tag, tagRules] of Object.entries(rulesByTag)) {
    // Only show high-confidence rules prominently
    const highConfidence = tagRules.filter((r) => r.confidence >= 0.7);
    const mediumConfidence = tagRules.filter((r) => r.confidence >= 0.5 && r.confidence < 0.7);

    if (highConfidence.length > 0) {
      lines.push(`\n**${tag.toUpperCase()}:**`);
      for (const rule of highConfidence) {
        lines.push(`• ${rule.ruleText}`);
      }
    }

    if (mediumConfidence.length > 0) {
      if (highConfidence.length === 0) {
        lines.push(`\n**${tag.toUpperCase()}** (suggested):`);
      }
      for (const rule of mediumConfidence) {
        lines.push(`• (suggested) ${rule.ruleText}`);
      }
    }
  }

  if (guildId) {
    lines.push(
      '\n_These guidelines are specific to this community and were learned from feedback._'
    );
  }

  return lines.join('\n');
}

/**
 * The distinct people active in this conversation — pulled from the live Discord
 * transcript's speaker labels plus the current speaker. Used to steer memory recall
 * toward the people actually present (see addRelevantMemories). Excludes Artie himself
 * and bots; caps the list so the recall query stays lean. Returns [] off-Discord.
 */
export function extractParticipants(message: IncomingMessage): string[] {
  const names = new Set<string>();
  const history = (message.context as any)?.channelHistory;
  if (Array.isArray(history)) {
    for (const h of history) {
      if (!h || h.isSelf || h.isBot) continue; // not Artie, not other bots
      const author = typeof h.author === 'string' ? h.author : '';
      // "Rebecka (@rebecka) [staff]" -> "Rebecka (@rebecka)" — keep display + handle
      // (both are how memories name people), drop the role/bot tags.
      const cleaned = author.replace(/\s*\[(bot|staff)\]/gi, '').trim();
      if (cleaned) names.add(cleaned);
    }
  }
  const speaker = (message.context as any)?.displayName || (message.context as any)?.username;
  if (speaker) names.add(String(speaker));
  return Array.from(names).slice(0, 12);
}

/**
 * Bucket context sources by category, seeding the canonical category order and
 * creating buckets on demand for any unexpected category.
 */
export function groupContextByCategory(
  sources: ContextSource[]
): Record<string, ContextSource[]> {
  const grouped: Record<string, ContextSource[]> = {
    temporal: [],
    goals: [],
    memory: [],
    capabilities: [],
    user_state: [],
    evidence: [],
    system: [],
  };

  for (const source of sources) {
    // Safely handle unknown categories by creating the array if needed
    if (!grouped[source.category]) {
      grouped[source.category] = [];
    }
    grouped[source.category].push(source);
  }

  return grouped;
}
