import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  bountyStatus,
  decideBounty,
  recordBountyUsage,
  resetBountyStateForTests,
  type BountyRequest,
} from '../../src/engine/bounty/bounty-scaffold.js';

const REQUEST: BountyRequest = { userId: 'user-1', subject: 'rate my base' };

function clearEnv(): void {
  delete process.env.ARTIE_BOUNTIES_ENABLED;
  delete process.env.ARTIE_BOUNTY_SKU_ID;
}

describe('bounty scaffolding stays inert', () => {
  beforeEach(() => {
    clearEnv();
    resetBountyStateForTests();
  });
  afterEach(clearEnv);

  it('refuses with no env set at all', () => {
    expect(bountyStatus()).toEqual({ enabled: false, reason: 'disabled' });
    expect(decideBounty(REQUEST)).toEqual({ allowed: false, reason: 'disabled' });
  });

  it('refuses when ONLY the flag is set (no SKU)', () => {
    process.env.ARTIE_BOUNTIES_ENABLED = 'true';
    expect(bountyStatus()).toEqual({ enabled: false, reason: 'no-sku' });
    expect(decideBounty(REQUEST)).toEqual({ allowed: false, reason: 'no-sku' });
  });

  it('refuses when ONLY the SKU is set (flag still off)', () => {
    process.env.ARTIE_BOUNTY_SKU_ID = 'sku_123';
    expect(bountyStatus()).toEqual({ enabled: false, reason: 'disabled' });
    expect(decideBounty(REQUEST)).toEqual({ allowed: false, reason: 'disabled' });
  });

  it('a non-"true" value for the flag still refuses (e.g. "1", "TRUE")', () => {
    process.env.ARTIE_BOUNTIES_ENABLED = '1';
    process.env.ARTIE_BOUNTY_SKU_ID = 'sku_123';
    expect(decideBounty(REQUEST)).toEqual({ allowed: false, reason: 'disabled' });
  });

  it('allows only with BOTH set, and enforces the 2/day cap once it would run', () => {
    process.env.ARTIE_BOUNTIES_ENABLED = 'true';
    process.env.ARTIE_BOUNTY_SKU_ID = 'sku_123';
    const now = new Date('2026-10-26T12:00:00Z');

    expect(decideBounty(REQUEST, now)).toEqual({ allowed: true });
    recordBountyUsage(REQUEST.userId, now);
    expect(decideBounty(REQUEST, now)).toEqual({ allowed: true });
    recordBountyUsage(REQUEST.userId, now);
    expect(decideBounty(REQUEST, now)).toEqual({ allowed: false, reason: 'daily-cap' });

    const tomorrow = new Date('2026-10-27T12:00:00Z');
    expect(decideBounty(REQUEST, tomorrow)).toEqual({ allowed: true });
  });
});
