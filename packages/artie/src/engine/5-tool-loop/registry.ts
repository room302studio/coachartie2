import { logger } from '../../shared/logger.js';
import {
  StructuredCapabilityError,
  createStructuredError,
  formatStructuredErrorCompact,
  ParameterSchema,
} from '../errors.js';
import { isOwnerConfirmed } from './approval-gate.js';
import {
  gatesFor,
  requiredParamsFor,
  canonicalParams,
  OWNER_ONLY_REFUSAL,
  type ToolActions,
} from './tool-policy.js';
import { isOwner } from '../../shared/config/owner.js';
import { createPendingAction, findPendingDuplicate } from '../../shared/pending-actions.js';
import { pingApprovalNeeded } from './approval-ping.js';
import { trackRegistryCall, type RegistryCallRecord } from './tool-ledger.js';

/**
 * Context passed to capability handlers
 */
export interface CapabilityContext {
  guildId?: string;
  channelId?: string;
  userId?: string;
  messageId?: string;
}

/**
 * Type definition for a capability handler function
 */
export type CapabilityHandler = (
  params: any,
  content?: string,
  context?: CapabilityContext
) => Promise<string>;

/**
 * Interface for a registered capability
 */
export interface RegisteredCapability {
  name: string;
  supportedActions: string[];
  handler: CapabilityHandler;
  description?: string;
  requiredParams?: string[];
  examples?: string[];
  emoji?: string; // Visual signature for Discord reactions
  /**
   * Per-action policy: what each action touches and who may run it. The owner-only, taint and
   * approval gates are derived from this (tool-policy.ts). Undeclared = open + flagged.
   */
  actions?: ToolActions;
}

/**
 * Interface for capability validation errors
 */
export interface CapabilityValidationError {
  field: string;
  message: string;
}

/**
 * Capability Registry - A plugin-based system for registering and managing capabilities
 *
 * This registry allows dynamic registration of capabilities that can be invoked by
 * the capability orchestrator. Each capability can support multiple actions and
 * define required parameters for validation.
 */
/**
 * Curated action aliases: common synonyms the LLM reaches for that mean an
 * existing action. Keep these UNAMBIGUOUS — only map when the alias clearly
 * means the same thing (don't map across different intents). Silently
 * normalizing these saves a wasted loop iteration + paid LLM call per miss.
 */
const ACTION_ALIASES: Record<string, Record<string, string>> = {
  memory: {
    store: 'remember',
    save: 'remember',
    add: 'remember',
    retrieve: 'recall',
    get: 'recall',
    search: 'recall',
    delete: 'forget',
    remove: 'forget',
  },
};

/**
 * Old tool names that were merged into one canonical tool (wave 4, 2026-10-23). The model may
 * still emit them from memory, old examples or recalled conversations, so they keep working.
 *
 * - `to`: the canonical registered tool.
 * - `actions`: old action → canonical action. An action missing from the map keeps its name
 *   (the name still maps, so the taint guard sees the canonical tool and the registry rejects
 *   the unknown action with the canonical tool's real action list).
 * - `params`: fixed params the alias forces (e.g. which tracker inside `tasks`). They override
 *   whatever the model sent.
 * - `paramRenames`: old param key → canonical key, applied only when the canonical key is absent.
 *
 * Aliases are never registered, so they never appear in the prompt roster or a tool schema.
 * Resolve them ONLY through resolveToolCall().
 */
export interface ToolAlias {
  to: string;
  actions: Record<string, string>;
  params?: Record<string, unknown>;
  paramRenames?: Record<string, string>;
}

const identity = (actions: string[]): Record<string, string> =>
  Object.fromEntries(actions.map((a) => [a, a]));

