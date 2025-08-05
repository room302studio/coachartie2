# Coach Artie 2 - AI Capabilities Platform

🚀 **Production-grade AI system with embedded MCP tools, free model fallbacks, and bulletproof Docker architecture**

## 🚨 IMPORTANT: Choose ONE Method - Docker OR Local Development

⚠️ **WARNING**: You cannot run both Docker and local development at the same time - they will fight over the same ports!

### Option 1: Docker (Recommended for Production/Stability)
```bash
# Make sure no local services are running first!
pnpm run kill-all  # or pkill -f coachartie2

# Then start Docker
docker-compose up -d

# Test it works
curl http://localhost:18239/health
```

### Option 2: Local Development (For Hot-Reloading/Development)
```bash
# Make sure Docker is NOT running first!
docker-compose down

# Then just run:
pnpm install
pnpm run dev

# That's it! Services auto-discover available ports
```

## ⚡ Quick Start

**Prerequisites**: Docker Desktop installed and running

```bash
# 1. Clone and configure
git clone https://github.com/room302studio/coachartie2.git
cd coachartie2
cp .env.example .env  # Add your OPENROUTER_API_KEY

# 2. Choose your method (see above)
# Either: docker-compose up -d
# Or: pnpm install && pnpm run dev

# 3. Test it works
curl http://localhost:18239/health
```

## 🧪 Test Your Installation

```bash
# Health check
curl http://localhost:18239/health

# AI chat test
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! Calculate 42 * 42", "userId": "test"}'

# Memory system test
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "remember that I love pizza", "userId": "test"}'

# Wikipedia search (embedded MCP tool)
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<search-wikipedia>artificial intelligence</search-wikipedia>", "userId": "test"}'
```

All tests should return `{"success": true, "response": "working on it..."}` with processing happening in the background.

## 🐳 Docker Management

```bash
# View logs
docker-compose logs -f capabilities

# Check status
docker-compose ps

# Restart services
docker-compose restart

# Stop everything
docker-compose down

# Full rebuild (after code changes)
docker-compose down && docker-compose up -d --build

# Monitor resources
docker stats coachartie2-capabilities-1
```

## 🔧 Configuration

### Required Environment Variables

Create `.env` file with your API keys:

```env
# REQUIRED - Get from https://openrouter.ai/
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# OPTIONAL - Enhanced features
DISCORD_TOKEN=your-discord-bot-token
WOLFRAM_APP_ID=your-wolfram-id  
TWILIO_ACCOUNT_SID=your-twilio-sid
TWILIO_AUTH_TOKEN=your-twilio-token
TWILIO_PHONE_NUMBER=+1234567890
```

### Docker Services

| Service | Port | Purpose |
|---------|------|---------|
| **capabilities** | 18239 | Main AI API service |
| **redis** | 6379 | Memory & caching |
| **brain** | auto | Web dashboard (optional) |
| **discord** | - | Discord bot (optional) |
| **sms** | 27461 | SMS interface (optional) |

## 🎯 Features & Capabilities

### Core AI System
- **🧠 Multi-model AI**: Free model fallbacks (Mistral, Phi-3, Llama)
- **📝 Memory System**: Persistent conversation memory with FTS5 full-text search
- **🔢 Calculator**: Mathematical operations via MCP server
- **🌐 Web Search**: Brave Search API integration with Wolfram Alpha
- **📊 Analytics**: Usage tracking and monitoring
- **🩺 Self-healing**: Automatic error recovery system

### MCP Tools (Embedded)
Simple XML syntax for powerful tools:

```xml
<!-- Wikipedia search -->
<search-wikipedia>quantum physics</search-wikipedia>

<!-- Get Wikipedia article with optional params -->
<get-wikipedia-article limit="5">Python (programming language)</get-wikipedia-article>

<!-- Current time -->
<get-current-time />

<!-- Date parsing -->
<parse-date>2025-12-25</parse-date>

<!-- Calculator -->
<calculate>50 * 25 + 100</calculate>
```

**Rules:**
- Tool name = XML tag name (kebab-case like `search-wikipedia`)
- Main argument = tag content
- Optional params = XML attributes
- No args = self-closing tag
- **DO NOT** use the old format: `<capability name="mcp_client" action="call_tool"...>`

