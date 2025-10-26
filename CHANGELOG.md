# Changelog

All notable changes to Coach Artie will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
