/**
 * One process (wave 9): boot() brings up the engine and the gateway together and signals PM2
 * 'ready' exactly once, with exactly one worker on each queue — one INCOMING_MESSAGES
 * consumer, one scheduler, one OUTGOING_DISCORD (push) consumer.
 *
 * The real module graph boots (engine/main.ts, gateway/main.ts, every route and watcher);
 * only the outside world is faked: discord.js's Client (login emits ClientReady), BullMQ's
 * Queue/Worker and the shared Redis helpers (nothing here may reach a real Redis: the VPS
 * runs prod Redis on this box), and the three listeners bind port 0, not 47324/47321/47319,
 * where prod is listening.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

vi.hoisted(() => {
  process.env.CAPABILITIES_PORT = '0';
  process.env.DISCORD_API_PORT = '0';
  process.env.HEALTH_PORT = '0';
  process.env.ENABLE_SCHEDULING = 'false'; // no default cron tasks, no startup DM
  process.env.DISCORD_TOKEN = 'boot-test-not-a-token';
});

const fakes = vi.hoisted(() => {
  // Any property is an async no-op returning [], except the few with real shapes.
  const make = (name: string, extra: Record<string, unknown> = {}) => {
    const target: Record<string | symbol, unknown> = {
      name,
      async add() {
        return { id: '1' };
      },
      async close() {},
      ...extra,
    };
    const proxy: any = new Proxy(target, {
      get: (t, p) => {
        if (p in t) {
          return t[p];
        }
        if (p === 'then') {
          return undefined;
        }
        return async () => [];
      },
    });
    target.on = () => proxy;
    return proxy;
  };
  const workers: string[] = [];
  const closedWorkers: string[] = [];
  const inert: any = new Proxy(function () {}, {
    get: (_t, p) => {
      if (p === 'then') {
        return undefined;
      }
      return inert;
    },
    apply: () => inert,
  });
  return { make, workers, closedWorkers, inert, clients: [] as any[] };
});

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class Queue {
    constructor(name: string) {
      return fakes.make(name);
    }
  }
  class Worker {
    constructor(name: string) {
      fakes.workers.push(`raw:${name}`);
      return fakes.make(name);
    }
  }
  class QueueEvents {
    constructor(name: string) {
      return fakes.make(name);
    }
  }
  return { ...actual, Queue, Worker, QueueEvents };
});

vi.mock('../src/shared/queue/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/queue/redis.js')>();
  return {
    ...actual,
    testRedisConnection: async () => true,
    createRedisConnection: () => fakes.inert,
    getRedis: () => fakes.inert,
    createQueue: (name: string) => fakes.make(name),
    createQueueEvents: (name: string) => fakes.make(name),
    createWorker: (name: string) => {
      fakes.workers.push(name);
      return fakes.make(name, {
        async close() {
          fakes.closedWorkers.push(name);
        },
      });
    },
    closeRedisConnection: async () => {},
  };
});

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  // Imported inside the factory: vi.mock factories are hoisted above the file's imports.
  const { EventEmitter } = await import('events');
  class Client extends EventEmitter {
    options: unknown;
    user = { id: '100000000000000001', tag: 'artie#0001', username: 'artie', flags: { bitfield: 0 } };
    guilds = { cache: new actual.Collection(), fetch: async () => new actual.Collection() };
    channels = { cache: new actual.Collection(), fetch: async () => null };
    users = { cache: new actual.Collection(), fetch: async () => null };
    ws = { ping: 5 };
    destroyed = false;
    constructor(options: unknown) {
      super();
      this.options = options;
      fakes.clients.push(this);
    }
    isReady() {
      return true;
    }
    async login(token: string) {
      setTimeout(() => this.emit(actual.Events.ClientReady, this), 5);
      return token;
    }
    async destroy() {
      this.destroyed = true;
    }
  }
  return { ...actual, Client };
});

import { boot, shutdown } from '../src/boot.js';
import { QUEUES } from '../src/shared/queue/names.js';
import * as gateway from '../src/gateway/api.js';

describe('one process: boot()', () => {
  afterAll(async () => {
    await shutdown('test');
  });

  it('starts one worker per queue, registers the gateway, and sends PM2 ready once', async () => {
    const originalSend = process.send;
    const send = vi.fn(() => true);
    (process as any).send = send;
    let running!: Awaited<ReturnType<typeof boot>>;
    try {
      running = await boot();
    } finally {
      (process as any).send = originalSend;
    }

    // process.send('ready') exactly once, after everything is up
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('ready');
    expect(running.ready).toBe(true);
    expect(running.gateway.listening).toBe(true);
    expect(running.engine.server.listening).toBe(true);

    // exactly one consumer on each queue, and no raw BullMQ Worker behind the helper's back
    const count = (name: string) => fakes.workers.filter((w) => w === name).length;
    expect(count(QUEUES.INCOMING_MESSAGES)).toBe(1);
    expect(count(QUEUES.OUTGOING_DISCORD)).toBe(1);
    expect(count('coachartie-scheduler')).toBe(1);
    expect(fakes.workers.filter((w) => w.startsWith('raw:'))).toEqual([]);
    expect(fakes.workers).toHaveLength(3);

    // one Discord client, and the engine can reach it in-process now
    expect(fakes.clients).toHaveLength(1);
    const health = await gateway.gatewayHealth();
    expect(health.status).toBe(200);
  }, 60_000);

  it('shutdown() closes the workers, the Discord client, and unregisters the gateway', async () => {
    await shutdown('test');
    expect([...fakes.closedWorkers].sort()).toEqual(
      [QUEUES.INCOMING_MESSAGES, QUEUES.OUTGOING_DISCORD, 'coachartie-scheduler'].sort()
    );
    expect(fakes.clients[0].destroyed).toBe(true);
    await expect(gateway.gatewayHealth()).rejects.toBeInstanceOf(gateway.GatewayUnavailableError);
  }, 30_000);
});