export const TOOL_ALIASES: Record<string, ToolAlias> = {
  // planning: goal (legacy `goals` table) → goals (`objectives` table)
  goal: {
    to: 'goals',
    actions: {
      set: 'create',
      check: 'list',
      update: 'update',
      complete: 'complete',
      // goal:history was user-wide activity over N days; goals:history is per-goal and needs
      // an id, so the closest canonical action is the full list.
      history: 'list',
    },
    paramRenames: { objective: 'title', deadline: 'target_date', goal_id: 'id' },
  },
  // planning: todo + quests + task-status → tasks, told apart by `tracker`
  todo: {
    to: 'tasks',
    actions: identity(['create', 'add', 'next', 'complete', 'status', 'list']),
    params: { tracker: 'todo' },
  },
  quests: {
    to: 'tasks',
    actions: identity([
      'start', 'create', 'next', 'current', 'status', 'complete', 'done', 'finish', 'skip',
      'list', 'abandon', 'cancel', 'resume', 'clear',
    ]),
    params: { tracker: 'quest' },
  },
  'task-status': {
    to: 'tasks',
    actions: identity([
      'start', 'begin', 'update', 'progress', 'complete', 'done', 'finish', 'fail', 'error',
      'list', 'active', 'cancel', 'abort',
    ]),
    params: { tracker: 'task' },
  },
  // dev: shell + edit + git + search (docker exec into the sandbox container) → sandbox
  shell: {
    to: 'sandbox',
    actions: { exec: 'exec', send: 'send', split: 'split', read: 'read_pane', list: 'list_panes' },
  },
  edit: {
    to: 'sandbox',
    actions: { read: 'read_file', replace: 'replace', insert: 'insert', delete: 'delete' },
  },
  git: {
    to: 'sandbox',
    actions: {
      status: 'git_status',
      diff: 'git_diff',
      log: 'git_log',
      branch: 'git_branch',
      show: 'git_show',
      blame: 'git_blame',
    },
  },
  search: {
    to: 'sandbox',
    actions: { files: 'find_files', content: 'grep', both: 'search' },
  },
  // ops: runtime_config + model_manager → bot-config (no action collisions)
  runtime_config: {
    to: 'bot-config',
    actions: identity([
      'get_active_model', 'set_model_tier', 'get_context_size', 'set_context_size',
      'get_iteration_limits', 'set_iteration_limits', 'auto_optimize',
    ]),
  },
  model_manager: {
    to: 'bot-config',
    actions: identity(['list_models', 'get_pricing', 'get_recommendation', 'compare_models']),
  },
  // ops: hello-world (the OpenClaw-format example skill, zero real use) → diagnose's `ping`
  // action (wave: tool-loop cleanup 2026-10-26). F1: zero-use tools get merged, not deleted —
  // the skill's SKILL.md file stays on disk (skills/registry.ts skips auto-registering it as
  // its own capability because its name is a key here), but it no longer occupies its own
  // roster slot. greet/wave/introduce all collapse to the one harmless `ping`.
  'hello-world': {
    to: 'diagnose',
    actions: { greet: 'ping', wave: 'ping', introduce: 'ping' },
  },
};

export interface ResolvedToolCall<P = any> {
  name: string;
  action: string;
  params: P;
  /** The old name the call arrived with, when an alias fired. */
  aliasedFrom?: string;
}

/**
 * The ONE place an old tool name becomes its canonical tool. Used by registry
 * execute/has/get/supportsAction, the executor's taint check, conscience and the parse path.
 * Runs before ACTION_ALIASES. Idempotent: a canonical name resolves to itself.
 */
export function resolveToolCall<P = any>(
  name: string,
  action: string,
  params?: P,
  opts: { log?: boolean } = {}
): ResolvedToolCall<P> {
  let key: string;
  if (typeof name === 'string') {
    key = name;
  } else {
    key = String(name ?? '');
  }
  const alias = TOOL_ALIASES[key] ?? TOOL_ALIASES[key.toLowerCase()];
  if (!alias) {
    return { name, action, params: params as P };
  }

  const newAction = alias.actions[action] ?? alias.actions[String(action ?? '').toLowerCase()] ?? action;

  let newParams: any = params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const merged: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    for (const [oldKey, newKey] of Object.entries(alias.paramRenames ?? {})) {
      if (oldKey in merged && !(newKey in merged)) {
        merged[newKey] = merged[oldKey];
        delete merged[oldKey];
      }
    }
    newParams = { ...merged, ...(alias.params ?? {}) };
  } else if (params === undefined && alias.params) {
    newParams = { ...alias.params };
  }

  if (opts.log !== false) {
    logger.info(`🔀 tool alias ${key}:${action} → ${alias.to}:${newAction}`);
  }
  return { name: alias.to, action: newAction, params: newParams as P, aliasedFrom: key };
}

