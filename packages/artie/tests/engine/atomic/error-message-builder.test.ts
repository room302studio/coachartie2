import { describe, it, expect } from 'vitest';
import { calculateSimilarity } from './string-similarity.test.js';
import { ActionAliasMapper } from './action-alias-mapper.test.js';

/**
 * ATOMIC UNIT: Error Message Builder
 * Tests the core logic for building helpful error messages
 */

class ErrorMessageBuilder {
  static buildActionError(
    capabilityName: string,
    attemptedAction: string,
    supportedActions: string[]
  ): string {
    // Try alias first
    const alias = ActionAliasMapper.resolve(attemptedAction);
    if (alias !== attemptedAction && supportedActions.includes(alias)) {
      return (
        `❌ Capability '${capabilityName}' does not support action '${attemptedAction}'. ` +
        `💡 Did you mean '${alias}'? ` +
        `📋 Supported actions: ${supportedActions.join(', ')}`
      );
    }

    // Try fuzzy matching
    const suggestions = supportedActions
      .map((action) => ({ action, score: calculateSimilarity(attemptedAction, action) }))
      .filter((item) => item.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.action);

    if (suggestions.length > 0) {
      return (
        `❌ Capability '${capabilityName}' does not support action '${attemptedAction}'. ` +
        `💡 Did you mean '${suggestions.join("' or '")}'? ` +
        `📋 Supported actions: ${supportedActions.join(', ')}`
      );
    }

    // Basic error message
    return (
      `❌ Capability '${capabilityName}' does not support action '${attemptedAction}'. ` +
      `📋 Supported actions: ${supportedActions.join(', ')}`
    );
  }
}

describe('Error Message Builder (Atomic Unit)', () => {
  const supportedActions = [
    'read_file',
    'write_file',
    'create_directory',
    'list_directory',
    'exists',
    'delete',
  ];

  it('should suggest exact alias match', () => {
    const error = ErrorMessageBuilder.buildActionError('filesystem', 'write', supportedActions);
    expect(error).toContain("Did you mean 'write_file'?");
    expect(error).toContain('💡');
    expect(error).toContain('📋');
  });

  it('should suggest fuzzy matches when no alias exists', () => {
    const error = ErrorMessageBuilder.buildActionError('filesystem', 'read', supportedActions);
    expect(error).toContain("Did you mean 'read_file'?");
  });

  it('should suggest multiple fuzzy matches', () => {
    const error = ErrorMessageBuilder.buildActionError('filesystem', 'cre', supportedActions);
    expect(error).toContain('Did you mean');
    expect(error).toContain('create_directory');
  });

  it('should provide basic error when no good matches', () => {
    const error = ErrorMessageBuilder.buildActionError(
      'filesystem',
      'unknown_xyz',
      supportedActions
    );
    expect(error).not.toContain('Did you mean');
    expect(error).toContain('does not support action');
    expect(error).toContain('Supported actions:');
  });

  it('should include capability name in error', () => {
    const error = ErrorMessageBuilder.buildActionError('memory', 'xyz', ['remember', 'recall']);
    expect(error).toContain("Capability 'memory'");
  });

  it('should list all supported actions', () => {
    const error = ErrorMessageBuilder.buildActionError('filesystem', 'xyz', supportedActions);
    expect(error).toContain('read_file, write_file, create_directory');
  });

  it('should handle empty supported actions gracefully', () => {
    const error = ErrorMessageBuilder.buildActionError('test', 'action', []);
    expect(error).toBe(
      "❌ Capability 'test' does not support action 'action'. 📋 Supported actions: "
    );
  });
});

export { ErrorMessageBuilder };
