# COACHARTIE FILE INDEX

> 222 files | Tweet-length descriptions | Updated: 2025-11-26

Legend:
- [x] Documented
- [D] DELETE candidate
- [?] Needs investigation

---

## mcp-servers/ (2 files)

- [x] `mcp-servers/custom/ascii-art-generator/src/index.ts` - MCP server generating ASCII art including banners, boxes, shapes, text effects, and random patterns
- [x] `mcp-servers/time/index.ts` - Simple MCP server providing time-related tools (current time, timestamp, date parsing)

---

## packages/brain/ (23 files)

**Purpose:** Nuxt 3 dashboard for monitoring bot activity. Visualizes memories, messages, queues with t-SNE/UMAP plots. Read-only admin tool running on port 47325.

### Config
- [x] `app.config.ts` - Nuxt UI defaults: gray ghost buttons, dynamic icons. 14 lines.
- [x] `nuxt.config.ts` - SPA mode, port 47325, Figtree font, SQLite excluded from Vite bundle. Uses @vueuse/nuxt.
- [x] `database.types.ts` - Supabase-generated types for 8 tables: config, logs, memories, messages, prompts, queue, todos, user_identities. Includes DB functions like match_memories, get_next_task. 549 lines of types.

### Composables
- [x] `composables/useClustering.ts` - K-means clustering via Turf.js. Takes embedding array, returns clusterMap with point-to-cluster assignments. 36 lines.
- [D] `composables/useDatabase.ts` - DEAD CODE. Mock Supabase returning empty arrays. Comment says "should be replaced". 63 lines of nothing.
- [D] `composables/useSupabaseClient.ts` - DEAD CODE. Another mock placeholder. 23 lines returning nulls.
- [x] `composables/useTsne.ts` - t-SNE via tsne-js library. Extracts embeddings, runs reduction, normalizes coordinates to [0,1]. Heavy logging (313 lines). Exposes initialize(), start(), stop(), reset(), coordinates ref.
- [x] `composables/useUmap.ts` - UMAP via umap-js. Uses requestAnimationFrame for animated stepping. 52 lines. Returns embeddingPositions ref.

### Lib
- [D] `lib/database.ts` - DEPRECATED 910-line SQLite adapter. BrainDatabaseAdapter class with CRUD for all 8 tables. Creates brain_* tables with FTS5 search, triggers, indexes. REPLACED BY DRIZZLE - shared/db/schema.ts is source of truth now.

### API Routes
- [x] `server/api/analytics.get.ts` - Dynamic query builder with SQL injection protection. Whitelist: messages/memories/meetings tables. Supports groupBy, aggregates (count/sum/avg/min/max), timeRange filters. 170 lines.
- [x] `server/api/memories.get.ts` - Simple Drizzle query: `SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?`. 48 lines.
- [x] `server/api/memories.post.ts` - Insert memory with content, userId, tags, context, importance, timestamp. 42 lines.
- [x] `server/api/memories/search.get.ts` - LIKE search on content field. Params: q (required), user_id, limit, min_importance. No FTS5. 72 lines.
- [x] `server/api/messages.get.ts` - Drizzle query for messages with selective columns. 56 lines.
- [x] `server/api/prompts.get.ts` - Fetches prompts + joins promptHistory table. Parses metadata JSON for archived flag. Returns formatted history array. 79 lines.
- [x] `server/api/stats/memory-topics.get.ts` - Heavy analytics: tag frequency parsing, importance distribution, top users by memory count, recent high-importance memories. 160 lines.
- [x] `server/api/stats/memory-users.get.ts` - GROUP BY user_id with count/max/min. Time range filter. 65 lines.
- [x] `server/api/stats/top-users.get.ts` - Top message senders. Can exclude Artie. Time range filter. 80 lines.
- [x] `server/api/stats/user-activity.get.ts` - Per-user dashboard: message/memory/meeting counts, first/last activity, top channels. 148 lines.
- [x] `server/api/status.ts` - Main status endpoint. Counts all tables, builds 24-hour time series, memory age distribution (today/1-7d/1-4w/3+mo). 259 lines.
- [D] `server/api/test-db.get.ts` - DEBUG ONLY. Delete before prod.
- [D] `server/api/test-query.get.ts` - DEBUG ONLY. Delete before prod.

