/**
 * Capability policy: every capability action declares what it touches and who may run it, and
 * the three security gates are DERIVED from that declaration (EJ, 2026-11-17).
 *
 * Why: until 2026-11-17 the gates were four hand-kept tables keyed by capability name, in
 * three files (owner-only, taint, taint exemptions, approval). A new capability was open on
 * every gate unless someone remembered all four. `hermes` (an agent with a shell on the VPS
 * host) sat ungated that way, and the filesystem taint exemptions named actions that didn't
 * exist. Now the declaration lives next to the handler, in the capability's own file.
 *
 * Undeclared actions stay OPEN (EJ's pick: fail loudly, not closed). They are named in a
 * startup warning (register-all.ts) and fail tests/engine/capabilities/policy.test.ts, whose static
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
type ActionEffect = 'read' | 'own' | 'discord' | 'workspace' | 'host' | 'outside' | 'money';

type ActionAudience = 'anyone' | 'owner';

interface ActionParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  enum?: readonly string[];
  /** Required for THIS action (checked in registry.execute, reported back to the model). */
  required?: boolean;
  /** Other spellings accepted (forum_id for forumId); mapped to this name before validation. */
  aliases?: readonly string[];
}

interface ActionSpec {
  effect: ActionEffect;
  /** Default 'anyone'. */
  who?: ActionAudience;
  /**
   * Default: derived from effect (outside and money need EJ's approval). Set false only with a
   * reason in a comment, e.g. an owner-only action EJ runs himself.
   */
  approval?: boolean;
  params?: Record<string, ActionParamSpec>;
  /**
   * What this action reads from the free-text `content` argument (the body the XML format put
   * between the tags), in one short phrase. Absence = the handler ignores `content`.
   * It only matters for a capability that declares params: the native tool schema then lists
   * `content` only when some action sets this, instead of offering every capability a free-text
   * field it never reads. One with NO declared params keeps `content` (its handlers were never
   * audited).
   * Declare it whenever the handler reads `content` as the primary input; a mere fallback for a
   * param that is already declared does not need it.
   */
  content?: string;
}

export type CapabilityActions = Record<string, ActionSpec>;

interface ActionGates {
  declared: boolean;
  ownerOnly: boolean;
  dangerousWhenTainted: boolean;
  needsApproval: boolean;
}

const OPEN: ActionGates = {
  declared: false,
  ownerOnly: false,
  dangerousWhenTainted: false,
  needsApproval: false,
};

const HARMLESS: ReadonlySet<ActionEffect> = new Set<ActionEffect>(['read', 'own']);
const NEEDS_APPROVAL: ReadonlySet<ActionEffect> = new Set<ActionEffect>(['outside', 'money']);

function gatesOf(spec: ActionSpec): ActionGates {
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

/** The strictest gates across a capability's declared actions. */
function strictest(actions: CapabilityActions): ActionGates {
  const all = Object.values(actions).map(gatesOf);
  return {
    declared: true,
    ownerOnly: all.some((g) => g.ownerOnly),
    dangerousWhenTainted: true,
    needsApproval: all.some((g) => g.needsApproval),
  };
}

/**
 * The gates for one call. `actions` is the capability's declaration (undefined = undeclared).
 * An action the capability doesn't declare (an old synonym, a typo, a model's invention) gets
 * its strictest gates, since the gates run before the "unsupported action" check.
 */
export function gatesFor(actions: CapabilityActions | undefined, action: string): ActionGates {
  if (!actions) {
    return OPEN;
  }
  // Own keys only: `constructor`/`toString` must not read as a declared action (Codex).
  if (!Object.hasOwn(actions, action)) {
    return strictest(actions);
  }
  return gatesOf(actions[action]);
}

/**
 * Rename declared aliases (forum_id) to their canonical param (forumId) for this action. The
 * canonical name wins if both are present. Returns a new object; undeclared actions pass through.
 */
export function canonicalParams(
  actions: CapabilityActions | undefined,
  action: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (!actions || !Object.hasOwn(actions, action)) {
    return params;
  }
  const out = { ...params };
  for (const [name, spec] of Object.entries(actions[action].params ?? {})) {
    for (const alias of spec.aliases ?? []) {
      if (Object.hasOwn(out, alias)) {
        if (!Object.hasOwn(out, name)) {
          out[name] = out[alias];
        }
        delete out[alias];
      }
    }
  }
  return out;
}

/** Params this action declares as required (none for an undeclared action). */
export function requiredParamsFor(actions: CapabilityActions | undefined, action: string): string[] {
  if (!actions || !Object.hasOwn(actions, action)) {
    return [];
  }
  const params = actions[action].params ?? {};
  return Object.keys(params).filter((name) => params[name].required);
}

/**
 * The model-facing params of a capability: the union of every action's declared params, sorted by
 * name (byte-stable for the prompt cache), each described with the actions that use it.
 * Empty when no action declares params (the schema then falls back to example scraping).
 */
export function declaredActionParams(
  actions: CapabilityActions | undefined
): Array<[string, ActionParamSpec & { usedBy: string[]; requiredBy: string[] }]> {
  const merged = new Map<string, ActionParamSpec & { usedBy: string[]; requiredBy: string[] }>();
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

/**
 * The `content` argument a capability's declaration accepts: what it is (the distinct per-action
 * phrases, in action order) and which actions read it. undefined when no action declares it.
 */
export function declaredActionContent(
  actions: CapabilityActions | undefined
): { description: string; usedBy: string[] } | undefined {
  const usedBy: string[] = [];
  const phrases: string[] = [];
  for (const [action, spec] of Object.entries(actions ?? {})) {
    if (!spec.content) {
      continue;
    }
    usedBy.push(action);
    if (!phrases.includes(spec.content)) {
      phrases.push(spec.content);
    }
  }
  if (usedBy.length === 0) {
    return undefined;
  }
  return { description: phrases.join(' / '), usedBy };
}

/** True when any action declares typed params (the capability's schema is then fully declared). */
export function declaresParams(actions: CapabilityActions | undefined): boolean {
  return Object.values(actions ?? {}).some((spec) => Object.keys(spec.params ?? {}).length > 0);
}

/** "capability:action" for every supported action with no declaration, sorted. */
export function undeclaredActions(
  capabilities: Array<{ name: string; supportedActions: string[]; actions?: CapabilityActions }>
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

/** Actions declared on a capability but missing from supportedActions (a typo in either). */
export function strayDeclarations(
  capabilities: Array<{ name: string; supportedActions: string[]; actions?: CapabilityActions }>
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
