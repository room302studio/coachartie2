# Coach Artie Simplification Plan

**North Star (refined by EJ 2026-06-08):** Keep EVERY feature — nothing removed. Make Artie's
elements "better entwined, using shared utilities." Goal = *less duplication, not fewer features*;
the same job done once, in one shared place, used everywhere. Smaller LOC is a side-effect.
(Original framing was "cut to ~1/3"; that was aspirational — the real target is cohesion.)
**Approach (chosen):** *Demolition first, decide later* — start with safe, reversible
consolidations on branch `simplify/demolition`; re-evaluate how hard to push the core
after the early wins land. App stays runnable throughout.

## The actual problem (not what it looks like)

This is **not** a junk-drawer of dead experiments. The recent git history (Moltbook,
social-media behavior) is *active* work, and a first audit pass over-flagged "dead code"
that turned out to be load-bearing:

- `hybrid-data-layer.ts` is the **live memory store** (memory capability, api.ts, entourage).
- `reflection-consolidator` is wired into `context-alchemy.ts:1978` (its rules go into the prompt).
- `llm-response-coordinator` + `llm-loop-service` are both called by `capability-orchestrator`.

So the reduction comes from **collapsing duplication + splitting god-files + merging
capabilities**, NOT from deleting features.

> **Rule for this effort: verify importers before deleting anything.** Audit must catch
> *relative* barrel imports (`../observability/index`), not just absolute path strings —
> that gap nearly cost us `sessionManager`. Always finish with a clean `tsc --noEmit`.

## Where the bloat is

**Real usage = Discord + capabilities core + brain dashboard.** Slack/SMS/IRC/Email were
nice-to-have ideas, never used in practice — deleted in Phase 0.5. Don't reintroduce
multi-platform abstraction for hypotheticals.

| Pool | Today | Notes |
|---|---|---|
| `capabilities` | ~60K | the whale; forked LLM/memory/tracing stacks + ~70 capabilities |
| `discord` | ~19K | the one real integration; message-handler 2.4K, GitHub poller stack ~4.8K |
| `brain` | ~5–10K | Nuxt dashboard (separate concern; light touch) |
| ~~slack/sms/irc/email~~ | ~~5K~~ | ✅ deleted (Phase 0.5) |

**Forked core stacks** (the biggest structural waste):
- **LLM calling** ×3: `openrouter` + `llm-response-coordinator` + `llm-loop-service` + inline calls.
- **Memory recall** ×3: `combined` + `temporal` + `semantic` entourages (+`memory-orchestration`); only `combined` truly runs. Temporal-pattern + embedding code is dormant.
- **Tracing/experiments** ×2: `services/observability/` vs `services/context-alchemy/` — ~90% dup. *(Phase 0 removed the dead half.)*

**God-files:** `context-alchemy.ts` (2.5K), `message-handler.ts` (2.4K),
`social-media-behavior.ts` (1.6K), `api.ts` (1.5K→1.0K ✓), `morning-briefing.ts` (1.2K).

## Demolition sequence

### ✅ Phase 0 — Observability cut (DONE, −3,307 LOC, compiles clean)
Deleted the dead duplicate half of the tracing stack + the eval framework you green-lit:
- Removed `observability/{trace-manager, experiment-manager, conversation-tracker, memory-tracker, eval-suite, eval-harness, index}.ts` (2,839 LOC).
- Removed the `/api/eval/*` endpoints from `api.ts` (468 LOC).
- Kept the **live** `context-alchemy/` tracer; kept `error-tracker`, `capability-tracker`, `session-manager` (all have real callers). Repointed orchestrator to import `session-manager` directly (killed the barrel).

### ✅ Phase 0.5 — Drop unused integrations (DONE, −5,835 LOC, compiles clean)
Slack/SMS/IRC/Email were aspirational, never used. Removed:
- `packages/{slack,sms,irc,email}/` (4,983 LOC) — `packages/*` glob auto-drops them from the workspace.
- `capabilities/slack/slack-ui.ts` (Slack-only) + its bootstrap registration.
- Discord SMS phone-verification flow: `link-phone`/`verify-phone`/`unlink-phone` commands (the
  only external dependency on the SMS package) + registrations in `interaction-handler.ts` and `register-commands.ts`.
- `coach-artie-sms` PM2 process (`ecosystem.config.cjs`); `../sms` project ref in `discord/tsconfig.json`.
- **Kept:** `communication/email.ts` (outbound MailerSend *send* capability — separate from the inbound integration).
- **Left for later (inside files being rewritten anyway):** dead `slack`/`sms`/`irc`/`email` branches in
  `shared/types/queue.ts` union, `consumer.ts` `getOutgoingQueueName`, and `context-alchemy.ts` Slack-vs-Discord
  formatting. Narrow the union + drop Slack branches during Phase 3.

