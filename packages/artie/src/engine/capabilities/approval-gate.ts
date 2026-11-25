/**
 * Approval gate: tools that act outside Discord or move money require EJ's sign-off first.
 *
 * Owner ruling (2026-10-23): "Any tool that sends email, moves money (stripe), or acts outside
 * Discord must require the owner's approval." WHICH actions are gated is no longer a list here:
 * each tool declares an `effect` per action, and `outside`/`money` need approval
 * (policy.ts, 2026-11-17). Read actions on the same tool (reading GitHub issues) stay open.
 *
 * Checked in CapabilityRegistry.execute(), after resolveCapabilityAlias (so an alias is caught under its
 * canonical name) and before the handler runs: the one choke point every call path shares
 * (native loop, the HTTP execute-tool route). The email drafting flow's
 * real send calls capabilityRegistry.execute('email', 'send', …) for exactly that reason.
 */
import { OWNER_USER_ID } from '../../shared/config/owner.js';
import type { CapabilityContext } from './registry.js';

/**
 * True when this specific call may proceed without being queued for approval: the owner,
 * calling in explicitly, with `confirmed: true` in params.
 *
 * `confirmed: true` must ONLY ever reach here from the `approvals` tool replaying an
 * already-approved pending action — never from a live model tool call. execute-tool-call.ts's
 * executeNativeToolCall (the one entry point every native tool call goes through) strips
 * `confirmed` out of a model's own arguments before they ever reach resolveCapabilityAlias/
 * registry.execute, specifically so the model can't decide on its own to add the flag and
 * skip the gate, even in the owner's own conversation — "EJ said yes" has to mean EJ actually
 * ran `approvals:approve`, not Artie inferring it from the chat and setting a param.
 */
export function isOwnerConfirmed(context: CapabilityContext | undefined, params: unknown): boolean {
  if (!context?.userId || context.userId !== OWNER_USER_ID) return false;
  return !!(params && typeof params === 'object' && (params as Record<string, unknown>).confirmed === true);
}
