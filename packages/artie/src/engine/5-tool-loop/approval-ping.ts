/**
 * Approval ping: one plain line in #robot when a gated call lands in the approvals queue.
 *
 * Before this (TOOLS-NOTES: "learns by running approvals:list himself"), nothing told EJ an
 * ask was waiting, so scribe proposals and GitHub writes sat until someone remembered to look.
 * #robot is the channel EJ already reads for GitHub traffic, so this adds no new notification
 * surface and no @mention. Sent straight through gateway/api.ts (no LLM, no credits), and
 * fire-and-forget: a failed ping must never fail or delay the gated call itself.
 *
 * Only GitHub asks carry detail (repo, issue number, labels, state change). Every
 * other gated tool (email, stripe, http, reddit) shows just tool:action and the id: an email
 * draft or a payment amount doesn't belong in a shared channel.
 */
import { sendChannelMessage } from '../../gateway/api.js';
import { GITHUB_FEED_CHANNEL_ID } from '../../shared/config/channels.js';
import { logger } from '../../shared/logger.js';

const DETAIL_MAX = 120;

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function stringParam(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }
  return undefined;
}

/** The public detail for a GitHub ask: "owner/repo#12: add_labels bug, P2". Empty if unknown. */
function githubDetail(action: string, params: Record<string, unknown>): string {
  const repo = stringParam(params, 'repo', 'repository', 'project', 'query');
  const issue = stringParam(params, 'issueNumber', 'issue', 'number');
  let target = repo ?? '';
  if (issue) {
    target = `${target}#${issue}`;
  }
  // No titles, bodies or comment text: an unapproved draft (possibly written from a private
  // conversation) shouldn't be published to a shared channel before anyone said yes.
  let extra = '';
  if (action === 'add_labels' || action === 'remove_label') {
    extra = stringParam(params, 'labels', 'label') ?? '';
  } else if (action === 'update_issue') {
    const parts: string[] = [];
    const state = stringParam(params, 'state');
    if (state) parts.push(`state=${state}`);
    const reason = stringParam(params, 'state_reason', 'stateReason');
    if (reason) parts.push(`reason=${reason}`);
    const dup = stringParam(params, 'duplicateOf');
    if (dup) parts.push(`duplicate of #${dup}`);
    if (stringParam(params, 'title')) parts.push('title');
    if (stringParam(params, 'labels')) parts.push('labels');
    if (stringParam(params, 'assignees')) parts.push('assignees');
    extra = parts.join(', ');
  }
  return [target, extra].filter(Boolean).join(': ');
}

/** The ping text. Exported for tests. */
export function formatApprovalPing(input: { id: number; tool: string; action: string; params: unknown }): string {
  let params: Record<string, unknown> = {};
  if (input.params && typeof input.params === 'object') {
    params = input.params as Record<string, unknown>;
  }
  let detail = '';
  if (input.tool === 'github') {
    detail = githubDetail(input.action, params);
  }
  let line = `Approval needed #${input.id}: ${input.tool}:${input.action}`;
  if (detail) {
    line += ` (${clip(detail, DETAIL_MAX)})`;
  }
  return `${line}. Ask Artie "approvals approve ${input.id}" or "deny ${input.id}".`;
}

/** Post the ping. Never throws. */
export function pingApprovalNeeded(input: { id: number; tool: string; action: string; params: unknown }): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return;
  }
  sendChannelMessage(GITHUB_FEED_CHANNEL_ID, { content: formatApprovalPing(input) })
    .then((result) => {
      if (result && typeof result === 'object' && 'success' in result && result.success === false) {
        logger.warn(`Approval ping #${input.id} not delivered`);
      }
    })
    .catch((error: unknown) => {
      logger.warn(`Approval ping #${input.id} failed: ${String(error)}`);
    });
}
