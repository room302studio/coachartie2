# Coach Artie Monorepo Refactor Checklist

## Pre-Migration
- [ ] Backup all current repositories
- [ ] Document current service versions
- [ ] Test all services are currently working
- [ ] Create migration branch in each repo

## Phase 1: Repository Setup
- [ ] Create `coachartie-monorepo` directory
- [ ] Initialize git repository
- [ ] Create `pnpm-workspace.yaml`
- [ ] Setup Turborepo with `turbo.json`
- [ ] Create folder structure:
  - [ ] `packages/capabilities/`
  - [ ] `packages/discord/`
  - [ ] `packages/sms/`
  - [ ] `packages/email/`
  - [ ] `packages/shared/`
  - [ ] `docker/`
  - [ ] `scripts/`

## Phase 2: Shared Package
- [ ] Create `packages/shared/package.json`
- [ ] Create type definitions:
  - [ ] `packages/shared/src/types/queue.ts`
  - [ ] `packages/shared/src/types/database.ts`
- [ ] Create utilities:
  - [ ] `packages/shared/src/utils/redis.ts`
  - [ ] `packages/shared/src/utils/logger.ts`
  - [ ] `packages/shared/src/utils/supabase.ts`
- [ ] Create constants:
  - [ ] `packages/shared/src/constants/queues.ts`

## Phase 3: Service Migration

### Capabilities Service
- [ ] Copy code to `packages/capabilities/`
- [ ] Update `package.json` dependencies
- [ ] Create queue consumer in `src/queues/consumer.ts`
- [ ] Create queue publisher in `src/queues/publisher.ts`
- [ ] Remove HTTP endpoint dependencies
- [ ] Update Dockerfile for monorepo context
- [ ] Write unit tests for queue handlers

### Discord Service
- [ ] Copy code to `packages/discord/`
- [ ] Update `package.json` dependencies
- [ ] Replace HTTP calls with queue publisher
- [ ] Add response queue consumer
- [ ] Update message handlers
- [ ] Update Dockerfile
- [ ] Test Discord bot functionality

### SMS Service
- [ ] Copy code to `packages/sms/`
- [ ] Update `package.json` dependencies
- [ ] Replace HTTP calls with queue publisher
- [ ] Add response queue consumer
- [ ] Update Twilio webhook handlers
- [ ] Update Dockerfile
- [ ] Test SMS functionality

### Email Service
- [ ] Copy code to `packages/email/`
- [ ] Update `package.json` dependencies
- [ ] Replace HTTP calls with queue publisher
- [ ] Add response queue consumer
- [ ] Update email webhook handlers
- [ ] Update Dockerfile
- [ ] Test email functionality

## Phase 4: Infrastructure

### Docker Setup
- [ ] Create `docker/docker-compose.yml`
- [ ] Add Redis service with health check
- [ ] Configure service dependencies
- [ ] Create `.dockerignore` files
- [ ] Test local Docker Compose setup
- [ ] Create production Docker Compose

### CI/CD
- [ ] Create `.github/workflows/test.yml`
- [ ] Create `.github/workflows/build.yml`
- [ ] Create `.github/workflows/deploy.yml`
- [ ] Setup branch protection rules
- [ ] Configure secrets in GitHub

## Phase 5: Testing

### Unit Tests
- [ ] Test Redis queue publishers
- [ ] Test Redis queue consumers
- [ ] Test message handlers
- [ ] Test error handling
- [ ] Test retry logic

### Integration Tests
- [ ] Test Discord → Capabilities → Discord flow
- [ ] Test SMS → Capabilities → SMS flow
- [ ] Test Email → Capabilities → Email flow
- [ ] Test queue error handling
- [ ] Test dead letter queue

### E2E Tests
- [ ] Setup test environment
- [ ] Test full message flow
- [ ] Test service recovery
- [ ] Test queue persistence
- [ ] Load testing

## Phase 6: Deployment

### Staging
- [ ] Deploy to staging environment
- [ ] Monitor queue depths
- [ ] Check error rates
- [ ] Verify all services healthy
- [ ] Run smoke tests

### Production
- [ ] Create rollback plan
- [ ] Schedule maintenance window
- [ ] Deploy with blue-green strategy
- [ ] Monitor metrics closely
- [ ] Have team on standby

## Post-Migration
- [ ] Archive old repositories
- [ ] Update documentation
- [ ] Update deployment guides
- [ ] Team training on new setup
- [ ] Create runbooks

## Verification
- [ ] All tests passing
- [ ] No message loss
- [ ] Queue monitoring working
- [ ] Logs aggregated properly
- [ ] Deployment automated
- [ ] Rollback tested