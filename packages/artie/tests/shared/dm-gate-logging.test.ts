import { describe, it, expect, vi, afterEach } from 'vitest';
import { logDMGate } from '../src/services/dm-pairing.js';
import { logger } from '../src/utils/logger.js';

describe('logDMGate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs blocked attempts at warn with a dmGate field for the dashboard', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    logDMGate('blocked_pairing', { userId: '123', username: 'stranger', detail: 'hi' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [line, meta] = warn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(line).toContain('DM gate: blocked_pairing stranger (123)');
    expect(meta).toMatchObject({ dmGate: 'blocked_pairing', platform: 'discord', userId: '123' });
  });

  it('logs allowed and admin decisions at info', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    logDMGate('allowed', { userId: '456' });
    logDMGate('approved', { userId: '789', by: 'owner', code: '123456' });
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.map((c) => (c[1] as { dmGate: string }).dmGate)).toEqual([
      'allowed',
      'approved',
    ]);
  });
});
