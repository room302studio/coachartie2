import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/shared/privacy-opt-out.js', () => ({
  isOptedOut: (id?: string | null) => id === '42',
}));

import { scrubBlockedUserMentions, BLOCKED_USER_EPITHET } from '../../src/shared/blocklist.js';
import { escapeRegex } from '../../src/shared/regex.js';

// Wave 7 / ledger #4: blocked-name substitution is whole-word.
describe('scrubBlockedUserMentions', () => {
  const users = [{ id: '111222333444555666', names: ['kai', 'x.y'] }];
  const scrub = (t: string) => scrubBlockedUserMentions(t, users);
  const E = BLOCKED_USER_EPITHET;

  // EJ 2026-11-19: naming banned people is fine; only pings are defused.
  it('leaves names alone', () => {
    expect(scrub('Banlist:\n- kai (since 2026-11-18)')).toBe('Banlist:\n- kai (since 2026-11-18)');
  });

  it('turns a ping into the plain name', () => {
    expect(scrub('<@111222333444555666> and <@!111222333444555666>')).toBe('kai and kai');
  });

  it('keeps a banned user who also opted out fully anonymous', () => {
    const both = [{ id: '42', names: ['quiet'] }];
    expect(scrubBlockedUserMentions('quiet, <@42>, 42', both)).toBe(`${E}, ${E}, ${E}`);
  });

  it('falls back to the epithet when a banned user has no known name', () => {
    expect(scrubBlockedUserMentions('<@9>', [{ id: '9', names: [] }])).toBe(E);
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
