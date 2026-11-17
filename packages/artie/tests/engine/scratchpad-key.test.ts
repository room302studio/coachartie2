/**
 * 2026-11-17: every DM user used to share one 'default' pad, and a model-supplied guildId could
 * open another server's pad from any conversation.
 */
import { describe, it, expect } from 'vitest';
import { scratchpadKey } from '../../src/engine/tools/planning/scratchpad.js';

describe('scratchpadKey', () => {
  it("a server conversation uses that server's pad, never a model-supplied one", () => {
    expect(scratchpadKey({ guildId: 'g302', userId: 'u1' }, 'g-other')).toBe('g302');
  });

  it('each DM user gets their own pad', () => {
    expect(scratchpadKey({ userId: 'u1' }, undefined)).toBe('dm-u1');
    expect(scratchpadKey({ userId: 'u2' }, 'g302')).toBe('dm-u2');
  });

  it('only context-less internal callers may name a guild, and only a safe one', () => {
    expect(scratchpadKey(undefined, 'g302')).toBe('g302');
    expect(scratchpadKey(undefined, '../../etc')).toBe('default');
    expect(scratchpadKey(undefined, undefined)).toBe('default');
  });

  it('a DM user id cannot escape the notes directory', () => {
    expect(scratchpadKey({ userId: '../../x' }, undefined)).toBe('dm-x');
  });
});
