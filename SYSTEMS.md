# COACHARTIE SYSTEMS & FEATURES

> Complete documentation of every system, feature, and capability. Last updated: 2025-11-26

---

## What Coach Artie Does

### Autonomous Agent That Actually Ships

Artie thinks, acts, reflects, and keeps going until the job's done.

| Feature | What It Does |
|---------|--------------|
| **ReAct Loop** | LLM picks tools, runs them, checks results, decides next move. Up to 8 iterations per task. |
| **Circuit Breakers** | 5 failures on same capability = automatic stop. No infinite loops. |
| **120s Global Timeout** | Every task has a ceiling. Predictable costs, no zombies. |
| **Random Exploration Boost** | 50% chance to keep digging even when LLM thinks it's done. Finds the good stuff. |
| **Self-Reflection** | "Are you making progress?" injected each iteration. Keeps focus tight. |

### 39 Production Capabilities

| Category | Count | Examples |
|----------|-------|----------|
| **Core Tools** | 6 | Shell (Docker sandbox), Memory, Filesystem, HTTP, Web Search, Calculator |
| **Discord Native** | 7 | Channels, Forums, Threads, User History, UI Components, Send Message, Issue Parser |
| **External Services** | 7 | GitHub (full API), MCP Client, MediaWiki, LinkedIn, Wolfram Alpha, Email |
| **User Management** | 6 | Profiles, Goals, Todos, Mention Proxy, Credit Status, Model Manager |
| **System** | 8 | Environment, Runtime Config, Scheduler, System Monitor, Package Manager |
| **Communication** | 3 | Ask Question (multi-platform), Slack UI, Discord UI |
| **Persistence** | 2 | Variable Store (cross-session), Memory (semantic) |

### Memory System

| Feature | How |
|---------|-----|
| **Hybrid Data Layer** | In-memory Map (10k cap) + async SQLite. Zero-latency reads, durable writes. |
| **Semantic Auto-Tagging** | LLM generates tags in background. Find by meaning. |
| **User Indexing** | `Map<userId, Set<memoryId>>` for instant per-user recall. |
| **Importance Scoring** | 1-10 scale. Important stuff surfaces, noise fades. |
| **Cross-Session Persistence** | Remembers across conversations, days, weeks. |

### Context Alchemy

Smart token budgeting. Assembles the optimal prompt from multiple sources:

| Source | Priority | What It Adds |
|--------|----------|--------------|
| Current DateTime | Highest | Temporal awareness |
| Active User Goals | High | Goal-directed behavior |
| Relevant Memories | High | Personal context |
| Conversation History | Medium | Continuity |
| Available Capabilities | Medium | Tool awareness |
| User Profile | Medium | Preferences, linked accounts |
| Credit Warnings | Low | Cost awareness |
| UI Modality Rules | Low | Platform-specific formatting |

**Token Budget:** Reserves space for user message + system prompt, fills remaining with prioritized context.

### Multi-Platform, Single Brain

| Platform | Status | Special Features |
|----------|--------|------------------|
| **Discord** | Production | Buttons, selects, modals, threads, forums, reactions, streaming |
| **Slack** | Ready | Block Kit UI, threading, streaming |
| **IRC** | Production | forestpunks.com, reconnection logic |
| **SMS** | Production | Twilio, phone verification |
| **Email** | Ready | Webhook handler, needs deployment |

**Same AI personality, same capabilities, same memory** - just different interfaces.

### Production Hardening

| Feature | Implementation | Why |
|---------|----------------|-----|
| **Graceful Redis Fallback** | Works without Redis, logs warnings | No single point of failure |
| **Three-Tier Model Strategy** | Fast → Main → Fallback | Cost optimization + reliability |
| **Edit-Based Streaming** | Updates Discord messages in place | No spam, clean UX |
| **Message Chunking** | Auto-splits at 2000 chars | Never fails on long responses |
| **Job Monitoring Wheel** | Single poller for all jobs | Efficient, no race conditions |
| **Self-Healing** | Monitors processes, forces GC at 200MB | Stays healthy without restarts |
| **Prompt Hot-Reload** | Prompts from DB, no restart needed | Change behavior instantly |

### Unique Integrations

| Feature | What It Does |
|---------|--------------|
| **Forum → GitHub Sync** | `/sync-discussions` converts Discord forum threads to GitHub issues |
| **Mention Proxy** | Act as representative for offline users |
| **Observational Learning** | Passively learns from "watching" guilds |
| **GitHub URL Auto-Expand** | Pastes repo/issue info when GitHub links shared |
| **Phone/Email Linking** | Unified profile system, verify via SMS |
| **MCP Protocol Support** | Connect to Claude Desktop tools |

### Developer Experience

| Tool | Purpose |
|------|---------|
| **Prompt TUI** | `npm run prompts` - Interactive terminal editor |
| **Prompt CLI** | `npx ts-node tools/prompt-cli.ts` - Scriptable management |
| **Health Endpoints** | `/health`, `/ready`, `/live`, `/health/detailed` |
| **Structured Logging** | Winston + Grafana Loki |
| **Drizzle ORM** | Type-safe schema, single source of truth |

### By The Numbers

| Metric | Value |
|--------|-------|
| Total Capabilities | 39 |
| Database Tables | 18 |
| Platform Adapters | 5 (Discord, Slack, IRC, SMS, Email) |
| API Endpoints | 30+ |
| Lines of Code | ~40,000 |
| Max ReAct Iterations | 8 |
| Global Timeout | 120 seconds |
| Memory Hot Cache | 10,000 records |
| Concurrent Platforms | Unlimited |

### Design Philosophy

| Choice | Rationale |
|--------|-----------|
| LLM-native text ranking | Free with every inference call. Skip the embedding API. |
| Single ReAct loop | State emerges from conversation. Zero state machine code. |
| One universal prompt | Scales across models. Less maintenance. |
| LLM entity extraction | Handles edge cases regex can't. |
| Safety in main prompt | One LLM call, not two. |
| Autonomous tool ordering | LLM knows the task context. Let it choose. |

---

## 2025 Best Practices Audit

