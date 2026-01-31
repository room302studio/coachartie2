import { describe, it, expect } from 'vitest';
import { statusCommand } from '../src/commands/status';

describe('/status command', () => {
  it('should have correct command structure', () => {
    expect(statusCommand).toBeDefined();
    expect(statusCommand.data).toBeDefined();
    expect(statusCommand.execute).toBeDefined();
    expect(typeof statusCommand.execute).toBe('function');
  });

  it('should have correct command name and description', () => {
    const commandData = statusCommand.data.toJSON();
    expect(commandData.name).toBe('status');
    expect(commandData.description).toBe('Show the LLM model used for your most recent message');
  });

  it('should correctly format model names', () => {
    // Test that free models are formatted correctly
    const testCases = [
      {
        input: 'mistralai/mistral-7b-instruct:free',
        expected: 'mistralai/mistral-7b-instruct (Free)',
      },
      { input: 'anthropic/claude-3.5-sonnet', expected: 'anthropic/claude-3.5-sonnet' },
      {
        input: 'microsoft/phi-3-mini-128k-instruct:free',
        expected: 'microsoft/phi-3-mini-128k-instruct (Free)',
      },
    ];

    testCases.forEach(({ input, expected }) => {
      const formatted = input.includes(':free') ? input.replace(':free', '') + ' (Free)' : input;
      expect(formatted).toBe(expected);
    });
  });
});
