# Changelog

All notable changes to Coach Artie will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2025-11-02

**Testing & debugging improvements! Enhanced HTTP logging and Brain memory analytics.**

### ✨ Added

- **HTTP Capability Detailed Logging** - Comprehensive request/response logging
  - Logs HTTP response status codes and sizes
  - Shows data preview for JSON responses
  - Makes debugging API calls significantly easier
  - Reveals exactly what data Artie receives from HTTP requests
- **Brain Memory Users Endpoint** - New `/api/stats/memory-users` endpoint
  - Queries memories table (3,577 imported memories) instead of empty messages table
  - Returns top users by memory count with timestamps
  - Supports time range filtering (7d, 24h, 30d, etc.)
  - Enables Artie to introspect his own memory statistics
- **Testing Scripts** - Tools for development and debugging
  - `inject-message.js` for direct Redis queue message injection
  - `import-memories-v2.sh` for CSV memory data import
  - Proper test message formatting with valid API endpoints

### 🐛 Fixed

- **HTTP Capability URL Handling** - Fixed malformed test URLs
  - Corrected concatenated URLs that caused SQL errors
  - Updated test messages to use proper single endpoint format
  - Fixed query parameter formatting for FTS searches
- **Brain API Endpoint References** - Point to correct data tables
  - Memory queries now use dedicated memory-users endpoint
  - Resolves empty data returns from message table queries

### 🧪 Testing

- Systematic testing revealed and fixed three critical issues:
  1. Empty data returns (wrong table) → Created new endpoint
  2. Malformed URLs (concatenation) → Fixed test format
  3. No debugging visibility → Added comprehensive logging
- **This is why we test!** All issues discovered and resolved through end-to-end testing

## [1.3.0] - 2025-11-02

**Summer of development release! MediaWiki integration, GitHub automation, enhanced Discord capabilities, and major infrastructure improvements.**

### ✨ Added

- **MediaWiki Integration** - New `mediawiki` capability for reading, writing, and searching wiki pages
  - Auto-discovery from environment variables
  - Smart wiki selection with fuzzy matching
  - Full CRUD operations for wiki content
- **GitHub Release Auto-Updates** - Automatically updates wiki pages when releases are published
  - Configurable per-repository via `WIKI_UPDATE_*` env vars
  - Supports list/table/append formatting
  - Graceful failure handling
- **GitHub URL Auto-Expansion** - Rich embeds for GitHub URLs in Discord
  - Auto-expands repo metadata, PR status, and issue details
  - Only active in whitelisted guilds
  - Enhanced with PR/issue metadata
- **Enhanced Discord Message Handler** - Smarter context gathering
  - Channel history context (10-25 recent messages)
  - Forum thread awareness with metadata
  - Multi-turn conversation support
  - Improved mention proxy with LLM judgment
- **Meeting Scheduler Enhancements** - Discord reminder system
  - Database schema: Added `participant_type` field (Discord or email)
  - 15-minute advance Discord DM reminders
  - Reliable delivery via Bull queue
  - Timezone-aware scheduling with `date-fns-tz`
  - **Flexible date parsing** - Supports ISO format, MM/dd/yyyy, and natural language ("tomorrow", "next Tuesday")
- **Discord Outgoing Message Queue** - Reliable async messaging
  - Channel and DM support with automatic retries
  - Used for reminders and notifications
  - Prevents message delivery failures
- **Automated Changelog Generator** - LLM-powered release notes
  - Semantic commit parsing
  - Artie writes user-friendly summaries
  - Integrated into `npm run changelog`
- **Discord Context Tracking** - Enhanced capability execution
  - Tracks guild, channel, and mention context
  - Enables context-aware capability responses
  - Better mention resolution in multi-user conversations

### 🐛 Fixed

- Handle LLM parameter variations and make participants optional (`e497489`)
- **Critical**: Fix two breaking bugs discovered through skeptical testing (`accc38c`)
  - XML parser regex failed on Discord mentions (stopped at `>` characters)
  - Schema mismatch in participant insert attempted to use non-existent column
  - Both caused silent failures in production - now working correctly
- Align meeting scheduler with official database schema (`20faf6a`)
- Make changelog generator compatible with macOS bash (`7d6fd00`)

### ♻️ Refactored

- DELETE duplicate bulletproof-capability-extractor (157 lines) (`ed24920`)
- Documentation cleanup: Removed 15 internal-only markdown files (design specs, testing schemes, runbooks)
- Simplified README from 432 to 283 lines (focused, actionable)

### 🔧 Infrastructure

