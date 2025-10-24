import { logger } from '@coachartie/shared';

/**
 * Type definition for a capability handler function
 */
export type CapabilityHandler = (params: any, content?: string) => Promise<string>;

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
    return this.capabilities.has(name);
  }

  /**
   * Check if a capability supports a specific action
   *
   * @param name - The capability name
   * @param action - The action to check
   * @returns True if capability exists and supports the action
   */
  supportsAction(name: string, action: string): boolean {
    const capability = this.capabilities.get(name);
    return capability ? capability.supportedActions.includes(action) : false;
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
   * @returns Promise resolving to the capability result
   * @throws Error if capability not found, action not supported, or required params missing
   */
  async execute(name: string, action: string, params: any = {}, content?: string): Promise<string> {
    // Get and validate capability
    const capability = this.get(name, action);

    // Validate required parameters - BUT allow content as fallback for single-param capabilities
    if (capability.requiredParams) {
      const missingParams = capability.requiredParams.filter((param) => !(param in params));
      if (missingParams.length > 0) {
        // Special case: If only one param is required and content is provided, allow it
        // This handles cases where params.expression is missing but content has "2+2"
        const canUsContentAsFallback =
          missingParams.length === 1 && content && content.trim().length > 0;

        if (!canUsContentAsFallback) {
          throw new Error(
            `Missing required parameters for capability '${name}': ${missingParams.join(', ')}`
          );
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
      const result = await capability.handler(handlerParams, content);
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

  /**
   * Generate simple capability instructions - DELETED BLOAT
   */
  generateInstructions(): string {
    const capabilities = Array.from(this.capabilities.values());

    let instructions = `CRITICAL CAPABILITY FORMAT RULES:

When you need to execute a capability, you MUST use this EXACT XML format:
<capability name="capability-name" action="action-name" data='{"param":"value"}' />

CORRECT EXAMPLES:
<capability name="discord-forums" action="list-forums" data='{"guildId":"123456"}' />
<capability name="calculator" action="calculate" data='{"expression":"2+2"}' />
<capability name="web" action="search" data='{"query":"machine learning"}' />

WRONG FORMATS (DO NOT USE):
❌ discord-forums.list-forums("123456")
❌ /discord-forums(list-forums, 123456)
❌ discord-forums(list-forums: 123456)
❌ /execute_tool discord-forums list-forums

Available capabilities:
`;

    // List with examples
    for (const capability of capabilities) {
      instructions += `\n- ${capability.name}: ${capability.description || 'No description'}`;
      if (capability.examples && capability.examples.length > 0) {
        instructions += `\n  Example: ${capability.examples[0]}`;
      }
    }

    return instructions;
  }
}

// Export singleton instance
export const capabilityRegistry = new CapabilityRegistry();

// Auto-register embedded MCP capability
import { embeddedMCPCapability } from '../capabilities/embedded-mcp.js';
capabilityRegistry.register(embeddedMCPCapability);

// Auto-register LinkedIn capability
import { linkedInCapability } from '../capabilities/linkedin.js';
capabilityRegistry.register(linkedInCapability);

// Auto-register Semantic Search capability
import { semanticSearchCapability } from '../capabilities/semantic-search.js';
capabilityRegistry.register(semanticSearchCapability);

// Auto-register Web capability
import { webCapability } from '../capabilities/web.js';
capabilityRegistry.register(webCapability);

// Auto-register Discord Forums capability
import { discordForumsCapability } from '../capabilities/discord-forums.js';
capabilityRegistry.register(discordForumsCapability);

// Auto-register Email capability
import { emailCapability } from '../capabilities/email.js';
capabilityRegistry.register(emailCapability);

// Auto-register User Profile capability
import { userProfileCapability } from '../capabilities/user-profile.js';
capabilityRegistry.register(userProfileCapability);

// Log all successfully registered capabilities on startup
logger.info(
  `🚀 Capability Registry initialized with ${capabilityRegistry.size()} capabilities:`,
  capabilityRegistry
    .list()
    .map((cap) => `${cap.name} (${cap.supportedActions.join(', ')})`)
    .join(', ')
);
