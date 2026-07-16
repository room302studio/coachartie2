import { logger } from '@coachartie/shared';
import { CreditMonitor } from '../monitoring/credit-monitor.js';
import { costMonitor } from '../monitoring/cost-monitor.js';

// =====================================================
// BROWNOUT CONTROLLER
// Ashby ultrastability: degrade, don't die. Before this,
// Artie had two states — full Opus personality, or total
// silence when credits ran out (which users read as an
// outage). This adds the rungs in between: as credit
// runway shrinks we step down to cheaper models and
// shorter replies instead of going dark. Visibility is
// LOGS ONLY — the vitals monitor owns operator comms.
// =====================================================

export type BrownoutMode = 'normal' | 'lean' | 'critical';

export interface BrownoutStatus {
  mode: BrownoutMode;
  runwayHours: number | null;
}

// Balance lookups can hit OpenRouter's /credits endpoint — cache so we
// pay that cost at most once per 5 minutes, not once per message.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { status: BrownoutStatus; fetchedAt: number } | null = null;

// Track the last observed mode so the FIRST transition into a degraded
// mode gets one loud logger.error (visible in prod where console level
// is warn) instead of a per-message drumbeat.
let lastMode: BrownoutMode = 'normal';

function envNumber(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Stale-while-revalidate: the balance lookup can be a live OpenRouter fetch with
// no timeout, and this sits on the per-message hot path — so a cache miss returns
// the last known status immediately and refreshes in the background. Concurrent
// messages during a refresh share the one in-flight fetch instead of stampeding.
let refreshing = false;

export async function getBrownoutMode(): Promise<BrownoutStatus> {
  const now = Date.now();
  if ((!cached || now - cached.fetchedAt >= CACHE_TTL_MS) && !refreshing) {
    refreshing = true;
    void refresh(now).finally(() => {
      refreshing = false;
    });
  }
  return cached?.status ?? { mode: 'normal', runwayHours: null };
}

// Runway = balance ÷ burn rate. The burn rate must reflect what Artie is ACTUALLY
// spending, not a fixed guess. For months this used a hardcoded $1.5/hr constant while
// the real burn was $0.3–0.6/hr, so a healthy balance looked like ~4h of runway and
// pinned Artie in CRITICAL (Haiku, 250 tokens) all day — the root cause of most
// "he's acting dumb" reports. We now read the measured burn from the cost monitor and
// only fall back to the constant when the sample is too fresh to trust (right after a
// restart). The fallback default is also lowered to a realistic 0.75/hr.
function currentBurnPerHour(): number {
  const floor = envNumber('BROWNOUT_BURN_FLOOR', 0.15); // never divide by ~0 → false infinite runway
  const fallback = envNumber('BROWNOUT_BURN_PER_HOUR', 0.75);
  try {
    const stats = costMonitor.getStats();
    const uptimeHours = stats.uptime / 3_600_000;
    // Need a stable sample: at least 15 min of uptime and some real spend. A fresh
    // process (post-deploy) hasn't spent enough to estimate — use the fallback.
    if (uptimeHours >= 0.25 && stats.costPerHour > 0) {
      return Math.max(floor, stats.costPerHour);
    }
  } catch {
    // cost monitor unavailable → fallback below
  }
  return Math.max(floor, fallback);
}

async function refresh(now: number): Promise<void> {
  let runwayHours: number | null = null;
  try {
    const balance = await CreditMonitor.getInstance().getCurrentBalance();
    const credits = balance?.credits_remaining;
    if (typeof credits === 'number' && Number.isFinite(credits)) {
      runwayHours = credits / currentBurnPerHour();
    }
  } catch (error) {
    logger.error('🕯️ Brownout: balance check failed, staying in normal mode', error);
  }

  // Unknown balance → normal. Fail toward full service: the credit
  // monitor already guards true exhaustion, so a flaky balance lookup
  // shouldn't lobotomize Artie.
  let mode: BrownoutMode = 'normal';
  if (runwayHours !== null) {
    if (runwayHours < envNumber('BROWNOUT_CRITICAL_HOURS', 6)) {
      mode = 'critical';
    } else if (runwayHours < envNumber('BROWNOUT_LEAN_HOURS', 24)) {
      mode = 'lean';
    }
  }

  if (mode !== lastMode) {
    if (mode !== 'normal') {
      logger.error(
        `🚨🕯️ BROWNOUT ENGAGED: ${lastMode} → ${mode.toUpperCase()} ` +
          `(~${runwayHours?.toFixed(1)}h of credit runway left)`
      );
    } else {
      logger.warn(`🕯️ Brownout cleared: ${lastMode} → normal (runway recovered)`);
    }
    lastMode = mode;
  }

  cached = { status: { mode, runwayHours }, fetchedAt: now };
}