How Coach Artie compares to industry consensus from [Comet AI Agent Design](https://www.comet.com/site/blog/ai-agent-design/), [IBM ReAct Agents](https://www.ibm.com/think/topics/react-agent), [LangChain Context Engineering](https://blog.langchain.com/context-engineering-for-agents/), [OpenTelemetry AI Observability](https://opentelemetry.io/blog/2025/ai-agent-observability/), and [Cognition's Multi-Agent Warning](https://cognition.ai/blog/dont-build-multi-agents).

### We Follow Best Practices

| Practice | Industry Recommendation | Coach Artie Implementation |
|----------|------------------------|---------------------------|
| **ReAct Architecture** | "Thought → Action → Observation loop until solution" | Exactly this. `llm-loop-service.ts` implements classic ReAct. |
| **Single Agent + Tools** | "Can achieve similar accuracy to complex architectures at 50% lower cost" | One brain, 39 tools. No multi-agent overhead. |
| **Loop Termination** | "Max iterations + timeout to prevent runaway" | 8 max iterations, 120s global timeout, circuit breakers. |
| **Capable Models** | "ReAct benefits from highly capable models" | Three-tier strategy: Claude 3.5 Sonnet (main), Haiku (fast), GPT-4o-mini (fallback). |
| **Memory Architecture** | "Combine persistent memory with working memory" | Hybrid Data Layer (hot Map + cold SQLite) + conversation history in context. |
| **Context Engineering** | "Fill context window with just the right information" | Context Alchemy with 11 prioritized sources and token budgeting. |
| **Graceful Degradation** | "Hard caps with graceful fallbacks" | Redis goes down → bot keeps running. Context overflow → lower-priority items dropped. |
| **Tool Error Handling** | "Handle tool calls safely with error handling" | Try/catch on every capability, results added to context for LLM to reason about. |
| **Modular Design** | "Multi-agent systems are most effective when each agent has a specialized task" | We use modular capabilities instead of agents. Each capability is a specialist. |
| **Conversation History Blending** | "Retrieve relevant information from external knowledge base" | 70% current channel, 30% cross-channel (like human memory). |

### We Deviate From Conventional Wisdom

| Convention | Industry Says | What We Do | Why |
|------------|---------------|------------|-----|
| **Vector Embeddings for RAG** | "Use vector database for long-term memory" | Keyword search + LLM ranking | Embedding APIs cost money. LLMs rank text similarity for free during inference. Works fine for our scale. |
| **OpenTelemetry Standard** | "Use GenAI semantic conventions" | Winston + Grafana Loki | Simpler stack. We log prompts/responses, but not in OTel format. Trade-off: less tooling compatibility. |
| **Model-Aware Prompting** | "Different prompts for different model capabilities" | One universal prompt | One good prompt beats three mediocre ones. Less maintenance, fewer bugs. Models are smart enough. |
| **Separate Safety Layer** | "Validate outputs with guardrails" | Safety rules in main prompt | Extra LLM call per request is expensive. Main prompt handles safety. |
| **Plan-and-Execute for Complex Tasks** | "Use planning phase before execution" | Pure ReAct (no separate planning) | ReAct handles planning implicitly. Self-reflection prompts keep it on track. |
| **Structured Output Validation** | "Validate JSON schemas on outputs" | Trust LLM + retry on parse failure | Adds latency. LLMs rarely malform XML capability tags. Retry handles edge cases. |

### Unconventional Techniques (Our Innovations)

| Technique | Industry Status | Our Rationale |
|-----------|-----------------|---------------|
| **Random Exploration Boost** | Not standard. Most systems stop when LLM says done. | LLMs satisfice (stop at "good enough"). 50% chance to keep going finds better answers. Circuit breaker prevents runaway. |
| **Credit Awareness in Context** | Rare. Most systems don't tell the AI about costs. | Artie knows when he's running low. Adjusts behavior, suggests cheaper models. Self-preservation instinct. |
| **Reflection-Based Learning** | Industry uses automated test suites. We use experiential learning. | After each interaction: generate reflection → store with capability tags → retrieve for similar future queries. Learns from real usage, not synthetic benchmarks. |
| **In-Loop Self-Reflection** | Some systems do this. We inject it every iteration. | "Are you making progress? Are you repeating yourself?" keeps the ReAct loop focused and self-correcting. |
| **Observational Learning** | Unusual. Most bots only respond to direct messages. | Passive watching builds community knowledge without engagement fatigue. ~$0.0002/summary. |
| **Mention Proxy with Judgment** | Unique. Most bots don't represent offline users. | LLM judgment layer decides if user is actively chatting before interrupting. Social intelligence. |
| **Cross-Platform Identity** | Rare. Most bots are single-platform. | Same memory across Discord/Slack/SMS/Email. Users are people, not platform IDs. |

### Why We Skip Prompt Injection Defense

Industry consensus says "detect and block prompt injection attacks." We deliberately don't, for three reasons:

First, there's nothing worth stealing. Artie's memory contains meeting notes, project discussions, user preferences. No API keys, no bank details, no secrets. Everything interesting is already open source. An attacker's reward approaches zero.

Second, the sandbox contains the blast radius. Even if someone convinced Artie to run malicious code, he's in a Docker container with no access to host secrets. The laptop is a playground, not a vault.

Third, reflection beats regex. Instead of pattern-matching against known injection phrases (which attackers trivially evade), the conscience layer asks "should I do this?" every iteration. The safety manifest in `conscience.ts` blocks dangerous actions. Self-reflection prompts force genuine reasoning about whether an action is appropriate. You can't social-engineer around first principles the way you can around keyword filters.

The industry's prompt injection obsession assumes two things: you're protecting something valuable, and your LLM blindly executes input. Artie has neither problem. We'd rather serve real users well than cripple the experience defending against theoretical attackers with nothing to gain.

### Additional Systems Found During Audit

The original documentation missed about 50 systems. Here's what's actually in the codebase:

Monitoring & Observability

`llm-error-pattern-tracker.ts` learns from errors to prevent repeats. It maintains per-user and global error profiles, tracks which message patterns trigger failures, and can inject prevention strategies into future prompts.

`security-monitor.ts` watches for information leaks in LLM responses - system prompt exposure, debug info, internal reasoning chains. Logs incidents with severity levels and tracks patterns over time.

`credit-monitor.ts` tracks OpenRouter API credits in real-time. Alert thresholds at $5 (critical), $25 (warning), $50 (daily limit). Posts alerts to Discord. Artie knows when he's running low and adjusts behavior accordingly.

`usage-tracker.ts` logs token usage per model/user/message, calculates costs using the model pricing table, tracks response times and capability execution stats. Powers the /usage command.

`telemetry.ts` captures comprehensive Discord metrics: messages received/processed/failed, job states, response time distributions, unique users, guild counts, reconnection events.

Core Services

`prompt-manager.ts` enables hot-reloading prompts from the database without restart. 30-second cache, full version history for rollback, categories (system/capability/safety). Edit prompts at runtime via the TUI tool.

`meeting-service.ts` schedules meetings via natural language. Discord @mentions to attendees, timezone support from user preferences, automatic reminders via the scheduler.

`job-tracker.ts` monitors async job status across services. Polling-based completion detection, full lifecycle tracking (pending → processing → completed/failed), timeout handling. Discord and Slack use this to wait for capability responses.

`*-memory-entourage.ts` provides three retrieval strategies: keyword (fast text match), semantic (vector similarity), and combined. Retrieved memories get injected into context with configurable limits and relevance thresholds.

`mcp-process-manager.ts` spawns and manages Model Context Protocol server processes. Start, stop, restart, health monitoring. Enables external tool servers like Wikipedia and calculator MCPs.

`service-discovery.ts` lets services register their ports/hosts in Redis on startup. Other services query to find each other dynamically. Heartbeat pings every 30s, status tracking (starting/running/stopping). Enables the microservice architecture.

`user-profile.ts` stores profiles as Redis Hashes for fast read/write. Contact info (email, phone, github, reddit, linkedin, twitter), preferences (timezone, locale), plus any key-value pairs Artie discovers about users.

`scheduler.ts` handles cron-based job scheduling via BullMQ. Reminders, recurring tasks, timed notifications. Tracks job states, timezone-aware scheduling. Powers meeting reminders.

`llm-response-coordinator.ts` implements the three-tier model strategy (fast/smart/manager). Handles all LLM interactions with streaming support, integrates Context Alchemy, generates reflection memories post-interaction.

`openrouter-models.ts` fetches live model info from the OpenRouter API with 5-minute caching. Returns pricing, context lengths, architecture details.

`oauth-manager.ts` securely stores OAuth tokens in SQLite. Per-user, per-provider tokens with access/refresh tokens, expiry, and scopes. Supports GitHub, Google, etc.

`email-drafting-service.ts` provides a full drafting workflow: LLM-assisted draft creation, versioning for revisions, status tracking (draft/approved/sent/cancelled), intent detection from natural language.

`mediawiki-manager.ts` supports multiple wikis. Auto-discovers wikis from MEDIAWIKI_*_URL environment variables, manages authentication per wiki. Artie can read and edit wiki pages.

`conversation-state.ts` (Slack) tracks multi-turn conversations. Per-user state with 5-minute auto-timeout, concurrent conversation support, automatic cleanup of expired states.

`forum-traversal.ts` navigates Discord Forums programmatically. Lists forums in a guild, fetches threads with tags, reads all messages. Powers /sync-discussions.

Runtime Systems

`hybrid-data-layer.ts` uses an in-memory Map for zero-latency reads with async SQLite persistence. AsyncQueue serializes writes, 10k record cap with LRU eviction. Eliminates SQLite concurrency issues.

`simple-healer.ts` is a self-healing daemon that runs every 30 seconds. Forces garbage collection if heap exceeds 200MB, can restart dead MCP processes. Keeps the system healthy without manual intervention.

`embedded-mcp-runtime.ts` provides built-in Wikipedia search without needing an external MCP server. Direct REST API calls, serves as fallback when MCP processes fail.

`robust-capability-executor.ts` adds retry logic with exponential backoff, param cleaning/validation, structured error formatting for the LLM, and integration with the error pattern tracker.

`correlation.ts` enables request tracking across services via UUIDs. Short 8-char IDs for logs, maps Discord messages to correlation IDs for end-to-end tracing.

Additional Capabilities

`goal.ts` manages user goals with objectives, status (not_started/in_progress/completed), priority (1-10), and deadlines. Full CRUD operations, persisted in SQLite.

`todo.ts` handles todo lists with items that can link to goals. Status tracking, position ordering, multiple lists per user.

`system-monitor.ts` provides real-time system resources: memory, CPU, load average, disk, uptime. Service health checks with visual health meters in Discord. Artie can self-diagnose.

`model-manager.ts` queries available AI models with live pricing from OpenRouter. Cost-aware recommendations based on credit balance, model comparison by context length/speed/cost.

`package-manager.ts` enables safe npm operations within the workspace. Install, create, run scripts, check dependencies. Blocklist prevents dangerous packages (rimraf, shelljs, etc.).

`vector-embeddings.ts` uses OpenAI's text-embedding-3-small (1536 dimensions). Embeddings stored in SQLite with cosine similarity search. Falls back to keyword search if no API key.

Handlers

`reaction-handler.ts` enables two-way emoji reactions. The recycle emoji regenerates responses with a fresh LLM call, thumbs up/down collects feedback for quality tracking. 60-second deduplication cache.

`github-webhook.ts` processes repository events: push, release, PR opened/merged/closed. HMAC signature verification, can trigger wiki changelog updates.

`interaction-handler.ts` routes Discord interactions: slash commands, button clicks, select menus. Handles deferred replies for long operations.

`message-handler.ts` is the core routing logic (1400 lines). Detects @mentions, DMs, robot channels. Threading decisions, typing indicators, message chunking for long responses.

Slash Commands

/sync-discussions syncs Discord forum threads to GitHub issues, preserving tags and replies with progress updates.

/status shows the LLM model used for your last message: tokens, cost, response time, capabilities detected/executed.

/usage displays your AI usage stats by period (today/week/month/all time) with per-user cost tracking and token breakdown.

/memory lets you view and search stored memories by tags and time range.

/models lists available AI models with live pricing from OpenRouter.

/link-phone, /verify-phone, /unlink-phone manage SMS integration for cross-platform conversations.

/link-email, /unlink-email manage email integration for cross-platform identity.

/debug provides admin-only commands for memory stats, queue inspection, and service health.

/bot-status checks bot health: uptime, connected guilds, queue depth, Redis status, memory usage.

Support Utilities

`discord-formatter.ts` creates rich visual formatting: progress bars (blocks/dots/bars), status indicators, health meters, metric tables, box layouts.

`slack-formatter.ts` handles Slack Block Kit: sections, dividers, context blocks. Platform-specific presentation layer.

`conscience.ts` injects goal-aware whispers into context. Infers user energy level from message tone, uses a free model (phi-3) with 200ms timeout. Maintains a safety manifest with dangerous action blocklists.

`cost-monitor.ts` does session-level token tracking (separate from Credit Monitor). Configurable hourly limits ($10 default), max tokens per call (8000 default), logs stats every 5 minutes.

Database Schema

22 tables: memories, messages, prompts, prompt_history, queue, todos, todo_lists, todo_items, goals, user_identities, capabilities_config, global_variables, global_variables_history, config, logs, model_usage_stats, credit_balance, credit_alerts, oauth_tokens, meetings, meeting_participants, scheduled_reminders.

---

### The Verdict

Alignment score around 85%.

This codebase has 39 capabilities, 50+ services/utilities, 22 database tables, 12 slash commands, and 5 platform adapters. The original documentation captured maybe 30% of what's actually here.

We follow industry patterns (ReAct, single-agent, memory layers, context engineering, graceful degradation) and have comprehensive monitoring, cost tracking, self-healing, and security monitoring built in.

We deliberately skip prompt injection defense because there's nothing to steal, the sandbox contains any damage, and the reflection/conscience layer provides first-principles protection that's harder to fool than regex filters.

Biggest win: production-ready infrastructure that wasn't even documented.

---

## Unique Frameworks

### Artie's Laptop

Artie has a persistent Linux computer that survives across conversations.

```
┌─────────────────────────────────────────────────────────────┐
│  ARTIE'S LAPTOP (Docker Sandbox)                            │
│                                                             │
│  /workspace/              ← Persistent project directory    │
│  ├── cloned-repos/                                          │
│  ├── scripts/                                               │
│  └── output/                                                │
│                                                             │
│  Installed: git, gh (authenticated), npm, node, python3,    │
│            jq, curl, wget, ripgrep, fzf, vim                │
│                                                             │
│  tmux sessions persist between conversations                │
│  Can run long-running processes (servers, watchers)         │
└─────────────────────────────────────────────────────────────┘
```

**What this enables:**
- Clone a repo, make changes, push commits
- Run test suites and report results
- Build and deploy projects
- Process data files with Python/Node scripts
- Keep a dev server running while working on code

**Location:** `packages/capabilities/src/capabilities/shell.ts`

**Actions:**
| Action | Purpose |
|--------|---------|
| `exec` | One-shot command execution. Results returned. |
| `send` | Send command to persistent tmux session. |
| `read` | Read output from tmux pane. |
| `split` | Create new tmux pane for parallel work. |
| `list` | Show all sessions and panes. |

---

### Multiplayer Architecture

Same AI, multiple bodies. Artie exists simultaneously across platforms.

```
                    ┌──────────────────┐
     Discord ──────►│                  │
       Slack ──────►│   SHARED BRAIN   │◄────── Shared Memory
         IRC ──────►│   (capabilities) │◄────── Unified User Profiles
         SMS ──────►│                  │◄────── Same Personality
       Email ──────►│                  │
                    └──────────────────┘
```

**Cross-Platform Identity:**
```
User: ejfox
├── Discord: 123456789
├── Phone: +1-555-0123 (verified via SMS)
├── Email: ej@example.com
├── GitHub: ejfox (linked)
└── Slack: U0123ABC (same person)
```

**What this means:**
- Tell Artie something on Discord, he remembers it when you text him
- Link your GitHub account on Discord, he can use it on Slack
- One conversation can span platforms (start on Discord, continue via SMS)

**Linking commands:** `/link-phone`, `/link-email`, `/verify-phone`

**Location:** `packages/shared/src/services/user-profile.ts`

---

### Mention Proxy (Digital Representative)

Artie can speak for you when you're offline.

```
User: @ejfox what's the status of that PR?

┌─────────────────────────────────────────────────────────────┐
│  MENTION PROXY DECISION FLOW                                │
│                                                             │
│  1. Is @ejfox in an active conversation? (LLM judgment)     │
│     └── If yes: SKIP (don't interrupt)                      │
│                                                             │
│  2. Does this match ejfox's proxy rules?                    │
│     └── Trigger type: any_mention | questions_only | keywords│
│                                                             │
│  3. Response mode:                                          │
│     ├── direct: Respond naturally as representative         │
│     ├── announced: "Answering for @ejfox: ..."             │
│     └── assistant: "@ejfox isn't available, but I can help" │
└─────────────────────────────────────────────────────────────┘
```

**The Judgment Layer:**
Before responding, Artie uses a fast LLM call to determine if the mentioned user is actively in conversation. If they're chatting right now, Artie stays quiet.

**Location:** `packages/discord/src/services/mention-proxy-service.ts`

---

### Observational Learning

Artie passively watches Discord servers to learn community patterns.

```
┌─────────────────────────────────────────────────────────────┐
│  WATCHING MODE                                              │
│                                                             │
│  Guild Config:                                              │
│  ├── type: "working"  → Artie responds to messages          │
│  └── type: "watching" → Artie only observes (passive)       │
│                                                             │
│  Every 5 minutes:                                           │
│  1. Fetch new messages from watching guilds                 │
│  2. Filter bot messages (humans only)                       │
│  3. Summarize with FAST_MODEL (~$0.0002/summary)            │
│  4. Store as observational memory                           │
│                                                             │
│  Memory tag: "observation", "passive-learning"              │
└─────────────────────────────────────────────────────────────┘
```

**What Artie learns:**
- Community topics and interests
- Recurring questions (FAQ fodder)
- User behavior patterns
- Cultural norms and language

**Location:** `packages/discord/src/services/observational-learning.ts`

---

### Forum → GitHub Sync

Discord discussions become GitHub issues with one command.

```
/sync-discussions repo:myorg/myrepo

┌─────────────────────────────────────────────────────────────┐
│  SYNC FLOW                                                  │
│                                                             │
│  Discord Forum Thread         →    GitHub Issue             │
│  ├── Thread title             →    Issue title              │
│  ├── Starter message          →    Issue body               │
│  ├── Replies                  →    Quoted in body           │
│  ├── Forum tags               →    GitHub labels            │
│  └── Discord link             →    Reference in body        │
│                                                             │
│  Labels auto-detected: bug, feature, question, discussion   │
└─────────────────────────────────────────────────────────────┘
```

**Use case:** Community feedback in Discord → actionable issues in GitHub

**Location:** `packages/discord/src/commands/sync-discussions.ts`

---

### Reflection & Experiential Learning

Two-layer reflection system: real-time self-correction + post-interaction memory formation.

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: IN-LOOP SELF-REFLECTION (Real-time)               │
│                                                             │
│  Every ReAct iteration, inject:                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ [SELF-REFLECTION]                                   │    │
│  │ Iteration: 3/8, Time: 15s/120s                      │    │
│  │ Recent actions: memory:recall, web:search           │    │
│  │ User asked: "find me restaurants nearby"            │    │
│  │                                                     │    │
│  │ Take a moment: Are you making progress toward the   │    │
│  │ user's goal? Are you repeating yourself?            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Effect: LLM self-corrects, avoids loops, stays focused     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: POST-INTERACTION REFLECTION (Memory formation)    │
│                                                             │
│  After successful interaction:                              │
│                                                             │
│  1. autoStoreReflectionMemory() triggered                   │
│  2. LLM generates TWO reflections:                          │
│     ├── General: "User asked about food preferences..."    │
│     └── Capability: "Used memory:recall then web:search"   │
│  3. Store per-user with capability tags                     │
│  4. Future similar queries → retrieve what worked           │
│                                                             │
│  Example stored reflection:                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ tags: [capability-reflection, memory, web]          │    │
│  │ content: "For food preference queries, first check  │    │
│  │ memory for stored preferences, then search if none  │    │
│  │ found. User ejfox likes Thai food."                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**vs Industry "Continuous Evaluation":**
| Industry Approach | Our Approach |
|-------------------|--------------|
| Run automated test suites | Learn from real interactions |
| Score outputs against benchmarks | Generate reflections per-user |
| Detect regression via metrics | Retrieve what worked before |
| Synthetic test cases | Real usage patterns |

**Location:**
- `packages/capabilities/src/services/llm-loop-service.ts:240` (in-loop)
- `packages/capabilities/src/services/memory-orchestration.ts` (post-interaction)

---

### Random Exploration Boost

The ReAct loop has a 50% chance to keep exploring even when the LLM says it's done.

```typescript
// llm-loop-service.ts:340-345
if (!wantsLoop && iteration < 6) {
  const shouldRandomContinue = Math.random() < 0.5;
  if (shouldRandomContinue) {
    logger.info('🎲 Random exploration boost - continuing');
    wantsLoop = true;
  }
}
```

**Why this matters:**
- LLMs often stop too early (satisficing behavior)
- Random continuation finds useful info the LLM would have missed
- Self-reflection prompt injected: "Are you making progress? What could you explore further?"
- Circuit breaker (5 failures) prevents runaway exploration

---

### Context Alchemy

The brain's memory assembly system. Every message gets a custom-built context window optimized for that specific conversation.

```
┌─────────────────────────────────────────────────────────────┐
│  CONTEXT ALCHEMY PIPELINE                                   │
│                                                             │
│  1. CALCULATE TOKEN BUDGET                                  │
│     Total: 32,000 (configurable via CONTEXT_WINDOW_SIZE)    │
│     - Reserve 25% for response generation                   │
│     - Reserve space for user message + system prompt        │
│     - Remaining = available for context                     │
│                                                             │
│  2. ASSEMBLE CONTEXT SOURCES (in priority order)            │
│     ┌─────────────────────────────────────────────────┐     │
│     │ temporal_context     (pri:100) "Date: 2025-11-26"│     │
│     │ discord_situational  (pri:98)  "Server X, #chan" │     │
│     │ reply_context        (pri:97)  "Replying to @Y"  │     │
│     │ goal_whisper         (pri:95)  User's active goals│     │
│     │ credit_status        (pri:95)  "$12.50 remaining" │     │
│     │ channel_vibes        (pri:80)  Activity level     │     │
│     │ recent_channel_msgs  (pri:75)  Last 10 messages   │     │
│     │ recent_guild_msgs    (pri:70)  Cross-channel ctx  │     │
│     │ relevant_memories    (pri:60)  Semantic search    │     │
│     │ capability_manifest  (pri:50)  Available tools    │     │
│     │ discord_environment  (pri:40)  Connected servers  │     │
│     └─────────────────────────────────────────────────┘     │
│                                                             │
│  3. SELECT OPTIMAL CONTEXT                                  │
│     Fill available space by priority until budget exhausted │
│                                                             │
│  4. BLEND CONVERSATION HISTORY                              │
│     70% from current channel (immediate context)            │
│     30% from other channels (cross-context awareness)       │
│     ↳ Like human memory: mostly here, some from elsewhere   │
└─────────────────────────────────────────────────────────────┘
```

**Situational Awareness:**
```
📍 Discord server "Forest Punks" in #general
👤 Talking to: @ejfox
💬 Replying to @otheruser: "Can you help me with..."
🏷️ Mentions: @artie, @helper
```

**Credit Awareness:**
When funds are low, Artie knows it:
```
⚠️ Low credit balance: $12.50 remaining
💡 Consider using cheaper models for simple tasks
```

At critical levels (<$5), Artie gets dramatic: "I'm faddddingggg..."

**Location:** `packages/capabilities/src/services/context-alchemy.ts` (1309 lines)

---

### Redis Job Queue (BullMQ)

The nervous system. Every message flows through Redis queues for reliable async processing.

```
┌─────────────────────────────────────────────────────────────┐
│  MESSAGE FLOW THROUGH QUEUES                                │
│                                                             │
│  PLATFORM ADAPTERS                    CAPABILITIES          │
│  ┌─────────────┐                      ┌─────────────┐       │
│  │   Discord   │──┐                ┌──│  Consumer   │       │
│  │    Slack    │──┼── incoming ───►├──│  (Worker)   │       │
│  │     IRC     │──┤   -messages    │  └─────────────┘       │
│  │     SMS     │──┤                │         │              │
│  │    Email    │──┘                │         ▼              │
│  └─────────────┘                   │  ┌─────────────┐       │
│                                    │  │  ReAct Loop │       │
│                                    │  │   (Brain)   │       │
│                                    │  └─────────────┘       │
│                                    │         │              │
│  RESPONSE DELIVERY                 │         ▼              │
│  ┌─────────────┐                   │  discord-outgoing ◄────┘
│  │   Discord   │◄── discord  ◄────┤  slack-outgoing         │
│  │    Slack    │◄── slack    ◄────┤  irc-outgoing           │
│  │     IRC     │◄── irc      ◄────┤  sms-outgoing           │
│  │     SMS     │◄── sms      ◄────┘                         │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

**Queue Names:**
| Queue | Purpose |
|-------|---------|
| `incoming-messages` | All platforms → central processing |
| `discord-outgoing` | Responses → Discord |
| `slack-outgoing` | Responses → Slack |
| `irc-outgoing` | Responses → IRC |
| `sms-outgoing` | Responses → SMS |

**BullMQ Features We Use:**
```typescript
// Job options
{
  removeOnComplete: true,    // Clean up successful jobs
  removeOnFail: false,       // Keep failed for debugging
  attempts: 3,               // Retry up to 3 times
  backoff: {
    type: 'exponential',     // 2s, 4s, 8s...
    delay: 2000,
  },
}

// Worker concurrency
concurrency: 5  // Process 5 jobs in parallel
```

**Graceful Degradation:**
```
┌─────────────────────────────────────────────────────────────┐
│  REDIS UNAVAILABLE? NO PROBLEM.                             │
│                                                             │
│  1. testRedisConnection() fails on startup                  │
│  2. redisAvailable = false                                  │
│  3. Services continue with HTTP fallback                    │
│  4. Errors rate-limited (3 logs, then silence)              │
│  5. Auto-reconnect on Redis recovery                        │
│                                                             │
│  Result: Bot stays online even if Redis dies                │
└─────────────────────────────────────────────────────────────┘
```

**Location:** `packages/shared/src/utils/redis.ts`

---

### Two-Tier Capability Triage

Showing all 39 capabilities to the LLM causes choice overload. The model gets overwhelmed, claims it invoked a capability without actually doing it, or picks poorly.

The solution splits capability selection into two tiers. First, a fast cheap model (Gemini Flash tier) sees all capabilities and nominates 3-5 relevant ones with relevance scores. Then the smart model (Claude tier) sees only those nominated capabilities and makes better decisions with less noise.

Cost comparison: without triage, every message pays full smart-model price for the entire capability list. With triage, you pay about $0.00005 for the fast model plus reduced context for the smart model. The fast model's triage is usually under 100ms.

The system includes keyword heuristics to skip triage entirely for obvious cases. If the message contains "calculate" or "remind me in 5 minutes," no need to ask a model what capabilities might be relevant.

`packages/capabilities/src/services/capability-selector.ts`

---

### Stochastic Memory Fusion

Memory recall runs two strategies in parallel: semantic similarity (embeddings + cosine distance) and temporal patterns (time-based relevance). Results get fused together, but the fusion pattern is randomly selected each time from five options: layered, interleaved, comparative, synthesized, or temporal_flow.

The randomness prevents Artie from falling into predictable patterns when presenting remembered information. Sometimes memories appear as "Conceptual: X, Temporal: Y." Other times they flow as "From what I remember: X. This connects to Y."

Confidence gets boosted when both layers find the same memories (convergent validation). Token budget splits 60/40 favoring semantic search since conceptual connections matter more than recency for most queries.

`packages/capabilities/src/services/combined-memory-entourage.ts`

---

### Errors Designed for LLMs

Every capability error includes a copyable example the LLM can use to retry. Not "missing required parameter" but "missing required parameter, here's the exact XML you should have written."

Errors follow a taxonomy (PARAM_MISSING_001, ACTION_NOT_FOUND_005, etc.) with structured fields: what went wrong, what capability was attempted, what parameters were provided versus required, the correct format to copy, a recovery template with placeholders, and suggested alternatives with reasoning.

The philosophy: LLMs learn from examples faster than explanations. An error message that says "you need a query parameter" is less useful than one that shows `<capability name="memory" action="recall" query="your search here" />` ready to copy.

Two output formats exist: full (for debugging) and compact (for token efficiency). Both always include the copyable example.

`packages/capabilities/src/types/structured-errors.ts`

---

### Model-Aware Prompting

Different models need different instruction formats. Weak models (Mistral 7B, Phi-3, free tiers) can't reliably parse XML, so they get bold-text syntax: `**CALCULATE:** 42 * 42`. Medium models get simple XML tags: `<calculate>42 * 42</calculate>`. Strong models get the full capability syntax with attributes and nesting.

The prompter detects model tier from the model name and transforms capability instructions accordingly. When a model fails to produce the expected format, recovery prompts guide it back on track with the specific syntax that model understands.

This matters because the system routes different tasks to different model tiers for cost optimization. The consensus engine uses free models; triage uses fast models; final responses use smart models. Each needs instructions in its native format.

`packages/capabilities/src/utils/model-aware-prompter.ts`

---

## Table of Contents

1. [Capability Chaining](#capability-chaining)
2. [Message Lifecycle](#message-lifecycle)
3. [ReAct Loop](#react-loop)
4. [Capabilities (39 total)](#capabilities)
5. [Memory System](#memory-system)
6. [Context Alchemy](#context-alchemy)
7. [User Profiles](#user-profiles)
8. [Queue System](#queue-system)
9. [Database Schema](#database-schema)
10. [API Endpoints](#api-endpoints)
11. [Discord Integration](#discord-integration)
12. [Prompt System](#prompt-system)
13. [Environment Variables](#environment-variables)
14. [Deployment](#deployment)

---

## Capability Chaining

**There are THREE ways capabilities can share data:**

### 1. Implicit Result Forwarding (Within ReAct Loop)

When capabilities execute in the same ReAct loop, results are automatically available via mustache templates:

```
{{result}}      → Last capability's result
{{result_1}}    → First capability's result
{{result_2}}    → Second capability's result
{{memories}}    → Last memory capability result
{{content}}     → Alias for {{result}}
```

**Example Flow:**
```xml
<!-- Step 1: Search web -->
<capability name="web" action="search" query="weather in NYC" />

<!-- Step 2: Use result in memory (automatic substitution) -->
<capability name="memory" action="remember" content="Weather info: {{result}}" />
```

**Location:** `packages/capabilities/src/services/capability-executor.ts:312` - `substituteTemplateVariables()`

### 2. Global Variable Store (Persistent, Cross-Session)

Store results to named variables that persist in the database:

```xml
<!-- Store result to global variable using 'output' param -->
<capability name="web" action="search" query="AAPL stock price" output="stock_price" />

<!-- Later (even in different session), use the variable -->
<capability name="memory" action="remember" content="Stock was {{stock_price}}" />
```

**Auto-Storage:** Any capability with `output` param automatically stores its result:
```typescript
// In llm-loop-service.ts:195
const outputVar = processedCapability.params.output;
if (outputVar && result.success && result.data) {
  await globalStore.set(String(outputVar), result.data);
}
```

**Manual Storage:**
```xml
<capability name="variable-store" action="set" key="my_var" value="hello world" />
<capability name="variable-store" action="get" key="my_var" />
```

**Storage:** `global_variables` table in SQLite

### 3. Sequence Capability (Explicit Chaining)

Execute multiple capabilities in order with fail-fast behavior:

```xml
<capability name="sequence" action="execute" steps='[
  {"name": "web", "action": "search", "query": "latest news"},
  {"name": "memory", "action": "remember", "content": "News: {{result}}"},
  {"name": "discord-send-message", "action": "send", "channel": "123", "message": "Done!"}
]' />
```

**Note:** The `sequence` capability is somewhat redundant now that the ReAct loop handles iteration. The LLM naturally chains capabilities by requesting them one at a time.

### Substitution Order

When processing a capability, substitution happens in this order:

1. **Local Results** - `{{result}}`, `{{result_1}}`, `{{memories}}`
2. **Global Variables** - Any `{{variable_name}}` from database

```typescript
// capability-executor.ts:339-348
// First substitute local results
for (const [key, value] of substitutions) {
  processedContent = processedContent.replace(pattern, value);
}
// Then substitute global variables from database
processedContent = await globalStore.substitute(processedContent);
```

### Practical Example

```
User: "Get the weather and remind me about it tomorrow"

