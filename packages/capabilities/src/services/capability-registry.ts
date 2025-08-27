import { logger } from '@coachartie/shared';
import { FuzzyMatcher } from '../utils/fuzzy-matcher.js';

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
  private mcpTools = new Map<string, {connectionId: string, command: string, tool: any}>();

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
      const errorMessages = validationErrors.map(e => `${e.field}: ${e.message}`).join(', ');
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
      // ⚡ ENHANCED: Use fuzzy matching for capability names! *swoosh*
      const availableCapabilities = Array.from(this.capabilities.keys());
      const fuzzyError = FuzzyMatcher.generateHelpfulError(
        'capability', 
        name, 
        availableCapabilities
      );
      throw new Error(fuzzyError);
    }

    if (!capability.supportedActions.includes(action)) {
      // ⚡ ENHANCED: Use fuzzy matching for actions! *zoom*
      const fuzzyError = FuzzyMatcher.generateHelpfulError(
        'action', 
        action, 
        capability.supportedActions, 
        { capabilityName: name }
      );
      throw new Error(fuzzyError);
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
        message: 'Name is required and must be a string'
      });
    }

    if (!capability.supportedActions || !Array.isArray(capability.supportedActions)) {
      errors.push({
        field: 'supportedActions',
        message: 'supportedActions is required and must be an array'
      });
    } else {
      // Validate each action is a string
      const invalidActions = capability.supportedActions.filter(action => typeof action !== 'string');
      if (invalidActions.length > 0) {
        errors.push({
          field: 'supportedActions',
          message: 'All actions must be strings'
        });
      }

      // Validate at least one action is provided
      if (capability.supportedActions.length === 0) {
        errors.push({
          field: 'supportedActions',
          message: 'At least one supported action is required'
        });
      }
    }

    if (!capability.handler || typeof capability.handler !== 'function') {
      errors.push({
        field: 'handler',
        message: 'Handler is required and must be a function'
      });
    }

    // Validate optional fields
    if (capability.description && typeof capability.description !== 'string') {
      errors.push({
        field: 'description',
        message: 'Description must be a string if provided'
      });
    }

    if (capability.requiredParams && !Array.isArray(capability.requiredParams)) {
      errors.push({
        field: 'requiredParams',
        message: 'requiredParams must be an array if provided'
      });
    } else if (capability.requiredParams) {
      // Validate each required param is a string
      const invalidParams = capability.requiredParams.filter(param => typeof param !== 'string');
      if (invalidParams.length > 0) {
        errors.push({
          field: 'requiredParams',
          message: 'All required parameter names must be strings'
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

    // Validate required parameters
    if (capability.requiredParams) {
      const missingParams = capability.requiredParams.filter(param => !(param in params));
      if (missingParams.length > 0) {
        throw new Error(
          `Missing required parameters for capability '${name}': ${missingParams.join(', ')}`
        );
      }
    }

    // Add action to params for the handler
    const handlerParams = { ...params, action };


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
  getStats(): { totalCapabilities: number; totalActions: number; capabilities: Array<{ name: string; actions: number; hasDescription: boolean; hasRequiredParams: boolean }> } {
    const capabilities = Array.from(this.capabilities.values());
    
    return {
      totalCapabilities: capabilities.length,
      totalActions: capabilities.reduce((sum, cap) => sum + cap.supportedActions.length, 0),
      capabilities: capabilities.map(cap => ({
        name: cap.name,
        actions: cap.supportedActions.length,
        hasDescription: !!cap.description,
        hasRequiredParams: !!(cap.requiredParams && cap.requiredParams.length > 0)
      }))
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
  getMCPTool(toolName: string): {connectionId: string, command: string, tool: any} | undefined {
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

  // ⚡ REMOVED: Old aliases - now using unified FuzzyMatcher system! *pew pew*

  // ⚡ REMOVED: Old findSimilarActions - now using unified FuzzyMatcher! *whoosh*

  // ⚡ REMOVED: Old calculateSimilarity - now using Levenshtein distance in FuzzyMatcher! *zoom*

  // ⚡ ENHANCED: Now using unified FuzzyMatcher for ALL error generation! *pew pew*
  generateActionError(capabilityName: string, attemptedAction: string): string {
    const capability = this.capabilities.get(capabilityName);
    if (!capability) {
      return `Capability '${capabilityName}' not found`;
    }

    return FuzzyMatcher.generateHelpfulError(
      'action', 
      attemptedAction, 
      capability.supportedActions, 
      { capabilityName }
    );
  }

  /**
   * Generate capability instructions from the registry manifest
   */
  generateInstructions(): string {
    const capabilities = Array.from(this.capabilities.values());
    
    let instructions = `CRITICAL: You MUST use XML tags for ALL actions. NO EXCEPTIONS.

When user says "calculate 2+2" you write:
<capability name="calculator" action="calculate" expression="2+2" />

When user says "what is 5 times 5" you write:
<capability name="calculator" action="calculate" expression="5*5" />

When user says "add todo: buy milk" you write:
<capability name="todo" action="add" expression="buy milk" />

When user says "remember I like pizza" you write:
<capability name="memory" action="remember" expression="I like pizza" />

THAT'S IT. JUST THE XML TAG. NOTHING ELSE.

PATTERN: <capability name="[tool]" action="[action]" expression="[content]" />

DO NOT write explanations.
DO NOT write "The answer is..."
DO NOT write anything except the XML tag.

MORE EXAMPLES:
User: "15 divided by 3"
You: <capability name="calculator" action="calculate" expression="15/3" />

User: "add task write tests"
You: <capability name="todo" action="add" expression="write tests" />

User: "search for pizza"
You: <capability name="memory" action="search" expression="pizza" />

AVAILABLE CAPABILITIES:\n`;
    
    // Generate capability list with examples from manifest
    for (const capability of capabilities) {
      const { name, supportedActions, description, examples } = capability;
      
      // Add description
      if (description) {
        instructions += `- ${name}: ${description}\n`;
      }
      
      // Add examples from the capability manifest
      if (examples && examples.length > 0) {
        for (const example of examples.slice(0, 2)) { // Limit to 2 examples per capability
          instructions += `  ${example}\n`;
        }
      } else {
        // Generate basic examples for capabilities without them
        for (const action of supportedActions.slice(0, 2)) {
          instructions += `  <capability name="${name}" action="${action}" />\n`;
        }
      }
      instructions += `\n`;
    }
    
    instructions += `\n⚡ REMEMBER: USE YOUR SPECIAL POWERS! ⚡

When the user asks for math, memory, or searches:
1. Write the XML tag (don't calculate in your head!)
2. The system will replace it with the real answer
3. Then respond naturally around that result

Example conversation:
User: "What's 15 times 8?"
You: "Let me calculate that: <capability name="calculator" action="calculate" expression="15*8" />"
System replaces with: "Let me calculate that: 120"
You continue: "So 15 times 8 equals 120!"

🎯 THE KEY: Write the XML tag, let the system do the work, then respond naturally!

User message: {{USER_MESSAGE}}`;
    
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