---

## packages/capabilities/ (90 files)

**Purpose:** The heart of Coach Artie. 40+ tools in a ReAct loop. LLM picks capabilities, executes, iterates. Max 8 loops, 120s timeout.

### Entry Points
- [x] `src/index.ts` - Express server on dynamic port. Routes: /health, /chat, /capabilities, /scheduler, /github, /services, /api/memories, /api/models, /logs. Starts queue workers, scheduler, simple healer. Graceful shutdown cleans up all services. 306 lines.
- [x] `src/mcp-index.ts` - Standalone MCP server entry for Claude Desktop integration.
- [x] `src/mcp-server.ts` - MCP server with SSE/HTTP transport. Exposes capabilities as MCP tools.

### Capabilities (39 files)

**Core Tools:**
- [x] `capabilities/shell.ts` - **THE BIG ONE.** Executes bash in sandboxed Debian Docker container. Actions: exec (one-shot), send/read/split/list (persistent tmux sessions). Uses marked for markdown code extraction. Handles heredocs, environment variables. 547 lines.
- [x] `capabilities/memory.ts` - Persistent storage via HybridDataLayer. remember() stores with auto-tags + semantic tagging. recall() searches by keyword. recallByTags() for filtered retrieval. Uses instant hot cache + async SQLite persistence.
- [x] `capabilities/github.ts` - 11 actions: get_releases, get_recent_commits, get_deployment_stats, search_repositories, list_issues, search_issues, create_issue, update_issue, get_issues_by_label, get_issue_details, get_related_prs. Uses GITHUB_TOKEN.
- [x] `capabilities/filesystem.ts` - CRUD for files. Actions: read_file, write_file, create_directory, list_directory, delete, exists, copy, move. Absolute paths only. Permission checks.
- [x] `capabilities/http.ts` - GET/POST/PUT/DELETE. 106 lines. Minimal cruft.
- [x] `capabilities/web.ts` - DuckDuckGo search + HTML content fetching. Handles current events.

**Discord Integration:**
- [x] `capabilities/discord-channels.ts` - Fetch recent/pinned messages, search in channels.
- [x] `capabilities/discord-forums.ts` - Traverse forums, read discussions, sync to GitHub issues.
- [x] `capabilities/discord-threads.ts` - Create threads, get thread messages.
- [x] `capabilities/discord-user-history.ts` - Query user message history in channels.
- [x] `capabilities/discord-ui.ts` - Discord.js buttons, select menus, modals.
- [x] `capabilities/discord-send-message.ts` - Send to whitelisted channels only.
- [x] `capabilities/discord-issue-parser.ts` - Parse #123 GitHub issue references.

**Communication:**
- [x] `capabilities/ask-question.ts` - Multi-choice questions with buttons/selects. Works Discord & Slack.
- [x] `capabilities/email.ts` - Send via n8n webhook, MailDev, or SMTP.
- [x] `capabilities/slack-ui.ts` - Slack Block Kit: modals, buttons, menus.

**External Services:**
- [x] `capabilities/mcp-client.ts` - Connect to MCP servers (HTTP/stdio). JSON-RPC tool calls. 881 lines.
- [x] `capabilities/embedded-mcp.ts` - Built-in MCP tools (Wikipedia, time, calc) - zero deps.
- [x] `capabilities/mediawiki.ts` - Read/write MediaWiki pages.
- [x] `capabilities/linkedin.ts` - OAuth + autonomous posting.
- [x] `capabilities/wolfram.ts` - Wolfram Alpha for computation/finance.

**System:**
- [x] `capabilities/calculator.ts` - mathjs expression evaluation.
- [x] `capabilities/environment.ts` - Env var CRUD with backup.
- [x] `capabilities/system-installer.ts` - Install Chrome, Git, Docker, Node.
- [x] `capabilities/system-monitor.ts` - CPU, memory, disk, service health.
- [x] `capabilities/package-manager.ts` - npm package management.
- [x] `capabilities/runtime-config.ts` - Dynamic model/context adjustment.
- [x] `capabilities/scheduler.ts` - Cron reminders and recurring tasks.

