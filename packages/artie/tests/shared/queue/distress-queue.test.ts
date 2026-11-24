import { describe, it, expect, vi } from 'vitest';

// Wave 7 (d): the distress monitor's queue-depth signal reads the real incoming queue.
const { createQueue } = vi.hoisted(() => ({
  createQueue: vi.fn((_name: string) => ({
    getWaitingCount: async () => 40,
    getActiveCount: async () => 2,
  })),
}));
vi.mock('../../../src/shared/queue/redis.js', () => ({ createQueue }));

import { distressMonitor } from '../../../src/engine/health/distress.js';
import { QUEUES } from '../../../src/shared/queue/names.js';

describe('distress monitor queue depth', () => {
  it('reads QUEUES.INCOMING_MESSAGES, once, and sums waiting + active', async () => {
    const depth = (m: unknown) =>
      (m as { getMessageQueueDepth(): Promise<number> }).getMessageQueueDepth();
    expect(await depth(distressMonitor)).toBe(42);
    expect(await depth(distressMonitor)).toBe(42);
    expect(createQueue).toHaveBeenCalledTimes(1);
    expect(createQueue).toHaveBeenCalledWith(QUEUES.INCOMING_MESSAGES);
    expect(createQueue).not.toHaveBeenCalledWith('coachartie-incoming');
  });
});
