# Tool-loop cleanup notes (2026-10-26)

Branch `v3-tools`, off `v3`. Scope: the bot's own three asks — collapse the memory zoo, prune/
consolidate tools (hello-world, stripe/email approval), and make tool failures loud to the
model instead of swallowed. Bench: `/data2/tmp/artie-v3-tools` on the VPS. Final state:
`pnpm typecheck` clean, `pnpm test` **1020 passed / 6 skipped** (baseline before this work was
985 passed / 6 skipped — net +35 tests, 0 regressions, 0 failures).

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
| `email` | `send` (**both** the bare capability and the drafting flow's real send — see below) | `status` |
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

**Audit findings, found by re-checking this design against itself before calling it done:**

- **The real email-send path bypassed the gate entirely.** `email-drafting.ts` is *not* a
  registered capability (`tests/architecture.test.ts` lists it as a TOOL_HELPER, "routed from
  run-turn") — it's the flow that detects email intent, drafts with an LLM, and sends on the
  user's "send" reply, and it's how almost every real email actually goes out. Its
  `handleSendDraft()` called `emailCapability.handler()` **directly**, never touching
  `CapabilityRegistry.execute()` — so gating the bare `email` capability's `send` action did
  nothing for the path that matters. Fixed: it now calls
  `capabilityRegistry.execute('email', 'send', ..., { userId: message.userId })`, same as any
  other call, so it hits the gate like everything else. (The `'email-drafting'` row in
  `GATED_ACTIONS` from the first pass was consequently dead code — a name that's never a
  registered capability can never be looked up by `isGatedAction`. Removed.)
- **`confirmed: true` was trustable from a live model tool call, not just from `approvals.ts`'s
  replay.** `isOwnerConfirmed()` only checks `context.userId === OWNER_USER_ID &&
  params.confirmed === true` — and `params` comes straight from the model's tool-call
  arguments. In EJ's own conversation, nothing stopped Artie from deciding on its own to add
  `confirmed: true` to a stripe call and skip the gate without EJ having said yes to anything.
  Fixed: `executeNativeToolCall` (the one entry point every native tool call goes through)
  now strips `confirmed` out of the model's own params before `resolveToolCall` ever sees
  them. The only remaining path that can set it is `approvals.ts`'s own direct call to
  `capabilityRegistry.execute()`, which bypasses `executeNativeToolCall` entirely. (The legacy
  XML loop's equivalent call site wasn't touched — it's `// XML-LOOP`-marked and frozen until
  the soak ends — so this specific hardening is native-mode-only; XML mode is the emergency
  rollback, not the live default, but it's listed here rather than assumed fixed everywhere.)
- **A replayed approval lost its Discord context.** `pending_actions` originally stored only
  `params`, so `approvals:approve` replayed with `{ userId: owner }` and nothing else — a tool
  that reads `context.guildId`/`channelId` would behave differently on replay than it would
  have at the original call site. Fixed: the row now also stores `context_json`
  (guildId/channelId/messageId at request time) and `approve` merges it back in, overriding
  only `userId`.
- **A gated call's `content` (the 4th positional arg to `execute()`, separate from `params`)
  was dropped on the way into `pending_actions` and never replayed.** This is a defect in the
  fix above, not a pre-existing bug — found by re-reading the exact path the email-drafting
  fix now takes: `handleSendDraft()` calls `execute('email', 'send', {to, subject, from},
  draft.body, ctx)` — the drafted **body** rides in `content`, not `params`. The gate block
  only captured `params`/`context`; approving a gated drafted email would have sent with no
  body at all. Fixed the same way as `context_json`: `pending_actions` got a `content` column,
  `createPendingAction`/`approve` pass it through, and `approvals:list` now shows a preview of
  it. `tests/engine/approval-gate.test.ts`'s content round-trip test (a stub tool whose result
  echoes `content`) is the regression test for this specific class of bug.
- **Checked, not a bug:** `deleteMemory`'s plain `DELETE FROM memories WHERE id = ?` doesn't
  separately touch `memories_fts`. Confirmed this is fine —
  `reference-docs/migrations/schema.sql` has a `memories_fts_delete` trigger (`AFTER DELETE ON
  memories`) that keeps the FTS index in sync automatically in any DB that trigger actually
  ran against. The "no such table: memories_fts" warning that appears in the test suite's
  stderr is a pre-existing gap in the *test* DB's bootstrap (`client.ts`'s `initializeDb()`
  never creates the FTS virtual tables or their triggers — that's historical, not something
  this branch changed), not something `forget` introduced.

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
| `memory` (6 vs 9 actions; description rewritten once — see below) | ~59 tok | ~91 tok | **+32** |
| `hello-world` (removed) | ~26 tok | 0 | **−26** |
| `approvals` (new) | 0 | ~52 tok | **+52** |

**Net: the roster grew by ~58 tokens**, not shrank. The action list genuinely got smaller
(memory: 9→6 names; the roster no longer lists `add`/`save`/`store`/`search` as if they were
distinct from `remember`/`recall`), but the new `approvals` tool adds a whole new line, and
`memory`'s description grew to say what it's *not* for.

That description went through two drafts, worth recording because the first one was a bug.
The first version said memory "replaces scratchpad/variable/system_memory for ordinary facts"
and listed `guild`/`scratch` as example `kind` values, with "see TOOLS-NOTES.md" for the rest
— which actively steers the model toward writing guild notes into `memory` with
`kind: 'guild'`, exactly the silent-split §1 says scratchpad can't safely be routed into
(`gateway/1-receive/guild-context.ts` reads the scratchpad *file* directly and would never
see a note written to `memory` instead), and pointed at a file the model can't read. Caught
on review, not written then shipped. Rewritten to route rather than claim replacement: it
now says what memory IS for (facts about a person) and names scratchpad/user-profile by name
for what it explicitly is NOT for, with no file reference. That cost 32 tokens instead of 49
— still not free, but it's the honest price of a tool boundary a model actually has to
respect, not an explanation that belongs in this file instead.

## Open questions

1. **Scratchpad really is the bot's stated pain point**, and I didn't fix it — only
   documented why it's hard. If EJ wants it unified, the real fix is moving
   `gateway/1-receive/guild-context.ts`'s direct file read onto the same `memory`/hybrid-layer
   path the tool would use, which is a bigger, riskier change (it runs on every turn in both
   live guilds) than this task's budget covered.
2. **`context.results` success bookkeeping** doesn't know about `looksLikeToolFailure` (see
   §3's known gap) — health/usage stats will undercount these failures until that's wired up
   too.
3. **Roster token count went up, not down** (see above) — already trimmed once (108→91 tok
   for the `memory` line, after the description rewrite in finding #1 above); further cuts
   trade directly against the routing text that keeps the model out of scratchpad/user-profile,
   so I'd weigh that tradeoff explicitly before cutting more rather than cutting blind.
4. **The approval gate has no expiry/cleanup** — a denied or forgotten pending action sits in
   `pending_actions` forever. Fine at today's volume; worth a TTL or a `scheduler.ts` sweep if
   the queue ever actually fills up.
5. **`variable`** needed no code change (already excluded from the native roster via
   `XML_ONLY_TOOLS`), confirmed rather than assumed by reading `mode.ts`.
6. **The `confirmed`-stripping fix is native-loop-only.** The legacy XML loop has its own
   call-execution site (`5-tool-loop/loop.ts`) that also eventually reaches
   `registry.execute()`; it wasn't given the same strip because its code is `// XML-LOOP`-
   marked and frozen until the soak ends, and native is the live default. If `TOOL_LOOP=xml`
   is ever actually flipped on in prod before that code is deleted, re-check whether a model
   could set `confirmed` through that path too.
7. **Non-LLM callers of a gated action** (a scheduler job, a script hitting the HTTP
   `/capabilities/execute` route) would now queue as pending with `requestedBy: 'unknown-user'`
   whenever they don't pass a `context.userId`, rather than running — fail-closed, and a real
   behavior change from this branch if it ever applies. Checked whether it applies today:
   `grep -rn "capabilityRegistry.execute\|registry.execute\|emailCapability\|redditCapability"
   src/engine/proactive src/engine/jobs src/engine/routes src/gateway`. The only hits are
   `routes/memories.ts` (`memory:search`, not gated) and `routes/tool-registry.ts`'s own
   generic `execute()` passthrough (whatever caller/context hits that HTTP route — same path,
   same rules, nothing special). `proactive/delivery.ts` declares `'email'` as a
   `DeliveryChannel` type member but has no `case 'email'` that actually sends anything yet;
   `proactive/reddit-mentions.ts` and `morning-briefing.ts`'s `'reddit'` references are source
   labels and config keys, not tool calls. So: no scheduler/proactive job calls a gated action
   today. Worth re-checking if `delivery.ts` ever grows a real email-sending case — it would
   need its own owner-context, or an explicit decision that queued reminders fail closed too.
8. **`skills/registry.ts`'s `reload(name)`** (a *single*-skill reload, distinct from
   `reloadAll()`) had its own `capabilityRegistry.register(capability)` call that bypassed the
   same `TOOL_ALIASES` skip `initialize()` got — `skills:reload` on `hello-world` specifically
   would have re-registered it as its own capability, undoing the merge at runtime (caught by
   re-reading the file for every `register` call-site, not by a test — none of the existing
   tests call `reload()` on a merged name). Fixed with the same one-line skip.
9. **No dedicated unit test for the email-drafting fix itself** — `EmailDraftingService`'s
   draft state is populated by `handleEmailWritingMode()`, which calls the real
   `openRouterService`/`contextAlchemy` to draft with an LLM, so testing `handleSendDraft()`
   directly needs mocking that's out of this task's budget. The fix is covered indirectly:
   it now goes through the exact same `capabilityRegistry.execute('email', 'send', ...)` call
   the existing `email:send` gate test in `approval-gate.test.ts` already exercises, and
   `pnpm typecheck` confirms the new call shape compiles. Worth a real test if this flow gets
   touched again.
10. **EJ's own stripe/email calls are a two-step flow now, not one-shot.** Stripping
    `confirmed` (finding #2 above) means even EJ can't tell Artie "send that payment link" and
    have it happen in one turn — it queues, then he has to separately run
    `approvals:approve`. That's the correct call under "ambiguity means no" (a model deciding
    on its own that EJ said yes is exactly the ambiguity that rule exists for), but it's a
    felt UX change for the one person this gate is supposed to defer to, not just a safety
    detail — worth confirming he actually wants the two-step every time, versus e.g. some
    lower-friction "EJ said yes in this exact message" signal that isn't model-settable.
11. **Nothing notifies EJ when something queues.** The requester gets the ⏸️ message; EJ only
    learns a pending action exists by running `approvals:list` himself. The task asked for the
    record (a place pending actions land), not a push notification, so this isn't a defect —
    but the realistic failure mode is a stripe link or an email sitting unseen in the queue
    for a week because nothing surfaced it. Worth a line in `heartbeat.ts` or a DM on create
    if that's wanted.
12. **A gated drafted email's state after queuing is a little loose.** `handleSendDraft()`
    leaves the draft as `'draft'` (not `'sent'`) while its pending action waits — correct, so
    the user could in principle retry — but nothing tells the user it's pending EJ's review
    instead of sent, and nothing stops them from saying "send" again, which creates a SECOND
    pending action for the same email (not a double-send — each still needs its own
    `approvals:approve` — just two queue entries for one draft). Fine at today's volume; worth
    tightening if gated email drafts turn out to be common.
