# Recall notes (branch `v3-recall`)

Two small features Artie asked for at his 2026-10-26 check-in, both landed without an
extra LLM call per reply.

## 1. Per-person "last time" line

> "Not personality numbers, just 'last talked 3 days ago about X, owes you a bug
> report.' Callbacks are where my warmth comes from."

**Files:**
- `packages/artie/src/engine/3-context/sources/last-time.ts` — new module. `lastTimeLine()`
  is a pure formatter (same shape as `engine/budget/self-meter.ts`'s `selfMeterLine`);
  `getLastTimeFacts()` does the actual (synchronous, cheap) SQLite reads.
- `packages/artie/src/engine/3-context/assemble.ts` — wired into
  `addDiscordSituationalAwareness`, right after the "👤 Talking to: @name" line, in the
  same try/catch style as the self-meter line a few lines below it.
- Tests: `packages/artie/tests/engine/last-time.test.ts`.

**What it does.** For the current speaker, scoped to the current guild (or the current
DM channel when there's no guild — recall is already guild-scoped elsewhere, so this
follows that rule rather than inventing a new one):

- **When**: the previous EXCHANGE's timestamp, rendered as "3d ago" / "6h ago" / "2mo ago"
  (`relativeAge`). This is deliberately not "their most recent row in `messages`":
  `engine/1-intake/queue-worker.ts` stores every forwarded Discord message for history,
  including passive ones that are never generated on
  (`shouldSkipPassiveGeneration` is checked *after* the insert) — confirmed in prod, where
  user-authored rows outnumber Artie's own replies roughly 4:1. In a gated-ambient guild
  a regular who chats all day and pings Artie once would otherwise get "last talked 2m
  ago, about <their reply to someone else>" every time — the opposite of a callback. So
  `lastExchangeRow` reuses the exact row-pairing shape `getConversationHistory` (above
  it in `assemble.ts`) already uses: a user row counts only if an assistant reply landed
  within the next few rows of the same channel, before anything else that user said. The
  live message being answered right now has no reply yet, so it's excluded the same way,
  with no separate "skip the newest row" step needed.
  `messages.created_at` is written via SQLite's own `datetime('now')`, which has no
  timezone suffix — `strftime` normalizes it to an explicit `...Z` string before it
  leaves the query, so `new Date(...)` downstream can't get parsed as local time on a
  non-UTC process.
- **About what**: the cheapest signal that's actually descriptive, in order:
  1. the user's own previous message, truncated to ~60 chars, if it's at least 10
     characters (filters out "lol"/"thx"/etc.);
  2. else the latest `importance >= 7` memory about them, guild-scoped the same way
     `getRecentMemories` scopes everything else (this guild's memories plus any
     ungoverned/global one);
  3. else the latest memory tagged `user-profile` for them (581 of these already exist
     in prod, one per ~every active user — confirmed via a read-only aggregate query
     before building this, not assumed). **This one is NOT guild-scoped** — a
     `user-profile` memory is written about the person, not the server, so the same
     summary can surface in any guild they're active in. Low risk (it's their own
     profile, not someone else's business) but worth naming since the task's "don't
     leak across servers" guidance is about recall generally.
  4. If none of the above, the line omits the "about" clause entirely rather than
     printing something empty or made up.
- **Open loop**: one `objectives` row owned by them with status `active` or `blocked`
  (blocked wins — it reads as "owes you X"), falling back to one pending `todo_items`
  row. Confirmed via a read-only prod query that `objectives` has real per-user data
  beyond EJ (one other Discord user had 4 active goals at the time I checked); plain
  `todos`/`todo_lists` barely gets used (1 row total in prod) but it's wired anyway
  since the query is nearly free. **`objectives` has no `guild_id` column**, so a goal
  set while active in Subway Builder would also surface as "open:" in Room 302. It's
  always the speaker's own goal (never someone else's), so the exposure is "you see your
  own open loop in the wrong server" rather than a privacy leak — but it's a real gap if
  Artie ever wants goals to feel server-local.
- The whole thing is skipped — no line at all — when there's no prior exchange in
  scope, when there's no guild/channel to anchor to, or when the speaker is
  blocked/opted-out (`isBlockedUser`, `mentionsOptedOutUser` — same checks the rest of
  recall uses).

**Example** (made-up names, made-up content):

```
👤 Talking to: @mira (@mira_dev) — this is the ONE person you are replying to; do not attribute other people's messages from the history to them.
⏱️ last talked 3d ago, about the signal timing bug on the Piccadilly line — open: file the repro steps for the loader crash.
```

