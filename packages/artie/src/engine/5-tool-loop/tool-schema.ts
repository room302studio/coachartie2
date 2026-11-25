import { AUTO_INJECTED_PARAMS, type RegisteredCapability } from '../capabilities/registry.js';
import { declaredActionParams, declaredActionContent, declaresParams } from '../capabilities/policy.js';
import { parseTagAttributes, toCallNotation, TAG_ATTRS } from '../3-context/xml-teaching.js';

/**
 * Capability → native tool-call schema (see TOOL-USE-MIGRATION.md; wired in wave 8).
 *
 * Converts a RegisteredCapability into an OpenAI-format function/tool definition. OpenRouter
 * accepts this format and translates it to each provider's native tool API (Anthropic, OpenAI,
 * Gemini), so tools are defined ONCE here and the model stays freely swappable — no provider lock-in.
 *
 * Pure: no side effects, so the same registry always yields byte-identical JSON. That matters:
 * the tool list sits at the very front of the provider's cached prompt prefix (Anthropic orders
 * tools before system), so a reordered key or tool would silently re-bill the whole prefix.
 *
 * Every param is typed `string`. The registry only knows param names (`requiredParams`), and
 * handlers already parse strings, which is what the XML path always handed them. Optional params
 * are learned from each capability's `examples` (attribute names), and declared optional.
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ across providers. */
export function toToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** JSON-schema property names Anthropic accepts. */
const PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Attribute names that are tool selectors or are filled in by the engine, never by the model. */
const NOT_A_PARAM = new Set(['name', 'action', 'content', 'userId', 'messageId', 'channelId', 'guildId']);

/**
 * For params a tool DECLARES, only these stay hidden. A declared channelId/messageId/userId is a
 * target the model picks (which channel to read, which message to edit, whose history), not
 * the conversation's own ids: those reach handlers as branded CapabilityContext, never params.
 * Hiding them meant Artie had to guess send_message's channelId from error text (his report,
 * 2026-11-23). guildId stays hidden: only EJ's own DM may name a server.
 */
const DECLARED_NOT_A_PARAM = new Set(['name', 'action', 'content', 'guildId']);

const DESCRIPTION_FIRST_LINE_MAX = 200;
// One example per tool: optional param names are already declared in the schema, so the
// example only has to show a call's shape. The whole list rides on every tool turn.
const EXAMPLE_MAX = 200;
const EXAMPLES_SHOWN = 1;

/** Free-text body: what the XML format put between the tags. */
const CONTENT_DESCRIPTION = 'Free text body (lyrics, a fact to remember, code, a message).';

/** The opening <capability ...> tag of an example (quoted values may contain `>`). */
const OPEN_TAG = new RegExp(`<capability\\b${TAG_ATTRS}\\/?>`);

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Compare two strings for sorting. Returns -1, 0, or 1. */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Optional param names seen in a capability's XML examples, sorted. */
function exampleParams(cap: RegisteredCapability): string[] {
  const names = new Set<string>();
  for (const example of cap.examples ?? []) {
    const open = OPEN_TAG.exec(example);
    if (!open) continue;
    for (const [k] of parseTagAttributes(open[1])) {
      if (!NOT_A_PARAM.has(k) && PROPERTY_NAME.test(k)) names.add(k);
    }
  }
  return [...names].sort();
}

/**
 * "what it is (for create, update; required for create)": compact, repeated per call. Names
 * which actions take it and, separately, which require it, so an optional-on-update param
 * never reads as required there (Codex).
 */
function paramDescription(
  spec: { description: string; usedBy: string[]; requiredBy: string[] },
  actionCount: number
): string {
  const parts: string[] = [];
  if (spec.usedBy.length < actionCount) {
    parts.push(`for ${spec.usedBy.join(', ')}`);
  }
  if (spec.requiredBy.length > 0 && spec.requiredBy.length < actionCount) {
    parts.push(`required for ${spec.requiredBy.join(', ')}`);
  }
  if (parts.length === 0) {
    return spec.description;
  }
  return `${spec.description} (${parts.join('; ')})`;
}

