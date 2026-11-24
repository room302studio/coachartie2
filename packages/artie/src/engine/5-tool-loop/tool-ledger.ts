/**
 * Tool-call ledger: one persisted row per logical tool call, so Artie (and EJ) can see which
 * tools are avoided, which calls fail validation and which are refused, across restarts.
 *
 * Privacy: a row holds ONLY tool, action, outcome, a short error class/message (200 chars max),
 * duration, user id and guild id. Never params, content or results.
 *
 * Where it is written (every outcome exactly once):
 *   - CapabilityRegistry.execute (registry.ts) through trackRegistryCall: ok, invalid_args,
 *     refused_owner, queued_approval, error, unknown_tool, unknown_action.
 *   - execute.ts checkTaintBlock sites: blocked_taint (the registry is never reached).
 *   - robustExecutor.executeWithRetry (retry.ts) opens a ledger scope around its attempts, so
 *     up to 3 registry attempts (plus fallbacks) collapse into ONE row: the final outcome.
 *     Without a scope (HTTP execute-tool route, approvals replay) the registry
 *     writes its own row directly. A call made from inside another call's handler (approvals
 *     replaying a gated call) is a separate logical call and gets its own row.
 *
 * Writes never throw into the call path: every failure is swallowed (logged at debug).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRawDb, getSyncDb } from '../../shared/db/client.js';
import { logger } from '../../shared/logger.js';

export type LedgerOutcome =
  | 'ok'
  | 'invalid_args'
  | 'refused_owner'
  | 'blocked_taint'
  | 'queued_approval'
  | 'error'
  | 'unknown_tool'
  | 'unknown_action';

export const LEDGER_OUTCOMES: readonly LedgerOutcome[] = [
  'ok',
  'invalid_args',
  'refused_owner',
  'blocked_taint',
  'queued_approval',
  'error',
  'unknown_tool',
  'unknown_action',
];

export interface LedgerEntry {
  tool: string;
  action: string;
  outcome: LedgerOutcome;
  /** Short class/message, never params or results. Clipped to 200 chars on write. */
  errorClass?: string;
  durationMs?: number;
  userId?: string;
  guildId?: string;
  /** Registry attempts behind this row (retries); 1 for an unretried call. */
  attempts?: number;
}

export const LEDGER_RETENTION_DAYS = 30;
const MAX_ERROR_CHARS = 200;
const MAX_NAME_CHARS = 64;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Catches a class of bug found 2026-10-26: several tool handlers catch their own failures and
 * RETURN a string describing the error instead of throwing, so the call looks like a success.
 * Deliberately narrow and prefix-anchored (see execute.ts for the history): a leading cross
 * mark, "<Words> error: " or "Error: " at the very start, or a JSON object with
 * `success: false`. Lives here (not execute.ts) so the registry can classify without importing
 * the executor; execute.ts re-exports it.
 */
const FAILURE_TEXT_PREFIX = /^(?:[A-Za-z][\w -]{0,40}\s)?error:\s/i;

export function looksLikeToolFailure(text: string): boolean {
  if (!text) return false;
  if (text.startsWith('❌')) return true;
  if (FAILURE_TEXT_PREFIX.test(text)) return true;
  if (text[0] === '{' || text[0] === '[') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.success === false) {
        return true;
      }
    } catch {
      // Not JSON (or not parseable): not this check's problem.
    }
  }
  return false;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max);
}

/**
 * Allowlisted categories. Raw exception text is NEVER stored: it can carry user input, URLs
 * with tokens, or private content, and self-stats:tools shows these to everyone (Codex
 * 2026-11-17). The message is only pattern-matched to pick a fixed label.
 */
