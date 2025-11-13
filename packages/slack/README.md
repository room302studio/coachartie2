# Coach Artie Slack Bot

A professional Slack bot integration for Coach Artie, featuring real-time streaming responses, conversation context awareness, and comprehensive telemetry.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Creating a Slack App](#creating-a-slack-app)
- [Configuring Permissions](#configuring-permissions)
- [Setting Up Event Subscriptions](#setting-up-event-subscriptions)
- [Installing to Your Workspace](#installing-to-your-workspace)
- [Environment Configuration](#environment-configuration)
- [Running the Service](#running-the-service)
- [Testing](#testing)
- [Health Checks & Monitoring](#health-checks--monitoring)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

## Features

- **Smart Response Detection**: Automatically responds to @mentions and direct messages
- **Real-time Streaming**: Progressive message delivery with live updates
- **Conversation Context**: Fetches 10-25 recent messages for conversational awareness
- **Thread Support**: Maintains context in threaded conversations
- **Message Chunking**: Automatically handles Slack's 40k character limit
- **Health Monitoring**: Built-in health checks and metrics endpoints
- **Reaction Support**: Can add/remove emoji reactions to messages
- **Duplicate Prevention**: Intelligent message deduplication
- **Comprehensive Telemetry**: Tracks messages, responses, and system health

## Prerequisites

Before setting up the Slack bot, ensure you have:

- **Node.js** 20+ installed
- **Redis** server running (for message queue)
- **Capabilities service** running on port 47324
- A **Slack workspace** where you have permission to add apps
- Access to the [Slack API dashboard](https://api.slack.com/apps)

## Creating a Slack App

### Step 1: Create New App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Select **"From scratch"**
4. Enter app details:
   - **App Name**: `Coach Artie` (or your preferred name)
   - **Workspace**: Select your development workspace
5. Click **"Create App"**

### Step 2: Basic Information

After creating the app, you'll land on the "Basic Information" page. Keep this page handy - you'll need it later.

## Configuring Permissions

### Step 1: Navigate to OAuth & Permissions

From your app's settings page:
1. Click **"OAuth & Permissions"** in the left sidebar
2. Scroll to **"Scopes"** section
3. Under **"Bot Token Scopes"**, add the following scopes:

### Required Bot Token Scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Detect when the bot is mentioned with @CoachArtie |
| `channels:history` | Read message history in public channels |
| `channels:read` | View basic information about public channels |
| `chat:write` | Send messages as the bot |
| `im:history` | Read message history in direct messages |
| `im:read` | View basic information about DMs |
| `im:write` | Send direct messages |
| `users:read` | View user information (names, profiles) |
| `reactions:read` | View reactions on messages |
| `reactions:write` | Add reactions to messages |

### Adding Scopes

For each scope listed above:
1. Click **"Add an OAuth Scope"**
2. Search for the scope name
3. Click to add it

> **Note**: Some scopes may trigger additional permission requirements. Slack will guide you through any additional steps needed.

## Setting Up Event Subscriptions

Events allow your bot to respond to messages and mentions in real-time.

### Step 1: Enable Events

1. Click **"Event Subscriptions"** in the left sidebar
2. Toggle **"Enable Events"** to **ON**

### Step 2: Configure Request URL

You need to provide a public URL that Slack can send events to. This must be accessible from the internet.

**Development Options:**
- Use [ngrok](https://ngrok.com/) to expose your local server: `ngrok http 3000`
- Use a cloud deployment (recommended for production)

**Request URL Format:**
```
https://your-domain.com/slack/events
```

> **Important**: Your server must be running and responding to Slack's verification challenge before you can save this URL.

### Step 3: Subscribe to Bot Events

Scroll to **"Subscribe to bot events"** and add these event types:

| Event Name | Description |
|------------|-------------|
| `app_mention` | When someone mentions @CoachArtie |
| `message.channels` | Messages posted to public channels |
| `message.im` | Direct messages sent to the bot |

After adding all events:
1. Click **"Save Changes"**
2. Slack will verify your Request URL

## Installing to Your Workspace

### Step 1: Install App

1. Click **"Install App"** in the left sidebar
2. Click **"Install to Workspace"**
3. Review the permissions
4. Click **"Allow"**

### Step 2: Get Your Tokens

After installation, you'll see two important tokens:

1. **Bot User OAuth Token**
   - Starts with `xoxb-`
   - Click **"Copy"** button
   - Save this for your `.env` file

2. **Signing Secret**
   - Go to **"Basic Information"** in the left sidebar
   - Scroll to **"App Credentials"**
   - Find **"Signing Secret"**
   - Click **"Show"** then copy
   - Save this for your `.env` file

> **Security Note**: Never commit these tokens to version control. Keep them in your `.env` file which should be in `.gitignore`.

## Environment Configuration

### Step 1: Create Environment File

From the monorepo root, create or update your `.env` file:

```bash
# Navigate to monorepo root
cd /Users/ejfox/code/coachartie2

# Create .env from example (if it doesn't exist)
cp .env.example .env

# Edit the file
nano .env
```

### Step 2: Add Slack Configuration

Add these variables to your `.env` file:

```bash
# ============================================
# SLACK CONFIGURATION
# ============================================

# Bot User OAuth Token (from "OAuth & Permissions" page)
SLACK_BOT_TOKEN=xoxb-your-token-here

# Signing Secret (from "Basic Information" > "App Credentials")
SLACK_SIGNING_SECRET=your-secret-here

# Slack server port (must match your Event Subscriptions Request URL)
SLACK_PORT=3000

# ============================================
# REQUIRED SERVICES
# ============================================

# Capabilities service URL (default: http://localhost:47324)
CAPABILITIES_URL=http://localhost:47324

# Redis configuration (for BullMQ message queue)
REDIS_HOST=localhost
REDIS_PORT=6379

# Health check server port
HEALTH_PORT=47320

# ============================================
# OPTIONAL
# ============================================

# Environment
NODE_ENV=development

# Logging
LOG_LEVEL=info
```

### Configuration Details

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | ✅ Yes | - | Bot User OAuth Token from Slack |
| `SLACK_SIGNING_SECRET` | ✅ Yes | - | Signing Secret for request verification |
| `SLACK_PORT` | No | `3000` | Port for Slack event server |
| `CAPABILITIES_URL` | ✅ Yes | - | URL of the capabilities service |
| `REDIS_HOST` | ✅ Yes | - | Redis server hostname |
| `REDIS_PORT` | ✅ Yes | `6379` | Redis server port |
| `HEALTH_PORT` | No | `47320` | Health check server port |
| `NODE_ENV` | No | `development` | Environment mode |
| `LOG_LEVEL` | No | `info` | Logging verbosity |

## Running the Service

### Prerequisites Check

Before starting, ensure these services are running:

1. **Redis Server**
   ```bash
   # Check if Redis is running
   redis-cli ping
   # Should return: PONG
   ```

2. **Capabilities Service**
   ```bash
   # Check if capabilities service is running
   curl http://localhost:47324/health
   # Should return JSON health status
   ```

### Development Mode

Run with auto-reload on code changes:

```bash
# From monorepo root
cd /Users/ejfox/code/coachartie2/packages/slack

# Install dependencies (if not already done)
npm install

# Start in development mode
npm run dev
```

You should see output like:
```
🚀 SLACK SERVICE STARTING UP - BOOKITY BOOKITY!
📍 Current directory: /Users/ejfox/code/coachartie2/packages/slack
🔧 Node version: v20.x.x
🌍 Environment: development
🔑 Loading environment variables...
🔌 Environment check:
  - SLACK_BOT_TOKEN: ✅ Set
  - SLACK_SIGNING_SECRET: ✅ Set
  - REDIS_HOST: localhost
  - REDIS_PORT: 6379
  - CAPABILITIES_URL: http://localhost:47324
  - SLACK_PORT: 3000
✅ Slack app started successfully!
✅ slack: Bot connected on port 3000
🩺 Health server running on port 47320
```

### Production Mode

For production deployment:

```bash
# Build TypeScript to JavaScript
npm run build

# Start the production server
npm start
```

### Using Docker

If you're using the monorepo's Docker setup:

```bash
# From monorepo root
docker-compose up slack
```

## Testing

### Basic Response Test

1. **Test @mention in channel**
   - Go to a channel where the bot is a member
   - Type: `@CoachArtie Hello!`
   - The bot should respond with a greeting

2. **Test Direct Message**
   - Open a DM with Coach Artie
   - Send any message: `Hi there!`
   - The bot should respond

3. **Test Threading**
   - @mention the bot in a channel
   - Reply to the bot's response in a thread
   - The bot should continue the conversation in the thread

### Verify Response Features

- **Streaming**: You should see the response appear progressively
- **Context Awareness**: Ask follow-up questions to verify the bot remembers context
- **Reactions**: The bot may add emoji reactions during processing
- **Error Handling**: Try an invalid command to see error messages

### Check Logs

Monitor the logs for any errors:

```bash
# Development mode shows real-time logs
npm run dev

# Production mode - use your logging solution
# Logs include correlation IDs for tracking requests
```

### Verify Services

Check that all components are healthy:

```bash
# Health check
curl http://localhost:47320/health

# Metrics
curl http://localhost:47320/metrics

# Readiness
curl http://localhost:47320/ready

# Liveness
curl http://localhost:47320/live
```

## Health Checks & Monitoring

The Slack bot includes a comprehensive health check server.

### Health Endpoints

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `/health` | Overall health status | Full health report with Slack status and metrics |
| `/metrics` | Telemetry metrics | Message counts, user stats, recent events |
| `/ready` | Readiness probe | Whether bot is ready to handle requests |
| `/live` | Liveness probe | Whether bot process is alive |

### Health Status Example

```bash
curl http://localhost:47320/health
```

```json
{
  "status": "healthy",
  "timestamp": "2025-11-13T15:00:00.000Z",
  "service": "slack-bot",
  "version": "1.0.0",
  "uptime": 3600,
  "slack": {
    "connected": true,
    "workspaces": 1,
    "users": 0
  },
  "telemetry": {
    "messagesReceived": 150,
    "responsesDelivered": 145,
    "messagesFailed": 2,
    "averageResponseTime": 1250
  }
}
```

### Metrics Example

```bash
curl http://localhost:47320/metrics
```

```json
{
  "timestamp": "2025-11-13T15:00:00.000Z",
  "slack": {
    "connected": true,
    "workspaces": 1,
    "users": 0
  },
  "metrics": {
    "messagesReceived": 150,
    "responsesDelivered": 145,
    "messagesFailed": 2,
    "uniqueUsers": 12,
    "averageResponseTime": 1250
  },
  "events": [
    {
      "type": "message_received",
      "timestamp": "2025-11-13T14:59:30.000Z",
      "metadata": { "userId": "U12345", "channelId": "C67890" }
    }
  ]
}
```

### Monitoring in Production

For production deployments, you can:

1. **Set up health check alerts**
   ```bash
   # Example: Check health every minute
   * * * * * curl -f http://localhost:47320/health || alert-team
   ```

2. **Monitor metrics**
   - Integrate with Prometheus, Datadog, or your monitoring solution
   - Track message success rate, response times, error rates

3. **Use Kubernetes probes** (if applicable)
   ```yaml
   livenessProbe:
     httpGet:
       path: /live
       port: 47320
     initialDelaySeconds: 30
     periodSeconds: 10

   readinessProbe:
     httpGet:
       path: /ready
       port: 47320
     initialDelaySeconds: 10
     periodSeconds: 5
   ```

## Architecture

### Components

The Slack bot consists of several key components:

```
packages/slack/
├── src/
│   ├── index.ts                      # Main entry point
│   ├── handlers/
│   │   ├── message-handler.ts        # Message processing & streaming
│   │   └── interaction-handler.ts    # Button/modal interactions
│   ├── services/
│   │   ├── capabilities-client.ts    # Capabilities service integration
│   │   ├── conversation-state.ts     # Conversation tracking
│   │   ├── health-server.ts          # Health check endpoints
│   │   ├── api-server.ts             # API server
│   │   ├── job-monitor.ts            # Job status monitoring
│   │   ├── telemetry.ts              # Metrics & logging
│   │   └── user-intent-processor.ts  # Unified intent processing
│   ├── queues/
│   │   ├── publisher.ts              # Publish to message queue
│   │   ├── consumer.ts               # Consume responses
│   │   └── outgoing-consumer.ts      # Handle outgoing messages
│   ├── routes/
│   │   └── api.ts                    # API routes
│   └── utils/
│       ├── correlation.ts            # Request correlation tracking
│       └── path-resolver.ts          # Environment-aware paths
├── package.json
├── tsconfig.json
└── README.md                         # This file
```

### Message Flow

1. **Slack sends event** → Message received by Bolt app
2. **Deduplication check** → Prevent duplicate processing
3. **Response detection** → Check if bot should respond (@mention or DM)
4. **Context gathering** → Fetch recent channel history (10-25 messages)
5. **Intent processing** → Process through unified intent processor
6. **Queue publishing** → Publish to Redis queue
7. **Capabilities processing** → Capabilities service generates response
8. **Streaming response** → Progressive delivery back to Slack
9. **Telemetry** → Track metrics and events

### Correlation Tracking

Every message gets a unique correlation ID for request tracing:
- Logged with all events
- Included in telemetry
- Helps debug issues across services

Example log:
```
📨 Message received [a1b2c3d4]
🤖 Will respond to message [a1b2c3d4]
📨 SLACK RESPOND [a1b2c3d4]: contentLength=150
✅ SLACK: All 2 chunks delivered [a1b2c3d4]
```

### Queue System

Uses BullMQ with Redis for reliable message processing:
- **Incoming Queue**: Messages from Slack → Capabilities
- **Response Queue**: Responses from Capabilities → Slack
- **Outgoing Queue**: Messages to send to Slack

Benefits:
- Resilient to service restarts
- Retry failed messages
- Track job status
- Rate limiting

## Troubleshooting

### Bot Not Responding

**Check 1: Verify bot is running**
```bash
curl http://localhost:47320/health
```

**Check 2: Verify environment variables**
```bash
# In packages/slack directory
npm run dev

# Look for:
# ✅ SLACK_BOT_TOKEN: Set
# ✅ SLACK_SIGNING_SECRET: Set
```

**Check 3: Verify bot is in the channel**
- Type `/invite @CoachArtie` in the channel
- Or add via channel settings

**Check 4: Check permissions**
- Go to [Slack API Apps](https://api.slack.com/apps)
- Select your app → OAuth & Permissions
- Verify all scopes are present
- Reinstall app if scopes changed

### Events Not Reaching Bot

**Check 1: Verify Event Subscriptions**
- Go to Event Subscriptions in Slack app settings
- Ensure Request URL is verified (green checkmark)
- Verify all three events are subscribed:
  - `app_mention`
  - `message.channels`
  - `message.im`

**Check 2: Request URL Issues**

If using ngrok:
```bash
# Start ngrok
ngrok http 3000

# Update Request URL in Slack app settings to:
# https://your-ngrok-url.ngrok.io/slack/events
```

**Check 3: Firewall/Network**
- Ensure port 3000 is accessible
- Check firewall rules
- Verify Slack can reach your server

### Redis Connection Errors

**Check 1: Redis is running**
```bash
redis-cli ping
# Should return: PONG
```

**Check 2: Redis connection settings**
```bash
# Verify in .env:
REDIS_HOST=localhost
REDIS_PORT=6379
```

**Check 3: Redis permissions**
```bash
# Test connection
redis-cli -h localhost -p 6379 ping
```

### Capabilities Service Errors

**Check 1: Service is running**
```bash
curl http://localhost:47324/health
```

**Check 2: Verify URL in .env**
```bash
CAPABILITIES_URL=http://localhost:47324
```

**Check 3: Check logs**
```bash
# In packages/capabilities
npm run dev
```

### High Response Times

**Check 1: Capabilities service performance**
```bash
# Check capabilities metrics
curl http://localhost:47324/metrics
```

**Check 2: Redis queue backlog**
```bash
# Connect to Redis
redis-cli

# Check queue sizes
LLEN bull:slack-messages:waiting
LLEN bull:slack-responses:waiting
```

**Check 3: Message history fetch**
- Bot fetches 10-25 recent messages for context
- In busy channels, this may slow responses
- Consider reducing MAX_CHANNEL_HISTORY in message-handler.ts

### Streaming Not Working

**Check 1: Network latency**
- Streaming requires stable connection
- Check network stability

**Check 2: Message size**
- Large responses may appear to stream slower
- Check message chunking is working

**Check 3: Capabilities service streaming**
- Verify capabilities service supports streaming
- Check job status updates are being sent

### Permission Errors

**Error: `missing_scope`**
- Go to OAuth & Permissions
- Add the missing scope
- Reinstall app to workspace

**Error: `not_in_channel`**
- Invite bot to channel: `/invite @CoachArtie`
- Or add via channel settings → Integrations

**Error: `channel_not_found`**
- Verify bot has access to channel
- Check if channel is private (bot needs invite)

### Debug Mode

Enable verbose logging:

```bash
# In .env
LOG_LEVEL=debug
NODE_ENV=development

# Restart the bot
npm run dev
```

This will show detailed logs including:
- Full message payloads
- Queue job details
- API responses
- Correlation tracking

### Getting Help

If you're still stuck:

1. Check the logs with correlation IDs
2. Verify all prerequisites are met
3. Check the [Slack API documentation](https://api.slack.com/docs)
4. Review the code comments in `src/handlers/message-handler.ts`
5. Open an issue with:
   - Error messages
   - Health check output
   - Relevant log snippets (with sensitive data removed)

---

**Last Updated**: November 2025
**Package Version**: 1.0.0
**Slack Bolt Version**: 3.17.1
