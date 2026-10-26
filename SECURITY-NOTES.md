# Security hardening — batch 1 (hotfix) + batch 2 (`v3-sec2`)

What's gated, what's capped, how to add a tool to each list, and what's still open.
Source audits: `sec-authority.md`, `sec-leaks.md`, `sec-abuse.md` (scratchpad reports this
branch was built from).

## 1. Owner-only tools

File: `packages/artie/src/engine/5-tool-loop/owner-only.ts`.

Checked in `CapabilityRegistry.execute()` — the one choke point every call path shares
(native tool loop, the legacy XML loop, and the HTTP execute-tool route) — right after
`resolveToolCall`, so aliases (e.g. `shell` → `sandbox`) are already resolved to their
canonical name before the check runs. Refuses with a fixed string
(`OWNER_ONLY_REFUSAL`) before the handler, the approval gate, or anything else sees the call.

Current list (`OWNER_ONLY_ACTIONS`):

| Tool | Scope | Why |
|---|---|---|
| `sandbox` | all | `docker exec` forwards `GITHUB_TOKEN`/`OPENAI_API_KEY` into the container |
| `http` | all | raw outbound fetch; see §5, it's now also SSRF-guarded as defense in depth |
| `osint` | all | EJ's private intelligence-monitoring stack |
| `system_memory` | all | cross-agent (Artie ↔ VPS-Claude) handoff notes |
| `mention_proxy` | all | lets Artie answer @mentions *as* someone, undisclosed |
| `self-stats` | `user_costs` | per-user LLM spend/usage profiling |
| `deep_research` | `submit` | real OpenAI $ outside the normal budget pipeline |

**To add a tool here:** add an entry to `OWNER_ONLY_ACTIONS` (`'all'` or a `Set` of actions).
Nothing else to wire — the registry check is automatic. Caller identity comes from
`context.userId`, which the registry's callers set from the *real*, Discord-verified id (or
the HTTP API's `userId`, which is why `isOwner`/`isOwnerConfirmed` not checking `source` is
still an open item, below).

## 2. Approval gate (money / leaves Discord)

File: `packages/artie/src/engine/5-tool-loop/approval-gate.ts`. Same choke point as §1,
checked right after it. A gated call is queued (`createPendingAction`) and returns a
"needs EJ's approval" message instead of running; EJ clears it with the `approvals` tool,
which is the only path that may set `confirmed: true` — `execute.ts`'s
`executeNativeToolCall` and `retry.ts`'s `tryRegistryExecution` both strip a model-supplied
`confirmed` before it reaches `resolveToolCall`/`registry.execute`, so a model can never
self-grant the bypass, even in EJ's own conversation.

Current list (`GATED_ACTIONS`): `stripe` (all), `email:send`, `reddit:post/comment`,
`github:create_issue/update_issue`, `mediawiki:write/add`, `http:post/put/delete`.

