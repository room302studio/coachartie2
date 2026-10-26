# Tool-loop cleanup notes (2026-10-26)

Branch `v3-tools`, off `v3`. Scope: the bot's own three asks — collapse the memory zoo, prune/
consolidate tools (hello-world, stripe/email approval), and make tool failures loud to the
model instead of swallowed. Bench: `/data2/tmp/artie-v3-tools` on the VPS. Final state:
`pnpm typecheck` clean, `pnpm test` **1015 passed / 6 skipped** (baseline before this work was
985 passed / 6 skipped — net +30 tests, 0 regressions, 0 failures).

## 1. The memory zoo: what unified, what didn't, and why

The bot's complaint: *"memory, scratchpad, variable, system_memory, goal and goals,
user-profile. I never know where a fact lives."* Inventory, each with its storage and its
real consumers:

| Tool | Storage | Consumers | Verdict |
|---|---|---|---|
| `memory` | `memories` table (hybridDataLayer, hot cache + SQLite) | the LLM only, via the tool | **canonical** — kept, extended |
| `scratchpad` | one Markdown file per guild on disk (`CAPABILITIES_GUILD_NOTES`) | the LLM via the tool, **and** `gateway/1-receive/guild-context.ts` reads the file directly, outside any tool call, to build context for every turn | **kept separate** |
| `system_memory` | its own `system_memory` table, keyed by `agent` (`'artie'` / `'vps-claude'`), not by Discord `userId` | Artie **and** VPS Claude (a different process); VPS Claude also writes a *separate* Postgres `mesh_memories` for its own durable cross-session memory | **kept separate** |
| `user-profile` | `UserProfileService`, one row per user, one column per attribute (`email`, `github`, `timezone`, …), with per-attribute validation (email/phone format) | the LLM only | **kept separate** |
| `goal` / `goals` | `objectives` + `goal_actions` tables, its own status/progress/`achieved_at` lifecycle | the LLM, the scheduler (nudges) | **kept separate** — named as an exception in the brief itself |
| `variable` (XML-LOOP) | `global_variables` table, `{{key}}` template substitution for the legacy XML tool loop | the XML loop's template substitutor only; **not offered to the model in native mode at all** (`XML_ONLY_TOOLS` in `5-tool-loop/mode.ts` already excludes it from `registryToTools`) | **kept separate** — named as an exception; also already correctly out of the native roster, no change needed |

**Why scratchpad, system_memory and user-profile can't fold into `memory` without breaking
something**, in order of how close they look to "just another kind":

- **scratchpad** is the closest call. Its *tool* actions (note/read/section/append/write/
  clear) could plausibly become `memory` rows tagged `kind: 'guild'`. But
  `gateway/1-receive/guild-context.ts` reads the **file** directly — not through the tool,
  not through `hybridDataLayer` — on every turn, to assemble guild context. Routing the tool
  through `memory` while that reader keeps reading the file would silently split guild notes
  across two places with no sync, which is the exact bug this task exists to fix, just moved.
  Fixing it properly means rewriting that reader too, which is out of scope for "add a `kind`
  param" and risks a path that runs on every single turn in two live guilds. Left alone.
- **system_memory** isn't scoped to a Discord user at all — its primary key is `agent`
  (`artie` / `vps-claude`), and its `check_handoffs` query filters on
  `json_extract(metadata, '$.for')`. Memory's whole schema and every recall path assume a
  Discord `userId`. Forcing cross-agent handoffs into that shape means inventing a fake
  `userId` namespace for "vps-claude" and hoping nothing in recall/stats ever surfaces it to
  a real human. Left alone.
- **user-profile** is key→value with *validated* keys (email regex, international phone
  regex) and `get`/`set` **by attribute name** — "what's their github handle" needs an exact
  answer, not a fuzzy-tagged recall hit. `memory` has no notion of "the current value of
  attribute X for this user"; it's an append-only log of facts. Left alone.

**What did unify — `memory` itself, extended:**

