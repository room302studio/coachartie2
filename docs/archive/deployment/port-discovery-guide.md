# 🚀 Automatic Port Discovery System

**Problem Solved**: No more manual process killing for port conflicts!

## Overview

The Coach Artie 2 platform now features automatic port discovery, eliminating the need to manually kill processes when port conflicts occur. Services automatically find available ports and register themselves for inter-service communication.

## How It Works

### 1. Port Discovery (`packages/shared/src/utils/port-discovery.ts`)

Services automatically find available ports using:

```typescript
import { PortDiscovery, parsePortWithFallback } from '@coachartie/shared';

// Auto-discover port with fallback to environment variable
const PORT = await parsePortWithFallback('SERVICE_PORT', 'service-name');

// Or direct port discovery
const port = await PortDiscovery.getServicePort('capabilities');
```

**Default Ports** (used as starting points):

- **Capabilities**: 18239
- **SMS**: 27461
- **Email**: 35892
- **Brain**: 3000

If default port is busy, system automatically increments to find next available port.

### 2. Service Discovery (`packages/shared/src/utils/service-discovery.ts`)

Services register themselves and can find each other:

```typescript
import { serviceDiscovery, registerServiceWithDiscovery } from '@coachartie/shared';

// Register service (done automatically in updated services)
await registerServiceWithDiscovery('service-name', port);

// Find other services
const capabilitiesUrl = await serviceDiscovery.getServiceUrl('capabilities');
const allServices = await serviceDiscovery.getAllServices();
```

## Updated Services

### ✅ Capabilities Service

- Auto-discovers port starting from 18239
- Registers with service discovery
- Exposes `/services` endpoint for service lookup

### ✅ SMS Service

- Auto-discovers port starting from 27461
- Registers with service discovery
- Webhook URL adapts to discovered port

### ✅ Email Service

- Auto-discovers port starting from 35892
- Registers with service discovery
- Webhook URL adapts to discovered port

### ✅ Brain Frontend

- Uses custom dev server (`dev-server.mjs`)
- Auto-discovers port starting from 3000
- Registers with service discovery
- `pnpm dev` now uses auto-discovery (fallback: `pnpm run dev-manual`)

## Benefits

🎯 **Zero Manual Intervention**: No more `lsof -i :PORT` and `kill -9 PID`

🔄 **Multiple Instances**: Run multiple instances of same service automatically

🌐 **Service Discovery**: Services can find each other dynamically

📊 **Development Workflow**: Start all services with `pnpm run dev` - no conflicts

🛡️ **Error Prevention**: Rare race conditions handled gracefully

## Usage Examples

### Starting Services

```bash
# All services automatically find available ports
pnpm run dev

# Individual services
cd packages/capabilities && pnpm start
cd packages/brain && pnpm dev          # Uses auto-discovery
cd packages/brain && pnpm run dev-manual  # Traditional Nuxt dev
```

### Testing Port Discovery

```bash
# Run comprehensive test suite
node test-port-discovery.mjs
```

### Service Discovery API

```bash
# Get all running services
curl http://localhost:[auto-discovered-port]/services

# Get specific service
curl http://localhost:[auto-discovered-port]/services/sms

# Get service URL
curl http://localhost:[auto-discovered-port]/services/brain/url
```

## Environment Variables

Services still respect environment variables as overrides:

```bash
# Force specific ports (bypasses auto-discovery)
CAPABILITIES_PORT=8000
SMS_PORT=8001
EMAIL_SERVICE_PORT=8002
PORT=8003  # For brain frontend

# Port range configuration (optional)
PORT_RANGE_START=8000
PORT_RANGE_END=9000
```

## Redis Integration

Service discovery uses Redis for inter-service communication:

- Services register themselves with 90-second TTL
- Automatic ping system keeps registrations alive
- Graceful cleanup on service shutdown
- Works locally without Redis (degraded mode)

## Error Handling

**Before**: Port conflicts caused immediate failures

```
❌ EADDRINUSE: address already in use :::18239
```

**After**: Automatic conflict resolution

```
⚠️  Default port 18239 for capabilities service was busy, using port 18240
✅ Capabilities service successfully started on port 18240
```

## Migration Notes

- **Environment variables still work** - they override auto-discovery
- **Existing scripts unchanged** - services just find different ports automatically
- **Service URLs adapt** - check logs or `/services` endpoint for actual URLs
- **Webhook configuration** - External services (Twilio) may need URL updates

## Implementation Files

```
packages/shared/src/utils/
├── port-discovery.ts     # Core port discovery logic
├── service-discovery.ts  # Service registration & lookup
└── index.ts             # Exports

packages/capabilities/src/
├── index.ts             # Updated with auto-discovery
└── routes/services.ts   # Service discovery API

packages/sms/src/index.ts        # Updated with auto-discovery
packages/email/src/index.ts      # Updated with auto-discovery
packages/brain/
├── dev-server.mjs              # Custom dev server
└── package.json               # Updated dev script

test-port-discovery.mjs         # Comprehensive test suite
```

---

**Result**: Development is now completely conflict-free. Services intelligently find available ports and register themselves for seamless inter-service communication. No more manual process management!
