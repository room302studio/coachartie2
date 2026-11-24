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

// ---------------------------------------------------------------------------------------
// Component numbering and forms (2026-11-24: buttons on any message, forms behind buttons).
// ---------------------------------------------------------------------------------------

const nextIndex = new Map<string, { next: number; expiresAt: number }>();

/**
 * Reserve `count` component numbers for a turn and return the first. One turn can put buttons
 * under its reply AND on a message it sends elsewhere; numbering continues across both, so a
 * custom_id (`artie:<turn>:<n>`) names exactly one component and a form keyed by it can't be
 * claimed by a different button.
 */
export function claimComponentIndexes(turnId: string, count: number): number {
  const now = Date.now();
  let entry = nextIndex.get(turnId);
  if (!entry || entry.expiresAt <= now) {
    entry = { next: 0, expiresAt: now + TTL_MS };
  }
  const first = entry.next;
  entry.next += Math.max(0, count);
  nextIndex.set(turnId, entry);
  if (nextIndex.size > 500) {
    for (const [id, e] of nextIndex) {
      if (e.expiresAt <= now) {
        nextIndex.delete(id);
      }
    }
  }
  return first;
}

/** One field of a form (a Discord modal text input). */
export interface FormField {
  label: string;
  paragraph?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface FormSpec {
  title: string;
  fields: FormField[];
}

/**
 * Forms behind buttons, keyed by the button's custom_id. In memory for a day: a restart or an
 * old message just means the click arrives as a plain click turn, never an error.
 */
const FORM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FORMS = 1000;
const forms = new Map<string, { form: FormSpec; expiresAt: number }>();

export function registerForm(customId: string, form: FormSpec): void {
  const now = Date.now();
  if (forms.size >= MAX_FORMS) {
    for (const [id, e] of forms) {
      if (e.expiresAt <= now) {
        forms.delete(id);
      }
    }
    // Still full: drop the oldest (Map keeps insertion order).
    if (forms.size >= MAX_FORMS) {
      const oldest = forms.keys().next().value;
      if (oldest !== undefined) {
        forms.delete(oldest);
      }
    }
  }
  forms.set(customId, { form, expiresAt: now + FORM_TTL_MS });
}

/** The form behind a button, or null (none, or expired). Not consumed: anyone may open it. */
export function formFor(customId: string): FormSpec | null {
  const entry = forms.get(customId);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    forms.delete(customId);
    return null;
  }
  return entry.form;
}
