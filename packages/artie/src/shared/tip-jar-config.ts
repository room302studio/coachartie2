/**
 * Whether/where Artie's tip jar button should link.
 *
 * Shared because both zones need "is the jar configured": the gateway (jar-button.ts) to
 * decide whether to attach the link button, the engine (self-meter.ts) to decide whether the
 * jar line even makes sense. The Stripe read key and payment-link id are a different concern
 * (reading earnings, not deciding visibility) and stay engine-only — see
 * src/engine/budget/jar-earnings.ts. Nothing payment-related belongs in shared.
 */

/**
 * https-only, parseable URL; anything else — missing, http, malformed, javascript:, etc. —
 * is ignored and returns null. Never throws.
 */
export function tipJarUrl(
  raw: string | undefined | null = process.env.ARTIE_TIP_JAR_URL
): string | null {
  if (!raw) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') {
    return null;
  }
  return parsed.toString();
}