const ERROR_CATEGORIES: Array<[RegExp, string]> = [
  [/missing required|is required|required param/i, 'missing_param'],
  [/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError/i, 'timeout'],
  [/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i, 'network'],
  [/\b401\b|unauthori[sz]ed|invalid (api )?key/i, 'http_401'],
  [/\b403\b|forbidden|missing permissions?/i, 'http_403'],
  [/\b404\b|not found|unknown (member|user|message|channel)/i, 'not_found'],
  [/\b402\b|insufficient credits?|payment required/i, 'http_402'],
  [/\b429\b|rate.?limit|too many requests/i, 'rate_limited'],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, 'http_5xx'],
  [/JSON|Unexpected token|parse/i, 'parse_error'],
  [/invalid|must be|out of range|not allowed/i, 'invalid_input'],
];

/**
 * Explicit allowlists, not a character check: an errorCode holding a payment key or a custom
 * `class LeakyError` would pass a regex (Codex). Unknown codes become 'structured_error'.
 * Codes from createStructuredError in registry.ts / tools (grep "_00").
 */
const KNOWN_ERROR_CODES = new Set(['ACTION_NOT_FOUND_005', 'PARAM_MISSING_001', 'PARAM_MISSING_003']);
const BUILTIN_ERROR_NAMES = new Set([
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'AbortError', 'TimeoutError',
]);

/** A fixed category for an error. Structured registry errors keep only their (safe) code. */
export function describeError(error: unknown): string {
  let message: string;
  let name = 'Error';
  if (error instanceof Error) {
    message = error.message;
    name = error.name;
  } else {
    message = String(error);
  }
  if (message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed.errorCode === 'string') {
        if (KNOWN_ERROR_CODES.has(parsed.errorCode)) {
          return parsed.errorCode;
        }
        return 'structured_error';
      }
    } catch {
      // not JSON after all
    }
  }
  for (const [pattern, label] of ERROR_CATEGORIES) {
    if (pattern.test(message)) {
      return label;
    }
  }
  // Built-in error names (TypeError, RangeError...) are safe; anything else is just "error".
  if (BUILTIN_ERROR_NAMES.has(name)) {
    return name;
  }
  return 'error';
}

// ── storage ────────────────────────────────────────────────────────────────

let ensuredFor: unknown = null;
let lastPruneAt = 0;

function ensureTable(): void {
  const raw = getRawDb();
  if (ensuredFor === raw) return;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tool TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_class TEXT,
      duration_ms INTEGER,
      attempts INTEGER NOT NULL DEFAULT 1,
      user_id TEXT,
      guild_id TEXT
    )
  `);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_tool_call_ledger_ts ON tool_call_ledger(ts)`);
  ensuredFor = raw;
  lastPruneAt = 0;
}

/** Delete rows past retention. Returns the number removed (0 on any failure). */
export function pruneToolLedger(now: number = Date.now()): number {
  try {
    ensureTable();
    const cutoff = now - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const res = getSyncDb().run(`DELETE FROM tool_call_ledger WHERE ts < ?`, [cutoff]);
    lastPruneAt = now;
    return res.changes;
  } catch (error) {
    logger.debug('tool ledger prune failed', error);
    return 0;
  }
}

/**
 * Which (tool, action) pairs are real. Set by the registry (it imports this module, so the
 * ledger can't import it back). A model-invented name can carry arbitrary text, and
 * self-stats:tools shows names to everyone, so anything unregistered is stored as UNKNOWN (Codex).
 */
type NameCheck = (tool: string, action: string) => { tool: boolean; action: boolean };
let nameCheck: NameCheck | null = null;
const UNKNOWN_NAME = '(unknown)';

export function setLedgerNameCheck(check: NameCheck | null): void {
  nameCheck = check;
}

function safeNames(tool: string, action: string): { tool: string; action: string } {
  if (!nameCheck) {
    return { tool: clip(tool, MAX_NAME_CHARS), action: clip(action, MAX_NAME_CHARS) };
  }
  const known = nameCheck(tool, action);
  let safeTool = UNKNOWN_NAME;
  let safeAction = UNKNOWN_NAME;
  if (known.tool) {
    safeTool = clip(tool, MAX_NAME_CHARS);
    if (known.action) safeAction = clip(action, MAX_NAME_CHARS);
  }
  return { tool: safeTool, action: safeAction };
}