LLM Response (iteration 1):
<capability name="web" action="search" query="weather forecast" output="weather_data" />

[SYSTEM: web:search succeeded → "Sunny, 72°F, low chance of rain"]

LLM Response (iteration 2):
<capability name="scheduler" action="create"
  cron="0 9 * * *"
  message="Weather reminder: {{weather_data}}" />

[SYSTEM: scheduler:create succeeded → "Reminder set for 9 AM daily"]

LLM Response (iteration 3):
Done! I've checked the weather (Sunny, 72°F) and set up a daily reminder for 9 AM.
```

---

## Message Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MESSAGE LIFECYCLE                                  │
└─────────────────────────────────────────────────────────────────────────────┘

1. USER SENDS MESSAGE
   Discord/Slack/IRC/SMS → Platform Adapter

2. PLATFORM ADAPTER (packages/discord, slack, irc, sms)
   - Validates message (mentions, DMs, robot channels)
   - Builds context (guild, channel, attachments, user history)
   - Calls processUserIntent()

3. USER INTENT PROCESSOR (services/user-intent-processor.ts)
   - Submits job to capabilities service via HTTP POST /chat
   - Starts typing indicator
   - Begins job monitoring loop

4. CAPABILITIES SERVICE (packages/capabilities)
   - Receives job at /chat endpoint
   - Creates job in BullMQ queue
   - Returns messageId for polling

5. QUEUE CONSUMER (queues/consumer.ts)
   - Picks up job from queue
   - Calls capabilityOrchestrator.orchestrateMessage()

6. CAPABILITY ORCHESTRATOR (services/capability-orchestrator.ts)
   - contextAlchemy.buildMessageChain() → assembles LLM prompt
   - openRouterService.generateFromMessageChain() → initial LLM response
   - Extracts [LOOP] decision from response
   - If wantsLoop: enters ReAct loop via llmLoopService

7. REACT LOOP (services/llm-loop-service.ts)
   - Max 8 iterations, 120s timeout
   - Each iteration:
     a. Ask LLM "what next?"
     b. Extract <capability> tags from response
     c. Execute capabilities via capabilityExecutor
     d. Add system feedback to conversation
     e. Check if LLM wants to continue

8. RESPONSE DELIVERY
   - Job status updated in tracker
   - Platform adapter polls for completion
   - Edit-based streaming updates Discord message
   - Final response sent to user
```

