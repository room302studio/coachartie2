import { describe, it, expect } from 'vitest';
import { getSyncDb } from '../../src/shared/db/client.js';
import { optOut, optIn, isOptedOut, mentionsOptedOutUser } from '../../src/shared/privacy-opt-out.js';
import { isBlockedUser, BLOCKED_USER_IDS } from '../../src/shared/blocklist.js';
import { globalCommands } from '../../src/gateway/commands/registry.js';

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

  it('also deletes memories that NAME them under other ids, by whole word only', () => {
    const db = getSyncDb();
    const add = (uid: string, content: string) =>
      db.run(`INSERT INTO memories (user_id, content, tags, context, timestamp, importance)
              VALUES (?, ?, '[]', '', datetime('now'), 5)`, [uid, content]);
    add('someone-else', 'tram_fan_99 is building a Tokyo save');
    add('someone-else', `<@${USER}> asked about signals`);
    add('someone-else', 'janet likes trams'); // must survive: not a whole-word match for jan_gbg-style handles
    add('someone-else', 'tram_fan_990 is a different person'); // must survive

    const removed = optOut(USER, ['tram_fan_99', 'Tram Fan', 'jo']); // 'jo' is too short to match on
    expect(removed.memories_mentioning).toBe(2);
    const left = db.all<{ content: string }>(`SELECT content FROM memories WHERE user_id = 'someone-else'`).map((m) => m.content);
    expect(left).toContain('janet likes trams');
    expect(left).toContain('tram_fan_990 is a different person');
    expect(mentionsOptedOutUser('saw tram_fan_99 today')).toBe(true);
    expect(mentionsOptedOutUser('jo said hi')).toBe(false);
    optIn(USER);
    expect(mentionsOptedOutUser('saw tram_fan_99 today')).toBe(false);
  });

  it('registers /artie-optout and /artie-optin for everyone', () => {
    const names = globalCommands.map((c) => c.data.name);
    expect(names).toContain('artie-optout');
    expect(names).toContain('artie-optin');
    const json = globalCommands.find((c) => c.data.name === 'artie-optout')!.data.toJSON();
    expect(json.default_member_permissions ?? null).toBeNull();
  });
});
