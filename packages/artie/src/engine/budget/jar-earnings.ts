/**
 * Jar earnings reader: how much has landed in Artie's tip jar this calendar month (ET).
 *
 * Sums completed Stripe Checkout Sessions for the jar's payment link, using
 * STRIPE_JAR_READ_KEY — a SEPARATE, restricted, READ-ONLY key (read on Checkout Sessions
 * only). NEVER STRIPE_RESTRICTED_KEY, the write key money/stripe.ts uses to create payment
 * links; mixing them would give this reader write access it has no reason to hold.
 *
 * Cached: refreshed on a 15-minute timer (startJarEarningsWatch, called from engine/main.ts)
 * and lazily on demand (getJarTippedUsd triggers a refresh itself if the cache is stale or
 * the ET calendar month has rolled over) — so most callers (the self-meter line, built on
 * every reply) just read the cache instead of waiting on Stripe.
 *
 * Fail soft: a failed refresh logs a warning and keeps the last known total. It never throws
 * past this module and never takes a reply down with it.
 */

import { logger } from '../../shared/logger.js';
import { easternMonthBounds, easternMonthKey } from '../../shared/eastern-day.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const PAGE_LIMIT = 100;

function readKey(): string | null {
  const key = process.env.STRIPE_JAR_READ_KEY;
  if (key && key.startsWith('rk_')) {
    return key;
  }
  return null;
}

function paymentLinkId(): string | null {
  const id = process.env.ARTIE_TIP_JAR_PAYMENT_LINK_ID;
  if (id && id.startsWith('plink_')) {
    return id;
  }
  return null;
}

/** True when both the read key and the payment link id are set and well-formed. */
export function isJarEarningsConfigured(): boolean {
  return readKey() !== null && paymentLinkId() !== null;
}

interface CheckoutSessionsPage {
  data: Array<{ id: string; amount_total: number | null }>;
  has_more: boolean;
}

async function fetchSessionsPage(
  linkId: string,
  createdGteUnixSeconds: number,
  startingAfter: string | undefined,
  key: string
): Promise<CheckoutSessionsPage> {
  const params = new URLSearchParams({
    payment_link: linkId,
    status: 'complete',
    'created[gte]': String(createdGteUnixSeconds),
    limit: String(PAGE_LIMIT),
  });
  if (startingAfter) {
    params.set('starting_after', startingAfter);
  }
  const res = await fetch(`${STRIPE_API}/checkout/sessions?${params.toString()}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body: any = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe checkout/sessions error ${res.status}`);
  }
  return { data: body.data || [], has_more: !!body.has_more };
}

/**
 * Sum `amount_total` (cents) across every completed Checkout Session for this payment link
 * created on/after `createdGteUnixSeconds`, paginating with `starting_after` until
 * `has_more` is false.
 */
export async function sumCompletedCheckoutSessionsCents(
  linkId: string,
  createdGteUnixSeconds: number,
  key: string
): Promise<number> {
  let total = 0;
  let startingAfter: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const page = await fetchSessionsPage(linkId, createdGteUnixSeconds, startingAfter, key);
    for (const session of page.data) {
      total += session.amount_total ?? 0;
    }
    hasMore = page.has_more;
    if (hasMore) {
      const last = page.data[page.data.length - 1]?.id;
      if (!last) {
        break; // defensive: has_more with no id to page from — stop rather than loop forever
      }
      startingAfter = last;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Cache.
// ---------------------------------------------------------------------------

let cachedTotalCents: number | null = null;
// Tracks the last ATTEMPT (success or failure), not the last success — a persistently
// failing key (e.g. misconfigured) must still retry on the 15-min cadence instead of every
// single reply re-hitting Stripe inline. cachedTotalCents staying null is exactly the signal
// getJarTippedUsd uses to omit the jar clause for those 15 minutes; it's not a staleness flag.
let lastAttemptAt = 0;
let lastAttemptMonthKey: string | null = null;
let inFlight: Promise<void> | null = null;

async function doRefresh(now: number): Promise<void> {
  const key = readKey();
  const linkId = paymentLinkId();
  if (!key || !linkId) {
    return;
  }
  try {
    const { start } = easternMonthBounds(new Date(now));
    const createdGteUnixSeconds = Math.floor(start.getTime() / 1000);
    const totalCents = await sumCompletedCheckoutSessionsCents(linkId, createdGteUnixSeconds, key);
    cachedTotalCents = totalCents;
  } catch (error) {
    // Fail soft: keep the last known value. Status/message only — never the key.
    logger.warn(`🫙 Jar earnings refresh failed, keeping last known value: ${(error as Error)?.message}`);
  } finally {
    // Mark the ATTEMPT regardless of outcome, so a persistently-failing Stripe call is
    // retried on the normal 15-min cadence instead of hammered on every reply.
    lastAttemptAt = now;
    lastAttemptMonthKey = easternMonthKey(new Date(now));
  }
}

function isStale(now: number): boolean {
  if (lastAttemptAt === 0) {
    return true;
  }
  if (now - lastAttemptAt >= REFRESH_INTERVAL_MS) {
    return true;
  }
  return easternMonthKey(new Date(now)) !== lastAttemptMonthKey;
}

async function ensureFresh(now: number): Promise<void> {
  if (!isStale(now)) {
    return;
  }
  if (inFlight) {
    await inFlight;
    return;
  }
  inFlight = doRefresh(now).finally(() => {
    inFlight = null;
  });
  await inFlight;
}

/**
 * Cached total tipped this ET calendar month, in USD. Null when the jar isn't configured, or
 * when it is but no refresh has ever succeeded yet. Refreshes lazily if the cache is stale or
 * the ET month rolled over — most calls (the self-meter line) just read the cache.
 */
export async function getJarTippedUsd(now: number = Date.now()): Promise<number | null> {
  if (!isJarEarningsConfigured()) {
    return null;
  }
  await ensureFresh(now);
  if (cachedTotalCents === null) {
    return null;
  }
  return cachedTotalCents / 100;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

/** Background refresh every 15 minutes (default), started once from engine/main.ts. */
export function startJarEarningsWatch(intervalMs: number = REFRESH_INTERVAL_MS): void {
  if (watchTimer || !isJarEarningsConfigured()) {
    return;
  }
  watchTimer = setInterval(() => {
    void ensureFresh(Date.now());
  }, intervalMs);
}

export function stopJarEarningsWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

/** Test hook. */
export function resetJarEarningsCacheForTests(): void {
  cachedTotalCents = null;
  lastAttemptAt = 0;
  lastAttemptMonthKey = null;
  inFlight = null;
}
