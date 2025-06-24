# Coach Artie 2 - Monorepo

A unified monorepo for all Coach Artie services using Redis queue-based communication.

## Architecture

- **Monorepo**: All services in one repository using pnpm workspaces
- **Queue-based**: Redis (BullMQ) for inter-service communication
- **TypeScript**: Fully typed with shared types package
- **Docker**: Containerized services with Docker Compose

## Services

- `packages/capabilities` - Core AI capabilities and message processing
- `packages/discord` - Discord bot interface
- `packages/sms` - SMS interface via Twilio
- `packages/email` - Email interface
- `packages/shared` - Shared types, utilities, and constants

## Getting Started

```bash
# Install pnpm
npm install -g pnpm

# Install dependencies
pnpm install

# Run development environment
docker-compose -f docker/docker-compose.dev.yml up

# Run tests
pnpm test

# Build all packages
pnpm build
```

## Development

Each service can be developed independently:

```bash
# Work on a specific service
cd packages/discord
pnpm dev

# Run tests for a specific service
pnpm test
```

## Deployment

See [DEPLOYMENT.md](./docs/DEPLOYMENT.md) for deployment instructions.

## Migration Status

This is a complete rewrite of the Coach Artie system. See [MIGRATION.md](./docs/MIGRATION.md) for migration progress.