/** Insert one row. Never throws. Prunes on first use and then at most once a day. */
export function writeLedgerRow(entry: LedgerEntry, now: number = Date.now()): void {
  try {
    ensureTable();
    if (now - lastPruneAt > PRUNE_EVERY_MS) pruneToolLedger(now);
    let errorClass: string | null = null;
    if (entry.errorClass) errorClass = clip(entry.errorClass, MAX_ERROR_CHARS);
    const names = safeNames(String(entry.tool ?? ''), String(entry.action ?? ''));
    getSyncDb().run(
      `INSERT INTO tool_call_ledger (ts, tool, action, outcome, error_class, duration_ms, attempts, user_id, guild_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now,
        names.tool,
        names.action,
        entry.outcome,
        errorClass,
        Math.max(0, Math.round(entry.durationMs ?? 0)),
        entry.attempts ?? 1,
        entry.userId ?? null,
        entry.guildId ?? null,
      ]
    );
  } catch (error) {
    logger.debug('tool ledger write failed', error);
  }
}

/** Test hook: forget table/prune state so a fresh in-memory DB is re-ensured. */
export function resetToolLedgerState(): void {
  ensuredFor = null;
  lastPruneAt = 0;
}

// ── scope: collapse retries into one row ───────────────────────────────────

interface LedgerScope {
  active: boolean;
  last?: LedgerEntry;
  attempts: number;
}

const scopeStore = new AsyncLocalStorage<LedgerScope>();

/** What the registry fills in while it runs one call (see registry.ts). */
export interface RegistryCallRecord {
  tool: string;
  action: string;
  outcome?: LedgerOutcome;
  errorClass?: string;
  userId?: string;
  guildId?: string;
}

/**
 * Wrap one CapabilityRegistry.execute. `fn` sets rec.outcome for the early exits it knows
 * (refused, queued, unknown, invalid); thrown errors default to 'error' and a handler that
 * returns failure text is classified 'error' too. Inside a retry scope the entry is held for
 * the scope's single final row; otherwise it is written now.
 */
export async function trackRegistryCall<T>(
  rec: RegistryCallRecord,
  fn: () => Promise<T>
): Promise<T> {
  const scope = scopeStore.getStore();
  const nested = scope?.active === true;
  if (scope) scope.active = true;
  const startedAt = Date.now();
  try {
    const result = await fn();
    if (!rec.outcome) {
      rec.outcome = 'ok';
      if (typeof result === 'string' && looksLikeToolFailure(result)) {
        rec.outcome = 'error';
        rec.errorClass = 'returned_error_text';
      }
    }
    return result;
  } catch (error) {
    if (!rec.outcome) {
      rec.outcome = 'error';
      rec.errorClass = describeError(error);
    }
    throw error;
  } finally {
    if (scope) scope.active = nested;
    try {
      const entry: LedgerEntry = {
        tool: rec.tool,
        action: rec.action,
        outcome: rec.outcome ?? 'error',
        errorClass: rec.errorClass,
        durationMs: Date.now() - startedAt,
        userId: rec.userId,
        guildId: rec.guildId,
      };
      if (scope && !nested) {
        scope.last = entry;
        scope.attempts++;
      } else {
        writeLedgerRow(entry);
      }
    } catch {
      // never into the call path
    }
  }
}

/**
 * Run a whole retried call (retry.ts executeWithRetry) as ONE logical ledger row. `judge` maps
 * the final result to success/error so a fallback rescue or a validateResult rejection is
 * reflected, not just the last registry attempt.
 */
export async function runInLedgerScope<T>(
  meta: { tool: string; action: string; userId?: string; guildId?: string },
  fn: () => Promise<T>,
  judge: (result: T) => { success: boolean; error?: string; fallbackUsed?: boolean }
): Promise<T> {
  const scope: LedgerScope = { active: false, attempts: 0 };
  const startedAt = Date.now();
  let result: T;
  try {
    result = await scopeStore.run(scope, fn);
  } catch (error) {
    flushScope(scope, meta, startedAt, false, describeError(error));
    throw error;
  }
  try {
    const verdict = judge(result);
    flushScope(scope, meta, startedAt, verdict.success, verdict.error, verdict.fallbackUsed === true);
  } catch {
    // never into the call path
  }
  return result;
}

function flushScope(
  scope: LedgerScope,
  meta: { tool: string; action: string; userId?: string; guildId?: string },
  startedAt: number,
  success: boolean,
  errorText: string | undefined,
  fallbackUsed = false
): void {
  const last = scope.last;
  let outcome: LedgerOutcome;
  let errorClass: string | undefined;
  if (success) {
    // Only a fallback strategy can turn a failed registry attempt into a real success.
    const rescued =
      fallbackUsed &&
      (last?.outcome === 'error' ||
        last?.outcome === 'invalid_args' ||
        last?.outcome === 'unknown_action' ||
        last?.outcome === 'unknown_tool');
    if (rescued) {
      outcome = 'ok';
      errorClass = 'rescued_by_fallback';
    } else if (last) {
      // ok, or a refusal/queue that came back as a normal reply
      outcome = last.outcome;
      errorClass = last.errorClass;
    } else {
      outcome = 'ok';
    }
  } else if (last && last.outcome !== 'ok') {
    outcome = last.outcome;
    errorClass = last.errorClass;
  } else {
    // registry said ok but the result was rejected, or nothing reached the registry
    outcome = 'error';
    errorClass = 'invalid_result';
    if (!last && errorText) errorClass = describeError(errorText);
  }
  writeLedgerRow({
    tool: last?.tool ?? meta.tool,
    action: last?.action ?? meta.action,
    outcome,
    errorClass,
    durationMs: Date.now() - startedAt,
    userId: meta.userId,
    guildId: meta.guildId,
    attempts: Math.max(1, scope.attempts),
  });
}

// ── reads (self-stats) ─────────────────────────────────────────────────────

export interface LedgerCell {
  tool: string;
  action: string;
  outcome: LedgerOutcome;
  n: number;
}

export interface LedgerFailureClass {
  tool: string;
  action: string;
  outcome: LedgerOutcome;
  errorClass: string | null;
  n: number;
}

/** Counts per tool:action:outcome since `sinceMs` (epoch ms). */
export function ledgerCounts(sinceMs: number): LedgerCell[] {
  ensureTable();
  return getSyncDb().all<LedgerCell>(
    `SELECT tool, action, outcome, COUNT(*) AS n FROM tool_call_ledger WHERE ts >= ?
     GROUP BY tool, action, outcome`,
    [sinceMs]
  );
}

/** Most common failing error classes since `sinceMs`. */
export function ledgerTopFailures(sinceMs: number, limit: number): LedgerFailureClass[] {
  ensureTable();
  return getSyncDb().all<LedgerFailureClass>(
    `SELECT tool, action, outcome, error_class AS errorClass, COUNT(*) AS n FROM tool_call_ledger
     WHERE ts >= ? AND outcome != 'ok'
     GROUP BY tool, action, outcome, error_class ORDER BY n DESC LIMIT ?`,
    [sinceMs, limit]
  );
}

/** Epoch ms of the oldest ledger row, or null when the ledger is empty. */
export function ledgerFirstTs(): number | null {
  ensureTable();
  const row = getSyncDb().get<{ first: number | null }>(`SELECT MIN(ts) AS first FROM tool_call_ledger`);
  return row?.first ?? null;
}

/** Tools that were called at all since `sinceMs`. */
export function ledgerToolsCalled(sinceMs: number): Set<string> {
  ensureTable();
  const rows = getSyncDb().all<{ tool: string }>(
    `SELECT DISTINCT tool FROM tool_call_ledger WHERE ts >= ?`,
    [sinceMs]
  );
  return new Set(rows.map((r) => r.tool));
}