**User State:**
- [x] `capabilities/user-profile.ts` - Extensible profile linking any service.
- [x] `capabilities/goal.ts` - Track user goals with priority/deadline.
- [x] `capabilities/todo.ts` - Todo list management.
- [x] `capabilities/mention-proxy.ts` - Act as representative for offline users.
- [x] `capabilities/variable-store.ts` - Global vars for mustache templates.
- [x] `capabilities/credit-status.ts` - API credit monitoring.
- [x] `capabilities/model-manager.ts` - Model pricing/recommendations.

**Notes:**
- [x] `capabilities/semantic-search.ts` - Vector embeddings. Kept as explicit tool for intentional similarity search.
- [x] `capabilities/sequence.ts` - Explicit orchestration from management agents to subagents.

### Services (36 files)

**Core Orchestration:**
- [x] `services/capability-orchestrator.ts` - **GOSPEL ENTRY POINT.** orchestrateMessage() → createContext → assembleMessageOrchestration. Checks for email drafts first. Gets initial LLM response, extracts [LOOP] decision. If wantsLoop, enters ReAct loop via llmLoopService. Stores reflection memory. 302 lines.
- [x] `services/capability-registry.ts` - **PLUGIN SYSTEM.** Map<name, RegisteredCapability>. register() validates, get() checks action support, execute() runs handler. generateInstructions() builds capability list for LLM. Auto-registers 16 capabilities at bottom of file. 696 lines.
- [x] `services/llm-loop-service.ts` - **ReAct LOOP.** executeLLMDrivenLoop() iterates max 8 times with 120s global timeout. Each iteration: getLLMNextAction() → extract capabilities → execute → add system feedback. Circuit breaker after 5 failures per capability. 50% random continuation chance. 349 lines.
- [x] `services/context-alchemy.ts` - **INTELLIGENT CONTEXT BUILDING.** buildMessageChain() gathers context from multiple sources, prioritizes by relevance, manages token budget. Includes UI modality rules (Discord/Slack formatting), credit warnings, user goals, conversation history. 1309 lines.
- [x] `services/llm-response-coordinator.ts` - Three-tier model strategy. extractLoopDecision() finds [LOOP] tag. truncateConversationHistory(). stripThinkingTags() for security.

**Execution:**
- [x] `services/capability-executor.ts` - Streaming execution with error recovery. substituteTemplateVariables().
- [x] `services/capability-parser.ts` - XML extraction via fast-xml-parser. Generates helpful error messages.
- [x] `services/capability-bootstrap.ts` - Initializes registry with all capabilities on startup.
- [x] `services/capability-selector.ts` - Two-tier triage fallback. Used when DB prompts not found.

**LLM & API:**
- [x] `services/openrouter.ts` - OpenRouter client. generateFromMessageChain(), three-tier models (fast/main/fallback), streaming support.
- [x] `services/openrouter-models.ts` - Live model info with 5-min cache. Pricing, context sizes.
- [x] `services/prompt-manager.ts` - Loads prompts from DB with hot-reload. getCapabilityInstructions().
- [x] `services/cost-monitor.ts` - Tracks usage, alerts on limits, prevents runaway spending.
- [x] `services/credit-monitor.ts` - API credit balance alerts.
- [x] `services/usage-tracker.ts` - Records model usage stats and costs.
- [?] `services/conscience.ts` - Safety LLM review per capability. EXTRA CALL. Just put rules in prompt?

**Memory:**
- [x] `services/combined-memory-entourage.ts` - Multi-layered recall: semantic + temporal.
- [x] `services/temporal-memory-entourage.ts` - Time-aware search prioritizing recency.
- [?] `services/semantic-memory-entourage.ts` - OpenAI vector search. EXPENSIVE.
- [x] `services/memory-entourage-interface.ts` - Interface contract for memory recall.
- [x] `services/memory-orchestration.ts` - Auto-stores reflection memories.
- [?] `services/vector-embeddings.ts` - text-embedding-3-small. LLM can rank text.
- [?] `services/llm-error-pattern-tracker.ts` - Learns from errors. Over-engineered?

