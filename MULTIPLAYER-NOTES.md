# Multiplayer: who's talking to whom, burst debounce, real-time reactions

Branch `v3-multiplayer` off `v3`. Three features the bot asked for, built around the current
constraint that the Discord app lacks the privileged MessageContent/GuildMembers intents
(`DISCORD_PRIVILEGED_INTENTS` unset) — everything below works today on text-blank messages from
other people, and gets richer automatically the moment that env var flips to `true` and the
process restarts. No code here branches on `privilegedIntents`; it all branches on whether
`content` happens to be non-empty, which is exactly what makes that true.

## 1. Who's talking to whom

**Files:**
- `packages/artie/src/gateway/1-receive/channel-history.ts` — new exported `resolveAddressing()`
- `packages/artie/src/engine/3-context/sources/transcript.ts` — new `DiscordHistoryEntry` fields
  + `formatAddressingSuffix()`; `renderDiscordTranscript()` no longer drops metadata-only lines
- `packages/artie/src/engine/3-context/assemble.ts` — `discordChannelHistory` now typed as
  `DiscordHistoryEntry[]` (was an inline duplicate of the same shape)

**What it does:** every history line fetched for context now carries, when available:
`replyToAuthor` / `replyToIsSelf` / `replyToExcerpt` (who it's a Discord reply to, and — only
when that target is Artie's own message, which is in the already-fetched window — a short
excerpt of what he said), `mentions` (display names it `@`-pings, Artie excluded), and
`addressedElsewhere` (true when the line replies to or pings a human who isn't Artie, with no
mention of Artie in the same line — "this message was for someone else").

This all resolves from `message.reference`/`message.mentions.repliedUser`/`message.mentions.users`
— fields discord.js fills from the gateway payload regardless of the MessageContent intent (the
same fact `isReplyToBot` in `gateway/2-gate/speak-gate.ts` already relied on). So a line from
someone who never pinged Artie, whose `content` is blank today, still renders as e.g.
`Alice [↳@Bob (not to you)]: [no text]` instead of being silently dropped — exactly the
"metadata survives even when text doesn't" case the task asked for. Once privileged intents are
on, `content` stops being blank and the excerpt/content quality both improve automatically; no
code change needed.

Rendered compactly: a line's suffix is `[↳@Bob]` (reply), `[↳you ("excerpt…")]` (reply to Artie,
truncated to 60 chars), `[→@Bob,@Carol]` (mentions), and/or `[(not to you)]`, combined in one
bracket, e.g. `Alice [↳@Bob →@Carol (not to you)]: hey Carol tell Bob...`.

**Known gap, not fixed (left for a follow-up):** a reply target OUTSIDE the fetched
channel-history window (an old message, further back than `MAX_CHANNEL_HISTORY`=25) still gets
an author name (from `mentions.repliedUser`) but never an excerpt, even if the target was
Artie's own message — fetching it would be a second Discord API call per history line, which
isn't worth it for a context block that's already paid for once per turn.

## 2. Burst debounce + "landed while you were thinking"

**Files:**
- `packages/artie/src/gateway/3-ask-engine/burst.ts` — `BurstScheduler` (generic, no
  discord.js types), `combineBurstContent`, `renderBurstForContext`, `burstDebounceMs()`
- `packages/artie/src/gateway/1-receive/channel-activity.ts` — per-channel ring buffer +
  `pickLandedMessages`/`formatLandedNote`
- `packages/artie/src/gateway/1-receive/on-message.ts` — wiring: a `record-activity` step
  (feeds the ring buffer) and the burst scheduler replacing the direct
  `handleMessageAsIntent` call in the "shouldRespond" branch
- `packages/artie/src/gateway/3-ask-engine/build-request.ts` — `extraContext` param merged
  into `discordContext`
- `packages/artie/src/engine/3-context/assemble.ts` — renders `ctx.burst` /
  `ctx.landedWhileThinking` as two optional lines in `discord_situational`

**Env knob:** `BURST_DEBOUNCE_MS` (default `2500`, `0` disables added latency but still folds
same-tick arrivals; read fresh each time a NEW batch opens, so changing it mid-run only affects
the next batch).

