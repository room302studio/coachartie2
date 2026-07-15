/**
 * Relay Capability
 *
 * When someone asks Artie to pass a message along ("tell EJ the deploy is green"),
 * he stacks it here instead of interrupting. Pending relays are drained into the
 * recipient's morning briefing.
 *
 * Sender identity comes from the capability context, not from params — the LLM can
 * be talked into claiming anything, but ctx.userId is what actually sent the message.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { logger, getDb, relays } from '@coachartie/shared';
import type { Relay } from '@coachartie/shared';
import {
  RegisteredCapability,
  CapabilityContext,
} from '../../services/capability/capability-registry.js';

/** Who relays are for when nobody says otherwise. Matches the briefing owner. */
const DEFAULT_RECIPIENT = process.env.RELAY_RECIPIENT || 'ej';

/** Per-sender daily cap — keeps one bored person from flooding the briefing. */
const DAILY_CAP = parseInt(process.env.RELAY_DAILY_CAP || '3');

const MAX_CONTENT_LENGTH = 500;

function pendingFor(recipient: string): Relay[] {
  return getDb()
    .select()
    .from(relays)
    .where(and(eq(relays.toUserId, recipient), eq(relays.status, 'pending')))
    .orderBy(desc(relays.createdAt))
    .all();
}

/**
 * Count what this sender has stacked in the last 24h. Uses SQLite datetime math so
 * the window slides rather than resetting at midnight.
 */
function relaysInLastDay(fromUserId: string): number {
  const rows = getDb()
    .select({ id: relays.id })
    .from(relays)
    .where(
      and(eq(relays.fromUserId, fromUserId), gte(relays.createdAt, sql`datetime('now', '-1 day')`))
    )
    .all();
  return rows.length;
}

async function addRelay(
  params: Record<string, unknown>,
  content: string | undefined,
  ctx?: CapabilityContext
): Promise<string> {
  const fromUserId = ctx?.userId;
  if (!fromUserId) {
    return "I can't tell who's asking me to pass that along, so I didn't save it.";
  }

  const message = String(params.message || params.content || content || '').trim();
  if (!message) {
    return 'What should I pass along? Give me the message.';
  }

  const recipient = String(params.to || DEFAULT_RECIPIENT).toLowerCase();
  const fromDisplay = String(params.from || params.from_display || fromUserId).trim();
  const trimmed =
    message.length > MAX_CONTENT_LENGTH ? message.slice(0, MAX_CONTENT_LENGTH) : message;

  // Same person, same message, still pending — they're repeating themselves, not adding news.
  const duplicate = getDb()
    .select({ id: relays.id })
    .from(relays)
    .where(
      and(
        eq(relays.fromUserId, fromUserId),
        eq(relays.toUserId, recipient),
        eq(relays.status, 'pending'),
        eq(relays.content, trimmed)
      )
    )
    .get();

  if (duplicate) {
    return `Already got that one queued for ${recipient} — it'll be in the morning briefing.`;
  }

  const used = relaysInLastDay(fromUserId);
  if (used >= DAILY_CAP) {
    logger.info(`📮 Relay rate limit hit by ${fromUserId} (${used}/${DAILY_CAP})`);
    return `You've already queued ${used} messages for ${recipient} today — that's the cap. Try again tomorrow, or say it to them directly if it's urgent.`;
  }

  getDb()
    .insert(relays)
    .values({
      fromUserId,
      fromDisplay,
      toUserId: recipient,
      content: trimmed,
      guildId: ctx?.guildId,
      channelId: ctx?.channelId,
      status: 'pending',
    })
    .run();

  logger.info(`📮 Relay queued for ${recipient} from ${fromDisplay} (${used + 1}/${DAILY_CAP})`);
  return `Got it — I'll pass that along to ${recipient} in the morning briefing.`;
}

function listRelays(params: Record<string, unknown>): string {
  const recipient = String(params.to || DEFAULT_RECIPIENT).toLowerCase();
  const pending = pendingFor(recipient);

  if (pending.length === 0) {
    return `Nothing queued for ${recipient} right now.`;
  }

  const lines = pending.map((r) => `- ${r.fromDisplay}: ${r.content}`).join('\n');
  return `${pending.length} message(s) waiting for ${recipient}:\n${lines}`;
}

function clearRelays(params: Record<string, unknown>): string {
  const recipient = String(params.to || DEFAULT_RECIPIENT).toLowerCase();
  const result = getDb()
    .update(relays)
    .set({ status: 'delivered', deliveredAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(relays.toUserId, recipient), eq(relays.status, 'pending')))
    .run();

  return `Cleared ${result.changes} pending message(s) for ${recipient}.`;
}

export const relayCapability: RegisteredCapability = {
  name: 'relay',
  emoji: '📮',
  supportedActions: ['add', 'list', 'clear'],
  description:
    'Stack a message for someone to read in their morning briefing. Use when a person asks you to tell/remind/pass something along to someone who is not in the conversation, instead of interrupting them.',
  examples: [
    '<capability name="relay" action="add" from="alice" message="the metro-maker deploy is green" />',
    '<capability name="relay" action="add" to="ej" from="bob" message="needs a review on PR 42" />',
    '<capability name="relay" action="list" />',
  ],
  handler: async (params, content, context) => {
    const action = String(params?.action || 'add');

    try {
      switch (action) {
        case 'add':
          return await addRelay(params || {}, content, context);
        case 'list':
          return listRelays(params || {});
        case 'clear':
          return clearRelays(params || {});
        default:
          return `Unknown relay action "${action}". Use add, list, or clear.`;
      }
    } catch (error) {
      logger.error('📮 Relay capability failed:', error);
      throw new Error(`Relay failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  },
};

/**
 * Pending relays formatted for the morning briefing, plus the ids that were shown.
 * The caller marks them delivered only once the brief actually goes out — otherwise a
 * failed brief would swallow the messages.
 */
export function getPendingRelaysForBriefing(recipient: string = DEFAULT_RECIPIENT): {
  text: string;
  ids: number[];
} {
  try {
    const pending = pendingFor(recipient);
    if (pending.length === 0) {
      return { text: '', ids: [] };
    }

    let text = `📮 **Passed along** (${pending.length})`;
    for (const r of pending) {
      text += `\n  · ${r.fromDisplay}: ${r.content}`;
    }

    return { text, ids: pending.map((r) => r.id) };
  } catch (error) {
    logger.warn('Failed to load relays for briefing:', error);
    return { text: '', ids: [] };
  }
}

/**
 * Mark relays delivered. Call only after the briefing has actually been handed off —
 * never at assembly time.
 */
export function markRelaysDelivered(ids: number[]): void {
  if (ids.length === 0) {
    return;
  }
  try {
    for (const id of ids) {
      getDb()
        .update(relays)
        .set({ status: 'delivered', deliveredAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(relays.id, id))
        .run();
    }
    logger.info(`📮 Marked ${ids.length} relay(s) delivered`);
  } catch (error) {
    logger.warn('Failed to mark relays delivered:', error);
  }
}