### ✅ Phase 0.6 — Dead orphans & scaffold (DONE, −1,017 LOC, compiles clean)
All verified 0-importer / unregistered / unused:
- `services/external/oauth-manager.ts` (0 importers), `test-capability-selector.ts` (0 importers).
- `packages/mcp-calculator/` (standalone, never imported; `calculator` capability already exists).
- Email-link scaffolding: `link-email`/`unlink-email` Discord commands + `utils/email-lookup.ts`
  (used only by those two) + registrations.
- `capabilities/github-identity.ts` — exported but **never registered**; real identity resolution
  lives in `discord/services/github-identity-resolver.ts`.

**Running total (Phases 0 + 0.5 + 0.6): ~11.6K LOC removed, every package compiles.**
This exhausts the provably-dead timber. Remaining reductions need either a feature-usage signal
(which capabilities are actually used) or behavior-preserving refactors (below).

### ✅ Phase 1 — Collapse memory recall (DONE, −1,102 LOC, compiles clean)
**Correction to the original audit:** temporal + semantic were NOT dead — both run every recall
with real, distinct scoring (TF-IDF cosine vs recency/time-of-day/historical). So this was a
faithful merge, not a deletion.
- New `memory-recaller.ts` (589 LOC) replaces `combined` + `semantic` + `temporal` (1,691 LOC).
  Fetches the candidate set **once** (was fetched twice), keeps the exact TF-IDF + temporal math,
  thresholds, confidence formulas, categories, guild layer, and fusion.
- Dropped: the double-fetch, 4 dead `fuse*` methods + `parseMemoryResult` + a never-populated
  (buggy) TF-IDF cache, and the `Math.random()` "fusion pattern / style" theater → deterministic top-K.