**How it works:** `on-message.ts`'s `respondOrObserve` step runs every existing gate exactly as
before — dedup, antibody (a message antibody silences never joins a batch at all), the DM
bypass — and only at the very end, for a non-DM message that will get a response, pushes the
message into `BurstScheduler` keyed by `channelId:authorId` instead of calling
`handleMessageAsIntent` directly. **Review change (2026-10-26):** the builder keyed by channel
alone, which mixed authors into one turn under the newest author's userId. The owner bypass
only covered EJ; staff-role checks, memory attribution and per-user tools also read userId.
So a batch is now one person's rapid-fire messages, and everyone else in the channel arrives
through the landed note. The scheduler starts a timer on the FIRST item in a channel's batch and does NOT
reset it for later arrivals — that's the "never waits longer than the window" guarantee: no
matter how many messages join, the batch fires at `firstArrival + windowMs`, never later. The
map entry is deleted the instant the timer fires, before the flush callback runs, so a message
arriving mid-flush (while the LLM/tool-loop for the previous batch is still running) always
starts a brand-new batch — there is no "batch in flight" state to join.

A flushed batch becomes ONE turn: `combineBurstContent` renders a lone message unchanged (the
overwhelmingly common case, byte-identical context to before this feature) and a real burst as
one `Author: text` line per message. The reply targets the NEWEST message in the batch (keeps
the Discord reply arrow pointed at the live conversation) using the NEWEST message's
antibody-adjusted guild context; the correlation id is the batch LEADER's, so trace latency
honestly reflects the added batching delay. `discordContext.burst` carries the raw list (author,
content, messageId) for anyone downstream who wants it; the engine only uses it for one headline
line since the combined text already shows who said what.

**"Landed while you were thinking" (2b):** a separate `record-activity` step runs for every
message that reaches that point in the pipeline (not just ones that get batched — ambient
chatter from a third person counts too) and writes it into `channel-activity.ts`'s per-channel
ring buffer (10-minute TTL, 40 entries/channel, in memory only). At flush time,
`pickLandedMessages` reads that buffer for anything with a timestamp after the batch's leader
was enqueued that ISN'T one of the batch's own message ids, and `formatLandedNote` turns up to 5
of them into one line: `discordContext.landedWhileThinking`.

