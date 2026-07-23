/**
 * Pure transcript / formatting helpers extracted verbatim from ContextAlchemy.
 *
 * These functions depend only on their arguments (no `this`, no module state),
 * so they live here as plain functions for testability and to shrink the
 * ContextAlchemy monolith. Behavior is byte-for-byte identical to the original
 * private methods — do not change wording, regexes, or output shape.
 */

import type { IncomingMessage } from '@coachartie/shared';
import type { ContextSource } from '../context-providers/types.js';

export interface DiscordHistoryEntry {
  author: string;
  content: string;
  timestamp: string;
  isBot: boolean;
  isSelf?: boolean;
}

/**
 * Strip conversation-history poisoning from a stored assistant turn.
 * Returns '' when the turn sanitizes to nothing (pure [SILENT]/scaffolding),
 * which signals the caller to drop the turn from history.
 */
export function sanitizeAssistantMessage(content: string): string {
  // Patterns that indicate conversation history poisoning
  // These are formats the model should NEVER use, so strip them from history
  const poisonedPrefixes = [
    /^\*\*Me:\*\*\s*/i,
    /^\*\*Artie:\*\*\s*/i,
    /^\*\*Coach Artie:\*\*\s*/i,
    /^\*\*Response:\*\*\s*/i,
    /^\*\*Reply:\*\*\s*/i,
    /^\*\*Review:\*\*\s*/i,
    /^\*\*Analysis:\*\*\s*/i,
    /^\*\*Answer:\*\*\s*/i,
    /^\*\*Explanation:\*\*\s*/i,
    /^Response to (your |the )?message:\s*/i,
    /^Response to user:\s*/i,
    /^Here's my response:\s*/i,
  ];

  let sanitized = content;
  for (const pattern of poisonedPrefixes) {
    sanitized = sanitized.replace(pattern, '');
  }

  // Stored assistant turns carry orchestration scaffolding that must never be
  // replayed as "something Artie said": capability invocations/results, step
  // markers from the multi-step loop, and injected wrapper blocks. Replaying
  // these made Artie describe his own prompts as "a mess of fragments stitched
  // together" and refuse live questions as jailbreak attempts.
  sanitized = sanitized
    .replace(/<capability\b[^>]*\/>/gi, '')
    .replace(/<capability\b[^>]*>[\s\S]*?<\/capability>/gi, '')
    .replace(/<security_reminder>[\s\S]*?<\/security_reminder>/gi, '')
    .replace(/<user_message\b[^>]*>[\s\S]*?<\/user_message>/gi, '')
    .replace(/^#{0,3}\s*Step \d+\s*\/\s*\d+.*$/gim, '')
    .trim();

  // A refusal-spiral breaker: [SILENT] markers (and pure-meta parentheticals
  // that ride with them) must not replay — each replayed refusal teaches the
  // next generation to refuse too. Returning '' drops the turn from history.
  const silentStripped = sanitized
    .replace(/\[SILENT\]/gi, '')
    .replace(/^\((?:that|this)['’a-z ,.-]*\)$/gim, '')
    .trim();
  if (silentStripped.length === 0) {
    return '';
  }
  if (/^\[SILENT\]/i.test(sanitized)) {
    return '';
  }

  return sanitized;
}

/**
 * Render Discord channel history as ONE labeled transcript. Every line names its
 * speaker — including Artie's own lines ("Coach Artie (you)") — so a weak model can
 * tell a group chat apart and never attributes one person's history to another.
 */
export function renderDiscordTranscript(
  discordHistory: DiscordHistoryEntry[],
  limit: number
): string {
  const recent = discordHistory.slice(-(limit * 2));
  const lines = recent
    .filter((msg) => msg.content && msg.content.trim().length > 0)
    .map((msg) => {
      const isSelf = msg.isSelf ?? msg.isBot;
      if (isSelf) {
        return `Coach Artie (you): ${sanitizeAssistantMessage(msg.content)}`;
      }
      // msg.author already carries "Display (@username)[staff]/[bot]" labeling
      // from the discord side.
      return `${msg.author}: ${msg.content}`;
    })
    .filter((l) => l.split(': ').slice(1).join(': ').trim().length > 0);
  return lines.join('\n');
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
