import { describe, it, expect } from 'vitest';

/**
 * ATOMIC UNIT: Variable Context Builder
 * Tests the logic for building variable contexts from capability results
 */

interface CapabilityResult {
  capability: { name: string };
  data: unknown;
  success: boolean;
}

class VariableContextBuilder {
  static buildContext(results: CapabilityResult[]): Record<string, unknown> {
    const variables: Record<string, unknown> = {};
    
    if (results.length === 0) {
      return variables;
    }

    // Add latest result
    const lastResult = results[results.length - 1];
    if (lastResult.success) {
      variables.result = lastResult.data;
      variables.content = lastResult.data;
    }
    
    // Add indexed results (result_1, result_2, etc.)
    results.forEach((result, index) => {
      if (result.success) {
        variables[`result_${index + 1}`] = result.data;
      }
    });
    
    // Add capability-specific shortcuts
    const memoryResults = results.filter(r => r.capability.name === 'memory' && r.success);
    if (memoryResults.length > 0) {
      variables.memories = memoryResults[memoryResults.length - 1].data;
    }

    const webResults = results.filter(r => r.capability.name === 'web' && r.success);
    if (webResults.length > 0) {
      variables.web_content = webResults[webResults.length - 1].data;
    }
    
    return variables;
  }
}

describe('Variable Context Builder (Atomic Unit)', () => {
  it('should return empty context for no results', () => {
    const context = VariableContextBuilder.buildContext([]);
    expect(context).toEqual({});
  });

  it('should build context from single result', () => {
    const results: CapabilityResult[] = [
      { 
        capability: { name: 'memory' }, 
        data: 'test data', 
        success: true 
      }
    ];
    
    const context = VariableContextBuilder.buildContext(results);
    
    expect(context.result).toBe('test data');
    expect(context.content).toBe('test data');
    expect(context.result_1).toBe('test data');
    expect(context.memories).toBe('test data');
  });

  it('should build context from multiple results', () => {
    const results: CapabilityResult[] = [
      { capability: { name: 'memory' }, data: 'memory data', success: true },
      { capability: { name: 'web' }, data: 'web data', success: true }
    ];
    
    const context = VariableContextBuilder.buildContext(results);
    
    expect(context.result).toBe('web data'); // Latest
    expect(context.content).toBe('web data'); // Latest
    expect(context.result_1).toBe('memory data');
    expect(context.result_2).toBe('web data');
    expect(context.memories).toBe('memory data');
    expect(context.web_content).toBe('web data');
  });

  it('should skip failed results', () => {
    const results: CapabilityResult[] = [
      { capability: { name: 'memory' }, data: 'good data', success: true },
      { capability: { name: 'web' }, data: 'bad data', success: false },
      { capability: { name: 'filesystem' }, data: 'final data', success: true }
    ];
    
    const context = VariableContextBuilder.buildContext(results);
    
    expect(context.result).toBe('final data'); // Latest successful
    expect(context.result_1).toBe('good data');
    expect(context.result_2).toBeUndefined(); // Failed result skipped
    expect(context.result_3).toBe('final data');
    expect(context.memories).toBe('good data');
    expect(context.web_content).toBeUndefined(); // Failed result
  });

  it('should handle multiple memory results', () => {
    const results: CapabilityResult[] = [
      { capability: { name: 'memory' }, data: 'first memory', success: true },
      { capability: { name: 'memory' }, data: 'second memory', success: true }
    ];
    
    const context = VariableContextBuilder.buildContext(results);
    
    expect(context.memories).toBe('second memory'); // Latest memory
    expect(context.result_1).toBe('first memory');
    expect(context.result_2).toBe('second memory');
  });

  it('should handle complex data types', () => {
    const complexData = { user: 'test', preferences: ['dark_mode', 'notifications'] };
    const results: CapabilityResult[] = [
      { capability: { name: 'memory' }, data: complexData, success: true }
    ];
    
    const context = VariableContextBuilder.buildContext(results);
    
    expect(context.result).toEqual(complexData);
    expect(context.memories).toEqual(complexData);
  });
});

export { VariableContextBuilder };