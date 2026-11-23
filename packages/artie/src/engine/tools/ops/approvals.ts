/**
 * Approvals — EJ's queue of gated tool calls (approval-gate.ts) waiting on his sign-off.
 *
 * Owner-only, like pairing.ts. `approve` doesn't just flip a status flag: it re-runs the exact
 * original call (same tool, action, params) with `confirmed: true` and the owner's userId as
 * context, so it clears the gate in registry.execute() and actually happens.
 */
import { logger } from '../../../shared/logger.js';
import { mintTrusted } from '../../../shared/trusted-ids.js';
import { isOwner } from '../../../shared/config/owner.js';
import {
  expireStalePendingActions,
  getPendingAction,
  listPendingActions,
  markPendingActionOutcome,
  resolvePendingAction,
} from '../../../shared/pending-actions.js';
import type { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { capabilityRegistry } from '../../5-tool-loop/registry.js';
import {
  onPendingActionsExpired,
  type PendingAction,
} from '../../../shared/pending-actions.js';
import * as gateway from '../../../gateway/api.js';

type Outcome = 'executed' | 'failed' | 'denied' | 'expired';

const OUTCOME_LINE: Record<Outcome, string> = {
  executed: 'EJ approved it and it ran.',
  failed: 'EJ approved it, but it failed when it ran.',
  denied: "EJ didn't approve it, so it didn't happen.",
  expired: 'Nobody decided within 7 days, so it lapsed and nothing happened.',
};

/**
 * Tell the person who asked how their gated request ended (Artie's own ask, 2026-11-17: the
 * requester never heard back). Plain text, no LLM call. Says what was asked and the outcome,
 * never the tool's output or the request's content (an email body, a payload). Goes to the
 * original channel, else a DM. Skipped for EJ himself (he made the call) and system callers.
 * Never throws: a failed notice must not undo or fail the decision.
 */
export function requesterNotice(
  pending: PendingAction,
  outcome: Outcome
): { userId: string; channelId?: string; text: string } | null {
  const who = pending.requestedBy;
  if (!who || who === 'unknown-user' || isOwner(who)) {
    return null;
  }
  let channelId: string | undefined;
  try {
    channelId = JSON.parse(pending.contextJson || '{}').channelId || undefined;
  } catch {
    channelId = undefined;
  }
  return {
    userId: who,
    channelId,
    text: `<@${who}> your request #${pending.id} (${pending.tool}:${pending.action}): ${OUTCOME_LINE[outcome]}`,
  };
}

export async function notifyRequester(pending: PendingAction, outcome: Outcome): Promise<void> {
  const notice = requesterNotice(pending, outcome);
  if (!notice || process.env.VITEST) {
    return;
  }
  try {
    if (notice.channelId) {
      await gateway.sendChannelMessage(notice.channelId, { content: notice.text });
      return;
    }
    await gateway.sendDm({ userId: notice.userId, message: notice.text });
  } catch (error) {
    logger.warn(`⏸️ Couldn't tell ${notice.userId} about #${pending.id} (${outcome}): ${error}`);
  }
}

onPendingActionsExpired((expired) => {
  for (const pending of expired) {
    void notifyRequester(pending, 'expired');
  }
});

interface ApprovalsParams {
  action: string;
  id?: string | number;
  [key: string]: unknown;
}

async function handleApprovals(
  params: ApprovalsParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const callerId = ctx?.userId;
  if (!callerId || !isOwner(callerId)) {
    return 'Only EJ can review the approvals queue.';
  }

  const { action } = params;
  const idRaw = params.id ?? content;

  // Lapse anything past its TTL before reading, so approve can never replay a stale ask.
  expireStalePendingActions();

  try {
    switch (action) {
      case 'list': {
        const pending = listPendingActions('pending');
        if (pending.length === 0) {
          return '📭 Nothing waiting on approval.';
        }
        const formatted = pending
          .map((p) => {
            let line = `#${p.id} — ${p.tool}:${p.action} (requested by ${p.requestedBy} at ${p.createdAt})\n   params: ${p.paramsJson}`;
            if (p.content) {
              let ellipsis: string;
              if (p.content.length > 300) {
                ellipsis = '…';
              } else {
                ellipsis = '';
              }
              line += `\n   content: ${p.content.slice(0, 300)}${ellipsis}`;
            }
            return line;
          })
          .join('\n');
        return `⏸️ ${pending.length} pending action(s):\n${formatted}`;
      }

      case 'approve': {
        const id = Number(idRaw);
        if (!idRaw || Number.isNaN(id)) {
          throw new Error('approve needs an id — see "approvals:list" for pending ids.');
        }
        const pending = getPendingAction(id);
        if (!pending) {
          throw new Error(`No pending action #${id}.`);
        }
        if (pending.status !== 'pending') {
          return `#${id} was already ${pending.status}, resolved by ${pending.resolvedBy ?? 'unknown'}.`;
        }

        resolvePendingAction(id, 'approved', callerId);
        logger.info(`✅ Approval #${id} approved by ${callerId}: ${pending.tool}:${pending.action}`);

        // 'approved' (written above, before the run) is the claim that stops a double approve
        // from running it twice; the outcome lands after (2026-10-31).
        let result: string;
        try {
          const originalParams = JSON.parse(pending.paramsJson || '{}');
          const originalContext = JSON.parse(pending.contextJson || '{}');
          result = await capabilityRegistry.execute(
            pending.tool,
            pending.action,
            { ...originalParams, confirmed: true },
            // The original call's `content` arg (e.g. a drafted email's body) — rides
            // separately from params, so it has to be replayed separately too. Without this,
            // approving a gated call whose payload is in `content` (the drafting flow's
            // email:send, specifically) would replay with no body at all.
            pending.content ?? undefined,
            // Replay with the ORIGINAL guildId/channelId/messageId (so a tool that reads
            // context behaves the way it would have at the original call site), but userId
            // is always the owner now — that's what satisfies isOwnerConfirmed().
            mintTrusted({ ...originalContext, userId: callerId }, 'approval-replay')
          );
        } catch (error) {
          markPendingActionOutcome(id, 'failed');
          void notifyRequester(pending, 'failed');
          throw error;
        }
        markPendingActionOutcome(id, 'executed');
        void notifyRequester(pending, 'executed');
        return `✅ Approved #${id} and ran ${pending.tool}:${pending.action}:\n${result}`;
      }

      case 'deny': {
        const id = Number(idRaw);
        if (!idRaw || Number.isNaN(id)) {
          throw new Error('deny needs an id — see "approvals:list" for pending ids.');
        }
        const pending = getPendingAction(id);
        if (!pending) {
          throw new Error(`No pending action #${id}.`);
        }
        if (pending.status !== 'pending') {
          return `#${id} was already ${pending.status}.`;
        }
        resolvePendingAction(id, 'denied', callerId);
        logger.info(`🚫 Approval #${id} denied by ${callerId}: ${pending.tool}:${pending.action}`);
        void notifyRequester(pending, 'denied');
        return `🚫 Denied #${id} (${pending.tool}:${pending.action}).`;
      }

      default:
        throw new Error(`Unknown action: ${action}. Supported actions: list, approve, deny`);
    }
  } catch (error) {
    logger.error(`Approvals capability error for action '${action}':`, error);
    throw error;
  }
}

export const approvalsCapability: RegisteredCapability = {
  name: 'approvals',
  emoji: '⏸️',
  supportedActions: ['list', 'approve', 'deny'],
  actions: {
    list: { effect: 'read', who: 'owner' },
    // Approve replays a gated call (an email, a payment). Taint-blocked: a GitHub issue or web
    // page read mid-turn must not be able to say "approve #5" in EJ's own conversation.
    // approval:false because this IS the approval step.
    approve: { effect: 'outside', who: 'owner', approval: false },
    // Drops someone's request and pings them that EJ said no: taint-blocked too (Codex).
    deny: { effect: 'discord', who: 'owner' },
  },
  description:
    "EJ-only. Review gated tool calls (money, email, or anything that leaves Discord) waiting on approval. " +
    'list shows what\'s pending; approve re-runs the exact call; deny drops it.',
  requiredParams: [],
  handler: handleApprovals,
  examples: [
    '<capability name="approvals" action="list" />',
    '<capability name="approvals" action="approve" id="3" />',
    '<capability name="approvals" action="deny" id="3" />',
  ],
};
