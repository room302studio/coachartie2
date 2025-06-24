# Coach Artie Monorepo Refactor Plan

## Overview
Refactoring Coach Artie from a polyrepo with HTTP calls to a monorepo with Redis queue-based communication.

## New Folder Structure

```
coachartie-monorepo/
├── packages/                         # All service packages
│   ├── capabilities/                 # Core capabilities service
│   │   ├── src/
│   │   │   ├── index.ts             # Main entry point
│   │   │   ├── server.ts            # Express server setup
│   │   │   ├── queues/
│   │   │   │   ├── consumer.ts     # Redis queue consumer
│   │   │   │   └── publisher.ts    # Redis queue publisher
│   │   │   ├── handlers/
│   │   │   │   ├── process-message.ts
│   │   │   │   └── execute-capability.ts
│   │   │   └── capabilities/        # Individual capability implementations
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   ├── discord/                     # Discord bot service
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── bot.ts              # Discord client setup
│   │   │   ├── queues/
│   │   │   │   ├── publisher.ts    # Publish to capabilities queue
│   │   │   │   └── consumer.ts     # Listen for responses
│   │   │   └── handlers/
│   │   │       └── message-handler.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   ├── sms/                         # SMS service (Twilio)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── server.ts
│   │   │   ├── queues/
│   │   │   │   ├── publisher.ts
│   │   │   │   └── consumer.ts
│   │   │   └── handlers/
│   │   │       └── twilio-webhook.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   ├── email/                       # Email service
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── server.ts
│   │   │   ├── queues/
│   │   │   │   ├── publisher.ts
│   │   │   │   └── consumer.ts
│   │   │   └── handlers/
│   │   │       └── email-webhook.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   └── shared/                      # Shared code/types
│       ├── src/
│       │   ├── types/
│       │   │   ├── queue.ts        # Queue message types
│       │   │   ├── database.ts     # Database types
│       │   │   └── index.ts
│       │   ├── utils/
│       │   │   ├── redis.ts        # Redis client setup
│       │   │   ├── logger.ts       # Shared logger
│       │   │   └── supabase.ts     # Supabase client
│       │   └── constants/
│       │       └── queues.ts       # Queue names
│       ├── package.json
│       └── tsconfig.json
│
├── docker/                          # Docker configuration
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   └── docker-compose.prod.yml
│
├── scripts/                         # Build and deployment scripts
│   ├── build-all.sh
│   ├── deploy.sh
│   └── migrate-data.ts
│
├── .github/                         # CI/CD workflows
│   └── workflows/
│       ├── test.yml
│       ├── build.yml
│       └── deploy.yml
│
├── package.json                     # Root package.json with workspaces
├── pnpm-workspace.yaml             # PNPM workspace configuration
├── turbo.json                      # Turborepo configuration
├── .env.example
├── .gitignore
├── .dockerignore
└── README.md
```

## Redis Queue Structure

### Queue Names
```typescript
// packages/shared/src/constants/queues.ts
export const QUEUES = {
  INCOMING_MESSAGES: 'coachartie:messages:incoming',
  CAPABILITY_PROCESSING: 'coachartie:capabilities:process',
  OUTGOING_DISCORD: 'coachartie:discord:outgoing',
  OUTGOING_SMS: 'coachartie:sms:outgoing',
  OUTGOING_EMAIL: 'coachartie:email:outgoing',
  DEAD_LETTER: 'coachartie:dlq'
} as const;
```

### Message Types
```typescript
// packages/shared/src/types/queue.ts
export interface BaseQueueMessage {
  id: string;
  timestamp: Date;
  retryCount: number;
  source: 'discord' | 'sms' | 'email' | 'api';
}

export interface IncomingMessage extends BaseQueueMessage {
  userId: string;
  message: string;
  context?: any;
  respondTo: {
    type: 'discord' | 'sms' | 'email';
    channelId?: string;
    phoneNumber?: string;
    emailAddress?: string;
  };
}

export interface OutgoingMessage extends BaseQueueMessage {
  userId: string;
  message: string;
  inReplyTo: string;
  metadata?: any;
}

export interface CapabilityRequest extends BaseQueueMessage {
  capability: string;
  parameters: any;
  context: any;
}
```

## Key Implementation Files

### 1. Redis Client Setup
```typescript
// packages/shared/src/utils/redis.ts
import Redis from 'ioredis';
import { Queue, Worker, QueueEvents } from 'bullmq';

export const createRedisConnection = () => {
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
};

export const createQueue = (name: string) => {
  return new Queue(name, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  });
};

export const createWorker = (name: string, processor: any) => {
  return new Worker(name, processor, {
    connection: createRedisConnection(),
    concurrency: 5,
  });
};
```

### 2. Capabilities Queue Consumer
```typescript
// packages/capabilities/src/queues/consumer.ts
import { createWorker } from '@coachartie/shared/utils/redis';
import { QUEUES } from '@coachartie/shared/constants/queues';
import { IncomingMessage } from '@coachartie/shared/types/queue';
import { processMessage } from '../handlers/process-message';

export const startMessageConsumer = () => {
  const worker = createWorker(
    QUEUES.INCOMING_MESSAGES,
    async (job) => {
      const message: IncomingMessage = job.data;
      
      try {
        const response = await processMessage(message);
        
        // Publish to appropriate outgoing queue
        const outgoingQueue = getOutgoingQueue(message.respondTo.type);
        await outgoingQueue.add('response', {
          ...response,
          inReplyTo: message.id,
        });
        
        return { success: true };
      } catch (error) {
        console.error('Error processing message:', error);
        throw error;
      }
    }
  );

  worker.on('completed', (job) => {
    console.log(`Message ${job.data.id} processed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Message ${job.data.id} failed:`, err);
  });

  return worker;
};
```

