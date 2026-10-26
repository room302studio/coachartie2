/**
 * Bounty scaffolding — OFF. A typed stub documenting the intended flow, nothing more.
 *
 * Policy constraint (verified 2026-10-26): Discord's Developer Policy requires any paid app
 * capability to also be sold through Discord Premium Apps at price parity, which requires a
 * VERIFIED app. Artie's verification is still pending, so bounties — a real paid capability,
 * unlike the jar's voluntary tip — cannot ship yet. The jar (src/gateway/4-reply/jar-button.ts,
 * src/engine/budget/jar-earnings.ts) is exempt from the price-parity requirement because
 * donations/tips are; this is not, and must stay off until a SKU exists.
 *
 * Intended flow, once this can turn on for real (a product decision, not a code change —
 * see JAR-NOTES.md "turning bounties on later"):
 *  1. A Discord Premium Apps consumable SKU, priced to match a Stripe payment link at the
 *     same price (price parity is exactly the requirement the jar sidesteps and this can't).
 *  2. An entitlement check (Discord's entitlements API) before any bounty work starts.
 *  3. A deep-review queue — map reviews / tier lists, Artie's own top pick when EJ asked him
 *     to rank what he'd want to get paid for — capped at 2/day per user, so one popular
 *     bounty can't become an unbounded cost.
 *
 * Nothing here is wired into any running path (no tool registration, no gateway call site).
 * It exists to be inert on purpose: tests assert that with no env set, with only the flag
 * set, or with only the SKU set, every call still refuses.
 */

export interface BountyRequest {
  userId: string;
  guildId?: string;
  channelId?: string;
  /** What they want reviewed/ranked — a map, a build, a tier-list entry, etc. */
  subject: string;
}

export type BountyRefusalReason = 'disabled' | 'no-sku' | 'daily-cap';

export type BountyDecision = { allowed: false; reason: BountyRefusalReason } | { allowed: true };

const MAX_DEEP_REVIEWS_PER_DAY = 2;

function bountiesEnabled(): boolean {
  return process.env.ARTIE_BOUNTIES_ENABLED === 'true';
}

function bountySkuId(): string | null {
  const id = process.env.ARTIE_BOUNTY_SKU_ID;
  if (id && id.trim()) {
    return id.trim();
  }
  return null;
}

/** Whole-feature status, for anything (ops tooling, a future slash command) that just wants
 *  to know if bounties are live at all, without going through decideBounty. */
export function bountyStatus(): { enabled: false; reason: BountyRefusalReason } | { enabled: true } {
  if (!bountiesEnabled()) {
    return { enabled: false, reason: 'disabled' };
  }
  if (!bountySkuId()) {
    return { enabled: false, reason: 'no-sku' };
  }
  return { enabled: true };
}

// A day key in UTC is good enough for a stub that can never actually run — the real daily
// cap, once this ships, should use eastern-day.ts like everything else budget-related does.
function utcDayKey(now: Date): string {
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
}

interface DailyCount {
  day: string;
  count: number;
}

const dailyCounts = new Map<string, DailyCount>();

/** Pure decision — does NOT record usage. Call recordBountyUsage() only once allowed. */
export function decideBounty(request: BountyRequest, now: Date = new Date()): BountyDecision {
  if (!bountiesEnabled()) {
    return { allowed: false, reason: 'disabled' };
  }
  if (!bountySkuId()) {
    return { allowed: false, reason: 'no-sku' };
  }
  const dayKey = utcDayKey(now);
  const entry = dailyCounts.get(request.userId);
  if (entry && entry.day === dayKey && entry.count >= MAX_DEEP_REVIEWS_PER_DAY) {
    return { allowed: false, reason: 'daily-cap' };
  }
  return { allowed: true };
}

export function recordBountyUsage(userId: string, now: Date = new Date()): void {
  const dayKey = utcDayKey(now);
  const entry = dailyCounts.get(userId);
  if (entry && entry.day === dayKey) {
    entry.count += 1;
  } else {
    dailyCounts.set(userId, { day: dayKey, count: 1 });
  }
}

/** Test hook. */
export function resetBountyStateForTests(): void {
  dailyCounts.clear();
}
