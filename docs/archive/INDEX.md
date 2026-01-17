# COACHARTIE INDEX

> Last updated: 2025-11-26 | 251 files | 11 packages | ~40 capabilities

---

## Architecture (One Tweet)

```
Message → Platform Adapter → Brain Orchestrator → LLM + Capabilities → Response
```

ReAct loop: LLM decides what tools to call, executes them, iterates until done. Max 8 loops, 120s timeout.

---

## Packages

### brain
**Nuxt dashboard for monitoring bot activity. Visualizes memories, messages, queues with t-SNE plots. Read-only admin tool.**

| File | Tweet |
|------|-------|
| `composables/useTsne.ts` | t-SNE dimensionality reduction for embedding viz. 313 lines, over-commented. |
| `composables/useDatabase.ts` | DEAD CODE. Mock Supabase client that returns empty objects. DELETE. |
| `composables/useSupabaseClient.ts` | DEAD CODE. Another mock. DELETE. |
| `lib/database.ts` | DEAD CODE. 910-line SQLite adapter replaced by Drizzle. DELETE. |
| `server/api/status.ts` | Main metrics endpoint. Counts, distributions, time series. |
| `server/api/analytics.get.ts` | Dynamic query builder. Flexible but SQL injection risk. |
| `server/api/test-db.get.ts` | Debug endpoint. Remove from prod. |

**Verdict: Delete 3 files (~1100 lines), remove test endpoints, replace emoji logging.**

---

### capabilities
**The heart. 40+ tools in a ReAct loop. LLM picks capabilities, executes, iterates.**

#### Core Services

| File | Tweet |
|------|-------|
| `capability-orchestrator.ts` | Entry point. Routes messages through LLM loop. Clean gospel methods. |
| `capability-registry.ts` | Plugin system. Capabilities self-register. Validates on load. Excellent. |
| `capability-executor.ts` | Runs capability chain with retries. Smart cost control skips unnecessary LLM calls. |
| `capability-parser.ts` | Extracts `<capability>` XML from LLM response. Uses fast-xml-parser. |
| `context-alchemy.ts` | 1309 lines. Intelligent context window management. Gathers memories, goals, user profile. Token budgeting. |
| `llm-loop-service.ts` | Autonomous iteration. 8 max loops, 120s timeout. Asks LLM "what next?" each round. |
| `llm-response-coordinator.ts` | Three-tier model strategy (fast/main/fallback). Extracts [LOOP] decision from response. |
| `conscience.ts` | OVER-ENGINEERED. Extra LLM call for safety review. Just put safety rules in prompt. |
| `openrouter.ts` | OpenRouter API client. Multi-model support. Streaming. |

#### Capabilities (The Good Ones)

| Capability | Tweet |
|------------|-------|
| `shell` | Bash in Docker sandbox. Handles tmux, heredocs, markdown extraction. 547 lines. |
| `filesystem` | CRUD for files. Absolute paths. Permission checks. Clean. |
| `memory` | Persistent storage with semantic tagging. Uses hybrid data layer for speed. |
| `http` | GET/POST/PUT/DELETE. 106 lines. Minimal cruft. |
| `github` | Releases, issues, PRs, commits, search. 1033 lines but clean. |
| `ask-question` | Multiple-choice questions to user. Buttons, selects. Works on Discord & Slack. |
| `mcp-client` | Connect to external MCP servers. JSON-RPC protocol. 881 lines. |

#### Capabilities (Notes)

| Capability | Note |
|------------|------|
| `semantic-search` | Vector embeddings for intentional similarity search. Kept as explicit tool option. |
| `discord-issue-parser` | Regex to extract GitHub URLs. Could let LLM parse instead. |
| `mention-proxy` | Regex for Discord mentions. Works well, kept. |
| `sequence` | Explicit orchestration from management agents to subagents. Different from ReAct. |

#### Notes

| File | Note |
|------|------|
| `capability-selector.ts` | Two-tier triage. Fallback when DB prompts not found. |

---

### discord
**Discord bot. Handles messages, slash commands, reactions, buttons, menus.**

| File | Tweet |
|------|-------|
| `src/handlers/message-handler.ts` | Core routing. 1400 lines. Detects mentions, DMs, robot channels. |
| `src/handlers/interaction-handler.ts` | Slash commands, buttons. Clean after recent cleanup. |
| `src/services/user-intent-processor.ts` | Unified intent processing. Recently cleaned. Just `text.trim()` now. |
| `src/services/capabilities-client.ts` | Bridge to capabilities service. Submits jobs. |
| `src/services/job-monitor.ts` | Tracks async jobs. Polling-based. |
| `src/services/github-integration.ts` | Auto-expands GitHub URLs in messages. |
| `src/services/mention-proxy-service.ts` | Proxy mentions for offline users. Has keyword matching (pre-LLM). |

**Recently Deleted (Good Riddance):**
- `conversation-state.ts` - 185-line state machine for one command. GONE.
- Pre-LLM text processing regex - GONE.

**Remaining Cruft:**
- `shouldCreateThread()` - Keyword matching for thread decisions. Let LLM decide.
- Keyword triggers in mention-proxy - Let LLM classify.

---

### shared
**Foundation. Database schema, Redis, logging, service discovery.**

