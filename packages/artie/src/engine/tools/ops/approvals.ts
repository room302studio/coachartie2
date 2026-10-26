/**
 * Approvals — EJ's queue of gated tool calls (approval-gate.ts) waiting on his sign-off.
 *
 * Owner-only, like pairing.ts. `approve` doesn't just flip a status flag: it re-runs the exact
 * original call (same tool, action, params) with `confirmed: true` and the owner's userId as
 * context, so it clears the gate in registry.execute() and actually happens.
 */
import { logger } from '../../../shared/logger.js';
import { isOwner } from '../../../shared/config/owner.js';
import {
  getPendingAction,
  listPendingActions,
  resolvePendingAction,
} from '../../../shared/pending-actions.js';
import type { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';
import { capabilityRegistry } from '../../5-tool-loop/registry.js';

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

  try {
    switch (action) {
      case 'list': {
        const pending = listPendingActions('pending');
        if (pending.length === 0) {
          return '📭 Nothing waiting on approval.';
        }
        const formatted = pending
          .map(
            (p) =>
              `#${p.id} — ${p.tool}:${p.action} (requested by ${p.requestedBy} at ${p.createdAt})\n   params: ${p.paramsJson}` +
              (p.content ? `\n   content: ${p.content.slice(0, 300)}${p.content.length > 300 ? '…' : ''}` : '')
          )
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

        const originalParams = JSON.parse(pending.paramsJson || '{}');
        const originalContext = JSON.parse(pending.contextJson || '{}');
        const result = await capabilityRegistry.execute(
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
          { ...originalContext, userId: callerId }
        );
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
