import { describe, it, expect } from 'vitest';
import { stripUserMessagePlaceholder, applyCacheControl } from '../src/services/llm/prompt-cache.js';

// Shape of PROMPT_SYSTEM in scripts/restore-prompts.ts: persona + examples, then a bare
// {{USER_MESSAGE}} at the very end.
const TEMPLATE = `<role>\nyou are coach artie.\n</role>\n\n${'persona rules. '.repeat(400)}\n</examples>\n\n{{USER_MESSAGE}}`;

describe('stripUserMessagePlaceholder', () => {
  it('removes a trailing bare placeholder', () => {
    const out = stripUserMessagePlaceholder(TEMPLATE);
    expect(out).not.toContain('{{USER_MESSAGE}}');
    expect(out.endsWith('</examples>')).toBe(true);
  });

  it('removes a "User message:" label with it', () => {
    expect(stripUserMessagePlaceholder('Instructions:\n1. Be nice\n\nUser message: {{USER_MESSAGE}}')).toBe(
      'Instructions:\n1. Be nice'
    );
  });

  it('is a byte-for-byte no-op without the placeholder', () => {
    const t = 'no placeholder here\n\n\n\nkeep my newlines   ';
    expect(stripUserMessagePlaceholder(t)).toBe(t);
  });

  it('makes the cached prefix identical across different user messages', () => {
    // What prompt-manager now does for every request, whatever the user said.
    const prefixFor = (_userMessage: string) =>
      JSON.stringify(
        applyCacheControl(
          [
            { role: 'system', content: stripUserMessagePlaceholder(TEMPLATE) },
            { role: 'user', content: `<user_message>${_userMessage}</user_message>` },
          ],
          'anthropic/claude-opus-4.8'
        ).messages[0]
      );
    expect(prefixFor('hey artie')).toBe(prefixFor('what time is the launch?'));
  });

  it('(the old substitution would have broken it)', () => {
    const old = (m: string) => TEMPLATE.replace(/\{\{USER_MESSAGE\}\}/g, m);
    expect(old('a')).not.toBe(old('b'));
  });
});