---

## ReAct Loop

**Location:** `packages/capabilities/src/services/llm-loop-service.ts`

**Purpose:** Autonomous LLM-driven tool execution. The LLM decides what capabilities to use.

**Configuration:**
| Setting | Default | Env Var |
|---------|---------|---------|
| Max iterations | 8 | `EXPLORATION_MAX_ITERATIONS` |
| Min iterations | 1 | `EXPLORATION_MIN_ITERATIONS` |
| Global timeout | 120s | Hardcoded |
| Per-capability retries | 3 | Hardcoded |
| Circuit breaker threshold | 5 failures | Hardcoded |

**Flow:**
```
executeLLMDrivenLoop()
  ├── Build conversation history
  ├── FOR each iteration (max 8):
  │     ├── checkTimeout() → throw if > 120s
  │     ├── getLLMNextAction() → ask LLM what to do
  │     ├── capabilityParser.extractCapabilities() → find <capability> tags
  │     ├── IF no capabilities:
  │     │     ├── IF < minIterations: force continue
  │     │     ├── ELSE IF random(0.5) && < 6 iterations: random continue
  │     │     └── ELSE: return final response
  │     ├── FOR each capability:
  │     │     ├── Check circuit breaker (5 failures = skip)
  │     │     ├── substituteTemplateVariables()
  │     │     ├── robustExecutor.executeWithRetry()
  │     │     └── Add result to context
  │     └── Add self-reflection to conversation
  └── Return "completed available steps"
```

