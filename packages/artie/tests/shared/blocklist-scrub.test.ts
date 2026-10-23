import { describe, it, expect } from 'vitest';
import { scrubBlockedUserMentions, BLOCKED_USER_EPITHET } from '../../src/shared/blocklist.js';
import { escapeRegex } from '../../src/shared/regex.js';

// Wave 7 / ledger #4: blocked-name substitution is whole-word.
describe('scrubBlockedUserMentions', () => {
  const users = [{ id: '111222333444555666', names: ['kai', 'x.y'] }];
  const scrub = (t: string) => scrubBlockedUserMentions(t, users);
  const E = BLOCKED_USER_EPITHET;

  it('leaves a short blocked name inside a longer word untouched', () => {
    expect(scrub('the kaiser and makai stay')).toBe('the kaiser and makai stay');
  });

  it('replaces the name, @name, possessives and any case', () => {
    expect(scrub('kai said hi')).toBe(`${E} said hi`);
    expect(scrub('ask @Kai')).toBe(`ask ${E}`);
    expect(scrub("KAI's turn")).toBe(`${E}'s turn`);
  });

  it('replaces ids and mentions', () => {
    expect(scrub('<@111222333444555666> and <@!111222333444555666>')).toBe(`${E} and ${E}`);
  });

  it('treats regex metacharacters in names literally', () => {
    expect(scrub('x.y is here, xzy is not')).toBe(`${E} is here, xzy is not`);
  });

  it('is a no-op with the real (empty) list', () => {
    expect(scrubBlockedUserMentions('kai')).toBe('kai');
  });
});

describe('escapeRegex', () => {
  it('escapes every metacharacter', () => {
    const s = '.*+?^${}()|[]\\';
    expect(new RegExp(`^${escapeRegex(s)}$`).test(s)).toBe(true);
  });
});
