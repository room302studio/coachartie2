/**
 * Pending Components Service
 *
 * Side channel for Discord message components (buttons/select menus), modelled on
 * pending-attachments.ts. A tool (discord-ui) queues action-row JSON for the CURRENT TURN;
 * the gateway (stream-reply.ts) takes it once, after the final reply, and attaches it to the
 * message it just sent.
 *
 * Keyed by turn id (the job/message id the gateway holds as jobInfo.messageId, which tools see
 * as CapabilityContext.messageId) — NOT by userId. Two turns from the same person must not
 * cross, which a userId key would allow.
 */

import { logger } from '../../shared/logger.js';

/** A Discord ActionRow in raw JSON form (type: 1, components: [...]), ready for ActionRowBuilder.from(). */
export type PendingComponentRow = Record<string, unknown>;

const TTL_MS = 10 * 60 * 1000; // 10 minutes — can't leak past a turn's realistic lifetime
const MAX_ROWS_PER_TURN = 5; // Discord's hard limit: 5 action rows per message

interface Entry {
  rows: PendingComponentRow[];
  expiresAt: number;
}

const pendingComponents = new Map<string, Entry>();

function pruneExpired(now: number): void {
  if (pendingComponents.size < 500) return;
  for (const [turnId, entry] of pendingComponents) {
    if (entry.expiresAt <= now) {
      pendingComponents.delete(turnId);
    }
  }
}

/**
 * Queue action rows for a turn. APPENDS to any rows already queued for the same turn (e.g. the
 * model calls discord-ui buttons, then select, in the same reply) and clamps the combined total
 * to Discord's 5-action-row-per-message limit — extra rows from the latest call are dropped.
 */
export function addPendingComponents(turnId: string, rows: PendingComponentRow[]): void {
  if (!turnId || rows.length === 0) return;
  const now = Date.now();
  pruneExpired(now);

  const existing = pendingComponents.get(turnId);
  let combined: PendingComponentRow[];
  if (existing && existing.expiresAt > now) {
    combined = [...existing.rows, ...rows].slice(0, MAX_ROWS_PER_TURN);
  } else {
    combined = rows.slice(0, MAX_ROWS_PER_TURN);
  }

  pendingComponents.set(turnId, { rows: combined, expiresAt: now + TTL_MS });
  logger.info(
    `🔘 Queued component row(s) for turn ${turnId.slice(-8)}: +${rows.length}, now ${combined.length} total`
  );
}

/** Take (and clear) the rows queued for a turn. Returns [] if none, or if they expired. */
export function takePendingComponents(turnId: string): PendingComponentRow[] {
  const entry = pendingComponents.get(turnId);
  pendingComponents.delete(turnId);
  if (!entry) return [];
  if (entry.expiresAt <= Date.now()) return [];
  return entry.rows;
}
