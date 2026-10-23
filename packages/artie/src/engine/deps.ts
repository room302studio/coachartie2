import type { Request } from 'express';
import type { Queue } from 'bullmq';
import { createQueue, createRedisConnection } from '../shared/queue/redis.js';
import { QUEUES } from '../shared/queue/names.js';
import type { IncomingMessage } from '../shared/queue/types.js';

/**
 * The two things the engine's HTTP layer touches Redis for, injectable so
 * `createEngineApp(deps)` can be built in a test with no Redis (wave 9).
 * Production uses the defaults: the INCOMING_MESSAGES BullMQ queue and the shared ioredis
 * connection, exactly what chat-route.ts and routes/health.ts used inline before.
 */
export interface EngineDeps {
  /** Put a turn on the INCOMING_MESSAGES queue (BullMQ job name 'process'). */
  enqueueTurn: (message: IncomingMessage) => Promise<{ id?: string }>;
  /** Redis liveness for /health and /health/ready; throws when Redis is down. */
  pingRedis: () => Promise<unknown>;
}

// Created on first use. chat-route.ts used to create it at module load; nothing reads it
// before the first POST /chat, so the only difference is when the queue object exists.
let incomingQueue: Queue<IncomingMessage> | null = null;

export const defaultEngineDeps: EngineDeps = {
  enqueueTurn: async (message) => {
    incomingQueue ??= createQueue<IncomingMessage>(QUEUES.INCOMING_MESSAGES);
    const job = await incomingQueue.add('process', message);
    return { id: job.id };
  },
  pingRedis: () => createRedisConnection().ping(),
};

/** The deps of the app serving this request (createEngineApp stores them in app.locals). */
export function engineDeps(req: Request): EngineDeps {
  return (req.app?.locals?.engineDeps as EngineDeps | undefined) ?? defaultEngineDeps;
}