**External:**
- [x] `services/email-drafting-service.ts` - AI email drafting with revision loop.
- [x] `services/mediawiki-client.ts` - MediaWiki API client.
- [x] `services/mediawiki-manager.ts` - Multiple wiki connections.
- [x] `services/meeting-service.ts` - Meeting scheduling.
- [x] `services/oauth-manager.ts` - OAuth token storage.
- [x] `services/wolfram.ts` - Wolfram Alpha client.
- [x] `services/mcp-process-manager.ts` - MCP server lifecycle.

**Monitoring:**
- [x] `services/job-tracker.ts` - Job state, results, Discord badges.
- [x] `services/observation-handler.ts` - Passive Discord observation.
- [x] `services/security-monitor.ts` - Detects info disclosure.
- [x] `services/scheduler.ts` - BullMQ task scheduler.
- [x] `services/database.ts` - Re-exports DB instance.

### Handlers
- [x] `handlers/github-webhook.ts` - Handles GitHub webhook events for push, release, PR with wiki updates
- [x] `handlers/process-message.ts` - Processes incoming messages with capability orchestration, job tracking

### Middleware
- [x] `middleware/rate-limiter.ts` - In-memory rate limiting middleware with configurable requests/window

### Queues
- [x] `queues/consumer.ts` - BullMQ worker consuming messages, executing capabilities, with global timeout
- [x] `queues/publisher.ts` - Publishes messages to queue with Discord-specific context for processing

### Routes
- [x] `routes/api.ts` - FastifyPluginAsync for memories, messages, stats, and error analytics
- [x] `routes/capabilities.ts` - Express router for listing capabilities, testing execution, health checks
- [x] `routes/chat.ts` - Chat endpoint with job tracking, result polling, cancellation, rate limiting
- [x] `routes/github.ts` - Express router for GitHub webhook endpoint with signature verification
- [x] `routes/health.ts` - Health check routes (basic, detailed, ready, live) with Redis, database metrics
- [x] `routes/logs.ts` - Logs management with in-memory storage, Docker integration, cleanup, search
- [x] `routes/memories.ts` - Memories endpoint supporting search and retrieval via capability registry
- [x] `routes/models.ts` - Models endpoint exposing active models from OpenRouter with metadata
- [x] `routes/scheduler.ts` - Scheduler management endpoints for creating, listing, canceling tasks
- [x] `routes/security.ts` - Security monitoring routes for incident tracking, pattern analysis
- [x] `routes/services.ts` - Service discovery routes listing available services and their URLs

### Runtime
- [x] `runtime/embedded-mcp-runtime.ts` - Built-in MCP tools (Wikipedia, time, calc). Zero external deps.
- [x] `runtime/hybrid-data-layer.ts` - **PERFORMANCE CRITICAL.** HotData Map (10k cap) + userIndex + AsyncQueue for serialized writes. Eliminates SQLite concurrency bottlenecks. 30s background sync. storeMemory() instant return. searchMemories() keyword+LIKE query.
- [x] `runtime/simple-healer.ts` - 30s interval. Forces GC if heap > 200MB. Can restart Wikipedia MCP. 60 lines.

### Types
- [x] `types/orchestration-types.ts` - Type definitions for orchestration context, capabilities, results
- [x] `types/structured-errors.ts` - Structured error types and helpers for LLM-friendly error messages

### Utils
- [x] `utils/context-alchemy-debugger.ts` - Debugging tool for Context Alchemy with session tracking, budgets
- [x] `utils/discord-formatter.ts` - Discord formatting utilities for progress bars, status, alerts, dashboards
- [x] `utils/error-utils.ts` - Error handling utilities for extracting messages, stacks, formatting errors
- [?] `utils/model-aware-prompter.ts` - Model-specific prompt generation. ONE GOOD PROMPT BEATS THREE.
- [x] `utils/robust-capability-executor.ts` - Capability executor with retry logic, fallback strategies
- [x] `utils/slack-formatter.ts` - Slack mrkdwn formatting utilities for messages, alerts, code blocks
- [x] `utils/web-fetch.ts` - Web content fetcher with security validation, HTML parsing, DuckDuckGo search
- [x] `utils/xml-parser.ts` - XML parser for capability tags supporting multiple formats with attributes

