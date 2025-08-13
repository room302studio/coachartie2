import { describe, it, expect } from 'vitest';

/**
 * ATOMIC UNIT: Template Variable Substitution
 * Tests the core template replacement algorithm
 */

function substituteVariables(template: string, variables: Record<string, unknown>): string {
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

describe('Template Variable Substitution (Atomic Unit)', () => {
  it('should substitute single variable', () => {
    const result = substituteVariables('Hello {{name}}', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('should substitute multiple variables', () => {
    const result = substituteVariables('{{greeting}} {{name}}!', { 
      greeting: 'Hello', 
      name: 'Coach Artie' 
    });
    expect(result).toBe('Hello Coach Artie!');
  });

  it('should handle missing variables gracefully', () => {
    const result = substituteVariables('Hello {{name}} and {{missing}}', { name: 'World' });
    expect(result).toBe('Hello World and {{missing}}');
  });

  it('should handle whitespace in variable names', () => {
    const result = substituteVariables('{{ name }} and {{  title  }}', { 
      name: 'Coach Artie', 
      title: 'AI Assistant' 
    });
    expect(result).toBe('Coach Artie and AI Assistant');
  });

  it('should stringify objects', () => {
    const result = substituteVariables('Data: {{data}}', { 
      data: { key: 'value', count: 42 } 
    });
    expect(result).toBe('Data: {"key":"value","count":42}');
  });

  it('should handle empty template', () => {
    const result = substituteVariables('', { name: 'test' });
    expect(result).toBe('');
  });

  it('should handle template with no variables', () => {
    const result = substituteVariables('No variables here', { name: 'test' });
    expect(result).toBe('No variables here');
  });

  it('should handle malformed variable syntax', () => {
    const result = substituteVariables('{{incomplete', { incomplete: 'test' });
    expect(result).toBe('{{incomplete');
  });
});

export { substituteVariables };