### All Capabilities (12 Total, 48+ Actions)

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

## 🚨 Security Notes

⚠️ **IMPORTANT**: This system includes security vulnerabilities for development purposes:
- API keys visible in environment variables
- Container runs as root user
- No rate limiting enabled

**For production deployment**: See [Issue #29](https://github.com/room302studio/coachartie2/issues/29) for security hardening steps.

## 🛠️ Troubleshooting

### Port Already in Use
```bash
# Kill conflicting processes
lsof -i :18239 | grep LISTEN | awk '{print $2}' | xargs kill -9
docker-compose up -d
```

### Container Won't Start
```bash
# Check logs for errors
docker-compose logs capabilities

# Rebuild from scratch
docker-compose down --volumes
docker-compose up -d --build
```

### API Keys Not Working
```bash
# Verify environment variables are set
docker-compose exec capabilities env | grep OPENROUTER_API_KEY

# Should show your API key, not empty
```

### Redis Connection Failed
```bash
# Check Redis health
docker-compose ps
# Should show redis as "healthy"

# Test connectivity
docker-compose exec capabilities nc -zv redis 6379
```

## 📁 Project Structure

```
coachartie2/
├── docker-compose.yml          # 🐳 Docker orchestration
├── .env                        # 🔑 Your API keys
├── packages/
│   ├── capabilities/           # 🧠 Main AI service
│   │   ├── Dockerfile         # Container definition
│   │   ├── src/index.ts       # Express server
│   │   └── data/              # SQLite database
│   ├── discord/               # 🤖 Discord bot
│   ├── sms/                   # 📱 SMS interface  
│   ├── brain/                 # 🌐 Web dashboard
│   └── shared/                # 🔧 Common utilities
└── CLAUDE.md                  # 📝 Development notes
```

## 🧪 Advanced Testing

### Comprehensive API Tests
```bash
# Memory system test
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"remember\">Docker solves networking issues</capability>", "userId": "test"}'

curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"memory\" action=\"search\" query=\"Docker\" />", "userId": "test"}'

# Calculator test  
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<capability name=\"calculator\" action=\"calculate\">999 * 888</capability>", "userId": "test"}'

# Registry test
curl http://localhost:18239/capabilities/registry | jq '.stats'
```

### Free Model Fallback Testing
```bash
# Natural language (Tier 1)
curl -X POST http://localhost:18239/chat \
  -d '{"message":"calculate 15 times 8","userId":"test"}'

# Markdown syntax (Tier 2) 
curl -X POST http://localhost:18239/chat \
  -d '{"message":"**CALCULATE:** 15 * 8","userId":"test"}'

# Simple XML (Tier 3)
curl -X POST http://localhost:18239/chat \
  -d '{"message":"<calculate>15 * 8</calculate>","userId":"test"}'
```

### Stress Testing
```bash
# Concurrent requests
for i in {1..10}; do (curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"test $i\",\"userId\":\"stress_$i\"}" &); done

# Memory usage monitoring
docker stats coachartie2-capabilities-1 --no-stream
```

## 🎯 Why Docker?

**Previous Issues (Now Solved)**:
- ❌ IPv6/IPv4 localhost resolution conflicts on macOS
- ❌ macOS Application Firewall interference  
- ❌ VPN software networking problems
- ❌ Port binding phantom server issues
- ❌ Process lifecycle management chaos
- ❌ Inconsistent environment across machines

**Docker Solution**:
- ✅ Complete network isolation
- ✅ Reliable service startup
- ✅ Consistent environments
- ✅ Easy deployment
- ✅ Resource monitoring

**Key Insight**: The issue wasn't with our code or Node.js frameworks - it was macOS host networking interference. Docker's network isolation completely solved the problem.

## 📞 Support

- **GitHub Issues**: [Report bugs or requests](https://github.com/room302studio/coachartie2/issues)
- **Email**: ejfox@room302.studio
- **Documentation**: See `CLAUDE.md` for detailed development notes

## 📄 License

**Non-Commercial**: Creative Commons Attribution-NonCommercial 4.0  
**Commercial licenses available** - Contact ejfox@room302.studio

---

🚀 **Ready to build amazing AI applications!** Start with the Quick Start guide above.