---

## Capabilities

**39 registered capabilities** in `packages/capabilities/src/capabilities/`

### Core Tools
| Capability | Actions | Description |
|------------|---------|-------------|
| `shell` | exec, send, read, split, list | Bash in Docker sandbox. Tmux sessions. |
| `memory` | remember, recall, forget, list, update | Persistent storage with semantic tags. |
| `filesystem` | read, write, create, list, delete, copy, move | File CRUD with permission checks. |
| `http` | GET, POST, PUT, DELETE | HTTP client for APIs. |
| `web` | search, fetch | DuckDuckGo search + HTML fetching. |
| `calculator` | evaluate | mathjs expression evaluation. |

### Discord Integration
| Capability | Actions | Description |
|------------|---------|-------------|
| `discord-channels` | get_recent, get_pinned, search | Query channel messages. |
| `discord-forums` | list_forums, get_threads, get_thread_messages | Forum traversal. |
| `discord-threads` | create, get_messages | Thread management. |
| `discord-user-history` | get_messages | User message history. |
| `discord-ui` | buttons, select, modal | Interactive UI components. |
| `discord-send-message` | send | Send to whitelisted channels. |
| `discord-issue-parser` | parse | Extract GitHub issue refs. |

### External Services
| Capability | Actions | Description |
|------------|---------|-------------|
| `github` | get_releases, get_commits, list_issues, create_issue, etc. | Full GitHub API. |
| `mcp-client` | list_tools, call_tool | Connect to MCP servers. |
| `embedded-mcp` | wikipedia, time, calculator | Built-in MCP tools. |
| `mediawiki` | get_page, edit_page, search | MediaWiki API. |
| `linkedin` | post, get_profile | LinkedIn integration. |
| `wolfram` | query | Wolfram Alpha API. |
| `email` | send, draft | Email via n8n/SMTP. |