/**
 * Params that are NOT part of the `data` blob the LLM writes — they arrive
 * separately: `action` is the tag attribute, and channelId/guildId are injected
 * downstream from the Discord context by the executor. Listing them in a
 * capability's requiredParams caused a premature "Missing required parameters"
 * rejection at parse time (before injection), which silently broke github,
 * discord-channels/threads/user-history, etc. Exclude them from the missing
 * check everywhere; if truly absent the handler surfaces a specific error.
 */
export const AUTO_INJECTED_PARAMS = new Set(['action', 'channelId', 'guildId']);

export class CapabilityRegistry {
  private capabilities = new Map<string, RegisteredCapability>();
  private mcpTools = new Map<string, { connectionId: string; command: string; tool: any }>();

  /**
   * Register a new capability in the registry
   *
   * @param capability - The capability to register
   * @throws Error if capability is invalid or already exists
   */
  register(capability: RegisteredCapability): void {
    // Validate the capability
    const validationErrors = this.validate(capability);
    if (validationErrors.length > 0) {
      const errorMessages = validationErrors.map((e) => `${e.field}: ${e.message}`).join(', ');
      throw new Error(`Invalid capability registration: ${errorMessages}`);
    }

    // Check if capability already exists
    if (this.capabilities.has(capability.name)) {
      logger.warn(`⚠️  Overwriting existing capability: ${capability.name}`);
    }

    // Register the capability
    this.capabilities.set(capability.name, capability);
  }

  /**
   * Get a capability by name and validate it supports the requested action
   *
   * @param name - The capability name
   * @param action - The action to perform
   * @returns The registered capability
   * @throws Error if capability not found or action not supported
   */
  get(name: string, action: string): RegisteredCapability {
    ({ name, action } = resolveToolCall(name, action, undefined, { log: false }));
    const capability = this.capabilities.get(name);

    if (!capability) {
      throw new Error(`Capability '${name}' not found in registry`);
    }

    if (!capability.supportedActions.includes(action)) {
      throw new Error(this.generateActionError(name, action));
    }

    return capability;
  }

  /**
   * List all registered capabilities
   *
   * @returns Array of all registered capabilities
   */
  list(): RegisteredCapability[] {
    return Array.from(this.capabilities.values());
  }

  size(): number {
    return this.capabilities.size;
  }

