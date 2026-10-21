import { describe, it, expect } from 'vitest';
import { getSyncDb, optOut, optIn, isOptedOut, isBlockedUser, BLOCKED_USER_IDS } from '@coachartie/shared';
import { globalCommands } from '../src/commands/registry.js';

const USER = '999000111222333444';

describe('privacy opt-out', () => {
  it('hides the user from every data gate, deletes their memories, and is reversible', () => {
    const db = getSyncDb();
    db.run(
      `INSERT INTO memories (user_id, content, tags, context, timestamp, importance)
       VALUES (?, 'likes the G train', '[]', '', datetime('now'), 5)`,
      [USER]
    );

    const removed = optOut(USER);
    expect(removed.memories).toBeGreaterThanOrEqual(1);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM memories WHERE user_id = ?`, [USER])?.n).toBe(0);
    expect(isOptedOut(USER)).toBe(true);
    expect(isBlockedUser(USER)).toBe(true);
    // A choice, not a ban: no 💔 / epithet treatment.
    expect(BLOCKED_USER_IDS.has(USER)).toBe(false);

    expect(optIn(USER)).toBe(true);
    expect(isBlockedUser(USER)).toBe(false);
    expect(optIn(USER)).toBe(false);
  });

  it('registers /artie-optout and /artie-optin for everyone', () => {
    const names = globalCommands.map((c) => c.data.name);
    expect(names).toContain('artie-optout');
    expect(names).toContain('artie-optin');
    const json = globalCommands.find((c) => c.data.name === 'artie-optout')!.data.toJSON();
    expect(json.default_member_permissions ?? null).toBeNull();
  });
});