### Tests
- [x] `src/test-capability-selector.ts` - Test file for capability selector
- [x] `src/test/mcp-client.test.ts` - MCP client unit tests
- [x] `src/test/xml-parser.test.ts` - XML parser unit tests
- [x] `tests/atomic/action-alias-mapper.test.ts` - Action alias mapper tests
- [x] `tests/atomic/error-message-builder.test.ts` - Error message builder tests
- [x] `tests/atomic/string-similarity.test.ts` - String similarity tests
- [x] `tests/atomic/template-substitution.test.ts` - Template substitution tests
- [x] `tests/atomic/variable-context-builder.test.ts` - Variable context builder tests
- [x] `tests/capability-orchestrator.test.ts` - Capability orchestrator tests
- [x] `tests/conscience.test.ts` - Conscience service tests
- [x] `tests/memory.test.ts` - Memory capability tests
- [x] `tests/template-substitution.test.ts` - Template substitution tests

---

## packages/discord/ (45 files)

**Purpose:** Discord bot. Handles messages, slash commands, reactions, buttons, menus. Routes to capabilities service for AI processing.

### Root
- [x] `features/messageHandler.ts` - Legacy message handler, validates and routes requests.
- [x] `logger.ts` - Winston + Grafana Loki structured logging.
- [x] `register-commands.ts` - REST API to register slash commands with Discord.
- [x] `src/index.ts` - **BOT ENTRY POINT.** Client with 6 intents (Guilds, Messages, Content, DMs, Integrations, Reactions). Events: ready, interactionCreate, messageCreate, messageReactionAdd. Starts healthServer (47326), apiServer (47327), jobMonitor. Initializes forum traversal, GitHub integration, mention proxy, observational learning. writeStatus() saves to JSON. 250 lines.
- [x] `types/errors.ts` - Custom error classes for capabilities, Discord, queue.

### Commands (12 files)
- [x] `commands/bot-status.ts` - /bot-status: Health, user stats, system status with embeds.
- [x] `commands/debug.ts` - /debug: Connection test, performance, caps check, diagnostics.
- [x] `commands/link-email.ts` - /link-email: Validates email, stores via user profile capability.
- [x] `commands/link-phone.ts` - /link-phone: SMS verification code generation.
- [x] `commands/memory.ts` - /memory: Search memories, show recent, display stats.
- [x] `commands/models.ts` - /models: List AI models with pricing, context, capabilities.
- [x] `commands/status.ts` - /status: Shows LLM model used for user's most recent message.
- [x] `commands/sync-discussions.ts` - /sync-discussions: Sync forum threads to GitHub issues. Required arg: repo (owner/repo). 210 lines.
- [x] `commands/unlink-email.ts` - /unlink-email: Remove linked email.
- [x] `commands/unlink-phone.ts` - /unlink-phone: Remove linked phone.
- [x] `commands/usage.ts` - /usage: Show user's API usage stats.
- [x] `commands/verify-phone.ts` - /verify-phone: Verify SMS code to complete phone linking.

### Config
- [x] `config/guild-whitelist.ts` - Whitelisted guild IDs, working/watching guild types
- [x] `config/mention-proxy.ts` - Mention proxy rule interface with response modes and triggers

### Handlers
- [x] `handlers/interaction-handler.ts` - **SLASH COMMANDS.** Map of 12 commands (link-*, verify-*, unlink-*, status, bot-status, models, memory, usage, debug, sync-discussions). handleSlashCommand() with correlation tracking. Buttons → processUserIntent(). 200 lines.
- [x] `handlers/message-handler.ts` - **CORE MESSAGE ROUTING.** Detects @mentions, DMs, robot channels. GitHub URL auto-expansion. Builds Discord context (guild, channel, mentions, attachments). Routes to processUserIntent(). Handles message chunking (2000 char limit). 1400 lines.
- [x] `handlers/reaction-handler.ts` - Regenerate (🔄), positive (👍), negative (👎) feedback tracking.

### Queues
- [x] `queues/consumer.ts` - BullMQ worker for outgoing Discord messages.
- [x] `queues/outgoing-consumer.ts` - Async message sender with error handling.
- [x] `queues/publisher.ts` - Publishes incoming messages to capabilities queue.

### Routes
- [x] `routes/api.ts` - GET /forums, /forums/:id, /threads/:id for forum access.
- [x] `routes/mention-proxy.ts` - CRUD for mention proxy rules.

