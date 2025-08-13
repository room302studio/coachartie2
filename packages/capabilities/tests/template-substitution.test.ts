import { describe, it, expect } from 'vitest';

/**
 * Standalone template variable substitution utility
 * Extracted from capability-orchestrator for testing
 */
class TemplateSubstitution {
  /**
   * Perform template variable substitution on text
   */
  static substitute(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      const trimmedVarName = varName.trim();
      const value = variables[trimmedVarName];
      
      if (value !== undefined) {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      } else {
        return match; // Leave unchanged if variable not found
      }
    });
  }

  /**
   * Create substitution variables from orchestration results
   */
  static createVariablesFromResults(results: Array<{ capability: { name: string }, data: unknown }>): Record<string, unknown> {
    const variables: Record<string, unknown> = {};
    
    if (results.length > 0) {
      const lastResult = results[results.length - 1];
      variables.result = lastResult.data;
      variables.content = lastResult.data;
      
      // Add indexed results (result_1, result_2, etc.)
      results.forEach((result, index) => {
        variables[`result_${index + 1}`] = result.data;
      });
      
      // Special handling for memory results
      const memoryResults = results.filter(r => r.capability.name === 'memory');
      if (memoryResults.length > 0) {
        variables.memories = memoryResults[memoryResults.length - 1].data;
      }
    }
    
    return variables;
  }
}

describe('Template Variable Substitution', () => {
  it('should substitute basic variables', () => {
    const template = 'Hello {{name}}!';
    const variables = { name: 'Coach Artie' };
    
    const result = TemplateSubstitution.substitute(template, variables);
    
    expect(result).toBe('Hello Coach Artie!');
  });

  it('should substitute multiple variables', () => {
    const template = 'User {{user}} wants {{item}}';
    const variables = { user: 'Alice', item: 'coffee' };
    
    const result = TemplateSubstitution.substitute(template, variables);
    
    expect(result).toBe('User Alice wants coffee');
  });

  it('should handle missing variables by leaving them unchanged', () => {
    const template = 'Hello {{name}}, you have {{count}} messages';
    const variables = { name: 'Bob' };
    
    const result = TemplateSubstitution.substitute(template, variables);
    
    expect(result).toBe('Hello Bob, you have {{count}} messages');
  });

  it('should handle object values by stringifying them', () => {
    const template = 'Data: {{data}}';
    const variables = { data: { key: 'value', number: 42 } };
    
    const result = TemplateSubstitution.substitute(template, variables);
    
    expect(result).toBe('Data: {"key":"value","number":42}');
  });

  it('should handle whitespace in variable names', () => {
    const template = 'Result: {{ result }}';
    const variables = { result: 'success' };
    
    const result = TemplateSubstitution.substitute(template, variables);
    
    expect(result).toBe('Result: success');
  });

  it('should create variables from orchestration results', () => {
    const results = [
      { capability: { name: 'memory' }, data: 'Alice prefers tea' },
      { capability: { name: 'web' }, data: 'Generated content here' }
    ];
    
    const variables = TemplateSubstitution.createVariablesFromResults(results);
    
    expect(variables.result).toBe('Generated content here');
    expect(variables.content).toBe('Generated content here');
    expect(variables.result_1).toBe('Alice prefers tea');
    expect(variables.result_2).toBe('Generated content here');
    expect(variables.memories).toBe('Alice prefers tea');
  });

  it('should handle LEGO-block orchestration pattern', () => {
    // Simulate the issue example:
    // 1. Memory recall -> "User achievements: Led 3 major projects, Expert in TypeScript"
    // 2. Web generation with template -> "Format as resume: {{memories}}"
    // 3. Filesystem write with template -> "{{content}}"
    
    const results = [
      { capability: { name: 'memory' }, data: 'User achievements: Led 3 major projects, Expert in TypeScript' }
    ];
    
    const variables = TemplateSubstitution.createVariablesFromResults(results);
    
    const webPrompt = TemplateSubstitution.substitute(
      'Format as resume: {{memories}}',
      variables
    );
    
    expect(webPrompt).toBe('Format as resume: User achievements: Led 3 major projects, Expert in TypeScript');
    
    // Simulate web generation result
    results.push({ 
      capability: { name: 'web' }, 
      data: '# Resume\n\n## Experience\n- Led 3 major projects\n- Expert in TypeScript' 
    });
    
    const updatedVariables = TemplateSubstitution.createVariablesFromResults(results);
    
    const filesystemContent = TemplateSubstitution.substitute(
      '{{content}}',
      updatedVariables
    );
    
    expect(filesystemContent).toBe('# Resume\n\n## Experience\n- Led 3 major projects\n- Expert in TypeScript');
  });

  it('should handle empty results gracefully', () => {
    const variables = TemplateSubstitution.createVariablesFromResults([]);
    const template = 'Hello {{result}}';
    
    const result = TemplateSubstitution.substitute(template, variables);
    
    expect(result).toBe('Hello {{result}}');
  });

  it('should handle complex nested templates', () => {
    const results = [
      { capability: { name: 'memory' }, data: 'chocolate preferences' },
      { capability: { name: 'variable' }, data: 'stored_value' },
      { capability: { name: 'web' }, data: 'final output' }
    ];
    
    const variables = TemplateSubstitution.createVariablesFromResults(results);
    
    const complexTemplate = 'Previous: {{result_1}}, Current: {{result}}, Memory: {{memories}}';
    const result = TemplateSubstitution.substitute(complexTemplate, variables);
    
    expect(result).toBe('Previous: chocolate preferences, Current: final output, Memory: chocolate preferences');
  });
});