  /**
   * Get capability names and their supported actions
   *
   * @returns Object mapping capability names to their supported actions
   */
  getCapabilityActions(): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const [name, capability] of this.capabilities) {
      result[name] = capability.supportedActions;
    }

    return result;
  }

  /**
   * Check if a capability exists
   *
   * @param name - The capability name
   * @returns True if capability exists
   */
  has(name: string): boolean {
    return this.capabilities.has(resolveToolCall(name, '', undefined, { log: false }).name);
  }

  /**
   * Check if a capability supports a specific action
   *
   * @param name - The capability name
   * @param action - The action to check
   * @returns True if capability exists and supports the action
   */
  supportsAction(name: string, action: string): boolean {
    ({ name, action } = resolveToolCall(name, action, undefined, { log: false }));
    const capability = this.capabilities.get(name);
    if (capability) {
      return capability.supportedActions.includes(action);
    }
    return false;
  }

  /**
   * Find the capability name that provides a given action
   * This enables simplified syntax like <action> instead of <capability name="X" action="Y">
   *
   * @param action - The action to find
   * @returns The capability name that provides this action, or null if not found
   */
  findCapabilityByAction(action: string): string | null {
    for (const [name, capability] of this.capabilities) {
      if (capability.supportedActions.includes(action)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Remove a capability from the registry
   *
   * @param name - The capability name to remove
   * @returns True if capability was removed, false if it didn't exist
   */
  unregister(name: string): boolean {
    const existed = this.capabilities.has(name);
    if (existed) {
      this.capabilities.delete(name);
      logger.info(`🗑️  Unregistered capability: ${name}`);
    }
    return existed;
  }

  /**
   * Validate a capability has all required fields and correct types
   *
   * @param capability - The capability to validate
   * @returns Array of validation errors (empty if valid)
   */
  validate(capability: RegisteredCapability): CapabilityValidationError[] {
    const errors: CapabilityValidationError[] = [];

    // Validate required fields
    if (!capability.name || typeof capability.name !== 'string') {
      errors.push({
        field: 'name',
        message: 'Name is required and must be a string',
      });
    }

    if (!capability.supportedActions || !Array.isArray(capability.supportedActions)) {
      errors.push({
        field: 'supportedActions',
        message: 'supportedActions is required and must be an array',
      });
    } else {
      // Validate each action is a string
      const invalidActions = capability.supportedActions.filter(
        (action) => typeof action !== 'string'
      );
      if (invalidActions.length > 0) {
        errors.push({
          field: 'supportedActions',
          message: 'All actions must be strings',
        });
      }

      // Validate at least one action is provided
      if (capability.supportedActions.length === 0) {
        errors.push({
          field: 'supportedActions',
          message: 'At least one supported action is required',
        });
      }
    }

    if (!capability.handler || typeof capability.handler !== 'function') {
      errors.push({
        field: 'handler',
        message: 'Handler is required and must be a function',
      });
    }

    // Validate optional fields
    if (capability.description && typeof capability.description !== 'string') {
      errors.push({
        field: 'description',
        message: 'Description must be a string if provided',
      });
    }

    if (capability.requiredParams && !Array.isArray(capability.requiredParams)) {
      errors.push({
        field: 'requiredParams',
        message: 'requiredParams must be an array if provided',
      });
    } else if (capability.requiredParams) {
      // Validate each required param is a string
      const invalidParams = capability.requiredParams.filter((param) => typeof param !== 'string');
      if (invalidParams.length > 0) {
        errors.push({
          field: 'requiredParams',
          message: 'All required parameter names must be strings',
        });
      }
    }

    return errors;
  }

  /**
   * Execute a capability with the given parameters
   *
   * @param name - The capability name
   * @param action - The action to perform
   * @param params - Parameters for the capability
   * @param content - Optional content string
   * @param context - Optional context (guildId, channelId, etc.)
   * @returns Promise resolving to the capability result
   * @throws StructuredCapabilityError if capability not found, action not supported, or required params missing
   */
  async execute(
    name: string,
    action: string,
    params: any = {},
    content?: string,
    context?: CapabilityContext
  ): Promise<string> {
    // Every call, whatever its outcome, leaves one row in the tool-call ledger (tool-ledger.ts).
    const rec: RegistryCallRecord = {
      tool: name,
      action,
      userId: context?.userId,
      guildId: context?.guildId,
    };
    return trackRegistryCall(rec, () => this.executeInner(rec, name, action, params, content, context));
  }

  private async executeInner(
    rec: RegistryCallRecord,
    name: string,
    action: string,
    params: any,
    content?: string,
    context?: CapabilityContext
  ): Promise<string> {
    // Old merged tool names (goal, shell, todo, …) resolve to their canonical tool first,
    // before ACTION_ALIASES and before any validation.
    ({ name, action, params } = resolveToolCall(name, action, params));
    rec.tool = name;
    rec.action = action;

    // Gates derived from the tool's own declaration (tool-policy.ts).
    const gates = gatesFor(this.capabilities.get(name)?.actions, action);

    // Owner-only: refused outright for anyone but EJ, before the approval gate, so a
    // non-owner can't even queue them for approval.
    if (gates.ownerOnly && !isOwner(context?.userId || '')) {
      logger.warn(`🔒 Owner-only call refused: ${name}:${action} from ${context?.userId || 'no-context'}`);
      rec.outcome = 'refused_owner';
      return OWNER_ONLY_REFUSAL;
    }

    // Approval gate: money and anything leaving Discord (effect outside/money) needs EJ's
    // sign-off, unless EJ is the one calling and explicitly confirmed. resolveToolCall already
    // ran, so `name` is canonical here.
    if (gates.needsApproval && !isOwnerConfirmed(context, params)) {
      // An identical ask already waiting (a model retry, a re-proposed scribe issue) reuses
      // that row instead of stacking a duplicate EJ would have to deny, and pings nobody.
      rec.outcome = 'queued_approval';
      const existingId = findPendingDuplicate({ tool: name, action, params, content });
      if (existingId !== null) {
        logger.info(`⏸️ Gated call already pending: ${name}:${action} (#${existingId})`);
        return `⏸️ This ${name}:${action} call needs EJ's approval first and is already waiting (pending #${existingId}). EJ can review it with the approvals tool.`;
      }
      const id = createPendingAction({
        tool: name,
        action,
        params,
        content,
        context,
        requestedBy: context?.userId || 'unknown-user',
      });
      logger.info(`⏸️ Gated call blocked pending approval: ${name}:${action} (#${id})`);
      pingApprovalNeeded({ id, tool: name, action, params });
      return `⏸️ This ${name}:${action} call needs EJ's approval first (pending #${id}). EJ can review it with the approvals tool.`;
    }

    // Get capability (will throw if not found)
    const capability = this.capabilities.get(name);

    if (!capability) {
      rec.outcome = 'unknown_tool';
      rec.errorClass = 'tool_not_found';
      // The model often knows the ACTION but invents the capability name (e.g.
      // "Dev Support:create_payment_link" — the product name, not the tool name).
      // If exactly the requested action exists elsewhere, say where, so the
      // retry loop can self-correct instead of burning three blind attempts.
      const owner = Array.from(this.capabilities.values()).find((c) =>
        c.supportedActions.includes(action)
      );
      let errorMessage = `Capability '${name}' not found in registry.`;
      if (owner) {
        errorMessage += ` The action "${action}" belongs to capability "${owner.name}" — use <capability name="${owner.name}" action="${action}" ... />`;
      }
      throw new Error(errorMessage);
    }

    // Auto-correct known action synonyms before validating, so a wrong-but-clear
    // action name (e.g. memory:store) just works instead of erroring + retrying.
    if (!capability.supportedActions.includes(action)) {
      const aliased = ACTION_ALIASES[name]?.[action];
      if (aliased && capability.supportedActions.includes(aliased)) {
        logger.info(`🔀 Aliased ${name}:${action} → ${name}:${aliased}`);
        action = aliased;
        rec.action = action;
      }
    }

    // Validate action is supported
    if (!capability.supportedActions.includes(action)) {
      rec.outcome = 'unknown_action';
      rec.errorClass = 'action_not_supported';
      const structuredError = this.createActionError(name, action, capability);
      logger.warn(`⚠️ ${formatStructuredErrorCompact(structuredError)}`);
      throw new Error(JSON.stringify(structuredError));
    }

    // Declared aliases (forum_id) become their canonical names (forumId) first.
    params = canonicalParams(capability.actions, action, params ?? {});

    // Validate required parameters: the tool-wide list plus this action's declared ones
    // (tool-policy.ts). The schema can't require per-action params, so this is where they bind.
    const requiredForCall = [
      ...(capability.requiredParams ?? []),
      ...requiredParamsFor(capability.actions, action),
    ];
    if (requiredForCall.length > 0) {
      const missingParams = requiredForCall.filter(
        (param) => !AUTO_INJECTED_PARAMS.has(param) && !(param in params)
      );

      if (missingParams.length > 0) {
        // Special case: If only one param is required and content is provided, allow it
        // This handles cases where params.expression is missing but content has "2+2"
        const canUseContentAsFallback =
          missingParams.length === 1 && content && content.trim().length > 0;

        if (!canUseContentAsFallback) {
          rec.outcome = 'invalid_args';
          rec.errorClass = `missing_params:${missingParams.join(',')}`;
          const structuredError = this.createMissingParamsError(
            name,
            action,
            missingParams,
            capability
          );
          logger.warn(`⚠️ ${formatStructuredErrorCompact(structuredError)}`);
          throw new Error(JSON.stringify(structuredError));
        }

        logger.info(
          `✅ Using content as fallback for required param '${missingParams[0]}' in ${name}:${action}`
        );
      }
    }

    // Add action to params for the handler
    const handlerParams = { ...params, action };

    // Debug: Log what we're passing to the handler
    logger.info(
      `🔧 REGISTRY: Calling ${name}:${action} with content="${content}" (${typeof content})`
    );

    try {
      const result = await capability.handler(handlerParams, content, context);
      return result;
    } catch (error) {
      logger.error(`❌ Capability '${name}:${action}' failed:`, error);
      throw error;
    }
  }

  /**
   * Get registry statistics
   *
   * @returns Object with registry statistics
   */
  getStats(): {
    totalCapabilities: number;
    totalActions: number;
    capabilities: Array<{
      name: string;
      actions: number;
      hasDescription: boolean;
      hasRequiredParams: boolean;
    }>;
  } {
    const capabilities = Array.from(this.capabilities.values());

    return {
      totalCapabilities: capabilities.length,
      totalActions: capabilities.reduce((sum, cap) => sum + cap.supportedActions.length, 0),
      capabilities: capabilities.map((cap) => ({
        name: cap.name,
        actions: cap.supportedActions.length,
        hasDescription: !!cap.description,
        hasRequiredParams: !!(cap.requiredParams && cap.requiredParams.length > 0),
      })),
    };
  }

  /**
   * Register an MCP tool for XML tag mapping
   */
  registerMCPTool(toolName: string, connectionId: string, command: string, tool: any): void {
    this.mcpTools.set(toolName, { connectionId, command, tool });
  }

  /**
   * Get registered MCP tool by name
   */
  getMCPTool(toolName: string): { connectionId: string; command: string; tool: any } | undefined {
    return this.mcpTools.get(toolName);
  }

  /**
   * List all registered MCP tools
   */
  listMCPTools(): string[] {
    return Array.from(this.mcpTools.keys());
  }

  /**
   * Clear all registered capabilities (useful for testing)
   */
  clear(): void {
    this.capabilities.clear();
    this.mcpTools.clear();
  }

  /**
   * Create structured error for missing required parameters
   */
  createMissingParamsError(
    capabilityName: string,
    action: string,
    missingParams: string[],
    _capability: RegisteredCapability
  ): StructuredCapabilityError {
    // Build parameter schema
    const paramSchema: ParameterSchema[] = missingParams.map((param) => ({
      name: param,
      type: 'string',
      required: true,
      description: `Required parameter for ${action}`,
      example: `"example-${param}"`,
    }));

    // Build example - we need to know what params the capability typically needs
    const correctExample = this.buildCapabilityExample(capabilityName, action, missingParams);

    return createStructuredError(
      capabilityName,
      action,
      'PARAM_MISSING_001',
      `Missing required parameters: ${missingParams.join(', ')}`,
      {
        requiredParams: paramSchema,
        correctExample,
        recoveryTemplate: `<capability name="${capabilityName}" action="${action}" data='{"${missingParams[0]}":"YOUR_VALUE_HERE"}' />`,
        suggestedAlternatives: this.findSimilarCapabilities(capabilityName),
      }
    );
  }

  /**
   * Create structured error for unsupported action
   */
  createActionError(
    capabilityName: string,
    attemptedAction: string,
    capability: RegisteredCapability
  ): StructuredCapabilityError {
    const available = capability.supportedActions;

    // Find best match. Coerce defensively — a caller bug once passed an object
    // here and the error-builder itself became the crash.
    const target = String(attemptedAction ?? '').toLowerCase();
    const match = available.find((action) => {
      const actionLower = action.toLowerCase();
      return (
        actionLower.includes(target) ||
        target.includes(actionLower) ||
        actionLower.startsWith(target.slice(0, 3)) ||
        target.startsWith(actionLower.slice(0, 3))
      );
    });

    const suggestedAction = match || available[0];
    const correctExample = `<capability name="${capabilityName}" action="${suggestedAction}" data='{"param":"value"}' />`;

    return createStructuredError(
      capabilityName,
      attemptedAction,
      'ACTION_NOT_FOUND_005',
      `Action "${attemptedAction}" is not supported. Did you mean "${suggestedAction}"?`,
      {
        correctExample,
        recoveryTemplate: `<capability name="${capabilityName}" action="${suggestedAction}" data='{"param":"value"}' />`,
        suggestedAlternatives: available.map((action) => ({
          action,
          reason: `Alternative action for ${capabilityName}`,
          example: `<capability name="${capabilityName}" action="${action}" data='{"param":"value"}' />`,
        })),
      }
    );
  }

  /**
   * Build a proper capability example based on common patterns
   */
  private buildCapabilityExample(
    capabilityName: string,
    action: string,
    paramNames: string[]
  ): string {
    // Build data object with all required params
    const dataObj = paramNames
      .map((param) => {
        // Smart defaults based on parameter name patterns
        if (param.includes('repo') || param.includes('repository')) {
          return `"${param}":"owner/repository-name"`;
        } else if (param.includes('query') || param.includes('search')) {
          return `"${param}":"search-term"`;
        } else if (param.includes('id')) {
          return `"${param}":"123456"`;
        } else if (param.includes('limit') || param.includes('count')) {
          return `"${param}":10`;
        }
        return `"${param}":"value"`;
      })
      .join(',');

    return `<capability name="${capabilityName}" action="${action}" data='{${dataObj}}' />`;
  }

  /**
   * Find similar capabilities for suggestions
   */
  private findSimilarCapabilities(
    capabilityName: string
  ): Array<{ action: string; reason: string; example: string }> {
    const similar = Array.from(this.capabilities.values())
      .filter((cap) => cap.name !== capabilityName)
      .filter(
        (cap) =>
          cap.name.toLowerCase().includes(capabilityName.toLowerCase().split(/[-_]/)[0]) ||
          capabilityName.toLowerCase().includes(cap.name.toLowerCase().split(/[-_]/)[0])
      )
      .slice(0, 2);

    return similar.map((cap) => ({
      action: cap.supportedActions[0],
      reason: `Use ${cap.name}:${cap.supportedActions[0]} for similar functionality`,
      example: `<capability name="${cap.name}" action="${cap.supportedActions[0]}" data='{"param":"value"}' />`,
    }));
  }

  /**
   * Generate error message with action suggestions using simple fuzzy matching
   */
  generateActionError(capabilityName: string, attemptedAction: string): string {
    const capability = this.capabilities.get(capabilityName);
    if (!capability) {
      return `Capability '${capabilityName}' not found`;
    }

    const available = capability.supportedActions;
    const supportedActions = available.join(', ');

    // Simple alias check and fuzzy matching
    const aliases = new Map([
      ['write', 'write_file'],
      ['read', 'read_file'],
      ['store', 'remember'],
      ['save', 'remember'],
      ['search', 'recall'],
      ['find', 'recall'],
      ['get', 'recall'],
      ['create', 'create_directory'],
      ['list', 'list_directory'],
      ['check', 'exists'],
      ['remove', 'delete'],
      ['calc', 'calculate'],
    ]);

    const alias = aliases.get(attemptedAction.toLowerCase());
    if (alias && available.includes(alias)) {
      return `Capability '${capabilityName}' does not support action '${attemptedAction}'. Did you mean '${alias}'? Supported actions: ${supportedActions}`;
    }

    // Find best match by substring/prefix similarity
    const target = attemptedAction.toLowerCase();
    const match = available.find((action) => {
      const actionLower = action.toLowerCase();
      return (
        actionLower.includes(target) ||
        target.includes(actionLower) ||
        actionLower.startsWith(target.slice(0, 3)) ||
        target.startsWith(actionLower.slice(0, 3))
      );
    });

    if (match) {
      return `Capability '${capabilityName}' does not support action '${attemptedAction}'. Did you mean '${match}'? Supported actions: ${supportedActions}`;
    }

    return `Capability '${capabilityName}' does not support action '${attemptedAction}'. Supported actions: ${supportedActions}`;
  }
}

// Export singleton instance. It starts empty: every tool is registered by
// register-tools.ts (capabilityBootstrap), which also logs the roster. The old
// module-load side-door here (embedded_mcp, scrapbook) moved there in wave 7.
export const capabilityRegistry = new CapabilityRegistry();
