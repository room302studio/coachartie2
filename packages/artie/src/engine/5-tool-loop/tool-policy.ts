/**
 * Tool policy: every tool action declares what it touches and who may run it, and the three
 * security gates are DERIVED from that declaration (EJ, 2026-11-17).
 *
 * Why: until 2026-11-17 the gates were four hand-kept tables keyed by tool name, in three
 * files (owner-only, taint, taint exemptions, approval). A new tool was open on every gate
 * unless someone remembered all four. `hermes` (an agent with a shell on the VPS host) sat
 * ungated that way, and the filesystem taint exemptions named actions that didn't exist.
 * Now the declaration lives next to the handler, in the tool's own file.
 *
 * Undeclared actions stay OPEN (EJ's pick: fail loudly, not closed). They are named in a
 * startup warning (register-tools.ts) and fail tests/engine/tool-policy.test.ts, whose static
 * gate matrix is the security floor: entries can be added, never silently removed.
 */

/**
 * What an action touches. Ordered from harmless to consequential.
 * - read: no side effects
 * - own: Artie's own state (memory, goals, tasks, notes); no person or system outside him
 * - discord: acts on people or channels in Discord (DM, moderate, rename, post UI, a send later)
 * - workspace: his sandbox container / filesystem
 * - host: the VPS host itself (hermes)
 * - outside: leaves Discord for the public world (email, reddit, github, wiki, raw http writes)
 * - money: real money (stripe)
 */
export type ToolEffect = 'read' | 'own' | 'discord' | 'workspace' | 'host' | 'outside' | 'money';

export type ToolAudience = 'anyone' | 'owner';

export interface ToolParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  enum?: string[];
  /** Required for THIS action (checked in registry.execute, reported back to the model). */
  required?: boolean;
}

export interface ToolActionSpec {
  effect: ToolEffect;
  /** Default 'anyone'. */
  who?: ToolAudience;
  /**
   * Default: derived from effect (outside and money need EJ's approval). Set false only with a
   * reason in a comment, e.g. an owner-only action EJ runs himself.
   */
  approval?: boolean;
  params?: Record<string, ToolParamSpec>;
}

export type ToolActions = Record<string, ToolActionSpec>;

export interface ToolGates {
  declared: boolean;
  ownerOnly: boolean;
  dangerousWhenTainted: boolean;
  needsApproval: boolean;
}

const OPEN: ToolGates = {
  declared: false,
  ownerOnly: false,
  dangerousWhenTainted: false,
  needsApproval: false,
};

const HARMLESS: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['read', 'own']);
const NEEDS_APPROVAL: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['outside', 'money']);

function gatesOf(spec: ToolActionSpec): ToolGates {
  let needsApproval = NEEDS_APPROVAL.has(spec.effect);
  if (spec.approval !== undefined) {
    needsApproval = spec.approval;
  }
  return {
    declared: true,
    ownerOnly: spec.who === 'owner',
    dangerousWhenTainted: !HARMLESS.has(spec.effect),
    needsApproval,
  };
}

/** The strictest gates across a tool's declared actions. */
function strictest(actions: ToolActions): ToolGates {
  const all = Object.values(actions).map(gatesOf);
  return {
    declared: true,
    ownerOnly: all.some((g) => g.ownerOnly),
    dangerousWhenTainted: true,
    needsApproval: all.some((g) => g.needsApproval),
  };
}

/**
 * The gates for one call. `actions` is the tool's declaration (undefined = undeclared tool).
 * An action the tool doesn't declare (an old synonym, a typo, a model's invention) gets the
 * strictest gates of that tool, since the gates run before the "unsupported action" check.
 */
export function gatesFor(actions: ToolActions | undefined, action: string): ToolGates {
  if (!actions) {
    return OPEN;
  }
  // Own keys only: `constructor`/`toString` must not read as a declared action (Codex).
  if (!Object.hasOwn(actions, action)) {
    return strictest(actions);
  }
  return gatesOf(actions[action]);
}

/** Params this action declares as required (none for an undeclared action). */
export function requiredParamsFor(actions: ToolActions | undefined, action: string): string[] {
  if (!actions || !Object.hasOwn(actions, action)) {
    return [];
  }
  const params = actions[action].params ?? {};
  return Object.keys(params).filter((name) => params[name].required);
}

/**
 * The model-facing params of a tool: the union of every action's declared params, sorted by
 * name (byte-stable for the prompt cache), each described with the actions that use it.
 * Empty when no action declares params (the schema then falls back to example scraping).
 */
export function declaredToolParams(
  actions: ToolActions | undefined
): Array<[string, ToolParamSpec & { usedBy: string[]; requiredBy: string[] }]> {
  const merged = new Map<string, ToolParamSpec & { usedBy: string[]; requiredBy: string[] }>();
  for (const [action, spec] of Object.entries(actions ?? {})) {
    for (const [name, param] of Object.entries(spec.params ?? {})) {
      let entry = merged.get(name);
      if (!entry) {
        entry = { ...param, usedBy: [], requiredBy: [] };
        merged.set(name, entry);
      }
      entry.usedBy.push(action);
      if (param.required) {
        entry.requiredBy.push(action);
      }
    }
  }
  return [...merged.entries()].sort(([a], [b]) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

/** "tool:action" for every supported action with no declaration, sorted. */
export function undeclaredActions(
  capabilities: Array<{ name: string; supportedActions: string[]; actions?: ToolActions }>
): string[] {
  const missing: string[] = [];
  for (const cap of capabilities) {
    for (const action of cap.supportedActions) {
      if (!cap.actions || !Object.hasOwn(cap.actions, action)) {
        missing.push(`${cap.name}:${action}`);
      }
    }
  }
  return missing.sort();
}

/** Supported actions declared on a tool but missing from supportedActions (a typo in either). */
export function strayDeclarations(
  capabilities: Array<{ name: string; supportedActions: string[]; actions?: ToolActions }>
): string[] {
  const stray: string[] = [];
  for (const cap of capabilities) {
    for (const action of Object.keys(cap.actions ?? {})) {
      if (!cap.supportedActions.includes(action)) {
        stray.push(`${cap.name}:${action}`);
      }
    }
  }
  return stray.sort();
}

export const OWNER_ONLY_REFUSAL =
  "That one's EJ-only, so I can't run it for you. Ask me something else?";
