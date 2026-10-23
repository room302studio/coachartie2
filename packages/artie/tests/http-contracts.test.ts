/**
 * External HTTP contracts (wave 9). The engine (:47324) and gateway (:47321) apps are built
 * from their factories with stub deps, listen on port 0, and every route an outside caller
 * uses is checked for today's status codes and JSON keys:
 *   - ~/scripts discord-dm, briefs/morning-brief.sh, briefs/card-fallback.sh -> POST /api/dm
 *   - scripts/claude/presence-respond.sh -> GET /api/presence/inbox, POST .../:id/ack
 *   - scripts/mesh/artie-bridge.ts, artie-response-bridge.ts -> POST /chat, GET /chat/:id
 *   - brain + monitors -> /health, /api/memories, /api/models; GitHub -> POST /github/webhook
 * Written before the one-process conversion and kept green through it: these shapes are what
 * the outside world parses.
 *
 * No Redis: the queue module is mocked so nothing here can reach a real Redis (the VPS runs
 * prod Redis on this box), and the engine app gets stub enqueue/ping deps.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../src/shared/queue/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/queue/redis.js')>();
  const noRedis = () => {
    throw new Error('http-contracts: no Redis in this test');
  };
  // Some modules open a (lazy) connection at import time (shared/db/user-profiles.ts);
  // hand them an inert object whose every property/call is itself, never a socket.
  const inert: any = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : inert),
    apply: () => inert,
  });
  return {
    ...actual,
    testRedisConnection: async () => false,
    createRedisConnection: () => inert,
    getRedis: () => inert,
    createQueue: noRedis,
    createWorker: noRedis,
    createQueueEvents: noRedis,
  };
});

import { createEngineApp } from '../src/engine/http.js';
import { createGatewayApp } from '../src/gateway/http.js';
import { openRouterModelsService } from '../src/engine/4-generate/model-catalog.js';

function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }) {
  return new Promise<{ server: Server; base: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON (legal pages); keep the text
  }
  return { status: res.status, body };
}

const keys = (o: object) => Object.keys(o).sort();

describe('engine HTTP contracts (:47324)', () => {
  let server: Server;
  let base: string;
  let redisUp = true;
  const enqueued: unknown[] = [];

  beforeAll(async () => {
    const app = createEngineApp({
      enqueueTurn: async (msg) => {
        enqueued.push(msg);
        return { id: String(enqueued.length) };
      },
      pingRedis: async () => {
        if (!redisUp) throw new Error('Redis down (stub)');
        return 'PONG';
      },
    });
    ({ server, base } = await listen(app));
  });

  afterAll(() => {
    server?.close();
  });

  it('POST /chat queues a turn and answers {success, messageId, status: pending, jobUrl}', async () => {
    const r = await call(base, '/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello from the mesh', userId: 'mesh-user' }),
    });
    expect(r.status).toBe(200);
    expect(keys(r.body)).toEqual(['jobUrl', 'messageId', 'status', 'success']);
    expect(r.body.success).toBe(true);
    expect(r.body.status).toBe('pending');
    expect(r.body.jobUrl).toBe(`/chat/${r.body.messageId}`);
    expect(enqueued.length).toBeGreaterThan(0);

    // GET /chat/:id on the job just queued
    const s = await call(base, `/chat/${r.body.messageId}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ success: true, messageId: r.body.messageId, status: 'pending' });
    for (const k of ['jobUrl', 'processingTime', 'startTime']) expect(s.body).toHaveProperty(k);
  });

  it('POST /chat without a message is 400 {success:false, messageId:"", error}', async () => {
    const r = await call(base, '/chat', { method: 'POST', body: JSON.stringify({ userId: 'x' }) });
    expect(r.status).toBe(400);
    expect(keys(r.body)).toEqual(['error', 'messageId', 'success']);
    expect(r.body).toMatchObject({ success: false, messageId: '' });
  });

  it('GET /chat/:id for an unknown job is 404 {success:false, error}', async () => {
    const r = await call(base, '/chat/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ success: false, error: 'Job not found or expired' });
  });

  it('GET /health is 200 {status: healthy, timestamp}, 503 when Redis is down', async () => {
    const up = await call(base, '/health');
    expect(up.status).toBe(200);
    expect(keys(up.body)).toEqual(['status', 'timestamp']);
    expect(up.body.status).toBe('healthy');

    redisUp = false;
    try {
      const down = await call(base, '/health');
      expect(down.status).toBe(503);
      expect(keys(down.body)).toEqual(['error', 'service', 'status', 'timestamp']);
      expect(down.body).toMatchObject({ status: 'unhealthy', service: 'capabilities' });
    } finally {
      redisUp = true;
    }
  });

  it('POST /github/webhook with a bad signature is 500 {error, timestamp}', async () => {
    const prev = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = 'contract-test-secret'; // not a real secret
    try {
      const r = await call(base, '/github/webhook', {
        method: 'POST',
        headers: { 'x-github-event': 'push', 'x-github-delivery': 'test' },
        body: JSON.stringify({ repository: { full_name: 'a/b' } }),
      });
      expect(r.status).toBe(500);
      expect(keys(r.body)).toEqual(['error', 'timestamp']);
      expect(r.body.error).toBe('Internal server error');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = prev;
    }
  });

  it('GET /api/memories is 200 {success, data, count}', async () => {
    const r = await call(base, '/api/memories?limit=5');
    expect(r.status).toBe(200);
    expect(keys(r.body)).toEqual(['count', 'data', 'success']);
    expect(r.body.success).toBe(true);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('GET /api/models is 200 {success, data:{currentModel, summary, models, totalModels, all}}', async () => {
    const enhanced = vi
      .spyOn(openRouterModelsService, 'getEnhancedModelData')
      .mockResolvedValue([] as any);
    const summary = vi
      .spyOn(openRouterModelsService, 'getModelSummary')
      .mockResolvedValue({ total: 0 } as any);
    try {
      const r = await call(base, '/api/models');
      expect(r.status).toBe(200);
      expect(keys(r.body)).toEqual(['data', 'success']);
      expect(keys(r.body.data)).toEqual(['all', 'currentModel', 'models', 'summary', 'totalModels']);
    } finally {
      enhanced.mockRestore();
      summary.mockRestore();
    }
  });
});

describe('gateway HTTP contracts (:47321)', () => {
  let server: Server;
  let base: string;
  const sent: Array<{ userId: string; options: any }> = [];
  const prevToken = process.env.DM_API_TOKEN;
  const TOKEN = 'contract-test-token'; // not a real secret

  // Just enough of a discord.js Client for /api/dm: users.fetch -> a user that can be DMed.
  const stubClient = {
    users: {
      fetch: async (userId: string) => ({
        tag: `user#${userId.slice(-4)}`,
        send: async (options: any) => {
          sent.push({ userId, options });
          return { id: `dm-${sent.length}` };
        },
      }),
    },
    channels: { fetch: async () => null },
    guilds: { cache: new Map() },
  };

  beforeAll(async () => {
    process.env.DM_API_TOKEN = TOKEN;
    ({ server, base } = await listen(createGatewayApp({ client: stubClient as any })));
  });

  afterAll(() => {
    server?.close();
    if (prevToken === undefined) delete process.env.DM_API_TOKEN;
    else process.env.DM_API_TOKEN = prevToken;
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('POST /api/dm without the Bearer token is 401 {success:false, error}', async () => {
    const r = await call(base, '/api/dm', {
      method: 'POST',
      body: JSON.stringify({ userId: '123456789012345678', message: 'hi' }),
    });
    expect(r.status).toBe(401);
    expect(keys(r.body)).toEqual(['error', 'success']);
    expect(r.body.success).toBe(false);
  });

  it('POST /api/dm validation is 400 {success:false, error}', async () => {
    const noUser = await call(base, '/api/dm', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(noUser.status).toBe(400);
    expect(noUser.body).toEqual({ success: false, error: 'userId is required' });

    const noBody = await call(base, '/api/dm', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ userId: '123456789012345678' }),
    });
    expect(noBody.status).toBe(400);
    expect(noBody.body).toEqual({ success: false, error: 'message or fileBase64 is required' });
  });

  it('POST /api/dm success is 200 {success, userId, userTag, messageId}', async () => {
    const r = await call(base, '/api/dm', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ userId: '123456789012345678', message: 'morning brief' }),
    });
    expect(r.status).toBe(200);
    expect(keys(r.body)).toEqual(['messageId', 'success', 'userId', 'userTag']);
    expect(r.body).toMatchObject({ success: true, userId: '123456789012345678' });
    expect(sent.at(-1)?.options).toMatchObject({ content: 'morning brief' });
  });

  it('GET /api/presence/inbox is 200 {success, count, messages}', async () => {
    const r = await call(base, '/api/presence/inbox');
    expect(r.status).toBe(200);
    expect(keys(r.body)).toEqual(['count', 'messages', 'success']);
    expect(Array.isArray(r.body.messages)).toBe(true);
  });

  it('POST /api/presence/inbox/:id/ack for an unknown id is 404 {success:false, error}', async () => {
    const r = await call(base, '/api/presence/inbox/presence-nope/ack', { method: 'POST' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ success: false, error: 'Message presence-nope not found' });
  });

  it('GET /terms is public HTML', async () => {
    const res = await fetch(`${base}/terms`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});
