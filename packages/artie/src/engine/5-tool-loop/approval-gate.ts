/**
 * Approval gate — tools that act outside Discord or move money require EJ's sign-off first.
 *
 * Owner ruling (2026-10-23): "Any tool that sends email, moves money (stripe), or acts outside
 * Discord must require the owner's approval." Gated by (canonical tool, action) — not by whole
 * tool — so a read-only action on an otherwise-gated tool (e.g. reading GitHub issues) isn't
 * blocked along with the write action that actually needs sign-off.
 *
 * Checked in CapabilityRegistry.execute(), after resolveToolCall (so an alias like
 * `email`-via-TOOL_ALIASES is still caught under its canonical name) and before the handler
 * runs — the one choke point every call path shares (native loop, the legacy XML loop, and the
 * HTTP execute-tool route all end up in registry.execute()).
 */
import { OWNER_USER_ID } from '../../shared/config/owner.js';
import type { CapabilityContext } from './registry.js';

/** `'all'` gates every action on that tool; a Set gates just the named actions. */
export const GATED_ACTIONS: Record<string, Set<string> | 'all'> = {
  // Real money, even though the Stripe key is restricted to payment-link creation.
  stripe: 'all',
  // Sends outside Discord, to a real inbox. Gates BOTH the bare `email` capability and the
  // drafting flow's real send step — email-drafting.ts's handleSendDraft() calls
  // capabilityRegistry.execute('email', 'send', …) rather than emailCapability.handler()
  // directly specifically so it passes through this gate (2026-10-26; it used to bypass it).
  email: new Set(['send']),
  // Public posts outside Discord; reading/searching Reddit is fine unattended.
  reddit: new Set(['post', 'comment']),
  // Writes a public GitHub issue/comment/label; every read action (list/search/get_*,
  // find_similar_issues, list_triage) stays open. tests/engine/approval-gate.test.ts fails if a
  // write-shaped github action is added to the tool without being listed here.
  github: new Set(['create_issue', 'update_issue', 'add_comment', 'add_labels', 'remove_label']),
  // Publishes to the public wiki; read/search/list stay open.
  mediawiki: new Set(['write', 'add']),
  // Generic outbound HTTP to an arbitrary URL with a body — gate the write verbs, not GET.
  http: new Set(['post', 'put', 'delete']),
};

export function isGatedAction(name: string, action: string): boolean {
  const gate = GATED_ACTIONS[name];
  if (!gate) return false;
  return gate === 'all' || gate.has(action);
}

/**
 * True when this specific call may proceed without being queued for approval: the owner,
 * calling in explicitly, with `confirmed: true` in params.
 *
 * `confirmed: true` must ONLY ever reach here from the `approvals` tool replaying an
 * already-approved pending action — never from a live model tool call. execute.ts's
 * executeNativeToolCall (the one entry point every native tool call goes through) strips
 * `confirmed` out of a model's own arguments before they ever reach resolveToolCall/
 * registry.execute, specifically so the model can't decide on its own to add the flag and
 * skip the gate, even in the owner's own conversation — "EJ said yes" has to mean EJ actually
 * ran `approvals:approve`, not Artie inferring it from the chat and setting a param.
 */
export function isOwnerConfirmed(context: CapabilityContext | undefined, params: unknown): boolean {
  if (!context?.userId || context.userId !== OWNER_USER_ID) return false;
  return !!(params && typeof params === 'object' && (params as Record<string, unknown>).confirmed === true);
}