### User Management
| Capability | Actions | Description |
|------------|---------|-------------|
| `user-profile` | get, update, link, unlink | Extensible profile system. |
| `goal` | create, update, list, complete | Goal tracking. |
| `todo` | create, update, list, complete | Todo management. |
| `mention-proxy` | create, list, delete | Act as user proxy. |
| `credit-status` | get, history | API credit monitoring. |

### System
| Capability | Actions | Description |
|------------|---------|-------------|
| `environment` | get, set, list, backup | Env var management. |
| `runtime-config` | get, set | Dynamic config adjustment. |
| `scheduler` | create, list, cancel | Cron tasks and reminders. |
| `system-monitor` | cpu, memory, disk, health | System metrics. |
| `system-installer` | install | Install Chrome, Git, etc. |
| `package-manager` | install, uninstall, list | npm package management. |
| `model-manager` | list, recommend | AI model info. |
| `variable-store` | get, set, list, delete | Global mustache variables. |

### Communication
| Capability | Actions | Description |
|------------|---------|-------------|
| `ask-question` | ask | Multi-choice questions with buttons. |
| `slack-ui` | buttons, select, modal | Slack Block Kit. |

### Notes
| Capability | Note |
|------------|------|
| `semantic-search` | Expensive embeddings, but useful as explicit tool for intentional vector search. |
| `sequence` | Explicit orchestration from management agents to subagents. Different purpose than ReAct exploration. |

