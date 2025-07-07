# Coach Artie 2 - AI Capabilities Platform

🎉 **PHANTOM SERVER ISSUE RESOLVED**: Docker containerization eliminates all host networking problems!

## Quick Start (Docker - RECOMMENDED)

**Requirements**: Docker Desktop installed and running

```bash
# Clone and start services
git clone <repository>
cd coachartie2
docker-compose up -d

# Test endpoints
curl http://localhost:18239/health
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "userId": "test"}'
```

## The Docker Solution

After extensive debugging of phantom server issues that affected **all Node.js frameworks** (Express, Fastify, raw HTTP), we implemented Docker containerization that **completely eliminates host networking problems**.

### What Docker Solves

**Previous Issues (RESOLVED)**:
- ✅ IPv6/IPv4 localhost resolution conflicts on macOS
- ✅ macOS Application Firewall interference  
- ✅ VPN software networking problems
- ✅ Port binding phantom server issues
- ✅ Process lifecycle management chaos
- ✅ Inconsistent environment across machines

**Root Cause**: macOS host networking stack was interfering with Node.js server binding, causing services to log "Server listening" but immediately become unreachable.

**Solution**: Docker containers provide complete networking isolation.

### Docker Architecture

```
Docker Services:
├── redis (redis:7-alpine)
│   ├── Port: 6379 (internal) 
│   ├── Health checks enabled
│   └── Persistent data volume
└── capabilities (custom Node.js)
    ├── Port: 18239 (exposed to host)
    ├── Hot-reload volumes for development
    ├── All environment variables configured
    └── Depends on Redis health
```

### Development Workflow

```bash
# Start services (RECOMMENDED)
docker-compose up -d

# View logs
docker-compose logs -f capabilities

# Check status
docker-compose ps

# Restart after changes
docker-compose down && docker-compose up -d

# Stop services
docker-compose down
```

## API Endpoints

All endpoints tested and verified working in Docker:

### Health Check
```bash
curl http://localhost:18239/health
# Returns: {"status":"healthy","service":"capabilities","checks":{"redis":"connected"}}
```

### Chat API
```bash
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "userId": "test"}'
```

### Memory System
```bash
# Store memory
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"remember\">Docker solves networking issues</capability>", "userId": "test"}'

# Search memory
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"search\" query=\"Docker\" />", "userId": "test"}'
```

### Calculator
```bash
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"calculator\" action=\"calculate\">999 * 888</capability>", "userId": "test"}'
# Returns: 887,112
```

### Capabilities Registry
```bash
curl http://localhost:18239/capabilities/registry
# Returns: 12 capabilities with 48 total actions
```

## MCP Tool Syntax (CRITICAL)

When calling MCP tools, **ALWAYS** use this simple syntax:

```xml
<!-- Search Wikipedia -->
<search-wikipedia>Python programming language</search-wikipedia>

<!-- Get Wikipedia article with optional params -->
<get-wikipedia-article limit="5">Python (programming language)</get-wikipedia-article>

<!-- Get current time (no args) -->
<get-current-time />

<!-- Parse a date -->
<parse-date>2025-06-30</parse-date>
```

**Rules:**
- Tool name = XML tag name (kebab-case like `search-wikipedia`)
- Main argument = tag content
- Optional params = XML attributes
- No args = self-closing tag
- **DO NOT** use the old format: `<capability name="mcp_client" action="call_tool"...>`

## Capabilities

The platform includes 12 core capabilities with 48 total actions:

- **Memory**: Store and search conversations with FTS5 full-text search
- **Calculator**: Mathematical operations via MCP server
- **Web Search**: Brave Search API integration
- **MCP Tools**: Simplified syntax for Wikipedia, time, etc.
- **File System**: Read, write, list operations with safety checks
- **Package Manager**: npm/pnpm operations
- **Environment**: System environment management
- **GitHub**: Repository operations
- **Wolfram Alpha**: Computational queries
- **Scheduler**: Task scheduling and management
- **Deployment Cheerleader**: Celebration and encouragement
- **MCP Client**: Connect to external MCP servers

