import { RegisteredCapability } from './capability-registry.js';

/**
 * Capability → native tool-call schema (Phase A foundation, see TOOL-USE-MIGRATION.md).
 *
 * Converts a RegisteredCapability into an OpenAI-format function/tool definition. OpenRouter
 * accepts this format and translates it to each provider's native tool API (Anthropic, OpenAI,
 * Gemini), so tools are defined ONCE here and the model stays freely swappable — no provider lock-in.
 *
 * This file is intentionally pure and standalone: it touches no live path and has no side effects,
 * so it can be unit-tested in isolation before the new agentic loop is wired up.
 *
 * Known limitation: the registry only knows param *names* (`requiredParams: string[]`), not their
 * types — so every param is typed `string` for now (handlers already parse strings). A later
 * enhancement can let capabilities declare richer JSON-Schema param types.
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
function toToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function capabilityToTool(cap: RegisteredCapability): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  // `action` selects which sub-action of the capability to run.
  if (cap.supportedActions.length > 0) {
    properties.action = {
      type: 'string',
      enum: [...cap.supportedActions],
      description: `Which ${cap.name} action to run.`,
    };
    required.push('action');
  }

  // Required params — names only in the registry, so typed as strings (handlers parse).
  for (const param of cap.requiredParams ?? []) {
    properties[param] = { type: 'string', description: `${param} for ${cap.name}.` };
    if (!required.includes(param)) {
      required.push(param);
    }
  }

  // Most handlers also accept free-text `content` (the CapabilityHandler 2nd arg).
  properties.content = {
    type: 'string',
    description: 'Optional free-text content/argument for the action.',
  };

  const description = [
    cap.description || `The ${cap.name} capability.`,
    cap.supportedActions.length ? `Actions: ${cap.supportedActions.join(', ')}.` : '',
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

/** Convert a list of capabilities (e.g. `capabilityRegistry.list()`) into tool definitions. */
export function registryToTools(capabilities: RegisteredCapability[]): ToolDefinition[] {
  return capabilities.map(capabilityToTool);
}

/**
 * Map a model's tool_call back to a registry invocation.
 * The model returns `{ name, arguments }`; we split `action` + `content` out of the args and
 * hand the rest to the capability handler as `params`. (Used by the future tool loop; pure here.)
 */
export function toolCallToInvocation(toolName: string, args: Record<string, unknown>): {
  name: string;
  action?: string;
  content?: string;
  params: Record<string, unknown>;
} {
  const { action, content, ...params } = args ?? {};
  return {
    name: toolName,
    action: typeof action === 'string' ? action : undefined,
    content: typeof content === 'string' ? content : undefined,
    params,
  };
}
