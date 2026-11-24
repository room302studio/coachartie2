/**
 * Promises Artie made to a person ("I'll check on your map", "I'll follow up once EJ approves").
 * Artie's own request (2026-11-17): the timed cases have reminders, but the "I said I'd check"
 * kind got dropped without him knowing. One row per promise, to the person he said it to.
 *
 * Scope (same rule as memory): a promise made in a server shows only in that server; one made
 * in a DM (guild_id NULL) shows only in that person's DMs. In their DMs a person sees all of
 * their own open promises, wherever made: they were there for each one.
 *
 * Open promises older than PROMISE_WINDOW_DAYS stop showing (rows are kept, never deleted).
 * Table is created on first touch, like tool_call_ledger.
 */

import { getRawDb } from './client.js';
import { getPendingAction } from '../pending-actions.js';

export const PROMISE_WINDOW_DAYS = 30;
export const MAX_OPEN_PER_PERSON = 10;
export const MAX_PROMISE_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PromiseRow {
  id: number;
  user_id: string;
  guild_id: string | null;
  channel_id: string | null;
  text: string;
  status: 'open' | 'done' | 'dropped';
  created_at: number;
  resolved_at: number | null;
  /** The approval (pending_actions id) this promise waits on, if any. */
  waits_on: number | null;
}

/** A row plus the live status of the approval it waits on (null if none or unreadable). */
export type PromiseView = PromiseRow & { waitStatus: string | null };

/**
 * Attach the live approval status, read at display time (no listener needed), and put
 * promises whose approval has resolved first: those are the ones Artie can act on now.
 */
export function withApprovalStatus(rows: PromiseRow[]): PromiseView[] {
  const views = rows.map((r) => {
    let waitStatus: string | null = null;
    if (r.waits_on !== null && r.waits_on !== undefined) {
      try {
        waitStatus = getPendingAction(r.waits_on)?.status ?? 'missing';
      } catch {
        waitStatus = null;
      }
    }
    return { ...r, waitStatus };
  });
  const actionable = (v: PromiseView) => v.waitStatus !== null && v.waitStatus !== 'pending';
  return [...views.filter(actionable), ...views.filter((v) => !actionable(v))];
}

/** Short words for an approval status on the promise line. */
export function waitNote(waitsOn: number | null, status: string | null): string {
  if (waitsOn === null || waitsOn === undefined || status === null) return '';
  if (status === 'pending') return `waiting on approval #${waitsOn}`;
  if (status === 'approved' || status === 'executed') return `approval #${waitsOn} went through: tell them`;
  if (status === 'denied') return `approval #${waitsOn} was denied: tell them`;
  if (status === 'expired') return `approval #${waitsOn} expired unanswered: tell them`;
  if (status === 'failed') return `approval #${waitsOn} was approved but failed: tell them`;
  return `approval #${waitsOn} is ${status}`;
}

let ensuredFor: unknown = null;

function db() {
  const raw = getRawDb();
  if (ensuredFor !== raw) {
    raw.exec(`
      CREATE TABLE IF NOT EXISTS artie_promises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        waits_on INTEGER
      )
    `);
    // The first deploy (2026-11-17, d5fd0f0) created the table without waits_on.
    const cols = raw.prepare(`PRAGMA table_info(artie_promises)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'waits_on')) {
      raw.exec(`ALTER TABLE artie_promises ADD COLUMN waits_on INTEGER`);
    }
    raw.exec(`CREATE INDEX IF NOT EXISTS idx_artie_promises_user ON artie_promises(user_id, status)`);
    ensuredFor = raw;
  }
  return raw;
}

/** Test hook: re-ensure against a fresh in-memory DB. */
export function resetPromiseStoreState(): void {
  ensuredFor = null;
}

function windowStart(now: number): number {
  return now - PROMISE_WINDOW_DAYS * DAY_MS;
}

/**
 * Open promises to this person that may be shown here. `guildId` null means a DM with them:
 * all of their own. A guild id means only promises made in that guild, never DM ones.
 */
export function listOpenPromises(userId: string, guildId: string | null, now: number = Date.now()): PromiseRow[] {
  if (!userId) return [];
  if (guildId) {
    return db()
      .prepare(
        `SELECT * FROM artie_promises
         WHERE user_id = ? AND guild_id = ? AND status = 'open' AND created_at >= ?
         ORDER BY created_at ASC`
      )
      .all(userId, guildId, windowStart(now)) as PromiseRow[];
  }
  return db()
    .prepare(
      `SELECT * FROM artie_promises
       WHERE user_id = ? AND status = 'open' AND created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(userId, windowStart(now)) as PromiseRow[];
}

type AddResult = { ok: true; row: PromiseRow } | { ok: false; error: string };

export function addPromise(
  input: { userId: string; guildId: string | null; channelId: string | null; text: string; waitsOn?: number | null },
  now: number = Date.now()
): AddResult {
  const text = String(input.text ?? '').replace(/\s+/g, ' ').trim();
  if (!input.userId) return { ok: false, error: "I can't tell who this promise is to." };
  if (!text) return { ok: false, error: 'What did you promise? text is required.' };
  if (text.length > MAX_PROMISE_CHARS) {
    return { ok: false, error: `Keep it under ${MAX_PROMISE_CHARS} characters: the promise, not the whole plan.` };
  }
  // The cap counts only this scope (this server, or DMs): a server-side error must not reveal
  // how many DM promises someone has (Codex).
  const open = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM artie_promises
       WHERE user_id = ? AND status = 'open' AND created_at >= ? AND guild_id IS ?`
    )
    .get(input.userId, windowStart(now), input.guildId ?? null) as { n: number };
  if (open.n >= MAX_OPEN_PER_PERSON) {
    return {
      ok: false,
      error: `There are already ${MAX_OPEN_PER_PERSON} open promises to this person here. Mark some done or drop them first.`,
    };
  }
  const info = db()
    .prepare(
      `INSERT INTO artie_promises (user_id, guild_id, channel_id, text, status, created_at, waits_on)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(input.userId, input.guildId ?? null, input.channelId ?? null, text, now, input.waitsOn ?? null);
  const row = db().prepare(`SELECT * FROM artie_promises WHERE id = ?`).get(info.lastInsertRowid) as PromiseRow;
  return { ok: true, row };
}

export function getPromise(id: number): PromiseRow | null {
  const row = db().prepare(`SELECT * FROM artie_promises WHERE id = ?`).get(id) as PromiseRow | undefined;
  return row ?? null;
}

/** Close an open promise. Returns false if it was not open (already closed, or gone). */
export function resolvePromise(id: number, status: 'done' | 'dropped', now: number = Date.now()): boolean {
  const info = db()
    .prepare(`UPDATE artie_promises SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
    .run(status, now, id);
  return info.changes > 0;
}