- Added `kind` (optional param): `person`, `guild`, `pinned`, `scratch`, `goal`, or anything
  else — folded straight into the existing `tags` array (`engine/tools/core/memory.ts`,
  `handleMemoryAction`'s `remember` case). This doesn't move any data or require a migration;
  it's the same `tags` column the hybrid layer already has, just with a documented
  convention for "what kind of memory is this" instead of ad-hoc free text.
- Added `forget` (new action): ownership-checked delete, backed by a new
  `HybridDataLayer.deleteMemory()` (`engine/memory/store.ts`) that mirrors `updateMemory`'s
  shape — hot cache removed immediately, cold-storage `DELETE` queued on the same write
  queue. `memories` rows were never deletable from a tool before this.
- `pinMemory` used to catch its own failures and `return` a `❌ ...` string (never thrown) —
  see §3. Now throws, same as every other memory failure path.
- Trimmed `supportedActions` from nine names to six: `remember`, `recall`, `forget`, `pin`,
  `recent`, `stats`. The dropped names (`store`/`save`/`add`/`search`/`delete`/`remove`) still
  work — `ACTION_ALIASES.memory` in `5-tool-loop/registry.ts` already normalized
  store/save/add/retrieve/get before this change; `search`, `delete` and `remove` were added
  to that same map. Because `CapabilityRegistry.execute()` rewrites the action to its
  canonical name *before* calling the handler, the handler's `switch` only needs to match
  canonical names now — the old synonym cases were dead code once the alias exists.
- Existing rows are untouched. No migration ran, no column changed, no data moved.

## 2. Tool pruning and consolidation

**`sandbox` is already the one shell/edit/git/search tool** — wave 4 (2026-10-23, before this
branch) already merged `shell`/`edit`/`git`/dev-`search` into `engine/tools/dev/sandbox.ts`,
aliased via `TOOL_ALIASES`. `filesystem` (`engine/tools/dev/filesystem.ts`) stays a separate
tool on purpose: it's **read-only access to the host repo tree** (`REPO_ROOT`, with a
realpath/symlink jail), where `sandbox` is `docker exec` into a *different* machine entirely
(`SANDBOX_CONTAINER_NAME`, Artie's own Linux sandbox). Aliasing filesystem into sandbox would
silently relocate where a read actually happens — a real behavior change, not a rename — so
it was left alone and is documented here instead.

**`hello-world`** (an OpenClaw-format example skill — SKILL.md, zero real use, actions
greet/wave/introduce) is merged per F1 (merge zero-use tools, don't delete):

- `TOOL_ALIASES['hello-world']` in `registry.ts` routes all three actions to a new `ping`
  action on `diagnose` (`engine/tools/ops/diagnose.ts`) — a harmless, argument-free liveness
  check. `diagnose` was the natural home: the brief suggested "fold it into a diagnostics
  tool" and diagnose already exists for "is something wrong" checks.
  `tests/engine/tool-aliases.test.ts` pins `hello-world:{greet,wave,introduce}` →
  `diagnose:ping` end-to-end, including actually running it.
- The `SKILL.md` file at `packages/artie/src/engine/tools/skills/library/hello-world/`
  **was not deleted** — F1 says merge, not delete. Instead, `skills/registry.ts` now skips
  auto-registering any discovered skill whose name already has a `TOOL_ALIASES` entry, so the
  file stays on disk but doesn't occupy its own roster slot.

**Approval gate** (`engine/5-tool-loop/approval-gate.ts` + `shared/pending-actions.ts` +
`engine/tools/ops/approvals.ts`): the owner ruling was "any tool that sends email, moves
money (stripe), or acts outside Discord must require the owner's approval." Enumerated every
tool that talks to something outside this process (`grep` for axios/fetch/stripe/webhook
across `engine/tools/`) and classified by **action**, not whole tool, so a read doesn't get
blocked along with the write that actually needs sign-off:

| Tool | Gated actions | Left open |
|---|---|---|
| `stripe` | all (`create_payment_link`, `deactivate_payment_link`) | — (it's money, full stop) |
| `email` | `send` | `status` |
| `email-drafting` | `send` (the actual send step) | draft/edit/cancel |
| `reddit` | `post`, `comment` | `read`, `search`, `mentions`, `status`, `list-subreddits` |
| `github` | `create_issue`, `update_issue` | every read action (`list_issues`, `search_issues`, `get_*`, …) |
| `mediawiki` | `write`, `add` | `read`, `search`, `list` |
| `http` | `post`, `put`, `delete` | `get` |

A gated call from anyone but `OWNER_USER_ID` — or from the owner without `confirmed: true`
in params — creates a `pending_actions` row (new table, same lazy
`CREATE TABLE IF NOT EXISTS` pattern `system-memory.ts` already uses; no schema.ts/migration
change) and returns a plain `⏸️ This x:y call needs EJ's approval first (pending #N)` instead
of running. Checked in `CapabilityRegistry.execute()`, right after `resolveToolCall` — the one
function every call path (native loop → `robustExecutor` → `registry.execute`, the legacy XML
loop, and the HTTP `/capabilities/execute` route) already shares, so the gate can't be
bypassed by calling a tool's old alias name either.

The `approvals` tool (owner-only, same `isOwner()` check `pairing.ts` uses) is how EJ actually
resolves one: `list` shows what's pending, `deny` drops it, `approve` re-runs the **exact**
original call with `confirmed: true` — so approving genuinely does the thing, not just flips
a flag and leaves EJ to retype the command.

I looked for an existing approval/pending mechanism before building one: `dm-pairing.ts`
(`approve`/`deny` pairing codes) is the closest precedent and shaped `pending_actions`'
approve/deny vocabulary, but it's specifically about who may DM the bot, not about gating a
tool call — reusing its table would have mixed two unrelated "pending" concepts in one place.

## 3. Loud fallbacks

Found by reading every tool's `catch` block for what it does instead of re-throwing. The
`CapabilityExecutor`/`robustExecutor` path only prefixes a result with `Error: ` when the
handler **threw**; `robust.success` is `true` whenever the handler returned *anything*
without throwing — so a handler that catches its own failure and `return`s a string
describing it (instead of letting the throw happen) produces a tool result that is
byte-for-byte indistinguishable from a real success, from the model's point of view. Found
this pattern in `scratchpad.ts`, `system-memory.ts`, the old `memory.ts` `pinMemory`, `goals.ts`,
`tasks.ts`, `sandbox.ts`, `diagnose.ts`, `stripe.ts`, `discord/{reaction,poll,moderation}.ts`,
`email-drafting.ts`, `context.ts`, `autonomous.ts`, `pairing.ts`, `embedded-mcp-runtime.ts`,
and more — basically most tools, to varying degrees.

Rather than touch every file (high blast radius for a production bot, and the fix is the same
shape everywhere), the fix is centralized: `executeNativeToolCall` in `5-tool-loop/execute.ts`
now runs every would-be-success result through `looksLikeToolFailure()` before deciding
whether to prefix it with `Error:`. That function flags:

- a leading `❌` (memory, email-drafting, autonomous, sandbox's edit errors, …),
- `"<Words> error: "` at the very start of the string (scratchpad, goals, tasks, context,
  diagnose, …),
- a bare `"Error: "` prefix (sandbox's edit/search, pairing, autonomous),
- a JSON object/array whose top-level `success` field is `false` (system_memory, stripe,
  discord reaction/poll/moderation, http).

It's deliberately prefix-anchored, not a loose `/error/i` scan, so it doesn't flag ordinary
content that happens to mention "error" mid-sentence (tested explicitly) or a normal `✅
Remembered: ...` success message. `tests/engine/execute.test.ts` has the full table of cases,
positive and negative.

I also fixed the three handlers the audit actually exercises in tests directly, as the loudest
case (throwing beats "the central detector happened to catch this one too"): `memory.ts`'s
`pinMemory` and new `forgetMemory` now throw on not-found/unauthorized instead of returning a
`❌` string. I left `scratchpad.ts` and `system-memory.ts` as-is (still return-not-throw) since
the central detector now catches their failure shapes before the model sees them, and
rewriting their control flow risked more behavior change than the bug was worth fixing twice.

**Known gap**: `context.results` (used for health/usage tracking, not shown to the model)
still records `success: true` for a self-reported failure that `looksLikeToolFailure` caught,
because that bookkeeping reads `robust.success` directly, upstream of the new check. The model
now sees the failure loudly; usage stats don't yet. Flagged as an open question below rather
than fixed, since touching usage/health tracking felt out of scope for "the tool-result
message he gets."

## Roster size

Measured by reconstructing each changed roster line (`- name [actions]: description`, the
exact shape `buildCapabilityRoster` emits) and counting chars/4 as an approximate token count
— no tokenizer package is in `package.json` on the VPS bench, and installing one wasn't worth
it for an estimate. Caveat: chars/4 is a rough average, not exact BPE tokenization.

| Line | Before | After | Δ |
|---|---|---|---|
| `memory` (6 vs 9 actions, longer description explaining what it replaced) | ~59 tok | ~108 tok | **+49** |
| `hello-world` (removed) | ~26 tok | 0 | **−26** |
| `approvals` (new) | 0 | ~52 tok | **+52** |

**Net: the roster grew by ~75 tokens**, not shrank. The action list genuinely got smaller
(memory: 9→6 names; the roster no longer lists `add`/`save`/`store`/`search` as if they were
distinct from `remember`/`recall`), but `memory`'s description grew to explain what it
absorbed, and the new `approvals` tool adds a whole new line. If the goal is strictly token
count, the next move is trimming `memory`'s description back down (the "what replaced what"
explanation belongs in this file, not the live prompt) — left as an open question below
rather than done here, since I'd rather the first version of a changed tool's prompt text be
over-explained than under-explained while it's new.

## Open questions

1. **Scratchpad really is the bot's stated pain point**, and I didn't fix it — only
   documented why it's hard. If EJ wants it unified, the real fix is moving
   `gateway/1-receive/guild-context.ts`'s direct file read onto the same `memory`/hybrid-layer
   path the tool would use, which is a bigger, riskier change (it runs on every turn in both
   live guilds) than this task's budget covered.
2. **`context.results` success bookkeeping** doesn't know about `looksLikeToolFailure` (see
   §3's known gap) — health/usage stats will undercount these failures until that's wired up
   too.
3. **Roster token count went up, not down** (see above) — trimming `memory`'s description is
   the obvious next step if that matters more than the explanation staying in the prompt.
4. **The approval gate has no expiry/cleanup** — a denied or forgotten pending action sits in
   `pending_actions` forever. Fine at today's volume; worth a TTL or a `scheduler.ts` sweep if
   the queue ever actually fills up.
5. **`variable`** needed no code change (already excluded from the native roster via
   `XML_ONLY_TOOLS`), confirmed rather than assumed by reading `mode.ts`.