### Services
- [x] `services/api-server.ts` - Express on 47327 for forum API.
- [x] `services/capabilities-client.ts` - **HTTP CLIENT TO CAPABILITIES.** submitJob() → POST /chat. checkJobStatus() → GET /chat/:id. cancelJob() → DELETE /chat/:id. 150 lines.
- [x] `services/forum-traversal.ts` - getForumSummary(), getThreadDetails() for forum/thread data.
- [x] `services/github-integration.ts` - parseRepoReference(), syncThreadsToGitHub(), formatThreadAsIssue(). 1033 lines.
- [x] `services/health-server.ts` - Express on 47326 for /health, /ready, /live.
- [x] `services/job-monitor.ts` - **THE WHEEL.** monitorJob() with callbacks (onProgress, onComplete, onError). Polls every 3s. Handles streaming, status updates, capability emojis.
- [x] `services/mention-proxy-service.ts` - Proxy rules: act as user for offline mentions.
- [x] `services/observational-learning.ts` - Scheduled passive learning from "watching" guilds.
- [x] `services/telemetry.ts` - Metrics: jobs, commands, messages. Persists to JSON.
- [x] `services/user-intent-processor.ts` - **UNIFIED UX.** processUserIntent() handles all interaction types. Edit-based streaming (no spam). 500ms min between edits. shouldCreateThread() for long requests. capabilitiesClient.submitJob() → jobMonitor.monitorJob(). 587 lines.

### Utils
- [x] `utils/correlation.ts` - Generates and tracks correlation IDs for request tracing
- [x] `utils/email-lookup.ts` - Links/unlinks user emails via unified profile system
- [x] `utils/path-resolver.ts` - Bulletproof path resolver for Docker and local development
- [x] `utils/phone-lookup.ts` - Links/unlinks user phones via unified profile system

### Tests
- [x] `tests/discussion-sync.test.ts` - Tests for discussion sync functionality
- [x] `tests/status.spec.ts` - Status command tests

---

## packages/email/ (6 files) - KEEP (future platform)

**Purpose:** Future email platform adapter. Ready for deployment when needed. Requires Dockerfile and docker-compose entry.

- [x] `src/handlers/incoming-email.ts` - Generic email webhook handler.
- [x] `src/index.ts` - Email service entry point. Needs Dockerfile.
- [x] `src/queues/consumer.ts` - Email response consumer.
- [x] `src/routes/email.ts` - Email webhook routes.
- [x] `src/routes/health.ts` - Health check endpoint.
- [x] `src/utils/email.ts` - Email utilities.

---

## packages/irc/ (4 files)

**Purpose:** IRC bot for forestpunks.com. Handles IRC quirks, reconnection logic. Deployed in docker-compose.

- [x] `src/handlers/incoming-message.ts` - IRC message handler with dedup and mention detection.
- [x] `src/index.ts` - IRC bot entry, irc-framework client, queue consumer, health server.
- [x] `src/queues/consumer.ts` - IRC response consumer, chunked messages.
- [x] `src/queues/publisher.ts` - Publishes incoming IRC messages to capabilities queue.

---

## packages/mcp-calculator/ (2 files)

**Purpose:** MCP server example exposing math tools. Keep if using Claude MCP protocol, delete otherwise.

- [x] `src/index.ts` - MCP server with stdio transport for Claude Desktop.
- [x] `src/tools.ts` - Calculator tools: add, subtract, multiply, divide.

---

## packages/shared/ (18 files)

**Purpose:** Foundation. Database schema, Redis, logging, service discovery. All other packages depend on this.

### Config
- [x] `drizzle.config.ts` - Drizzle ORM config: SQLite dialect, ./data/coachartie.db default.

### DB
- [x] `src/db/client.ts` - **SINGLETON DB CONNECTION.** getDb() returns BetterSQLite3Database. Uses WAL mode for concurrent access. initializeDb() creates 15+ tables (memories, messages, prompts, queue, todos, meetings, oauth_tokens, credit_balance, model_usage_stats...). closeDb() for cleanup. 337 lines.
- [x] `src/db/index.ts` - Re-exports client and schema.
- [x] `src/db/schema.ts` - **SINGLE SOURCE OF TRUTH.** 15 Drizzle tables: memories (userId/content/tags/importance/embedding), messages (value/userId/channelId/guildId), prompts (name/version/content/category), promptHistory, queue (status/taskType/payload/result), todos, todoLists, todoItems, capabilitiesConfig, globalVariables, globalVariablesHistory, modelUsageStats, creditBalance, creditAlerts, oauthTokens, meetings, meetingParticipants, meetingReminders. Each with indexes.

