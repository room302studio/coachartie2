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
  // Sends outside Discord, to a real inbox.
  email: new Set(['send']),
  // The drafting flow's actual send step (distinct from drafting/revising, which stay local).
  'email-drafting': new Set(['send']),
  // Public posts outside Discord; reading/searching Reddit is fine unattended.
  reddit: new Set(['post', 'comment']),
  // Writes a public GitHub issue/comment; every read action (list/search/get_*) stays open.
  github: new Set(['create_issue', 'update_issue']),
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
 * calling in explicitly, with `confirmed: true` in params (set by the `approvals` tool when
 * replaying an approved call, or by the owner's own turn when they say "yes, do it" and the
 * model passes the flag through).
 */
export function isOwnerConfirmed(context: CapabilityContext | undefined, params: unknown): boolean {
  if (!context?.userId || context.userId !== OWNER_USER_ID) return false;
  return !!(params && typeof params === 'object' && (params as Record<string, unknown>).confirmed === true);
}
