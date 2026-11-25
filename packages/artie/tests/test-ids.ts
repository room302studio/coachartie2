/**
 * Branded Discord ids for tests.
 *
 * Production code gets a TrustedUserId/GuildId/ChannelId only from mintTrusted at the sites
 * pinned in tests/shared/trusted-ids.test.ts (that test scans src/, not tests/). A test just
 * needs a literal the type system accepts, so these brand one without minting.
 */
import type { TrustedChannelId, TrustedGuildId, TrustedUserId } from '../src/shared/trusted-ids.js';

export function testUserId(id: string): TrustedUserId {
  return id as TrustedUserId;
}

export function testGuildId(id: string): TrustedGuildId {
  return id as TrustedGuildId;
}

export function testChannelId(id: string): TrustedChannelId {
  return id as TrustedChannelId;
}
