/**
 * Redis reconnect (2026-10-31): one failed availability check (or any connection error) used
 * to make every retryStrategy return null, so after a single blip nothing reconnected until
 * Artie restarted. Points at a closed local port; never touches a real Redis.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRedisConnection, closeRedisConnection, reconnectDelay, testRedisConnection } from '../../../src/shared/queue/redis.js';

const saved = { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT };

afterAll(() => {
  process.env.REDIS_HOST = saved.host;
  process.env.REDIS_PORT = saved.port;
});

describe('redis reconnect', () => {
  it('keeps retrying with a capped backoff after Redis has been seen down', async () => {
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '9'; // discard port: connection refused
    expect(await testRedisConnection()).toBe(false);

    const conn = createRedisConnection();
    try {
      const retry = conn.options.retryStrategy;
      expect(retry).toBeTypeOf('function');
      expect(retry!(1)).toBe(2000);
      expect(retry!(500)).toBe(60000);
    } finally {
      conn.disconnect();
      await closeRedisConnection().catch(() => undefined);
    }
  });

  it('caps the delay at a minute', () => {
    expect(reconnectDelay(3)).toBe(6000);
    expect(reconnectDelay(1000)).toBe(60000);
  });
});
