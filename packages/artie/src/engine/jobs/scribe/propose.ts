/**
 * Turn a scribe summary's proposed GitHub changes into real tool calls, routed through the
 * EXACT SAME entry point the live tool loop uses: capabilityRegistry.execute(). Called
 * without `confirmed`, every one of these hits approval-gate.ts's GATED_ACTIONS.github set
 * (create_issue/update_issue are both gated) and comes back queued as a pending_actions row —
 * no new approval logic, no bypass. EJ reviews and runs them with the `approvals` tool.
 */
import { logger } from '../../../shared/logger.js';
import { getErrorMessage } from '../../../shared/errors.js';
import { capabilityRegistry } from '../../5-tool-loop/registry.js';
import type { CapabilityContext } from '../../5-tool-loop/registry.js';
import type { ScribeProposal } from './types.js';

export interface ProposalOutcome {
  proposal: ScribeProposal;
  message: string;
  pendingId: number | null;
}

const PENDING_ID_PATTERN = /pending #(\d+)/;

function extractPendingId(message: string): number | null {
  const match = PENDING_ID_PATTERN.exec(message);
  if (!match) return null;
  const id = Number(match[1]);
  if (Number.isFinite(id)) {
    return id;
  }
  return null;
}

/** Create -> create_issue, update -> update_issue; both are in approval-gate.ts's gated set. */
function githubActionFor(kind: ScribeProposal['kind']): 'create_issue' | 'update_issue' {
  if (kind === 'create') {
    return 'create_issue';
  }
  return 'update_issue';
}

/**
 * Runs every proposal through the gate. Context carries the session's starter (always the
 * owner, since only the owner can run /scribe start) but deliberately NO `confirmed` —
 * approval-gate.ts's isOwnerConfirmed() requires that flag explicitly, and it must never be
 * set from an automated path like this one.
 */
export async function submitScribeProposals(
  proposals: ScribeProposal[],
  context: CapabilityContext
): Promise<ProposalOutcome[]> {
  const outcomes: ProposalOutcome[] = [];
  for (const proposal of proposals) {
    const action = githubActionFor(proposal.kind);
    const params: Record<string, unknown> = {
      action,
      repo: proposal.repo,
      title: proposal.title,
      body: proposal.body,
    };
    if (proposal.kind === 'update') {
      params.issueNumber = proposal.issueNumber;
      params.description = proposal.body;
    }
    try {
      const message = await capabilityRegistry.execute('github', action, params, proposal.body, context);
      outcomes.push({ proposal, message, pendingId: extractPendingId(message) });
    } catch (error) {
      logger.warn(`🐙 Scribe GitHub proposal failed (${action} ${proposal.repo}):`, getErrorMessage(error));
      outcomes.push({ proposal, message: `❌ ${getErrorMessage(error)}`, pendingId: null });
    }
  }
  return outcomes;
}