Or with no open loop and a thinner last message (falls back to a memory):

```
⏱️ last talked 6h ago, about Jacquard-loom-inspired animation pipeline.
```

Or with no history at all: nothing is added.

## 2. "Why did this match" on recalled memories

> "Memory recall still occasionally pulls junk... a 'why did this match' flag would
> help more."

**Files:**
- `packages/artie/src/engine/memory/recall.ts` — `MemoryRecaller`'s semantic (TF-IDF)
  and temporal layers each now carry a couple of extra fields per match
  (`rawSimilarity`, `mentionsParticipant`, `matchedParticipant`, `topTerm` on
  `SemanticMatch`; `temporalType` already existed on `TemporalMatch`) and two new
  private methods, `semanticReason()` / `temporalReason()` / `topSharedTerm()`, that
  turn those fields into a short bracketed tag appended to each memory's rendered text.
- Tests: `packages/artie/tests/engine/recall-reasons.test.ts`.

**What the pipeline actually knows** (there's no FTS in this path — `fetchCandidates`
calls `getRecentMemories`, not `searchMemories` — so the reasons are honest about that):

- Semantic layer: cosine similarity to the query, whether the memory mentions one of
  the people currently in the conversation (`participants`), and the single
  highest-weighted shared TF-IDF term between query and memory (the thing a human would
  point at and say "that's why"). Rendered as, in priority order:
  `[mentions nadia]` > `[kw:piccadilly]` > `[sim 0.23]`, each with `, imp` appended when
  the memory's importance is ≥ 7.
- Temporal layer: the existing `temporalType` (`recent` / `time_of_day` / `day_of_week`
  / `contextual` / `historical`) plus age in days: `[recent, 2d]`, `[day_of_week, 41d]`.

**Example** (made-up content):

```
This reminds me of: Nadia filed a repro for the Piccadilly signal bug yesterday [mentions nadia, imp], and also Sam mentioned the same crash last Tuesday [kw:crash].
```

**Ranking is untouched.** The reason fields are computed from data already produced
while scoring each match (nothing new is fetched or compared), and are only appended to
`content` *after* `sort()`/`slice()` — the same memories get selected in the same order
as before; they just explain themselves now. Verified by
`recall-reasons.test.ts`'s "does not change which memories are selected or their order"
case.

## Token cost

Both features ride in the per-message "Relevant context" block (not the cached system
prefix), so there's no cache-invalidation concern, but they do add a few tokens to
every reply:

- Last-time line: ~15–30 tokens (one short sentence).
- Match reasons: ~4–8 tokens × up to 5 memories (speed priority caps the semantic layer
  at 3 and the temporal layer at 2) ≈ 20–40 tokens.

**Total: roughly 35–70 tokens per reply**, all in the per-message block that's already
rebuilt every turn — nothing added to the cached system prefix.

## Open questions

- `addRelevantMemories`'s trace metric estimates `memoriesCount` as
  `tokenWeight / 50` (a rough chars-per-memory guess for observability only, not
  anything the model or ranking sees). The appended reason tags add a handful of tokens
  per memory, so that estimate now skews slightly high. Cosmetic — it was already an
  estimate — but worth a one-line fix if anyone tunes that constant later.
- `getLastTimeFacts` scopes DMs by `channelId` since there's no `guildId` there. That
  matches "one DM thread = one history", but if Artie ever gets multi-channel DM
  semantics this will need revisiting.
- See the two guild-scoping caveats inline above (`objectives` has no `guild_id`;
  `user-profile` memory fallback is deliberately global).
- The participant-token length floor (`>= 4` chars, in `semanticLayer`, not something
  I added) means short names like "Jan" or "Kai" never trigger the `[mentions X]`
  reason even when they clearly should — pre-existing behavior, just newly visible now
  that the reason is printed. Worth a look if Artie says a reason looks wrong for a
  short-named regular.
- `topSharedTerm` reuses the TF-IDF vectors already computed for scoring, so it's
  free, but it can occasionally surface a term that isn't the intuitively "right" one
  when two terms have close weights — it's meant as a junk-hunting aid, not a precise
  explanation.
- I didn't add a structured `items: [{content, reason}]` field to
  `MemoryEntourageResult` — `addRelevantMemories` only ever consumed the rendered
  `content` string, so I kept the change to that string rather than growing the
  interface. If a future caller wants reasons as data (not text), that's a small
  follow-up.
