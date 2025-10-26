# Coach Artie Showcase Guide

**For: coachartiebot.com Website Development**

This document outlines how to showcase Coach Artie's capabilities, architecture, and live stats on his website.

## Quick Overview

Coach Artie is an AI assistant with **28 capabilities** across multiple domains, featuring:
- **Runtime Adaptation** - Self-monitoring and auto-optimization based on credit balance
- **Hybrid Memory System** - Semantic + temporal memory for context-aware responses
- **Multi-Channel Communication** - Discord, SMS, Email, API
- **Three-Tier Model Strategy** - FAST/SMART/MANAGER models for cost optimization
- **Context Alchemy** - Intelligent context assembly from multiple sources

**Current Version:** 1.1.0
**Launch Date:** January 2025
**Primary LLM:** Claude 3.5 Sonnet (via OpenRouter)

---

## Live API Endpoints

These endpoints can provide real-time data for the website:

### Health Status
```bash
GET http://localhost:47319/health
# Returns: Service health across all components
```

### Chat with Artie
```bash
POST http://localhost:47324/chat
Content-Type: application/json
{
  "message": "What are your capabilities?",
  "user_id": "website-visitor"
}
# Returns: { messageId, status, jobUrl }

GET http://localhost:47324/chat/{messageId}
# Returns: { response, status, processingTime }
```

### System Stats (Future Enhancement)
```bash
GET http://localhost:47324/_stats
# Returns: Job processing statistics
```

---

## Core Capabilities (28 Total)

### 🔧 Runtime Adaptation (New in v1.1.0)
1. **model_manager** (4 actions) - Query available models, pricing, credit-aware recommendations
2. **runtime_config** (7 actions) - Dynamic configuration adjustment, auto-optimize modes
3. **system_monitor** (5 actions) - Monitor system resources, services, disk, health

### 🧠 Intelligence & Memory
4. **memory** - Hybrid semantic + temporal memory system with vector embeddings
5. **context_assembly** - Context Alchemy for intelligent multi-source context
6. **todos** - Task management with persistence

### 🌐 Communication & Integration
7. **discord** - Rich Discord integration with visual formatting, progress bars, health meters
8. **sms** - Two-way SMS communication (Twilio)
9. **email** - Email sending and management (SendGrid)
10. **github** - Repository management, PR creation, issue tracking

### 📊 Data & Information
11. **calculator** - Advanced mathematical calculations
12. **web_search** - Real-time web search capabilities
13. **web_scraper** - Extract content from websites
14. **weather** - Current conditions and forecasts
15. **time** - Time zone aware date/time operations
16. **file_system** - Read/write file operations

### 🎯 Productivity
17. **calendar** - Calendar management and scheduling
18. **reminders** - Time-based reminder system
19. **notes** - Note-taking and organization
20. **search** - Cross-capability search

### 🔌 Social Media (Select Capabilities)
21. **twitter** - Tweet posting and monitoring
22. **linkedin** - Professional networking (OAuth required)
23. **mastodon** - Fediverse posting

### 🛠️ System & Utilities
24. **code_execution** - Safe code execution sandbox
25. **image_generation** - AI image generation
26. **text_to_speech** - Voice synthesis
27. **translation** - Multi-language translation
28. **crypto_prices** - Cryptocurrency market data

---

## Auto-Optimize Modes

Artie automatically adjusts his configuration based on available credits:

| Mode | Credit Threshold | Max Iterations | Context Window | Available Models |
|------|-----------------|----------------|----------------|------------------|
| 🔴 **SURVIVAL** | < $5 | 3 | 16k tokens | FAST only |
| 🟡 **CONSERVATIVE** | < $25 | 5 | 24k tokens | FAST + SMART |
| 🟢 **EFFICIENT** | < $50 | 8 | 32k tokens | FAST + SMART |
| 🔵 **FULL POWER** | > $50 | 12 | 64k tokens | All models |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Incoming Messages                   │
│              (Discord, SMS, Email, API)              │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │   Message Queue      │
          │   (BullMQ/Redis)     │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │  Capabilities Service │
          │  (Port 47324)         │
          └──────────┬───────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
    ┌───────┐  ┌─────────┐  ┌────────┐
    │ FAST  │  │  SMART  │  │MANAGER │
    │Model  │  │  Model  │  │ Model  │
    └───┬───┘  └────┬────┘  └───┬────┘
        │           │            │
        └───────────┼────────────┘
                    ▼
          ┌──────────────────────┐
          │   Context Alchemy    │
          │ (Memory + Temporal)  │
          └──────────────────────┘
