/**
 * Owner-only tools: actions only EJ may run, no matter how a model is talked into calling them.
 *
 * Security audit 2026-10-26: these tools reach secrets, internal services, EJ's own data, or
 * let someone act as EJ, and before this file any Discord user could invoke them:
 * - sandbox: `docker exec` forwards GITHUB_TOKEN and OPENAI_API_KEY into the container.
 * - http: a raw fetch with no SSRF guard; loopback calls skip the API token, so it could
 *   read Artie's own internal routes.
 * - osint: EJ's private intelligence stack (only nearby-aircraft was owner-gated).
 * - system_memory: cross-agent handoff notes.
 * - mention_proxy: makes Artie answer @mentions of a person on their behalf.
 * - self-stats user_costs: per-user spend.
 *
 * Checked in CapabilityRegistry.execute() next to the approval gate (the one choke point every
 * call path shares), after resolveToolCall so aliases resolve to these canonical names first.
 */
import { isOwner } from '../../shared/config/owner.js';
import type { CapabilityContext } from './registry.js';

/** `'all'` locks every action on that tool; a Set locks just the named actions. */
export const OWNER_ONLY_ACTIONS: Record<string, Set<string> | 'all'> = {
  sandbox: 'all',
  // A separate agent with a real shell on the VPS host (:47400). Ungated until 2026-11-17.
  hermes: 'all',
  http: 'all',
  osint: 'all',
  system_memory: 'all',
  mention_proxy: 'all',
  'self-stats': new Set(['user_costs']),
  // OpenAI deep research spends real money outside the daily budget ledger.
  deep_research: new Set(['submit']),
};

export function isOwnerOnlyAction(name: string, action: string): boolean {
  const rule = OWNER_ONLY_ACTIONS[name];
  if (!rule) {
    return false;
  }
  if (rule === 'all') {
    return true;
  }
  return rule.has(action);
}

/** True when this call must be refused: an owner-only action from anyone but EJ. */
export function blocksNonOwner(
  name: string,
  action: string,
  context: CapabilityContext | undefined
): boolean {
  if (!isOwnerOnlyAction(name, action)) {
    return false;
  }
  return !isOwner(context?.userId || '');
}

export const OWNER_ONLY_REFUSAL =
  "That one's EJ-only, so I can't run it for you. Ask me something else?";
