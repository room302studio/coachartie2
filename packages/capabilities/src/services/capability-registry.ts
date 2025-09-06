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
      ['write', 'write_file'], ['read', 'read_file'], ['store', 'remember'],
      ['save', 'remember'], ['search', 'recall'], ['find', 'recall'],
      ['get', 'recall'], ['create', 'create_directory'], ['list', 'list_directory'],
      ['check', 'exists'], ['remove', 'delete'], ['calc', 'calculate']
    ]);
    
    const alias = aliases.get(attemptedAction.toLowerCase());
    if (alias && available.includes(alias)) {
      return `Capability '${capabilityName}' does not support action '${attemptedAction}'. Did you mean '${alias}'? Supported actions: ${supportedActions}`;
    }
    
    // Find best match by substring/prefix similarity
    const target = attemptedAction.toLowerCase();
    const match = available.find(action => {
      const actionLower = action.toLowerCase();
      return actionLower.includes(target) || target.includes(actionLower) || 
             actionLower.startsWith(target.slice(0, 3)) || target.startsWith(actionLower.slice(0, 3));
    });
    
    if (match) {
      return `Capability '${capabilityName}' does not support action '${attemptedAction}'. Did you mean '${match}'? Supported actions: ${supportedActions}`;
    }
    
    return `Capability '${capabilityName}' does not support action '${attemptedAction}'. Supported actions: ${supportedActions}`;
  }

  /**
   * Generate capability instructions from the registry manifest
   */
  generateInstructions(): string {
    const capabilities = Array.from(this.capabilities.values());
    
    let instructions = `You are Coach Artie, a helpful AI assistant with special powers.

🧠 THINKING PROCESS:
- Use <thinking>your internal reasoning here</thinking> for any analysis or planning
- Put ALL your reasoning inside thinking tags - users should never see this
- After thinking, write your clean user-facing response

🎯 HOW YOUR SPECIAL POWERS WORK:
1. When you need to DO something (calculate, remember, search), write a special XML tag
2. The system will execute that action and replace your tag with the real result
3. It's like magic - you write the tag, the system does the work!

📋 THE ONE XML FORMAT (NEVER DEVIATE):
- To calculate: <capability name="calculator" action="calculate" expression="5+5" />
- To remember: <capability name="memory" action="remember" content="User likes pizza" />  
- To search memory: <capability name="memory" action="search" query="pizza" />
- To create buttons: <capability name="discord-ui" action="buttons" data='[{"label":"Yes","style":"success"},{"label":"No","style":"danger"}]' />

🚨 IRON RULES - THESE ARE ABSOLUTE:
- Use <thinking>analysis here</thinking> for internal reasoning - NEVER show users your thinking
- ONLY use <capability name="X" action="Y" param="value" /> format for actions
- Put ALL data in attributes: <capability name="calculator" action="calculate" expression="25*4" />
- ALWAYS use self-closing tags <capability ... />
- Use expression= for math, query= for searches, content= for memory, data= for JSON
- Examples that WILL WORK: <capability name="memory" action="remember" content="pizza is good" />
- Examples that will FAIL: <capability name="memory" action="remember">pizza is good</capability>
- DON'T write "5+5 equals 10" - write the XML tag instead

Available capabilities:\n`;
    
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

// Auto-register Web capability
import { webCapability } from '../capabilities/web.js';
capabilityRegistry.register(webCapability);

// Log all successfully registered capabilities on startup
logger.info(`🚀 Capability Registry initialized with ${capabilityRegistry.size()} capabilities:`, 
  capabilityRegistry.list().map(cap => `${cap.name} (${cap.supportedActions.join(', ')})`).join(', ')
);