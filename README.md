# Coach Artie 2 - AI Capabilities Platform

## ⚡ Quick Start

**Prerequisites**: Docker Desktop installed and running

```bash
# 1. Clone and configure
git clone https://github.com/room302studio/coachartie2.git
cd coachartie2
cp .env.example .env  # Add your OPENROUTER_API_KEY

# 2. Start everything
docker-compose up -d

# 3. Test it works
curl http://localhost:18239/health
```

## 🧪 Test Installation

```bash
# AI chat test
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Calculate 42 * 42", "userId": "test"}'

# Wikipedia search (MCP tool)
curl -X POST http://localhost:18239/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "<search-wikipedia>artificial intelligence</search-wikipedia>", "userId": "test"}'
```

## 🐳 Docker Commands

```bash
# View logs
docker-compose logs -f capabilities

# Restart
docker-compose restart

# Stop
docker-compose down

# Rebuild
docker-compose down && docker-compose up -d --build
```

## 🔧 Configuration

Create `.env` file:

```env
# REQUIRED
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# OPTIONAL
DISCORD_TOKEN=your-token
WOLFRAM_APP_ID=your-id
```

## 🛠️ Troubleshooting

```bash
# Port in use
lsof -i :18239 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Check logs
docker-compose logs capabilities

# Rebuild from scratch
docker-compose down --volumes && docker-compose up -d --build
```

## 📄 License

Non-Commercial: CC BY-NC 4.0 | Commercial: ejfox@room302.studio