export function capabilityToTool(cap: RegisteredCapability): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  // `action` selects which sub-action of the capability to run.
  if (cap.supportedActions.length > 0) {
    properties.action = { type: 'string', enum: [...cap.supportedActions] };
    required.push('action');
  }

  // Required params — names only in the registry, so typed as strings (handlers parse).
  // channelId/guildId are filled from the conversation when absent (the registry's
  // AUTO_INJECTED_PARAMS), so they are declared but never required of the model.
  for (const param of cap.requiredParams ?? []) {
    if (!PROPERTY_NAME.test(param) || param === 'action' || param === 'content') continue;
    properties[param] = { type: 'string' };
    if (!AUTO_INJECTED_PARAMS.has(param) && !required.includes(param)) {
      required.push(param);
    }
  }

  // Typed params declared per action (capabilities/policy.ts) win. They are the truth about what the
  // handler reads, so example scraping is skipped for that tool (an example's `data='{json}'`
  // blob would otherwise surface as a param the native path never unpacks).
  const declared = declaredActionParams(cap.actions);
  for (const [param, spec] of declared) {
    if (!PROPERTY_NAME.test(param) || param in properties || DECLARED_NOT_A_PARAM.has(param)) continue;
    const prop: Record<string, unknown> = {
      type: spec.type,
      description: paramDescription(spec, cap.supportedActions.length),
    };
    if (spec.enum) {
      prop.enum = [...spec.enum];
    }
    properties[param] = prop;
    // Top-level required only when EVERY action needs it; per-action requirements are
    // enforced in registry.execute with an error naming the field.
    if (spec.requiredBy.length === cap.supportedActions.length && !required.includes(param)) {
      required.push(param);
    }
  }

  // Optional params the examples use (durationMinutes, query, user, ...): declared so the model
  // learns their names, never required. Only for tools without declared params.
  if (declared.length === 0) {
    for (const param of exampleParams(cap)) {
      if (!(param in properties)) properties[param] = { type: 'string' };
    }
  }

  // Most handlers also accept free-text `content` (the CapabilityHandler 2nd arg).
  // The whole list rides on every tool turn (~63 tools), so per-tool text stays short: the
  // action enum already lists the actions, and this one description is repeated 63 times.
  // A tool that declares typed params has been audited: `content` is offered only when an action
  // declares it reads it (ActionSpec.content), so the model is not handed a free-text field
  // the handler ignores. Tools with no declared params keep the generic field.
  const declaredContent = declaredActionContent(cap.actions);
  if (declaredContent) {
    properties.content = {
      type: 'string',
      description: paramDescription(
        { description: declaredContent.description, usedBy: declaredContent.usedBy, requiredBy: [] },
        cap.supportedActions.length
      ),
    };
  } else if (!declaresParams(cap.actions)) {
    properties.content = { type: 'string', description: CONTENT_DESCRIPTION };
  }

  const firstLine = toCallNotation((cap.description || '').split('\n')[0].trim());
  const examples = (cap.examples ?? [])
    .slice(0, EXAMPLES_SHOWN)
    .map((e) => clip(toCallNotation(e.trim()).replace(/\s+/g, ' '), EXAMPLE_MAX));
  let exampleLine: string;
  if (examples.length) {
    exampleLine = `e.g. ${examples.join(' ; ')}`;
  } else {
    exampleLine = '';
  }
  const description = [
    clip(firstLine || `The ${cap.name} capability.`, DESCRIPTION_FIRST_LINE_MAX),
    exampleLine,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    type: 'function',
    function: {
      name: toToolName(cap.name),
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

/**
 * The tool list for a native turn: canonical capabilities only (aliases resolve at execute
 * time and are never listed; `capabilityRegistry.list()` holds no aliases), sorted by name so
 * the JSON is byte-stable across restarts.
 */
export function registryToTools(capabilities: RegisteredCapability[]): ToolDefinition[] {
  return [...capabilities]
    .sort((a, b) => compareStrings(a.name, b.name))
    .map(capabilityToTool);
}

/** Ensure a value is a string, or stringify it. */
function ensureString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

/** Ensure a value is a string, or return undefined. */
function ensureStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

/**
 * Map a model's tool_call back to a registry invocation.
 * The model returns `{ name, arguments }`; we split `action` + `content` out of the args and
 * hand the rest to the capability handler as `params`. Non-string argument values (a model
 * that sends a number or a list despite the string schema) are stringified, so handlers see
 * what the XML path always gave them.
 */
export function toolCallToInvocation(toolName: string, args: Record<string, unknown>): {
  name: string;
  action?: string;
  content?: string;
  params: Record<string, unknown>;
} {
  const { action, content, ...rest } = args ?? {};
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null) continue;
    params[key] = ensureString(value);
  }
  return {
    name: toolName,
    action: ensureStringOrUndefined(action),
    content: ensureStringOrUndefined(content),
    params,
  };
}