| File | Tweet |
|------|-------|
| `db/schema.ts` | Drizzle ORM schema. 20+ tables. Single source of truth. |
| `db/client.ts` | Database singleton. getDb(), getRawDb(). |
| `utils/redis.ts` | BullMQ wrapper. Graceful fallback when Redis unavailable. |
| `utils/logger.ts` | Winston + Loki. Multiple transports. |
| `utils/database.ts` | DEPRECATED. 510-line sql.js wrapper. DELETE when fully migrated. |
| `utils/service-discovery.ts` | Inter-service communication. Redis-backed. |
| `services/user-profile.ts` | Redis-backed user profiles. |

**Cruft: Legacy database.ts (510 lines) should be deleted.**

---

### sms
**Twilio SMS adapter. Phone verification for Discord users.**

| Status | KEEP |
|--------|------|
| Lines | 316 |
| Deployed | Yes (docker-compose) |
| Tweet | Twilio webhook handler. Queues messages to capabilities. Used by Discord for phone linking. |

---

### email
**Generic email webhook handler. Future platform adapter.**

| Status | KEEP |
|--------|------|
| Lines | 387 |
| Deployed | No (needs Dockerfile) |
| Tweet | Future email platform. Ready for deployment when needed. Needs Dockerfile and docker-compose entry. |

---

### slack
**Full Slack bot with streaming, context awareness, telemetry.**

| Status | KEEP |
|--------|------|
| Lines | 3659 |
| Deployed | No (needs Slack token) |
| Tweet | Professional implementation. Streaming responses, conversation state, comprehensive telemetry. Ready for deploy. |

---

### irc
**IRC bot for forestpunks.com and other servers.**

| Status | KEEP |
|--------|------|
| Lines | 535 |
| Deployed | Yes (docker-compose) |
| Tweet | Niche but working. Handles IRC quirks, reconnection logic. |

---

### mcp-calculator
**MCP server exposing math tools.**

| Status | MAYBE DELETE |
|--------|--------------|
| Lines | 262 |
| Tweet | Complete but isolated. Keep if using Claude MCP protocol, delete otherwise. |

---

### ~~vue-tsne~~ - DELETED
~~Orphaned Vue 3 t-SNE composable. Not imported anywhere. Removed.~~

---

## Tools & Scripts

### Keep
| File | Tweet |
|------|-------|
| `tools/prompt-tui.ts` | Interactive TUI for browsing/editing prompts. Used via npm script. |
| `tools/prompt-cli.ts` | CLI for prompt management. List, view, edit, export. |
| `scripts/smart-dev.js` | Dev startup script. npm run dev. |
| `scripts/deploy.sh` | Production VPS deployment. |
| `scripts/rebuild.sh` | Docker rebuild with caching. |
| `scripts/health-check.sh` | System diagnostics for networking. |

### Delete
| File | Tweet |
|------|-------|
| `scripts/add-reality-anchor.js` | One-off migration. Already applied. |
| `scripts/add-reality-anchor-ts.ts` | Duplicate of above. |
| `scripts/add-discord-formatting.ts` | One-off migration. Already applied. |
| `scripts/update-prompt-integrity.ts` | One-off migration. Already applied. |
| `scripts/update-capability-prompt.ts` | One-off migration. Already applied. |
| `scripts/import-memories.js` | BROKEN. References non-existent deps. |
| `scripts/inject-message.js` | Debug artifact. Shouldn't be in repo. |
| `scripts/migrate-prompts-to-db.ts` | One-off migration. Already applied. |

---

## Pre-LLM Patterns (Delete These)

| Pattern | Location | Tweet |
|---------|----------|-------|
| Keyword intent matching | mention-proxy-service.ts | `content.includes('?')` to detect questions. Really? |
| Thread decision logic | user-intent-processor.ts | Keyword matching for "complex" conversations. LLM knows. |
| Model-aware prompting | model-aware-prompter.ts | Three-tier prompts for weak/medium/strong models. One good prompt beats three. |
| Regex entity extraction | github-integration.ts, discord-issue-parser.ts | Regex for GitHub URLs. LLM can extract. |
| Vector semantic search | semantic-memory-entourage.ts | Embedding API calls. LLM ranks by text similarity for free. |
| Conscience safety layer | conscience.ts | Extra LLM call per capability. Put safety in main prompt. |
| Structured error formatting | structured-errors.ts | Verbose error templates "for LLM understanding". LLMs understand errors. |

---

## Deletion Hitlist

**Immediate (no dependencies):**
```
packages/brain/composables/useDatabase.ts
packages/brain/composables/useSupabaseClient.ts
packages/brain/lib/database.ts
packages/brain/server/api/test-db.get.ts
packages/brain/server/api/test-query.get.ts
packages/capabilities/src/services/capability-selector.ts
packages/shared/src/utils/database.ts
scripts/add-discord-formatting.ts
scripts/import-memories.js
scripts/inject-message.js
scripts/migrate-prompts-to-db.ts
```

**Estimated savings: ~3200 lines** (vue-tsne deleted, email kept)

---

## What's Actually Good

| Thing | Tweet |
|-------|-------|
| Capability Registry | Plugin system. Self-registering capabilities. Clean validation. Extensible. |
| ReAct Loop | LLM decides, executes, iterates. 8 loops max, 120s timeout. Simple and effective. |
| Context Alchemy | Smart context window management. Token budgeting. Multi-source gathering. |
| Hybrid Data Layer | In-memory cache + async persistence. Eliminates SQLite concurrency issues. |
| Gospel Methods | Clear entry points in orchestrator. Easy to follow flow. |
| Drizzle Migration | Single source of truth for schema. Type-safe. Modern. |
| Graceful Redis Fallback | Works without Redis. Logs warnings, continues functioning. |

---

*This index is brutally honest. Trust it. Update it when you touch code.*
