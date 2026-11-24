import { describe, it, expect } from 'vitest';
import { shouldRefreshDigest, digestThresholds } from '../../../src/gateway/watchers/channel-digests.js';
import { GUILD_CONFIGS } from '../../../src/shared/config/guilds.js';
import { resolveAmbientMode } from '../../../src/gateway/2-gate/speak-gate.js';

const t = digestThresholds({} as NodeJS.ProcessEnv); // 30 msgs / 8 if stale / 12h / 30min
const H = 3600_000;
const now = 1_000 * H;

describe('shouldRefreshDigest', () => {
  it('waits for enough human messages', () => {
    expect(shouldRefreshDigest(29, now - 2 * H, now, false, t)).toBe(false);
    expect(shouldRefreshDigest(30, now - 2 * H, now, false, t)).toBe(true);
  });

  it('never refreshes a channel twice inside the minimum interval, even when busy', () => {
    expect(shouldRefreshDigest(100, now - 10 * 60_000, now, true, t)).toBe(false);
  });

  it('lets a quiet channel refresh on fewer messages once the digest is stale', () => {
    expect(shouldRefreshDigest(8, now - 13 * H, now, false, t)).toBe(true);
    expect(shouldRefreshDigest(7, now - 13 * H, now, false, t)).toBe(false);
    expect(shouldRefreshDigest(8, now - 2 * H, now, false, t)).toBe(false);
  });

  it('a full fetch refreshes regardless of count; zero humans never does', () => {
    expect(shouldRefreshDigest(12, now - H, now, true, t)).toBe(true);
    expect(shouldRefreshDigest(0, now - 100 * H, now, true, t)).toBe(false);
  });
});

describe('mention-only', () => {
  it('every guild is strictly mention/reply/DM', () => {
    for (const cfg of Object.values(GUILD_CONFIGS)) {
      expect(resolveAmbientMode(cfg), cfg.name).toBe('never');
      for (const p of Object.values(cfg.channelPersonas ?? {})) {
        expect(p.respondToAll ?? false, p.personaName).toBe(false);
      }
    }
  });
});