### Services
- [x] `src/services/index.ts` - Exports userProfile service.
- [x] `src/services/user-profile.ts` - **REDIS USER PROFILES.** getProfile(), updateProfile(), linkEmail(), linkPhone(), linkService(). TTL: 86400s. contact info, preferences, linked services.

### Types
- [x] `src/types/queue.ts` - IncomingMessage (message/userId/source/respondTo/context), OutgoingMessage (channel/userId/response).

### Constants
- [x] `src/constants/queues.ts` - QUEUE_NAMES: incoming-messages, outgoing-messages, slack-*, irc-*, sms-*.

### Utils
- [D] `src/utils/database.ts` - DEPRECATED 510-line sql.js wrapper. Use client.ts instead.
- [x] `src/utils/index.ts` - Re-exports all utilities.
- [x] `src/utils/logger.ts` - Winston logger. Transports: Loki (if LOKI_URL), console (pretty), file (combined.log). Levels: error/warn/info/debug.
- [x] `src/utils/port-discovery.ts` - PORT_MAP: brain=47325, capabilities=47324, discord=47326, slack=47327, irc=47328, sms=47329. getAvailablePort() finds free port.
- [x] `src/utils/redis.ts` - **REDIS + BULLMQ.** getRedisConfig() from env. getRedisConnection() with graceful offline fallback. createQueue(), createWorker() for BullMQ.
- [x] `src/utils/service-discovery.ts` - Redis-based service registry. registerService(), discoverService(), heartbeat every 30s.

### Index
- [x] `src/index.ts` - Main package exports: logger, getDatabase (legacy), getDb (drizzle), queue types, IncomingMessage, redis utils.

### Tests
- [x] `tests/integration.test.ts` - DB integration tests.
- [x] `tests/queue-comprehensive.test.ts` - Queue edge case tests.
- [x] `tests/redis.test.ts` - Redis connection tests.
- [x] `tests/service-integration.test.ts` - Service discovery tests.

---

## packages/slack/ (16 files)

**Purpose:** Full Slack bot with streaming, context awareness, telemetry. Ready for deploy when Slack token available.

- [x] `src/handlers/interaction-handler.ts` - Slash commands, button clicks, modal submissions.
- [x] `src/handlers/message-handler.ts` - Smart message routing with dedup, streaming, rich context.
- [x] `src/index.ts` - Bolt app initialization with handlers, queues, servers.
- [x] `src/queues/consumer.ts` - Response consumer for Slack channels.
- [x] `src/queues/outgoing-consumer.ts` - Outgoing message worker.
- [x] `src/queues/publisher.ts` - Publishes incoming Slack messages to capabilities queue.
- [x] `src/routes/api.ts` - API routes for workspace info.
- [x] `src/services/api-server.ts` - Express API server.
- [x] `src/services/capabilities-client.ts` - HTTP client to capabilities service.
- [x] `src/services/conversation-state.ts` - Multi-turn state with TTL.
- [x] `src/services/health-server.ts` - Health checks with metrics.
- [x] `src/services/job-monitor.ts` - Job status polling wheel.
- [x] `src/services/telemetry.ts` - Metrics collection.
- [x] `src/services/user-intent-processor.ts` - Universal intent processor.
- [x] `src/utils/correlation.ts` - Correlation ID tracking.
- [x] `src/utils/path-resolver.ts` - Docker/local path resolution.

---

## packages/sms/ (7 files)

**Purpose:** Twilio SMS adapter. Phone verification for Discord users. Deployed in docker-compose.