---

## Memory System

**Location:** `packages/capabilities/src/capabilities/memory.ts`

**Architecture:**
```
MemoryService (singleton)
  └── HybridDataLayer
        ├── hotData: Map<id, MemoryRecord>  (in-memory, 10k cap)
        ├── userIndex: Map<userId, Set<id>> (fast user lookup)
        ├── writeQueue: AsyncQueue          (serialized writes)
        └── SQLite                          (persistent storage)
```

**Operations:**
| Action | Method | Description |
|--------|--------|-------------|
| `remember` | `MemoryService.remember()` | Store with auto-tags + async semantic tagging |
| `recall` | `MemoryService.recall()` | Keyword search via LIKE query |
| `recallByTags` | `MemoryService.recallByTags()` | Filter by specific tags |
| `forget` | `MemoryService.forget()` | Delete by ID |
| `update` | `MemoryService.update()` | Modify existing memory |

**Memory Record Schema:**
```typescript
interface MemoryRecord {
  id: number;           // Auto-increment
  user_id: string;      // Discord/Slack user ID
  content: string;      // The memory text
  tags: string;         // JSON array of tags
  context: string;      // Additional context
  timestamp: string;    // ISO timestamp
  importance: number;   // 1-10 scale
  metadata: string;     // JSON object
  embedding?: string;   // Vector embedding (optional)
  related_message_id?: string;
}
```

---

## Context Alchemy

**Location:** `packages/capabilities/src/services/context-alchemy.ts`

**Purpose:** Intelligent assembly of LLM context from multiple sources.

**Token Budget:**
```
Total Context Window (default 32k)
  ├── Reserved for User Message: ~2000 tokens
  ├── Reserved for System Prompt: ~4000 tokens
  └── Available for Context: ~26000 tokens
```

**Context Sources (by priority):**
1. **Temporal** - Current date/time
2. **Goals** - Active user goals
3. **Memories** - Relevant memories (keyword + semantic search)
4. **Capabilities** - Available tool list
5. **User State** - Profile, preferences, linked accounts
6. **Conversation History** - Recent messages (scaled by context size)
7. **UI Modality Rules** - Discord/Slack formatting guidelines
8. **Credit Warnings** - Low balance alerts

**Key Methods:**
- `buildMessageChain()` - Main entry point
- `assembleMessageContext()` - Gather all context sources
- `selectOptimalContext()` - Prioritize within token budget
- `calculateTokenBudget()` - Determine available space

---

## User Profiles

**Location:** `packages/shared/src/services/user-profile.ts`

**Storage:** Redis with 86400s TTL

**Profile Structure:**
```typescript
interface UserProfile {
  userId: string;
  contact: {
    email?: string;
    phone?: string;
    discord?: string;
    slack?: string;
  };
  preferences: {
    timezone?: string;
    language?: string;
    notifications?: boolean;
  };
  linkedServices: {
    github?: string;
    linkedin?: string;
    [service: string]: string;
  };
  metadata: Record<string, any>;
}
```

**Operations:**
- `getProfile(userId)` - Fetch profile from Redis
- `updateProfile(userId, data)` - Merge updates
- `linkEmail(userId, email)` - Add email
- `linkPhone(userId, phone)` - Add phone
- `linkService(userId, service, value)` - Link any service

---

## Queue System

**Location:** `packages/shared/src/utils/redis.ts`

**Technology:** BullMQ with Redis backend

**Queues:**
| Queue Name | Purpose |
|------------|---------|
| `incoming-messages` | Messages awaiting processing |
| `outgoing-messages` | Responses to send |
| `discord-incoming` | Discord-specific incoming |
| `discord-outgoing` | Discord-specific outgoing |
| `slack-incoming` | Slack-specific incoming |
| `slack-outgoing` | Slack-specific outgoing |
| `irc-incoming` | IRC-specific incoming |
| `irc-outgoing` | IRC-specific outgoing |
| `sms-incoming` | SMS-specific incoming |
| `sms-outgoing` | SMS-specific outgoing |