- Kept untouched: `memory-orchestration.ts` (that's the *store* path, used by orchestrator) and
  `memory-entourage-interface.ts` (the contract). Rewired the one consumer (`context-alchemy.ts`).
- **⚠️ Behavior caveat (can't runtime-verify from here):** recall *ranking* shifts slightly —
  the semantic layer now scans 60 candidates instead of 30, and output phrasing is deterministic
  instead of randomized. Recall *quality* should be equal-or-better. **Test on a real conversation
  before deploying to the VPS.**

### ◐ Phase 2 — LLM paths (REVISED, −337 LOC, compiles clean)
**Correction:** `openrouter` + `coordinator` + `loop-service` are NOT redundant clients — they're
layers (transport / orchestration / agentic loop). The audit's "merge 3→1" was a phantom; forcing
it would be risky surgery for no gain. Did NOT do it.
Real win: pruned 5 dead methods from the 863-LOC coordinator grab-bag (`getLLMIntermediateResponse`,
`generateFinalSummaryResponse`, `generateFinalResponse`, and the `generateCapabilityBanner` →
`toSmallCaps` chain only it called). Coordinator 863 → 526.
Optional later: move the pure-formatting helpers (`stripThinkingTags`, `extractLoopDecision`,
`extractSuggestedNextActions`, `truncateConversationHistory`) into a `llm-format-utils.ts` — a
*move* for cohesion, not a LOC win.

### ◐ Phase 3 — Slim `context-alchemy.ts` (PARTIAL, −174 LOC, compiles clean)
Done so far (dead-code removal — behavior-neutral):
- Deleted the **jailbreak detection block** (patterns + `detectJailbreakPatterns` +
  `annotateSuspiciousMessage`, 67 LOC) — defined but **never called** anywhere.
- Deleted dead Slack code: `SLACK_UI_MODALITY_RULES_FALLBACK`, the `addSlackSituationalAwareness`
  method + its call, and the Slack branch in `assembleMessageChain`. (Slack source can't arrive.)
- File: 2,500 → 2,326 LOC.

**Modularization (in progress — EJ wants all features kept, just a smart redesign):**
Dependency analysis (do NOT skip — it's what makes this safe): of the 17 `add*` providers, only
**3** touch `this` — `addDiscordSituationalAwareness`→`loadGuildPrompt`, `addLearnedRules`→
`formatLearnedRulesForContext`, `addRelevantMemories`→`this.memoryEntourage`. Everything else uses
only module-level imports → cleanly extractable as **free functions** (lowest-risk: verbatim body
move, no push→return rewrite, no abstraction layer).

**Proven pattern (DONE for the first 3):** new dir `services/llm/context-providers/`:
- `types.ts` — `ContextSource`, `ContextBudget`, `DEBUG` (moved out of context-alchemy).
- `system-context.ts` — `addCreditWarnings`, `addCurrentDateTime`, `addSelfAwareness` as exported
  free functions. context-alchemy imports + calls them; methods removed. Compiles clean, behavior identical.

**Remaining providers to extract (same mechanical pattern, group into files):**
- `discord.ts`: addDiscordSituationalAwareness (move `loadGuildPrompt` here too), addReplyContext,
  addRecentChannelMessages, addRecentGuildMessages, addChannelVibes, addDiscordEnvironment.
- `attachments.ts`: addAttachmentContext (~500 LOC), addStoredFileContext.
- `memory.ts`: addRelevantMemories(sources, memoryEntourage), addCommunityFeedback,
  addLearnedRules (move `formatLearnedRulesForContext` here).
- `awareness.ts`: addGoalWhisper, addMoltbookPeek, addCapabilityManifest, addCapabilityLearnings.
Core keeps the machinery (buildMessageChain, calculateTokenBudget, selectOptimalContext,
assembleMessageChain, getConversationHistory, convertDiscordHistoryToMessages, sanitizeAssistantMessage).
Target: context-alchemy 2,191 → ~700. Note: this is a *maintainability* refactor — net LOC ~flat
(code moves out + small plumbing), not a reduction. Per-extraction: back up, splice, `tsc` green.

### ▢ Phase 4 — Shared transport package (target −4–6K)
`@coachartie/transport` with a `BaseAdapter` owning dedup-cache, correlation, telemetry,
job-monitor polling, chunking, capabilities-client. Discord/Slack/IRC/SMS/Email become thin
adapters. Discord keeps its genuinely-unique bits (guilds, personas, proactive-answer,
GitHub expansion). `correlation.ts` is 99% identical across Discord/Slack today.

### ✅ Phase 4 — Systematic dead-code sweep (DONE, −1,093 LOC, compiles clean)
Agent-found, then **independently verified** (the agents over-claim — 2 of this run's earlier
"dead" flags were live). Confirmed 0 callers (static + dynamic imports, internal + external):
- Orphaned files: `utils/slack-formatter.ts` (538), `utils/context-alchemy-debugger.ts` (195).
- Dead methods: coordinator-style splices removed `executeCapabilityChain` (executor, replaced by
  the streaming variant), 3 disabled parser methods, `getRelevantMemoryPatterns` (memory-orch),
  `logSanitizationEvent` (security-monitor), `generateResponse`+`isHealthy` (openrouter).
- Two typecheck-caught collateral nicks (a swept-up doc comment; a static `SIMPLE_SHORTCUTS` that
  lived between dead methods) — both repaired before moving on. **Bulk splices need a backup + a
  typecheck every time.**
- Deferred (need import-chain cleanup): `micro-llm.detectIntent`, `model-aware-prompter`'s
  `getModelCapabilities`/`generateRecoveryPrompt` (~96 LOC).

### ◐ Phase 5 — Capability standardization (PARTIAL, −228 LOC, compiles clean)
**Reality check:** the "−8–10K" was overstated. The real boilerplate was the *registration
ceremony* in `capability-bootstrap.ts` — 59 capabilities each registered with a 1–3 line
log-and-register ritual. Collapsed to one `ALL_CAPABILITIES` array + a loop: 389 → 161 LOC
(tsc validates completeness — a dropped capability becomes an unused-import error). Skill-loader
`setImmediate` block preserved.
The rest (merge `goal`+`goals`, `todo`+`task-status`, collapse `discord-*`) is **feature-shaped,
not boilerplate**: each handler is unique logic, and merging changes the capability *names the LLM
calls by* → behavior risk. Treat as feature work, not a free cut.

### ▢ Phase 6 — GitHub pipeline (target −1.5–2K)
Share event-parsing/formatting between the Discord poller (~4.8K) and the capabilities
webhook (632); add dedup so poller + webhook can't double-post.

### ◐ Phase 7 — Shared utilities ("better entwined") — IN PROGRESS
The North Star phase: the same small job done in one shared place, used everywhere. New home
is `packages/shared/src/utils/`, re-exported from the `@coachartie/shared` barrel.
**Done (compiles clean, both packages):**
- `utils/text.ts` → `estimateTokens(text)`. Rewired **35 inlined `Math.ceil(x.length/4)` copies + 1
  local duplicate estimator** (in llm-response-coordinator) → all use the one shared fn.
- `utils/async.ts` → `delay(ms)` + `withRetry(fn, opts)` (unifies the 3 divergent backoff loops:
  moltbook, robust-capability-executor, discord capabilities-client — pass `shouldRetry`/`jitter`/`onRetry`).
- `utils/async.ts` → `delay(ms)` — DONE. Rewired **12 inlined `setTimeout` sleeps + 2 local `sleep`
  helpers** (capabilities: shell, consumer, chat, robust-executor, moltbook; discord: reaction-handler,
  capabilities-client, message-handler×2, github-poller, github-integration, mention-proxy). Both packages green.
  Gotchas hit (all caught by tsc): local `delay` variables collide with the import (rename to `backoffMs`);
  multi-line first-imports break a naive "insert after first import line" — merge into the existing brace.

- `withRetry` — moltbook DONE: its 34-line 429 retry loop now calls shared `withRetry`, with the
  429 check kept as a local `withMoltbookRetry` policy wrapper (shared mechanism + local policy =
  the right separation). Verified behavior-identical (delays 1/2/4s never hit shared's 30s cap;
  attempt logging matches).

**Remaining candidates (evidence in this session's scan — verify each before rewiring):**
- `withRetry` (2 left, behavior-sensitive — defer/careful): `discord/capabilities-client.ts` loops
  `1..maxRetries` (off-by-one vs shared's `0..maxRetries` — pass `maxRetries-1`) and uses ADDITIVE
  jitter (`+random*500`) vs shared's MULTIPLICATIVE (`*(0.5+random)`) + a `noRetry` flag (→ `shouldRetry`);
  inline retry in `robust-capability-executor.executeWithRetry` (100ms base, no jitter).
- `TtlCache<V>` (new `utils/ttl-cache.ts`): 5+ in-memory `Map + TTL cleanup` dedup caches
  (discord reaction-handler/message-handler, capabilities github-webhook `isWebhookDuplicate`,
  context-alchemy guildPromptCache, observation-handler, capability-selector, social-media-behavior).
- `SlidingWindowRateLimiter` (new `utils/rate-limiter.ts`): the moltbook `RateLimiter` class (~91 LOC)
  + social-media-behavior cooldowns. (Express middleware rate-limiter is HTTP-specific — leave separate.)
Gotcha learned: a target file may already have a LOCAL helper of the same name (coordinator's
`estimateTokens`) — the import collides; delete the local and let the shared one take over.

## Decide-later / higher-risk items
- **`context-alchemy/` tracer + the Discord-reaction → `recordFeedback` → reflection loop.**
  Consolidating the remaining tracer is fine, but preserve this feedback→learning path —
  it may be the point of the reflection system. Don't cut blind.
- **Greenfield core vs strangler:** a true 1/3 likely needs the core spine (Phases 1–3)
  rewritten clean in a worktree and ported onto, rather than refactored in place. Revisit
  after Phases 0–1 prove the pattern.
- **Integrations:** resolved — Slack/SMS/IRC/Email deleted (Phase 0.5). Discord is the only real
  platform, so **Phase 4 collapses to "tidy Discord," not "build a multi-platform adapter."** Don't
  abstract for platforms that no longer exist.
- **Email send capability + `link-email`/`unlink-email` Discord commands:** kept for now; confirm
  whether outbound email is a real usage or also a hypothetical to cut.
- **Broader "is it actually used?" capability audit:** ~70 capabilities; some (moltbook is active,
  but reddit/wallet/osint/hermes/kanban/vps-claude?) may be hypotheticals. Worth a usage pass before Phase 5.

## Guardrails
- Work on `simplify/demolition`; never blind-merge with the VPS (`/data2/apps/coachartie2`) — local/server git have diverged.
- Pre-existing baseline issue (NOT from this work): `wallet.ts` imports `ethers`, which isn't installed → 1 tsc error on `capabilities`. Ignore or install `ethers`.
- Each phase ends green: `cd packages/<pkg> && npx tsc --noEmit` (build `shared` first to populate its dist exports).

### ▢ Orphan hunt — backlog (verified, deferred)
- **model-aware-prompter dead cluster** (`utils/model-aware-prompter.ts`): `generateRecoveryPrompt`
  (→ its only caller of `getModelCapabilities`), `getModelAwareSystemPrompt`, `adaptPromptForModel`
  all have 0 external callers; the LIVE method is `generateCapabilityPrompt` (used by
  llm-response-coordinator:106), which does NOT call the dead 4. Delete the 4 (scattered + interdependent
  + may orphan the `ModelCapabilities` type — do as a careful pass, back up + typecheck).