- [x] `src/handlers/incoming-sms.ts` - Twilio webhook handler, queues incoming SMS.
- [x] `src/index.ts` - Express server with Twilio integration.
- [x] `src/queues/consumer.ts` - SMS response consumer via Twilio.
- [x] `src/routes/health.ts` - Health check with Redis/Twilio validation.
- [x] `src/routes/sms.ts` - Twilio webhook routes.
- [x] `src/utils/index.ts` - Re-exports utilities.
- [x] `src/utils/twilio.ts` - sendSMS(), sendVerificationCode().

---

## packages/vue-tsne/ - DELETED

~~Orphaned Vue 3 t-SNE composable. Not imported anywhere. Removed.~~

---

## scripts/ (5+ files)

**Note:** Migration scripts that have already been applied should be deleted.

### Keep
- [x] `smart-dev.js` - npm run dev startup script. Starts services in order.
- [x] `deploy.sh` - Production VPS deployment script.
- [x] `rebuild.sh` - Docker rebuild with caching.
- [x] `health-check.sh` - System diagnostics for networking.

### Delete (One-Off Migrations Already Applied)
- [D] `add-discord-formatting.ts` - Already applied.
- [D] `add-reality-anchor-ts.ts` - Already applied.
- [D] `migrate-prompts-to-db.ts` - Already applied.
- [D] `update-capability-prompt.ts` - Already applied.
- [D] `update-prompt-integrity.ts` - Already applied.
- [D] `add-reality-anchor.js` - Duplicate of above.
- [D] `import-memories.js` - BROKEN. References non-existent deps.
- [D] `inject-message.js` - Debug artifact.

---

## tools/ (3 files)

**Purpose:** CLI and TUI tools for prompt management.

- [x] `prompt-cli.ts` - CLI: `npx ts-node tools/prompt-cli.ts list|view|edit|create|export|import`.
- [x] `prompt-tui.ts` - **BLESSED TUI.** Interactive prompt browser/editor with version history. `npm run prompts`.
- [x] `verify-memory-fixes.ts` - Memory leak verification testing job log cleanup.

---

## Root Config (1 file)

- [x] `vitest.config.ts` - Vitest config with test patterns, coverage, monorepo aliases, sequential execution

---

## Summary

| Category | Files | Documented | Delete |
|----------|-------|------------|--------|
| mcp-servers | 2 | 2 | 0 |
| brain | 23 | 23 | 5 |
| capabilities | 90 | 90 | 6 |
| discord | 45 | 45 | 0 |
| email | 6 | 6 | 0 |
| irc | 4 | 4 | 0 |
| mcp-calculator | 2 | 2 | 0 |
| shared | 18 | 18 | 1 |
| slack | 16 | 16 | 0 |
| sms | 7 | 7 | 0 |
| vue-tsne | ~~1~~ | DELETED | - |
| scripts | 12 | 12 | 8 |
| tools | 3 | 3 | 0 |
| root | 1 | 1 | 0 |
| **TOTAL** | **222** | **222** | **20** |

---

## Deletion Summary

**20 files to delete (~3500+ lines)**

### Packages Removed
- ~~`packages/vue-tsne/` (1 file) - DELETED~~

### Packages Kept (Future Platforms)
- `packages/email/` - Future email adapter
- `packages/irc/` - Already deployed
- `packages/sms/` - Already deployed

### Individual Files
```
packages/brain/composables/useDatabase.ts
packages/brain/composables/useSupabaseClient.ts
packages/brain/lib/database.ts (910 lines)
packages/brain/server/api/test-db.get.ts
packages/brain/server/api/test-query.get.ts
packages/capabilities/src/services/capability-selector.ts
packages/shared/src/utils/database.ts (510 lines)
scripts/add-discord-formatting.ts
scripts/migrate-prompts-to-db.ts
scripts/import-memories.js
scripts/inject-message.js
```

### Files to Investigate (?)
```
packages/capabilities/src/capabilities/semantic-search.ts - Over-engineered?
packages/capabilities/src/capabilities/sequence.ts - Redundant with LLM loop?
packages/capabilities/src/services/conscience.ts - Extra LLM call needed?
packages/capabilities/src/services/llm-error-pattern-tracker.ts - Over-engineered?
packages/capabilities/src/services/semantic-memory-entourage.ts - Expensive API calls
packages/capabilities/src/services/vector-embeddings.ts - LLM can rank text
packages/capabilities/src/utils/model-aware-prompter.ts - One prompt beats three
```