**Graceful Fallback:** Works without Redis (logs warnings, continues)

---

## Database Schema

**Location:** `packages/shared/src/db/schema.ts`

**Technology:** Drizzle ORM with better-sqlite3

**Tables:**
| Table | Purpose |
|-------|---------|
| `memories` | Persistent memory storage |
| `messages` | Chat history |
| `prompts` | System prompts |
| `prompt_history` | Prompt version history |
| `queue` | Job queue (fallback) |
| `todos` | Todo items |
| `todo_lists` | Todo list collections |
| `todo_items` | Individual todo items |
| `capabilities_config` | Capability settings |
| `global_variables` | Mustache template vars |
| `global_variables_history` | Var change history |
| `model_usage_stats` | LLM usage tracking |
| `credit_balance` | API credit tracking |
| `credit_alerts` | Low balance alerts |
| `oauth_tokens` | OAuth credentials |
| `meetings` | Scheduled meetings |
| `meeting_participants` | Meeting attendees |
| `meeting_reminders` | Meeting reminders |

---

## API Endpoints

### Capabilities Service (port 47324)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Basic health check |
| GET | `/health/detailed` | Full system status |
| GET | `/health/ready` | Readiness probe |
| GET | `/health/live` | Liveness probe |
| POST | `/chat` | Submit job for processing |
| GET | `/chat/:id` | Poll job status |
| DELETE | `/chat/:id` | Cancel job |
| GET | `/capabilities` | List all capabilities |
| POST | `/capabilities/test` | Test capability execution |
| GET | `/scheduler` | List scheduled tasks |
| POST | `/scheduler` | Create scheduled task |
| DELETE | `/scheduler/:id` | Cancel scheduled task |
| POST | `/github/webhook` | GitHub webhook handler |
| GET | `/api/memories` | Search memories |
| GET | `/api/models` | List available models |
| GET | `/logs` | View recent logs |
| GET | `/services` | Service discovery |

### Discord Service (port 47326/47327)

| Method | Path | Service | Description |
|--------|------|---------|-------------|
| GET | `/health` | Health (47326) | Health check |
| GET | `/ready` | Health (47326) | Readiness |
| GET | `/live` | Health (47326) | Liveness |
| GET | `/forums` | API (47327) | List forums |
| GET | `/forums/:id` | API (47327) | Forum details |
| GET | `/threads/:id` | API (47327) | Thread details |

### Brain Dashboard (port 47325)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | System status + metrics |
| GET | `/api/analytics` | Dynamic analytics queries |
| GET | `/api/memories` | Memory list |
| POST | `/api/memories` | Create memory |
| GET | `/api/memories/search` | Search memories |
| GET | `/api/messages` | Message list |
| GET | `/api/prompts` | Prompt list |
| GET | `/api/stats/*` | Various stats endpoints |

---

## Discord Integration

### Slash Commands
| Command | Description |
|---------|-------------|
| `/bot-status` | System health + stats |
| `/debug` | Diagnostics |
| `/link-email` | Link email address |
| `/link-phone` | Link phone number |
| `/unlink-email` | Remove email |
| `/unlink-phone` | Remove phone |
| `/verify-phone` | Verify SMS code |
| `/memory` | Search memories |
| `/models` | List AI models |
| `/status` | Last model used |
| `/usage` | Usage stats |
| `/sync-discussions` | Sync forum → GitHub |

### UI Components
| Type | Capability Tag |
|------|---------------|
| Buttons | `<capability name="discord-ui" action="buttons" data='[{"label":"Yes","style":"primary"}]' />` |
| Select Menu | `<capability name="discord-ui" action="select" data='{"placeholder":"Choose...","options":[...]}' />` |
| Modal | `<capability name="discord-ui" action="modal" data='{"title":"Form","inputs":[...]}' />` |

### Message Handling
- **Mentions:** Responds when @mentioned
- **DMs:** Always responds in direct messages
- **Robot Channels:** Channels containing "robot" in name
- **GitHub URLs:** Auto-expands to show repo/issue info
- **Streaming:** Edit-based updates (500ms throttle)
- **Chunking:** Splits messages > 2000 chars

---

## Prompt System

**Storage:** `prompts` table in SQLite

**Key Prompts:**
| Name | Purpose |
|------|---------|
| `system_prompt` | Main personality + rules |
| `capability_instructions` | Tool usage documentation |
| `discord_formatting` | Discord-specific formatting |
| `reality_anchor` | Grounding + accuracy rules |

**Management Tools:**
- `npm run prompts` - TUI editor (tools/prompt-tui.ts)
- `npx ts-node tools/prompt-cli.ts` - CLI tool

**Hot Reloading:** Prompts reload from DB on each request

---

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Discord bot token |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `DATABASE_PATH` | SQLite database path |

### Optional - Redis
| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | localhost | Redis host |
| `REDIS_PORT` | 6379 | Redis port |
| `REDIS_PASSWORD` | - | Redis password |

### Optional - Services
| Variable | Default | Description |
|----------|---------|-------------|
| `CAPABILITIES_URL` | http://localhost:47324 | Capabilities service URL |
| `BRAIN_PORT` | 47325 | Dashboard port |
| `DISCORD_PORT` | 47326 | Discord health port |

### Optional - LLM
| Variable | Default | Description |
|----------|---------|-------------|
| `MAIN_MODEL` | anthropic/claude-3.5-sonnet | Primary model |
| `FAST_MODEL` | anthropic/claude-3-haiku | Fast/cheap model |
| `FALLBACK_MODEL` | openai/gpt-4o-mini | Backup model |
| `CONTEXT_WINDOW_SIZE` | 32000 | Context window tokens |
| `EXPLORATION_MAX_ITERATIONS` | 8 | Max ReAct loops |

### Optional - External
| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub API token |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth |
| `TWILIO_PHONE_NUMBER` | Twilio phone |
| `WOLFRAM_APP_ID` | Wolfram Alpha API |
| `OPENAI_API_KEY` | OpenAI (for embeddings) |
| `LOKI_URL` | Grafana Loki endpoint |

---

## Deployment

### Services (docker-compose)
| Service | Port | Description |
|---------|------|-------------|
| capabilities | 47324 | Core AI processing |
| discord | 47326/47327 | Discord bot |
| brain | 47325 | Dashboard |
| irc | 47328 | IRC bot |
| sms | 47329 | SMS adapter |
| sandbox | - | Docker-in-Docker for shell |
| redis | 6379 | Queue backend |

### Commands
```bash
# Development
npm run dev              # Start all services
npm run prompts          # Prompt editor TUI

# Production
./scripts/deploy.sh      # Deploy to VPS
./scripts/rebuild.sh     # Rebuild Docker images
./scripts/health-check.sh # Check system health

# Database
pnpm db:generate         # Generate Drizzle migrations
pnpm db:migrate          # Apply migrations
```

### Health Checks
- `/health` - Basic alive check
- `/health/ready` - Ready to accept traffic
- `/health/live` - Application running
- `/health/detailed` - Full metrics (Redis, DB, queue sizes)

---

*This document is the authoritative reference for all Coach Artie systems and features.*