**To add a tool here:** add `{ toolName: 'all' | new Set([...actions]) }` to `GATED_ACTIONS`.
Gate the write verb, not the whole tool, if reads should stay open (that's why `github`
read actions and `http:get` aren't gated — `http:get` is instead SSRF-guarded, §5).

## 3. Taint tracking (indirect prompt injection)

File: `packages/artie/src/engine/5-tool-loop/execute.ts`.

- `TAINTING_CAPABILITIES` — executing one of these sets `context.taintedByExternalContent`:
  `http`, `web`, `n8n_browser`, and (batch 2) `github`, `reddit`, `mediawiki` — reading any of
  these pulls attacker-controlled text into the turn (an issue body, a thread, a wiki page)
  just as much as a raw fetch does, even though the read action itself stays ungated.
- **Ingest-time taint (batch 2, new):** `resolveDiscordMessageLinks`
  (`gateway/1-receive/expand-links.ts`) pulls another user's past Discord message content
  straight into `discordContext.resolvedDiscordMessages` *before* the tool loop starts —
  content that never passes through a capability call, so it could never set the taint flag
  on its own. `createOrchestrationContext` (`engine/2-turn/run-turn.ts`) now taints the turn
  at ingest when `message.context.resolvedDiscordMessages` is non-empty
  (`taintSource: 'discord-link-expansion'`). `handleGitHubAutoExpansion` does **not** need
  this: it returns `'stop'` in `on-message.ts` and never feeds its embed content into a turn
  the model sees.
- `DANGEROUS_WHEN_TAINTED` — blocked while the turn is tainted: `sandbox`, `filesystem`,
  `email`, `scheduler`, and (batch 2) `discord-moderation`, `discord-nickname`,
  `proactive-dm`, `mention_proxy`, `discord-ui`. `mention_proxy` is already owner-only (§1);
  it's listed here too as defense in depth, because an *owner's own* turn can still be
  prompt-injected mid-conversation (same reasoning as §5's http fix).
- `SAFE_ACTIONS_WHEN_TAINTED` — narrow exceptions for read-only/harmless actions on an
  otherwise-dangerous tool: `filesystem: read/list/exists`, `sandbox: <read-only git + file
  ops>`, and (batch 2) `discord-moderation: escalate` (just posts a string asking a human
  mod to look), `proactive-dm: status` (reads the queue, sends nothing).

**To add a tool here:** add the canonical registered name (not an alias — a dedicated test,
`tests/engine/taint-tracking.test.ts`, asserts every name in these three sets is registered
and isn't a `TOOL_ALIASES` key) to `TAINTING_CAPABILITIES` and/or `DANGEROUS_WHEN_TAINTED`,
and list any safe actions in `SAFE_ACTIONS_WHEN_TAINTED`.

## 4. Memory poisoning

Files: `packages/artie/src/engine/memory/recall.ts`, `packages/artie/src/engine/tools/core/memory.ts`.

Two independent fixes (batch 2):

1. **Read side (`recall.ts`):** a non-owner's guild memory that names the owner (by Discord
   id, `ejfox`, or the standalone word `EJ` — `mentionsOwner()`) is tagged
   `[unverified, said by <author id>]` and its importance is clamped to
   `UNVERIFIED_OWNER_MENTION_IMPORTANCE_CAP` (6) for any recall candidate pool, UNLESS the
   asker is the memory's own author or the owner (`guardGuildMentionOfOwner()`). This only
   changes what's handed to the model as a recall candidate — the stored row is untouched.
2. **Write side (`memory.ts`):** `memory:remember` and `memory:pin` cap a non-owner's
   importance at `NON_OWNER_MAX_IMPORTANCE` (6) — below the `>= 7` band that
   `recall.ts`'s `semanticLayer` both lowers the relevance threshold for (0.08 → 0.02) and
   always includes regardless of topical relevance. `pin` (which used to always set
   importance 10) now only reaches 10 for the owner; a non-owner's "pin" lands at the same
   cap. Memory write identity (`userId` can't be spoofed — `execute.ts` force-binds it to the
   real caller) was already solid before this branch and is unchanged.

**To change the cap:** both constants live next to their use (`recall.ts`,
`memory.ts`'s exported `NON_OWNER_MAX_IMPORTANCE`) — keep them equal, since the whole point
is staying under the `>= 7` recall-amplifier threshold.

## 5. http SSRF guard

Files: `packages/artie/src/engine/tools/core/http.ts`,
`packages/artie/src/engine/tools/core/web-fetch.ts`.

`http` is owner-only (§1), but an owner's own turn can be prompt-injected (a fetched page or
linked message telling Artie to call `http:get` against an internal address) — owner-only is
not injection-proof. `http.ts` used to do a raw `fetch()` with **zero** URL validation, so it
could reach Artie's own loopback-trusted internal routes (`/health/detailed`,
`/api/memories` with no `userId` scope, gateway's moderation/presence routes, …) and any
other private/internal host.

Fix: `http.ts` now reuses `web-fetch.ts`'s existing guard instead of duplicating it —
`validateUrl()` (format + literal-IP + `localhost` + port checks) plus the exported
`httpAgent`/`httpsAgent` (a guarded `dns.lookup` that re-checks every resolved IP, closing the
DNS-rebinding/redirect-to-127.0.0.1 hole that a URL-string check alone misses) and
`WEB_FETCH_MAX_REDIRECTS`. It's the same `node:net BlockList` covering loopback, RFC1918,
CGNAT, link-local (cloud metadata), and the IPv6 equivalents. `http.ts` switched from raw
`fetch()` to `axios` to pass those agents through.

**Consequence:** `http://brain:47325/...` (the capability's own old examples) now resolves
private and is blocked — intended; the examples were rewritten to public URLs.

**To add another outbound-HTTP tool:** import `validateUrl`, `httpAgent`, `httpsAgent` (and
`WEB_FETCH_MAX_REDIRECTS` if following redirects) from `web-fetch.ts` rather than writing a
new guard.

## 6. image_gen / deep_research spend

Files: `packages/artie/src/engine/tools/media/image-gen.ts`,
`packages/artie/src/engine/tools/research/harness/research-queue.ts`,
`packages/artie/src/engine/budget/daily-cap.ts`.

Both tools' real dollar cost used to be invisible to `daily-cap.ts`'s `getTodaySpendUsd`
(which sums exactly `model_usage_stats`) and so could never trip `DAILY_BUDGET_USD`'s
auto-mute. Both now call `UsageTracker.recordUsage(...)` with `step_type: 'image_gen'` /
`'deep_research'`:

- **image_gen:** records at generation time, in the capability handler. Cost is the
  OpenRouter-reported `usage.cost` (requested via `usage: { include: true }` in the request
  body) when present, else `UsageTracker.calculateCost` (bills an unrecognized model at
  top-tier rates — the codebase's existing "unknown ⇒ expensive, not free" convention).
  New per-user-per-day cap: env `ARTIE_IMAGE_GEN_PER_USER_DAY` (default 3), counted by
  `getUserActionCountToday(userId, 'image_gen')` — zero new state, the ledger write *is* the
  counter, so a restart can't reset it. The owner is exempt from both the cap and the
  brownout check below. Under `brownout.getBrownoutMode().mode === 'critical'`, non-owners
  are refused outright (no fetch call at all).
- **deep_research:** records at completion, in `research-queue.ts`'s `pollTask` (right after
  the `research_tasks.cost` UPDATE) — there is no real $ figure before the OpenAI task
  finishes, so there's necessarily a lag between submit and ledger visibility. `pollTask`
  now also calls `this.ensureTable()` defensively (it previously assumed `research_tasks`
  already existed, which is only true if `queueTask`/`listTasks` ran first in this process).

**To add a per-user cap elsewhere:** reuse `getUserActionCountToday(userId, stepType, now?)`
(`daily-cap.ts`) — it's a plain `COUNT(*)` over `model_usage_stats` for that `user_id` +
`step_type` within the America/New_York day, no new table needed as long as the spend is
already being recorded with a distinguishing `step_type`.

## 7. Autonomous moderation rate limit

Files: `packages/artie/src/gateway/routes/moderation.ts`,
`packages/artie/src/gateway/routes/moderation-service.ts`.

The feature is unchanged (Artie can still autonomously timeout someone who's abusive to him,
no human sign-off) — the audit flagged the *lack* of a backstop, not the feature itself. Now
bounded: at most 1 Artie-initiated timeout per target per 24h, at most 3 per guild per hour.
Counted by a small dedicated table, `artie_autonomous_timeouts` (own `created_at` column,
written as `new Date().toISOString()` explicitly — **not** SQLite's `DEFAULT
CURRENT_TIMESTAMP**, which formats as `"YYYY-MM-DD HH:MM:SS"`, a different string shape than
the ISO 8601 bounds callers compare against; mixing the two silently breaks the
`created_at >= ?` lexicographic comparison). This is deliberately **not** the existing
`moderation_audit` table/`ModerationService.logAction` — that table has no `CREATE TABLE`
anywhere in this codebase (per its own doc comment, it logged 0 rows against 45 real timeouts
before being partially fixed), so a rate limit built on it would silently never trigger.

**Not implemented (spec explicitly allows skipping this if too invasive):** "never act on a
target named only by a third party in the same message without the target having posted in
the channel recently." This needs a Discord channel-message fetch inside the gateway route
to check recent authorship, which is both a meaningfully bigger change and hard to cover with
the existing test harness (no live Discord client in tests). Only the rate limits shipped.

**To change the limits:** `AUTONOMOUS_TIMEOUT_PER_TARGET_PER_DAY` /
`AUTONOMOUS_TIMEOUT_PER_GUILD_PER_HOUR` constants at the top of `moderation.ts`.

## 8. Other batch-1 fixes (unchanged this round, still in effect)

- `scheduler`/`reminders`, `memory`, `user-profile` take the caller identity from
  `context.userId`, never a model-supplied param; memory recall of another user's memories is
  owner-only (`recallTargetUser`).
- `removeRole` (`gateway/routes/moderation.ts`) has the same `fetchModeratableMember`
  protected-user/staff/bot guard as `addRole`/`timeoutMember` (it used to skip it entirely).
- `GET /health/detailed` requires the Bearer token; the `/health/admin/*` fallback-secret path
  fails closed with no `ADMIN_SECRET` configured.

## Still open (flagged by the audits, out of this branch's scope)

- `isOwner`/`isOwnerConfirmed` (`shared/config/owner.ts`, `approval-gate.ts`) check only
  `userId === OWNER_USER_ID`, never `context.source` — `assemble.ts`'s `<owner_note>` prompt
  injection is the one place in the codebase that already reasons about `source` before
  trusting `userId`for owner treatment; the actual authority checks don't. Low practical risk
  today (exploitability from outside the box is already closed per `sec-authority.md`'s
  verification of `require-api-token.ts`), but still a defense-in-depth gap for anything with
  loopback/local access.
- `bot-config.ts` (runtime model tier / context size / iteration limits) has no `isOwner`
  check at all — not an authority-impersonation vector, but a "burn OpenRouter credits"
  vector.
- DM-approved users are fully exempt from the per-user "antibody" throttle
  (`gateway/2-gate/pacing.ts`) — a disgruntled formerly-trusted DM contact is a cheap
  wallet-drain vector relative to a public guild troll; only the global daily cap would ever
  slow them down.
- `replyContext`/`channelHistory` (other users' message content folded into a turn's context)
  are not tainted — only `resolvedDiscordMessages` is (§3). Same category of
  indirect-injection surface, not covered by this branch's taint-coverage item.
- Voice-transcript content fed to the scribe summarizer, and Discord attachments
  (`3-context/sources/attachments.ts`), were flagged as SUSPECTED-but-unverified injection
  vectors in `sec-abuse.md` — not independently checked or fixed here.
- "Never act on a target named only by a third party" for autonomous moderation — see §7.
- `filesystem.ts`, `n8n-browser.ts`, `sandbox.ts` beyond their taint/owner-only coverage: not
  re-verified for whether any action writes outside the sandbox/outside EJ's intent.
- Burst-batch userId attribution when EJ's message merges with others' in the same batch —
  only confirmed `on-message.ts` uses `message.author.id === OWNER_USER_ID` for the "EJ
  bypasses batching" check; how the eventual `context.userId` is picked for a merged batch
  wasn't traced further.

## Bench / verification (this branch)

- Branch `v3-sec2`, based on `a4b9fae`. Bench `/data2/tmp/artie-v3-sec2` on `ssh vps`.
- `npx tsc --noEmit`: clean.
- `pnpm -s lint`: 0 errors (117 pre-existing warnings, none new).
- `pnpm -s test`: 1300 passed / 1 failed / 6 skipped. The 1 failure
  (`tests/engine/recall-reasons.test.ts`, "does not change which memories are selected or
  their order") is **pre-existing** — reproduced identically on the unmodified `a4b9fae`
  checkout (`/data2/tmp/artie-v3`), both run in isolation and as part of the full suite. Not
  a regression from this branch.