## Environment Variables

Copy `.env` and configure required variables:

```env
# Required
OPENROUTER_API_KEY=your_key_here

# Optional but recommended
DISCORD_TOKEN=your_token_here
WOLFRAM_APP_ID=your_id_here
TWILIO_ACCOUNT_SID=your_sid_here
TWILIO_AUTH_TOKEN=your_token_here
TWILIO_PHONE_NUMBER=your_number_here

# Docker automatically sets these
REDIS_HOST=redis
REDIS_PORT=6379
CAPABILITIES_PORT=18239
```

## Legacy Development (Without Docker)

If Docker is unavailable, you can run services natively:

```bash
# Install dependencies
pnpm install

# Start development services (may encounter phantom server issues)
pnpm run dev:clean

# View logs
tail -f /tmp/turbo.log
```

**Warning**: Native development may encounter the phantom server issue on macOS configurations. Docker is **strongly recommended**.

## Troubleshooting

### Port Already in Use
```bash
# Kill any conflicting processes
lsof -i :18239 | grep LISTEN | awk '{print $2}' | xargs kill -9
docker-compose up -d
```

### Container Won't Start
```bash
# View detailed logs
docker-compose logs capabilities

# Rebuild containers
docker-compose down
docker-compose up -d --build
```

### Environment Variables Missing
```bash
# Check container environment
docker-compose exec capabilities env | grep OPENROUTER_API_KEY
```

### Redis Connection Issues
```bash
# Verify Redis health
docker-compose ps
# Should show redis as "healthy"

# Check Redis connectivity
docker-compose exec capabilities nc -zv redis 6379
```

## Project Structure

```
coachartie2/
├── docker-compose.yml           # Docker orchestration (NEW)
├── packages/
│   ├── capabilities/            # Core API service
│   │   ├── Dockerfile          # Container definition (NEW)
│   │   ├── src/
│   │   │   ├── index.ts        # Express server
│   │   │   ├── routes/         # API endpoints
│   │   │   ├── capabilities/   # Business logic
│   │   │   └── services/       # External integrations
│   │   └── data/
│   │       └── coachartie.db   # SQLite database
│   ├── shared/                 # Common utilities
│   ├── discord/                # Discord bot interface
│   ├── sms/                    # SMS service
│   ├── email/                  # Email service
│   └── brain/                  # Vue.js frontend (migration in progress)
└── CLAUDE.md                   # Detailed development notes
```

## Testing

Comprehensive tests to verify all functionality:

```bash
# Quick health test
curl http://localhost:18239/health

# Memory system test
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"remember\">Testing memory system</capability>", "userId": "test"}'

curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"search\" query=\"memory system\" />", "userId": "test"}'

# Calculator test  
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"calculator\" action=\"calculate\">123 * 456</capability>", "userId": "test"}'

# Registry test
curl http://localhost:18239/capabilities/registry | jq '.stats'
```

## Docker Success Story

**Timeline of the Phantom Server Issue**:
1. **Initial Problem**: Express servers would log "Server listening" but `curl localhost:PORT` would fail with "Connection refused"
2. **Framework Testing**: Tried Fastify, raw Node.js HTTP - same phantom server behavior
3. **System Investigation**: Extensive debugging of IPv6/IPv4, firewall, VPN, process management
4. **Docker Solution**: Complete containerization eliminated all host networking issues
5. **Result**: 100% reliable service startup with all endpoints functional

**Key Insight**: The issue wasn't with our code or Node.js frameworks - it was macOS host networking interference. Docker's network isolation completely solved the problem.

## License

This project is licensed for non-commercial use. For business inquiries, commercial licenses are available.

- **Email**: ejfox@room302.studio
- **Non-Commercial**: Creative Commons Attribution-NonCommercial 4.0

---

**🎉 Docker containerization: The definitive solution to phantom server nightmares!**