/**
 * Artie's tip jar: a Discord link button attached to substantial replies.
 *
 * Policy constraint (verified 2026-10-26): Discord's Developer Policy requires any paid app
 * capability to also be sold through Discord Premium Apps at price parity, which requires a
 * VERIFIED app — Artie's verification is still pending. Donations/tips are explicitly exempt
 * ("the Monetization Requirements … do not currently apply to donations and tips"), so a
 * voluntary Stripe payment link that unlocks nothing is safe to ship now. Bounties (a real
 * paid capability) stay OFF until a Premium Apps SKU exists — see
 * src/engine/bounty/bounty-scaffold.ts.
 *
 * Taste rule (non-negotiable, EJ 2026-10-26): Artie NEVER pitches, asks for, or mentions
 * money/tips/the jar in chat — the live prompt forbids it, and nagging about credits got him
 * switched off in September. Visibility is ONLY this link button: style Link, a url, no
 * custom_id, no interaction, no LLM cost.
 *
 * Every decision here is pure except the throttle's own Map, so stream-reply.ts's wiring
 * (one combined attachComponents call, after the suppressed-reply check) stays testable
 * without a live Discord client.
 */

import { ButtonStyle } from 'discord.js';

export const JAR_BUTTON_LABEL = "☕ Artie's token jar";

const CHANNEL_THROTTLE_MS = 6 * 60 * 60 * 1000; // once per channel per 6h
const SUBSTANTIAL_REPLY_CHARS = 900;
const MAX_ACTION_ROWS = 5; // Discord's hard limit, same constant discord-ui.ts enforces

/**
 * Did this turn do enough to earn a jar button? Length alone is a fine, testable heuristic
 * (the spec's own words). `usedQualifyingTool` is true when the turn rendered through a
 * tier-list/review-style surface — today that's discord-ui's buttons/select (the only
 * existing affordance for that), signaled by its 🎨 capability emoji having fired this turn.
 * There's no dedicated tier-list/map-review tool yet; when one exists, wire its signal in
 * here too.
 */
export function isSubstantialReply(input: {
  replyLength: number;
  usedQualifyingTool: boolean;
}): boolean {
  if (input.usedQualifyingTool) {
    return true;
  }
  return input.replyLength >= SUBSTANTIAL_REPLY_CHARS;
}

// ---------------------------------------------------------------------------
// Throttle: at most one jar button per channel per 6h. In-memory, TTL-pruned, same shape as
// on-component-click.ts's click counters.
// ---------------------------------------------------------------------------

const lastShownAt = new Map<string, number>();

function pruneExpired(now: number): void {
  if (lastShownAt.size < 500) {
    return;
  }
  for (const [channelId, at] of lastShownAt) {
    if (now - at >= CHANNEL_THROTTLE_MS) {
      lastShownAt.delete(channelId);
    }
  }
}

/** Read-only: true if a jar button already showed in this channel within the window. */
export function isJarButtonThrottled(channelId: string, now: number = Date.now()): boolean {
  pruneExpired(now);
  const at = lastShownAt.get(channelId);
  if (at === undefined) {
    return false;
  }
  return now - at < CHANNEL_THROTTLE_MS;
}

/** Record a jar button having been decided for this channel — call once per shown button. */
export function recordJarButtonShown(channelId: string, now: number = Date.now()): void {
  lastShownAt.set(channelId, now);
}

/** Test hook. */
export function resetJarButtonThrottleForTests(): void {
  lastShownAt.clear();
}

// ---------------------------------------------------------------------------
// Row building.
// ---------------------------------------------------------------------------

/** The raw action-row JSON for the jar link button: url, NO custom_id (link buttons can't
 *  carry one — Discord rejects it). Shape matches discord-ui.ts's own link-button rows
 *  exactly, since both ultimately pass through ActionRowBuilder.from(). */
export function buildJarButtonRow(url: string): Record<string, unknown> {
  return {
    type: 1, // ActionRow
    components: [
      {
        type: 2, // Button
        label: JAR_BUTTON_LABEL,
        style: ButtonStyle.Link,
        url,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The one combined decision.
// ---------------------------------------------------------------------------

export interface JarButtonInput {
  /** Already-validated jar URL (shared/tip-jar-config.ts's tipJarUrl()), or null when unset
   *  or invalid — either way, no button. */
  url: string | null;
  channelId: string | undefined | null;
  userBlocked: boolean;
  replyLength: number;
  usedQualifyingTool: boolean;
  /** How many component rows the turn already queued (discord-ui buttons/select). */
  existingRowCount: number;
  now?: number;
}

/**
 * Returns the jar button row to append, or null if nothing should be shown — covers: jar not
 * configured, no channel to throttle against, blocked user, the reply didn't earn one, no
 * room left in the 5-row cap (never bumps an existing row to make space), or the channel's
 * already had one within the last 6h.
 */
export function decideJarButton(input: JarButtonInput): Record<string, unknown> | null {
  if (!input.url || !input.channelId || input.userBlocked) {
    return null;
  }
  if (input.existingRowCount >= MAX_ACTION_ROWS) {
    return null;
  }
  if (!isSubstantialReply({ replyLength: input.replyLength, usedQualifyingTool: input.usedQualifyingTool })) {
    return null;
  }
  const now = input.now ?? Date.now();
  if (isJarButtonThrottled(input.channelId, now)) {
    return null;
  }
  return buildJarButtonRow(input.url);
}
