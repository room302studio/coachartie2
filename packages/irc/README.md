# Coach Artie IRC Bot

IRC bot interface for Coach Artie, following the same architecture as Discord, Slack, and SMS interfaces.

## Features

- Connects to IRC servers (default: irc.forestpunks.com)
- Handles both channel messages and direct messages
- Only responds when mentioned in channels (e.g., `@coachartie` or `coachartie:`)
- Message deduplication (10-second cache)
- Auto-reconnection support
- Optional NickServ authentication
- Message chunking for IRC's 512-byte limit
- Health check endpoint
- Queue-based pub/sub architecture

## Configuration

Create a `.env` file based on `.env.example`:

```bash
# IRC Server Configuration
IRC_SERVER=irc.forestpunks.com
IRC_SERVER_PORT=6667
IRC_NICK=coachartie
IRC_USERNAME=artie
IRC_REALNAME=Coach Artie Bot

# Channels to join (comma-separated)
IRC_CHANNELS=#test,#general

# Optional: Use TLS/SSL
IRC_USE_TLS=false

# Optional: NickServ password
IRC_PASSWORD=your_password_here

# Service Configuration
IRC_PORT=47327

# Redis Configuration
REDIS_HOST=redis
REDIS_PORT=47320
```

## Running

### With Docker (Recommended)

```bash
docker-compose up irc
```

### Locally for Development

```bash
# Install dependencies
pnpm install

# Build
pnpm --filter "@coachartie/irc" run build

# Start
pnpm --filter "@coachartie/irc" run start

# Or in dev mode with hot reload
pnpm --filter "@coachartie/irc" run dev
```

## Testing

1. Connect to the IRC server using an IRC client (e.g., irssi, HexChat, WeeChat)
2. Join the same channel as the bot
3. Mention the bot: `coachartie: hello!` or `@coachartie hello!`
4. Or send a direct message to `coachartie`

The bot will process your message through the capabilities system and respond!

## Architecture

- `src/index.ts` - Main entry point, IRC client setup
- `src/handlers/incoming-message.ts` - Handles incoming IRC messages
- `src/queues/publisher.ts` - Publishes messages to INCOMING_MESSAGES queue
- `src/queues/consumer.ts` - Consumes responses from OUTGOING_IRC queue
- `src/types/irc-framework.d.ts` - TypeScript declarations for irc-framework

## Health Check

Check bot status:
```bash
curl http://localhost:47327/health
```

Returns:
```json
{
  "status": "ok",
  "connected": true,
  "server": "irc.forestpunks.com",
  "nick": "coachartie",
  "channels": ["#test"],
  "timestamp": "2025-11-23T20:00:00.000Z"
}
```