- **Improved Deployment Scripts** - Production-ready deployment
  - Interactive mode for VPS deployment
  - Critical vs optional environment variable checking
  - Better Docker health checks
  - Local production testing: `./scripts/deploy.sh local`
- **Enhanced VPS Setup Script** - System validation
  - System requirements validation (OS, memory, disk)
  - Docker auto-detection and verification
  - Better error handling throughout
- **Environment Configuration** - Cleaner `.env.example`
  - REQUIRED vs OPTIONAL sections
  - Better documentation and examples

### 📦 Dependencies

- Added `date-fns` + `date-fns-tz` - Timezone-aware scheduling
- Added `form-data` - MediaWiki authentication
- Added `chance` - Random context window sizing
- Added `@types/chance` - TypeScript support

### 📝 Documentation

- Add version management to CLAUDE.md and create website showcase guide (`4b80df8`)
- **Complete README rewrite** (432 → 283 lines)
  - Clearer architecture overview with ASCII diagram
  - Streamlined setup instructions
  - Better quick-start guide
  - Port reference guide (47300+ range)
- Consolidated 15 internal docs into main docs
- Cleaned up `.gitignore` with essential patterns only

### Changed

- Total capabilities: 27 (added MediaWiki, previously 26)
- Enhanced GitHub webhook handler (+172 lines of functionality)

## [1.1.0] - 2025-10-26

### Added
- **Runtime Adaptation Capabilities** - Three new capabilities for self-monitoring and optimization:
  - `model_manager` - Query available models, pricing, and get credit-aware recommendations (4 actions)
  - `runtime_config` - Dynamically adjust configuration at runtime including auto-optimization modes (7 actions)
  - `system_monitor` - Monitor system resources, services, disk, and health (5 actions)
- **Discord Formatter Utility** - Rich visual formatting for Discord messages with progress bars, health meters, alerts
- **Credit Warning System** - Integrated credit monitoring into Artie's context with Rick & Morty style warnings
- **Auto-Optimize Modes** - Automatic configuration adjustment based on credit balance:
  - SURVIVAL (<$5): 3 iterations, 16k context, FAST model only
  - CONSERVATIVE (<$25): 5 iterations, 24k context
  - EFFICIENT (<$50): 8 iterations, 32k context
  - FULL POWER (>$50): 12 iterations, 64k context

### Fixed
- Database schema: Added missing `related_message_id` column to memories table
- Improved `/chat` endpoint error messages with JSON syntax examples

### Changed
- Total capabilities increased from 25 to 28
- OpenRouter API key updated to pay-as-you-go billing model

## [1.0.0] - 2025-01-24

### Added
- **Mention Proxy System** with LLM judgment layer for intelligent @ mention handling
- **GitHub PR Auto-Expansion** for Subway Builder guild
- **Cost Control Mechanisms** after $40 burn incident:
  - Maximum cost per hour: $2.00 (down from $10.00)
  - Maximum tokens per call: 3000 (down from 8000)
  - Auto credit check every 10 messages (down from 50)
  - Exploration iterations: 5 max (down from 24)
- Health check script for local development
- Memory leak verification script

### Fixed
- **Critical Security Patches** applied to dependency tree:
  - static-eval, minimist, esbuild, @nuxtjs/mdc, form-data
  - @eslint/plugin-kit, vite, axios, tar-fs, nodemailer, koa
- **Memory Leak Fixes** for low-memory VPS stability
- TypeScript errors in GitHub integration service
- Production hardening with log rotation and security configs
- BullMQ worker restored for scheduler job execution

### Changed
- Simplified scheduler service architecture
- Disabled LinkedIn capability (OAuth not configured)
- Enhanced worker error handlers for better visibility

## [0.9.0] - Earlier Development

### Foundation
- Initial Coach Artie 2 architecture
- Multi-service monorepo with Discord, Capabilities, Brain UI, SMS, Email
- Three-tier model strategy (FAST/SMART/MANAGER)
- Context Alchemy system for intelligent context assembly
- Hybrid memory system (semantic + temporal)
- 25 base capabilities including calculator, web search, memory, todos, etc.
- Redis-based job queue with BullMQ
- SQLite database with vector embeddings
- Health monitoring and metrics

---

## Versioning Strategy

**Semantic Versioning (MAJOR.MINOR.PATCH)**

- **MAJOR** (x.0.0): Breaking changes, complete rewrites, architecture changes
- **MINOR** (0.x.0): New features, new capabilities, significant enhancements
- **PATCH** (0.0.x): Bug fixes, security patches, minor improvements

**When to Bump:**
- Add new capability → MINOR bump
- Fix bugs/security → PATCH bump
- Major architecture change → MAJOR bump
- Database schema changes → Document in changelog, usually MINOR
