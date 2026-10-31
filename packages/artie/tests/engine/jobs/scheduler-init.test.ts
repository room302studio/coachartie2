/**
 * Scheduler init (2026-10-31): a failed Redis check at boot used to set a sticky flag, so the
 * scheduler stayed off until the next restart even once Redis came back. Redis and BullMQ
 * are faked; nothing here dials a real Redis.
 */
import { describe, it, expect, vi } from 'vitest';

const redisUp = vi.hoisted(() => ({ value: false }));

vi.mock('../../../src/shared/queue/redis.js', () => ({
  testRedisConnection: async () => redisUp.value,
  createRedisConnection: () => ({}),
  createWorker: () => ({ on: () => undefined, close: async () => undefined }),
}));

vi.mock('bullmq', () => {
  class Queue {
    async add() {
      return { id: '1' };
    }
    async close() {}
  }
  class Worker {}
  return { Queue, Worker };
});

const { SchedulerService } = await import('../../../src/engine/jobs/scheduler.js');

describe('SchedulerService.initialize', () => {
  it('comes up on a later call once Redis is back', async () => {
    const svc = new SchedulerService();
    redisUp.value = false;
    expect(await svc.initialize()).toBe(false);
    expect(svc.isReady()).toBe(false);

    redisUp.value = true;
    expect(await svc.initialize()).toBe(true);
    expect(svc.isReady()).toBe(true);
  });
});
