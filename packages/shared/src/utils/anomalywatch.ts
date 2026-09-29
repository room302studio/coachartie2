import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { logger } from './logger.js';
import { easternDayKey } from './eastern-day.js';
import { getSyncDb } from '../db/client.js';

/**
 * Operator alerts go to anomalywatch — never to Discord.
 *
 * Credit, balance, burn-rate, distress and vitals alerts used to be DMed (and at times posted
 * to a public channel: 73 "Credits Exhausted" posts in three days). Anomalywatch is the house
 * alert brain — it scores, dedups and decides what reaches a phone — so Artie hands it the
 * fact and stops there.
 *
 * On the VPS the canonical sender is `alert.sh <source> <level> <message>`; Artie runs
 * natively under PM2 on that host, so we shell out to it. The HTTP endpoint needs a token
 * we don't hold. Where the script doesn't exist (local dev, tests) the alert is only logged.
 *
 * Rate limit: at most one alert per `kind` per America/New_York calendar day, recorded in
 * SQLite so it survives the frequent PM2 restarts that made every in-memory throttle a lie.
 */

export type AnomalywatchLevel = 'info' | 'warning' | 'error';
export type ReportOutcome = 'sent' | 'logged' | 'rate-limited' | 'failed';

export const ANOMALYWATCH_SOURCE = 'coach-artie';

/** Tried in order when ALERT_SH_PATH is unset. The first is what EJ named as canonical;
 * the second is the path social-media-behavior.ts already shells out to. */
const DEFAULT_ALERT_SH_PATHS = [
  '/home/debian/scripts/scripts/alert.sh',
  '/home/debian/scripts/alert.sh',
];

export interface AlertRateStore {
  /** Last ET day key an alert of this kind was reported, if any. */
  lastDay(kind: string): string | undefined;
  markDay(kind: string, day: string): void;
}

/** In-memory store, used by tests and as a fallback if the DB is unavailable. */
export function createMemoryAlertRateStore(): AlertRateStore {
  const days = new Map<string, string>();
  return {
    lastDay: (kind) => days.get(kind),
    markDay: (kind, day) => {
      days.set(kind, day);
    },
  };
}

let tableReady = false;
const memoryFallback = createMemoryAlertRateStore();

/** SQLite-backed store (shared by every Artie process that opens the same DB). */
export const sqliteAlertRateStore: AlertRateStore = {
  lastDay(kind) {
    try {
      ensureTable();
      const row = getSyncDb().get<{ last_day: string }>(
        'SELECT last_day FROM alert_rate_limits WHERE kind = ?',
        [kind]
      );
      return row?.last_day ?? memoryFallback.lastDay(kind);
    } catch {
      return memoryFallback.lastDay(kind);
    }
  },
  markDay(kind, day) {
    memoryFallback.markDay(kind, day);
    try {
      ensureTable();
      getSyncDb().run(
        `INSERT INTO alert_rate_limits (kind, last_day, last_sent_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(kind) DO UPDATE SET last_day = excluded.last_day,
                                         last_sent_at = excluded.last_sent_at`,
        [kind, day]
      );
    } catch (error) {
      logger.warn(`📟 alert rate-limit write failed for ${kind} (memory fallback in use):`, error);
    }
  },
};

function ensureTable(): void {
  if (tableReady) return;
  getSyncDb().run(`
    CREATE TABLE IF NOT EXISTS alert_rate_limits (
      kind TEXT PRIMARY KEY,
      last_day TEXT NOT NULL,
      last_sent_at TEXT NOT NULL
    )
  `);
  tableReady = true;
}

export function resolveAlertScriptPath(): string | null {
  const configured = process.env.ALERT_SH_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  return DEFAULT_ALERT_SH_PATHS.find((p) => existsSync(p)) ?? null;
}

/** One line, no markdown, bounded — alert.sh takes it as a single argv entry. */
export function flattenAlertMessage(message: string, max = 500): string {
  const flat = message
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type AlertExec = (
  file: string,
  args: string[],
  env?: Record<string, string>
) => Promise<void>;

const defaultExec: AlertExec = (file, args, env) =>
  new Promise((resolve, reject) => {
    // execFile, not exec: the message is argv, never parsed by a shell.
    execFile(
      file,
      args,
      { timeout: 15_000, env: env ? { ...process.env, ...env } : undefined },
      (error) => (error ? reject(error) : resolve())
    );
  });

export interface ReportOptions {
  /** Rate-limit key. One report per kind per ET day. Defaults to the level + message head. */
  kind?: string;
  now?: Date;
  store?: AlertRateStore;
  /** Overrides script resolution (null = behave as if the script is missing). */
  scriptPath?: string | null;
  exec?: AlertExec;
  /** anomalywatch alert_type (alert.sh ALERT_TYPE; default 'system'). Anomalywatch scores by
   * type, and a critical 'system' alert pages even during sleep — use a specific type. */
  alertType?: string;
  /** Link the phone notification opens (alert.sh ALERT_DEEPLINK). */
  deepLink?: string;
}

/**
 * Report an operator-facing condition to anomalywatch. Never throws, never touches Discord.
 * Use level 'error' only for real outages (Artie cannot generate at all); otherwise 'warning'.
 */
export async function reportToAnomalywatch(
  level: AnomalywatchLevel,
  message: string,
  options: ReportOptions = {}
): Promise<ReportOutcome> {
  const text = flattenAlertMessage(message);
  const kind = options.kind ?? `${level}:${text.slice(0, 60)}`;
  const store = options.store ?? sqliteAlertRateStore;
  const today = easternDayKey(options.now ?? new Date());

  let previousDay: string | undefined;
  try {
    previousDay = store.lastDay(kind);
    if (previousDay === today) {
      logger.info(`📟 anomalywatch alert '${kind}' already reported today — suppressed`);
      return 'rate-limited';
    }
    // Claim the day BEFORE sending so two concurrent callers can't both get through.
    store.markDay(kind, today);

    const script =
      options.scriptPath !== undefined ? options.scriptPath : resolveAlertScriptPath();
    if (!script) {
      logger.warn(`📟 [anomalywatch:not-sent — no alert.sh] ${level} ${kind}: ${text}`);
      return 'logged';
    }

    const env: Record<string, string> = {};
    if (options.alertType) env.ALERT_TYPE = options.alertType;
    if (options.deepLink) env.ALERT_DEEPLINK = options.deepLink;
    await (options.exec ?? defaultExec)(
      script,
      [ANOMALYWATCH_SOURCE, level, text],
      Object.keys(env).length ? env : undefined
    );
    logger.warn(`📟 anomalywatch alert sent (${level}, ${kind}): ${text}`);
    return 'sent';
  } catch (error) {
    logger.error(`📟 anomalywatch alert failed (${kind}): ${text}`, error);
    // Release the claim so a later attempt today can still get through.
    try {
      store.markDay(kind, previousDay ?? '');
    } catch {
      // best effort
    }
    return 'failed';
  }
}

/**
 * True for error text that is an operator concern (billing, credits, budget, kill switch) and
 * must never be echoed into a channel or DM as a "something went wrong" reply.
 */
export function isOperatorOnlyError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : text instanceof Error ? text.message : String(text);
  return /OUT OF CREDITS|credit|billing|\b402\b|quota|GENERATION MUTED|kill ?switch|daily budget/i.test(
    s
  );
}
