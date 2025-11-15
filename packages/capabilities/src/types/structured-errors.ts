/**
 * Structured Error Types for LLM Self-Correction
 *
 * These error types are designed to help LLMs understand what went wrong
 * and provide them with exact templates they can copy to retry the operation.
 *
 * Key principle: Every error includes an example the LLM can copy directly.
 */

/**
 * Parameter schema definition for LLM understanding
 */
export interface ParameterSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  example?: string | number | boolean;
  validValues?: string[];
  pattern?: string;
}

/**
 * Structured error response for LLM-facing errors
 * Designed specifically for AI/LLM understanding and self-correction
 */
export interface StructuredCapabilityError {
  // Error categorization
  errorCode: string; // e.g., PARAM_MISSING_001, ACTION_UNSUPPORTED_002, INVALID_FORMAT_003

  // Clear explanation of what went wrong (for LLM understanding)
  message: string;

  // What capability was attempted
  capability: string;
  action: string;

  // Schema of what was needed
  requiredParams?: ParameterSchema[];
  providedParams?: Record<string, unknown>;

  // Exact example the LLM can copy
  correctExample: string; // XML tag format the LLM can copy exactly

  // Recovery instructions (what to do next)
  recoveryTemplate?: string; // Suggested retry with placeholders

  // Additional context for LLM reasoning
  suggestedAlternatives?: Array<{
    action: string;
    reason: string;
    example: string;
  }>;

  // Timestamp for debugging
  timestamp: string;
}

/**
 * Error code taxonomy for categorization
 */
export const ErrorCodeTaxonomy = {
  // Parameter errors (PARAM_*)
  PARAM_MISSING_001: 'Required parameter is missing',
  PARAM_INVALID_TYPE_002: 'Parameter has wrong type',
  PARAM_INVALID_VALUE_003: 'Parameter value is not in valid options',
  PARAM_INVALID_FORMAT_004: 'Parameter format is incorrect',

  // Action errors (ACTION_*)
  ACTION_NOT_FOUND_005: 'Action is not supported by this capability',
  ACTION_UNKNOWN_006: 'Unknown action',

  // Format errors (FORMAT_*)
  FORMAT_INVALID_XML_007: 'XML format is incorrect',
  FORMAT_MISSING_ATTRIBUTE_008: 'Required XML attribute is missing',

  // Authentication/Access errors (ACCESS_*)
  ACCESS_FORBIDDEN_009: 'You do not have permission to use this capability',
  ACCESS_TOKEN_INVALID_010: 'Authentication token is missing or invalid',

  // Service errors (SERVICE_*)
  SERVICE_UNAVAILABLE_011: 'The service is temporarily unavailable',
  SERVICE_RATE_LIMITED_012: 'Rate limit exceeded',

  // Validation errors (VALID_*)
  VALID_CONSTRAINT_VIOLATION_013: 'Validation constraint was violated',
  VALID_PRECONDITION_FAILED_014: 'Precondition for operation not met',
};

/**
 * Create a structured error from an error message
 */
export function createStructuredError(
  capability: string,
  action: string,
  errorCode: string,
  message: string,
  context: {
    requiredParams?: ParameterSchema[];
    providedParams?: Record<string, unknown>;
    correctExample: string;
    recoveryTemplate?: string;
    suggestedAlternatives?: Array<{
      action: string;
      reason: string;
      example: string;
    }>;
  }
): StructuredCapabilityError {
  return {
    errorCode,
    message,
    capability,
    action,
    requiredParams: context.requiredParams,
    providedParams: context.providedParams,
    correctExample: context.correctExample,
    recoveryTemplate: context.recoveryTemplate,
    suggestedAlternatives: context.suggestedAlternatives,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format structured error for LLM consumption
 * Provides clear, concise error information with actionable examples
 */
export function formatStructuredErrorForLLM(error: StructuredCapabilityError): string {
  let formatted = `❌ ERROR [${error.errorCode}]: ${error.message}\n`;
  formatted += `📍 Capability: ${error.capability}:${error.action}\n`;

  if (error.requiredParams && error.requiredParams.length > 0) {
    formatted += `📋 Required Parameters:\n`;
    for (const param of error.requiredParams) {
      formatted += `   - ${param.name} (${param.type})${param.required ? ' *required' : ''}: ${param.description}\n`;
      if (param.example !== undefined) {
        formatted += `     Example: ${param.example}\n`;
      }
      if (param.validValues) {
        formatted += `     Valid values: ${param.validValues.join(', ')}\n`;
      }
    }
  }

  formatted += `\n✅ CORRECT FORMAT TO COPY:\n`;
  formatted += `${error.correctExample}\n`;

  if (error.recoveryTemplate) {
    formatted += `\n💡 RECOVERY TEMPLATE:\n`;
    formatted += `${error.recoveryTemplate}\n`;
  }

  if (error.suggestedAlternatives && error.suggestedAlternatives.length > 0) {
    formatted += `\n🔄 SUGGESTED ALTERNATIVES:\n`;
    for (const alt of error.suggestedAlternatives) {
      formatted += `   - ${alt.action}: ${alt.reason}\n`;
      formatted += `     ${alt.example}\n`;
    }
  }

  return formatted;
}

/**
 * Compact error format for token efficiency
 * Provides essential info + example in minimal tokens
 */
export function formatStructuredErrorCompact(error: StructuredCapabilityError): string {
  const lines = [
    `❌ [${error.errorCode}] ${error.message}`,
    `📍 ${error.capability}:${error.action}`,
    `✅ ${error.correctExample}`,
  ];

  if (error.recoveryTemplate) {
    lines.push(`💡 Try: ${error.recoveryTemplate}`);
  }

  return lines.join('\n');
}
