import { logger } from '@coachartie/shared';

/**
 * Type definition for a capability handler function
 */
export type CapabilityHandler = (params: Record<string, any>, content?: string) => Promise<string>;

/**
 * Interface for a registered capability
 */
export interface RegisteredCapability {
  name: string;
  supportedActions: string[];
  handler: CapabilityHandler;
  description?: string;
  requiredParams?: string[];
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

  /**
   * Register a new capability in the registry
   * 
   * @param capability - The capability to register
   * @throws Error if capability is invalid or already exists
   */
  register(capability: RegisteredCapability): void {
    logger.info(`🔧 Registering capability: ${capability.name}`);

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
    
    logger.info(`✅ Capability '${capability.name}' registered successfully with actions: ${capability.supportedActions.join(', ')}`);
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
      throw new Error(
        `Capability '${name}' does not support action '${action}'. ` +
        `Supported actions: ${capability.supportedActions.join(', ')}`
      );
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
  async execute(name: string, action: string, params: Record<string, any> = {}, content?: string): Promise<string> {
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

    logger.info(`🔧 Executing capability '${name}' with action '${action}'`);

    try {
      const result = await capability.handler(handlerParams, content);
      logger.info(`✅ Capability '${name}:${action}' executed successfully`);
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
   * Clear all registered capabilities (useful for testing)
   */
  clear(): void {
    logger.info(`🧹 Clearing all ${this.capabilities.size} registered capabilities`);
    this.capabilities.clear();
  }
}

// Export singleton instance
export const capabilityRegistry = new CapabilityRegistry();