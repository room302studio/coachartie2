/**
 * Pending Actions - the owner-approval queue.
 *
 * Any tool call that sends something outside Discord (email, a Reddit post, a GitHub issue, a
 * wiki edit, an arbitrary HTTP POST/PUT/DELETE) or moves money (Stripe) is gated: a non-owner
 * caller — or the owner without an explicit confirm — gets the call parked here instead of
 * run, and a plain "needs EJ's approval" message back. EJ reviews and resolves it with the
 * `approvals` capability (list/approve/deny), which re-runs the exact original call on approve.
 *
 * Mirrors the lightweight `CREATE TABLE IF NOT EXISTS` pattern engine/tools/agents/system-memory.ts
 * uses for its own table: a raw-SQL table outside the drizzle schema, created lazily on first
 * use. No migration needed, nothing to keep in sync with schema.ts.
 */
import { getSyncDb } from './db/client.js';
import { logger } from './logger.js';

/** pending → approved (claimed, about to run) → executed | failed; or pending → denied. */
export type PendingActionStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'failed';

export interface PendingAction {
  id: number;
  tool: string;
  action: string;
  paramsJson: string;
  /** The capability call's `content` arg (4th positional arg to execute(), separate from
   *  params) — e.g. a drafted email's body. Null when the original call had none. */
  content: string | null;
  /** guildId/channelId/messageId at request time, so approve() can replay with the same
   *  Discord context instead of a bare owner-only context (otherwise a tool that reads
   *  context.channelId/guildId would behave differently on replay than it would have at
   *  the original call site). */
  contextJson: string;
  requestedBy: string;
  reason: string | null;
  status: PendingActionStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

let ensured = false;

function ensureTable(): void {
  if (ensured) return;
  const db = getSyncDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      action TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      context_json TEXT NOT NULL DEFAULT '{}',
      content TEXT,
      requested_by TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolved_by TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status)`);
  // A bench created before context_json/content existed would otherwise error on every insert.
  for (const ddl of [
    `ALTER TABLE pending_actions ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE pending_actions ADD COLUMN content TEXT`,
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // already has the column
    }
  }
  ensured = true;
}

function rowToPendingAction(row: Record<string, unknown>): PendingAction {
  return {
    id: row.id as number,
    tool: row.tool as string,
    action: row.action as string,
    paramsJson: row.params_json as string,
    content: (row.content as string | null) ?? null,
    contextJson: (row.context_json as string) ?? '{}',
    requestedBy: row.requested_by as string,
    reason: (row.reason as string | null) ?? null,
    status: row.status as PendingActionStatus,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
  };
}

/** Create a pending action record for a gated call that was blocked. Returns its id. */
export function createPendingAction(input: {
  tool: string;
  action: string;
  params: unknown;
  /** The call's `content` arg (separate from params) — e.g. a drafted email's body. Without
   *  this, approving a gated call that carries its payload in `content` (not params) would
   *  replay with no content at all. */
  content?: string;
  context?: unknown;
  requestedBy: string;
  reason?: string;
}): number {
  ensureTable();
  const db = getSyncDb();
  const result = db.run(
    `INSERT INTO pending_actions (tool, action, params_json, context_json, content, requested_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.tool,
      input.action,
      JSON.stringify(input.params ?? {}),
      JSON.stringify(input.context ?? {}),
      input.content ?? null,
      input.requestedBy,
      input.reason ?? null,
    ]
  );
  const id = Number(result.lastInsertRowid);
  logger.info(`⏸️ Pending action #${id} created: ${input.tool}:${input.action} (by ${input.requestedBy})`);
  return id;
}

export function getPendingAction(id: number): PendingAction | null {
  ensureTable();
  const db = getSyncDb();
  const row = db.get<Record<string, unknown>>(`SELECT * FROM pending_actions WHERE id = ?`, [id]);
  if (row) {
    return rowToPendingAction(row);
  }
  return null;
}

export function listPendingActions(status: PendingActionStatus = 'pending'): PendingAction[] {
  ensureTable();
  const db = getSyncDb();
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at DESC`,
    [status]
  );
  return rows.map(rowToPendingAction);
}

/** Marks a pending action resolved. Does NOT execute anything — the caller does that. */
export function resolvePendingAction(
  id: number,
  status: 'approved' | 'denied',
  resolvedBy: string
): PendingAction | null {
  ensureTable();
  const db = getSyncDb();
  const existing = getPendingAction(id);
  if (!existing) return null;
  if (existing.status !== 'pending') return existing;
  db.run(
    `UPDATE pending_actions SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`,
    [status, resolvedBy, id]
  );
  return { ...existing, status, resolvedBy };
}

/**
 * Record how an approved action's run went. 'approved' alone used to be the final state, so
 * an approved action whose replay threw looked done (2026-10-31). Only moves an 'approved' row.
 */
export function markPendingActionOutcome(id: number, outcome: 'executed' | 'failed'): void {
  ensureTable();
  getSyncDb().run(`UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'approved'`, [
    outcome,
    id,
  ]);
}