**Known limitation (documented, not fixed):** this only catches what arrived during the
debounce WINDOW (up to `BURST_DEBOUNCE_MS`), not what arrives during the subsequent LLM
generation / tool loop (which can run far longer). The task explicitly allowed either timing
("just before generating, or just before sending if simpler and safe"); the richer version —
reading the ring buffer right before `respond()` actually sends, so it covers the full
processing time — needs either a `gateway/api.ts` seam addition (the engine calling back into
the gateway's ring buffer right before delivery) or moving the read into
`discord-reply.ts`'s `respond()` closure. Both are straightforward follow-ups; this PR ships the
cheaper, fully-testable version first per the plan, and the gap is a real but bounded miss (it
still catches the common "three people typing over each other within a couple seconds" case,
just not "someone replies 45 seconds into a tool loop").

**Not fixed, flagged for a human call:** `recordAmbientResponse()` / `markRespondToAllCooldown()`
still fire once per ORIGINAL message before batching, not once per flushed batch — so a batched
ambient burst overcounts against the hourly ambient budget relative to how many replies actually
went out. Conservative direction (undercounts how much Artie can still say, never overcounts),
left as-is rather than risking a budget-gate change under this PR's scope.

## 3. Reactions in real time

**Files:**
- `packages/artie/src/gateway/1-receive/reaction-log.ts` — `recordReaction`,
  `getRecentReactions`, `formatRecentReactionsNote`
- `packages/artie/src/gateway/1-receive/on-reaction.ts` — records every reaction (not just the
  sentiment-tracked ones) right after the existing dedup check
- `packages/artie/src/gateway/3-ask-engine/build-request.ts` — surfaces
  `discordContext.recentReactions`
- `packages/artie/src/engine/3-context/assemble.ts` — renders it as one line

`GatewayIntentBits.GuildMessageReactions` was already requested unconditionally in
`gateway/main.ts` (it's not privileged) — no intent change needed for this feature.

`on-reaction.ts` already dedupes reactions and already only looks at reactions on Artie's own
messages (both kept exactly as-is). I added one `recordReaction()` call right after the dedup
check, before the `switch` that only handles 🔄/👍/👎/the sentiment list — this is the fix for
"I want to see it then, not in a batch later": EVERY emoji on Artie's own recent messages is now
logged (who, which emoji, which message, a short excerpt, when), in memory, 30-minute TTL,
50 entries/channel.

The existing batch-processed path (`handleFeedbackReaction`, which writes the durable
memory/trace-feedback record for the sentiment-bearing emoji subset) is untouched and NOT
duplicated — this is purely additive, read-only logging for the live-context surfacing.
`build-request.ts` reads `getRecentReactions(channelId)` on every turn and renders up to 5,
newest first, as one line: `Recent reactions to your messages here: @Bob 👎 on "here's my
take..." (4m ago); ...`.

## Token cost per reply (measured, not estimated)

`packages/artie/tests/engine/transcript-addressing-cost.test.ts` renders each feature's
representative fixture through the real functions and prints the result via the repo's own
`estimateTokens`. Actual numbers from that run:

- **Feature 1, worst case** — a full 25-line window where EVERY line is from someone who never
  pinged Artie (so `content` is blank under non-privileged intents) and every line carries
  reply/mention metadata, alternating reply-to-someone-else and @-mentions-someone-else:
  **257 tokens**. Under the PREVIOUS behavior every one of those 25 lines would have been
  dropped entirely (0 tokens) — so this is the true worst-case cost of "don't drop the line,
  attribute it instead," not a diff against a non-empty baseline. This case is rare in
  practice (a channel where literally nobody ever addresses Artie directly); typical channels
  mix in plenty of blank, metadata-free lines that still drop.
- **Feature 1, normal case** — 25 lines that all HAVE real content, each also carrying a reply
  target and an @-mention: **+120 tokens** over the same 25 lines with no addressing metadata.
  This is the overhead on top of an already-populated transcript, which is the common case once
  privileged intents are on.
- **Feature 2a** — combined content for a 3-person burst (short, realistic messages): **22
  tokens** for the combined `<user_message>` body. Only present for a real burst (>1 message);
  a lone message costs 0 extra (passes through unchanged).
- **Feature 2b** — the "landed while you were thinking" note for 3 landed messages: **51
  tokens**. Only present when something actually landed during the debounce window.
- **Feature 3** — the recent-reactions note at its cap of 5 reactions, each with an excerpt:
  **93 tokens**. Only present when Artie's recent messages in that channel got reacted to in the
  last 30 minutes.

Realistic worst case per reply (busy robot channel, rich addressing metadata throughout history,
a real burst, something landed, reactions capped): roughly **257 + 22 + 51 + 93 ≈ 420 extra
tokens** on top of the existing prompt. Typical case is far lower — most of these blocks are
absent most of the time (no burst, nothing landed, no recent reactions, and most history lines
carry no addressing metadata at all), so the common added cost is closer to the "+120" feature-1
overhead alone, or $0 when even that's absent.

## Behavior with / without `DISCORD_PRIVILEGED_INTENTS`

- **Without it (current prod state):** other people's `message.content` arrives blank unless
  they `@`-mention Artie or DM him. Feature 1 still resolves reply-to/@-mention metadata (not
  gated by the intent) and renders `[no text]` placeholders for the content. Feature 2's burst
  combine falls back to `[no text]` for a burst member with no readable content; the debounce
  and "landed" mechanics work identically either way (they key off message ARRIVAL, not
  content). Feature 3 is fully unaffected (reactions were never content-gated).
- **With it (once verification lands and the process restarts):** feature 1's reply excerpts and
  `[no text]` placeholders start carrying real text automatically — same code path, richer
  input. Nothing else changes.

## Bugs found and fixed before shipping (caught by review, not by the pure-function tests)

Both lived in `flushBurstBatch`'s glue code in on-message.ts, which the pure-function tests
(burst.ts, channel-activity.ts) don't reach — neither has test coverage of its own, since
on-message.ts isn't unit-tested anywhere in this codebase (confirmed: no existing tests exercise
the Discord.js-wired STEPS pipeline directly).

1. **Owner-authority leak.** A batch's `userId` was always the newest message's author, and
   `assemble.ts` appends `<owner_note>` ("his instructions are authoritative, carry them out
   fully") to the WHOLE `<user_message>` when that userId is EJ's. If EJ's message ever landed
   in the same batch as someone else's line, the someone-else's words would inherit owner
   authority. Fixed: EJ's messages (`OWNER_USER_ID`, same id already used as `EJ_USER_ID` in
   `capturePresenceReply`) now bypass batching entirely, same as DMs.
2. **Proactive-flag bug.** `isProactiveAnswer` was taken from the newest item only — one ambient
   message batched a moment after an explicit `@mention` could make the WHOLE combined turn look
   "proactive," injecting "you were NOT asked, if unsure stay silent" over what was actually a
   direct question. Fixed: now `items.every((i) => i.isProactiveAnswer)` — true only when every
   message in the batch was unprompted.

Also fixed in the same pass: batch items are now sorted by Discord's own `createdTimestamp`
before use (the async steps upstream of `respondOrObserve`, like `isReplyToBot`'s fetch, don't
guarantee completion order matches arrival order, so enqueue order isn't reliable); a
reply-with-ping no longer duplicates its target into the rendered `@`-mentions list; and the
"Talking to: @X — the ONE person" situational line is now skipped in favor of a multi-author
line when the turn is a real burst (it was actively wrong there).

## Open questions / things I wasn't fully sure about

1. The "landed while thinking" timing gap (window-only vs. full-generation-time) — flagged
   as a known, bounded limitation rather than solved, per the task's explicit "simpler and safe"
   allowance. See the "Known limitation" callout under feature 2.
2. The ambient-budget overcounting on a batched burst — flagged, not fixed; a real product
   decision about whether to recount at flush time instead of per-arrival.
3. Reply-target excerpts for out-of-window replies (feature 1) — not fetched, by design (cost
   tradeoff), documented above.
4. I did not touch `recordAmbientResponse()`/`markRespondToAllCooldown()`, the antibody counters,
   or any rate-limit logic beyond routing WHEN `handleMessageAsIntent` gets called — all existing
   gates still run per-message, exactly as before, so nothing about who gets throttled or
   silenced changed, only how an already-approved reply gets batched.
5. `MessageReactionRemove` isn't handled — a retracted 👎 stays in the 30-minute reaction log
   (and thus in context) until it ages out, rather than disappearing immediately.
6. A channel's pending burst batch is dropped (not flushed) if the gateway's `stop()` runs before
   the debounce timer fires — at most `BURST_DEBOUNCE_MS` (2.5s default) of exposure during a
   deploy/restart. Judged acceptable rather than adding flush-on-shutdown plumbing for a ≤2.5s
   window that only loses messages that would otherwise just get re-delivered or re-read on
   reconnect.

## Test coverage

New vitest files (mirroring `src/` under `packages/artie/tests/`, flat per the existing
`tests/gateway/`, `tests/engine/` convention):
- `tests/gateway/channel-history-addressing.test.ts` — `resolveAddressing()`
- `tests/engine/transcript-addressing.test.ts` — `formatAddressingSuffix()`,
  `renderDiscordTranscript()`'s metadata-line handling
- `tests/gateway/burst.test.ts` — `BurstScheduler` (fake timers), `combineBurstContent`,
  `renderBurstForContext`, `burstDebounceMs`
- `tests/gateway/channel-activity.test.ts` — ring buffer, `pickLandedMessages`, `formatLandedNote`
- `tests/gateway/reaction-log.test.ts` — `recordReaction`/`getRecentReactions`/
  `formatRecentReactionsNote`
- `tests/engine/transcript-addressing-cost.test.ts` — the token-cost measurement suite behind
  the numbers above (run it directly: `pnpm -s vitest run
  packages/artie/tests/engine/transcript-addressing-cost.test.ts`, read the `[cost]` console
  lines)

Bench run (`/data2/tmp/artie-v3-multiplayer`, VPS), full suite including the fixes above:
typecheck clean; `1043 passed | 6 skipped` (up from the stated baseline of `985 passed | 6
skipped`; zero failures, zero newly-skipped). The `tests/architecture.test.ts` seam check
(gateway/engine only talk through `engine/api.ts`/`gateway/api.ts`) passed — nothing here
crosses that line; every new field rides through `discordContext` (already JSON-wired across
the seam) or stays entirely within one side.
