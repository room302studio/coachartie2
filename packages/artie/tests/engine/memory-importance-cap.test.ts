/**
 * Security audit 2026-10-26 (sec-abuse.md Critical #2): "There's no reason a random user can
 * set 10 or pin." Non-owner remember/pin calls are capped at NON_OWNER_MAX_IMPORTANCE (6),
 * below the >=7 band that recall.ts's semanticLayer treats as always-relevant. The owner is
 * unaffected.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { memoryCapability, NON_OWNER_MAX_IMPORTANCE } from '../../src/engine/tools/core/memory.js';
import { OWNER_USER_ID } from '../../src/shared/config/owner.js';
import { getSyncDb } from '../../src/shared/db/client.js';

const ATTACKER = 'memory-cap-test-attacker';

// The client.ts bootstrap table lacks prod's guild_id/channel_id, so the insert failed here and
// this test was pinning a hot-cache-only temp id. remember() now shows only real ids
// (2026-10-31), so give the scratch table the prod columns.
beforeAll(() => {
  for (const col of ['guild_id TEXT', 'channel_id TEXT']) {
    try {
      getSyncDb().run(`ALTER TABLE memories ADD COLUMN ${col}`);
    } catch {
      // already has it
    }
  }
});

describe('memory:remember importance cap', () => {
  it('caps a non-owner at NON_OWNER_MAX_IMPORTANCE even if they ask for 10', async () => {
    const result = await memoryCapability.handler(
      { action: 'remember', content: 'poisoned fact', importance: '10' },
      undefined,
      { userId: ATTACKER }
    );
    expect(result).toContain(`importance: ${NON_OWNER_MAX_IMPORTANCE}/10`);
  });

  it('lets the owner set importance 10', async () => {
    const result = await memoryCapability.handler(
      { action: 'remember', content: 'owner fact', importance: '10' },
      undefined,
      { userId: OWNER_USER_ID }
    );
    expect(result).toContain('importance: 10/10');
  });
});

describe('memory:pin importance cap', () => {
  it('a non-owner pinning their own memory lands at the cap, not 10', async () => {
    const remembered = await memoryCapability.handler(
      { action: 'remember', content: 'attacker self note', importance: '5' },
      undefined,
      { userId: ATTACKER }
    );
    const idMatch = remembered.match(/ID: (-?\d+)/);
    expect(idMatch).toBeTruthy();
    const memoryId = idMatch![1];

    const pinned = await memoryCapability.handler(
      { action: 'pin', memoryId },
      undefined,
      { userId: ATTACKER }
    );
    expect(pinned).toContain(`now importance ${NON_OWNER_MAX_IMPORTANCE}/10`);
  });
});