```

**Services:**
- **47319** - Health monitoring
- **47320** - Redis (queue + cache)
- **47324** - Capabilities API
- **47325** - Brain UI (admin dashboard)
- **47326** - SMS interface
- **47327+** - Dynamic MCP servers

---

## Website Feature Ideas

### 1. Live Chat Demo
Interactive chat widget powered by `/chat` endpoint:
```javascript
// Example implementation
async function chatWithArtie(message) {
  const response = await fetch('http://localhost:47324/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, user_id: 'website-demo' })
  });
  const { messageId } = await response.json();

  // Poll for result
  const result = await pollForResponse(messageId);
  return result.response;
}
```

### 2. Capability Explorer
Interactive grid showing all 28 capabilities with:
- Capability name and icon
- Number of actions
- Usage examples
- Live demo button

### 3. Live System Stats
Real-time dashboard showing:
- Current optimization mode (SURVIVAL/CONSERVATIVE/EFFICIENT/FULL POWER)
- Active services status
- Messages processed (last 24h)
- Average response time
- Current model in use

### 4. Version History Timeline
Visual timeline from CHANGELOG.md:
- v1.1.0: Runtime adaptation capabilities
- v1.0.0: Cost controls and security hardening
- v0.9.0: Initial foundation

### 5. Architecture Diagram
Interactive SVG showing:
- Service ports and connections
- Data flow between components
- Model selection logic
- Memory system architecture

### 6. Credit Status Widget
```
┌─────────────────────────────────┐
│  Current Mode: 🟢 EFFICIENT     │
│  Credits: $45.23                │
│  Model: Claude 3.5 Sonnet       │
│  Context: 32k tokens            │
└─────────────────────────────────┘
```

### 7. Example Interactions Carousel
Showcase different capability types:
- "What's the weather in Tokyo?"
- "Remember that I prefer dark mode"
- "Create a GitHub issue for the bug we discussed"
- "Optimize your configuration for cost savings"

---

## Sample Data Structure

### Capability Metadata
```json
{
  "name": "model_manager",
  "version": "1.0.0",
  "actions": [
    {
      "name": "list_models",
      "description": "Get all available OpenRouter models with pricing",
      "parameters": {}
    },
    {
      "name": "get_model_details",
      "description": "Get detailed info about a specific model",
      "parameters": {
        "model_id": "string"
      }
    },
    {
      "name": "recommend_model",
      "description": "Get credit-aware model recommendation",
      "parameters": {
        "task_type": "string",
        "available_credits": "number"
      }
    },
    {
      "name": "get_current_balance",
      "description": "Check current OpenRouter credit balance",
      "parameters": {}
    }
  ]
}
```

### Auto-Optimize Config
```json
{
  "mode": "EFFICIENT",
  "trigger": "credit_threshold",
  "settings": {
    "max_exploration_iterations": 8,
    "max_context_tokens": 32000,
    "available_models": ["FAST", "SMART"],
    "cost_per_hour_limit": 2.00
  }
}
```

---

## Branding & Personality

**Voice:** Conversational, helpful, slightly self-aware about being an AI
**Tone:** Professional but friendly, Rick & Morty references for credit warnings
**Visual Style:** Clean, technical, with emoji accents (not overdone)

**Key Messages:**
- "I adapt to my environment" (runtime optimization)
- "I remember what matters" (hybrid memory)
- "I'm cost-conscious" (auto-optimization modes)
- "I write my own release notes" (changelog automation)

---

## Technical Implementation Notes

### Fetching Live Data
- All endpoints should be proxied through your web server (don't expose internal ports)
- Implement rate limiting for public chat endpoint
- Cache capability metadata (changes rarely)
- Use WebSocket or polling for live status updates

### Security Considerations
- Don't expose internal service ports publicly
- Implement API key authentication for write operations
- Sanitize all user input before sending to `/chat`
- Rate limit demo chat to prevent abuse

### Performance
- Cache static content (capability list, architecture diagrams)
- Use CDN for images and assets
- Lazy load heavy components (chat widget, system stats)
- Implement skeleton loading states

---

## Example Code Snippets

### React Component: Live Status
```tsx
function ArtieStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const fetchStatus = async () => {
      const res = await fetch('/api/artie/health');
      const data = await res.json();
      setStatus(data);
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="artie-status">
      <h3>System Status</h3>
      <div className="mode">{status?.optimizeMode || 'Loading...'}</div>
      <div className="services">
        {status?.services?.map(s => (
          <span key={s.name} className={s.healthy ? 'healthy' : 'unhealthy'}>
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
```

### Vue Component: Chat Interface
```vue
<template>
  <div class="chat-with-artie">
    <div class="messages" ref="messages">
      <div v-for="msg in messages" :key="msg.id" :class="msg.role">
        {{ msg.content }}
      </div>
    </div>
    <input
      v-model="input"
      @keyup.enter="sendMessage"
      placeholder="Ask Artie anything..."
    />
  </div>
</template>

<script>
export default {
  data() {
    return {
      messages: [],
      input: ''
    };
  },
  methods: {
    async sendMessage() {
      if (!this.input.trim()) return;

      this.messages.push({ role: 'user', content: this.input });
      const userMessage = this.input;
      this.input = '';

      // Send to Artie
      const res = await fetch('/api/artie/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage })
      });

      const { messageId } = await res.json();

      // Poll for response
      let attempts = 0;
      const poll = setInterval(async () => {
        const status = await fetch(`/api/artie/chat/${messageId}`);
        const data = await status.json();

        if (data.status === 'completed') {
          clearInterval(poll);
          this.messages.push({ role: 'artie', content: data.response });
        } else if (++attempts > 20) {
          clearInterval(poll);
          this.messages.push({ role: 'error', content: 'Timeout waiting for response' });
        }
      }, 1500);
    }
  }
};
</script>
```

---

## Content Suggestions

### Hero Section
**Headline:** "Coach Artie: The AI Assistant That Adapts"
**Subhead:** "28 capabilities. Self-optimizing. Always learning."
**CTA:** "Chat with Artie" / "Explore Capabilities"

### Feature Highlights
1. **Runtime Adaptation** - "I monitor my own resources and adjust my behavior to stay within budget"
2. **Hybrid Memory** - "I remember our conversations with semantic understanding, not just keyword matching"
3. **Multi-Channel** - "Reach me on Discord, SMS, Email, or API - I'm everywhere you need me"
4. **Cost Conscious** - "Automatic mode switching keeps costs predictable while maintaining quality"

### Technical Deep Dive Section
- Architecture diagram with explanations
- Capability registry system
- Context Alchemy algorithm
- Auto-optimization decision tree

### Latest Updates
Pull from CHANGELOG.md automatically:
```javascript
// Fetch latest version from CHANGELOG.md
const changelog = await fetch('/CHANGELOG.md');
const latest = parseChangelog(changelog)[0]; // Most recent version
displayVersion(latest);
```

---

## API Documentation for Website

### POST /api/artie/chat
```
Request:
{
  "message": string,
  "user_id": string (optional, defaults to "website-visitor")
}

Response:
{
  "success": true,
  "messageId": "uuid",
  "status": "pending",
  "jobUrl": "/chat/{messageId}"
}
```

### GET /api/artie/chat/:messageId
```
Response:
{
  "success": true,
  "messageId": "uuid",
  "status": "completed" | "processing" | "pending" | "failed",
  "response": string (when completed),
  "error": string (when failed),
  "processingTime": number (milliseconds)
}
```

### GET /api/artie/health
```
Response:
{
  "status": "healthy",
  "services": [
    { "name": "capabilities", "port": 47324, "healthy": true },
    { "name": "redis", "port": 47320, "healthy": true },
    ...
  ],
  "timestamp": "2025-10-26T12:34:56Z"
}
```

### GET /api/artie/capabilities
```
Response:
{
  "total": 28,
  "capabilities": [
    {
      "name": "model_manager",
      "description": "Query available models and get credit-aware recommendations",
      "actions": 4,
      "version": "1.0.0"
    },
    ...
  ]
}
```

---

## Future Enhancements

Ideas for v2 of the website:

1. **Live Conversation Feed** - Anonymized public conversations (with permission)
2. **Capability Voting** - Users vote on which capabilities to add next
3. **Usage Analytics** - Public dashboard showing usage patterns
4. **Model Comparison** - Visual comparison of FAST vs SMART vs MANAGER
5. **Credit Calculator** - Tool to estimate costs for different usage patterns
6. **Playground** - Interactive capability tester with live examples
7. **Documentation Search** - AI-powered search through all documentation
8. **Integration Guide** - Step-by-step guide to integrate Artie into your app

---

## Resources & Links

- **GitHub:** https://github.com/room302studio/coachartie2
- **Changelog:** `/CHANGELOG.md`
- **Version Guide:** `/VERSION_GUIDE.md`
- **Architecture Docs:** `/docs/architecture/`
- **API Docs:** `/docs/api/`

---

## Notes for Developers

- Artie runs on ports 47319-47327
- All services must be running for full functionality
- Redis is required for job queue
- SQLite database stores memories and state
- OpenRouter API key required for LLM access
- Secrets stored in `.env` (never commit!)

**Development URL:** http://localhost:47324
**Production URL:** https://api.coachartiebot.com (suggested)

---

**Generated:** 2025-10-26
**For:** coachartiebot.com website development
**Contact:** Room 302 Studio