### 3. Discord Publisher
```typescript
// packages/discord/src/queues/publisher.ts
import { createQueue } from '@coachartie/shared/utils/redis';
import { QUEUES } from '@coachartie/shared/constants/queues';
import { IncomingMessage } from '@coachartie/shared/types/queue';

const messageQueue = createQueue(QUEUES.INCOMING_MESSAGES);

export const publishMessage = async (
  userId: string,
  message: string,
  channelId: string
): Promise<void> => {
  const queueMessage: IncomingMessage = {
    id: `discord-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'discord',
    userId,
    message,
    respondTo: {
      type: 'discord',
      channelId,
    },
  };

  await messageQueue.add('process', queueMessage);
};
```

## Docker Compose Configuration

```yaml
# docker/docker-compose.yml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  capabilities:
    build:
      context: ..
      dockerfile: packages/capabilities/Dockerfile
    environment:
      - REDIS_HOST=redis
      - DATABASE_URL=${DATABASE_URL}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped

  discord:
    build:
      context: ..
      dockerfile: packages/discord/Dockerfile
    environment:
      - REDIS_HOST=redis
      - DATABASE_URL=${DATABASE_URL}
      - DISCORD_TOKEN=${DISCORD_TOKEN}
    depends_on:
      - redis
      - capabilities
    restart: unless-stopped

  sms:
    build:
      context: ..
      dockerfile: packages/sms/Dockerfile
    ports:
      - "9993:9993"
    environment:
      - REDIS_HOST=redis
      - DATABASE_URL=${DATABASE_URL}
      - TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}
      - TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}
    depends_on:
      - redis
      - capabilities
    restart: unless-stopped

  email:
    build:
      context: ..
      dockerfile: packages/email/Dockerfile
    ports:
      - "9994:9994"
    environment:
      - REDIS_HOST=redis
      - DATABASE_URL=${DATABASE_URL}
      - EMAIL_USER=${EMAIL_USER}
      - EMAIL_PASS=${EMAIL_PASS}
    depends_on:
      - redis
      - capabilities
    restart: unless-stopped

volumes:
  redis-data:
```

## Migration Steps

### Phase 1: Setup Monorepo Structure
```bash
# 1. Create new monorepo
mkdir coachartie-monorepo && cd coachartie-monorepo
git init

# 2. Setup pnpm workspaces
npm install -g pnpm
pnpm init

# 3. Create pnpm-workspace.yaml
echo "packages:
  - 'packages/*'" > pnpm-workspace.yaml

# 4. Setup Turborepo
pnpm add -D turbo
```

### Phase 2: Copy Services
```bash
# 5. Copy each service into packages/
cp -r ../coachartie_capabilities packages/capabilities
cp -r ../coachartie_discord2 packages/discord
cp -r ../coachartie_sms packages/sms
cp -r ../coachartie_email packages/email

# 6. Create shared package
mkdir -p packages/shared/src/{types,utils,constants}
```

### Phase 3: Update Dependencies
```bash
# 7. Update package.json in each service to use workspace protocol
# Example: "@coachartie/shared": "workspace:*"

# 8. Install all dependencies
pnpm install

# 9. Add Redis dependencies
pnpm add -w bullmq ioredis
pnpm add -w -D @types/ioredis
```

### Phase 4: Refactor Services
1. Replace HTTP calls with Redis queue publishers
2. Add queue consumers to each service
3. Update capabilities service to consume from incoming queue
4. Test each service with Redis locally

### Phase 5: Update CI/CD
```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - name: Install dependencies
        run: pnpm install
      - name: Run tests
        run: pnpm turbo test
```

## Environment Variables

```bash
# .env.example
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Database
DATABASE_URL=

# Service-specific
OPENAI_API_KEY=
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
EMAIL_USER=
EMAIL_PASS=
```

## Testing Strategy

### 1. Unit Tests
- Test queue publishers/consumers with Redis mocks
- Test message handlers independently

### 2. Integration Tests
```typescript
// tests/integration/message-flow.test.ts
import { createQueue } from '@coachartie/shared/utils/redis';
import { QUEUES } from '@coachartie/shared/constants/queues';

describe('Message Flow', () => {
  it('should process message from Discord to capabilities and back', async () => {
    // Test full flow through Redis
  });
});
```

### 3. E2E Tests
- Use Docker Compose to spin up all services
- Send test messages through each interface
- Verify responses are received correctly

## Monitoring

### Redis Queue Dashboard
```typescript
// packages/shared/src/utils/queue-monitor.ts
import { Queue } from 'bullmq';
import { QUEUES } from '../constants/queues';

export const getQueueStats = async () => {
  const stats = {};
  
  for (const [name, queueName] of Object.entries(QUEUES)) {
    const queue = new Queue(queueName);
    const counts = await queue.getJobCounts();
    stats[name] = counts;
  }
  
  return stats;
};
```

## Rollback Plan

1. Keep existing services running during migration
2. Test new services in staging environment
3. Use feature flags to gradually switch traffic
4. Monitor error rates and queue depths
5. Have quick rollback script ready:

```bash
#!/bin/bash
# scripts/rollback.sh
docker-compose -f docker/docker-compose.old.yml up -d
```

## Success Criteria

- [ ] All services communicate via Redis queues
- [ ] No direct HTTP calls between services
- [ ] Single repository with all code
- [ ] Automated tests pass for all services
- [ ] Deployment is simplified to single command
- [ ] Queue monitoring dashboard available
- [ ] Zero message loss during processing
- [ ] Proper retry and dead letter handling

## Timeline

- Week 1: Setup monorepo structure, copy services
- Week 2: Implement Redis queue communication
- Week 3: Testing and debugging
- Week 4: Deploy to staging, monitor
- Week 5: Production deployment