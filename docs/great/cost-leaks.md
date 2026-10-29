# Coach Artie cost leaks — 2026-10-28 audit

Source: `ssh vps` pm2 `coach-artie`, log `/data2/apps/coachartie2/logs/coach-artie-out-117.log`
(2026-10-26 18:19 → 2026-10-28 22:19), DB `/srv/artie/data/coachartie.db` (read-only).
OpenRouter balance at time of audit: **~$3.31–3.47**, repeatedly tripping the $5 critical-floor
brownout (`💰 Balance $X below $5 critical floor` lines throughout the log).

## 1. What produces the 22 "High token usage" / "Cost warnings" lines

Both lines come from one check: `engine/budget/usage-ledger.ts:557` warns whenever
`inputTokens + outputTokens > maxTokensPerCall` (16,384). It is a threshold alarm, not a bug
by itself — the question is *why* ordinary calls keep crossing 16k.

Breakdown of the 22 events:

| Cluster | Count | Tokens/call | Source |
|---|---|---|---|
| `📓 Steam review situation analysis refreshed` | 3 (10-26 18:27, 10-27 17:07, 10-27 20:37) | 19.4k–20.2k | `gateway/watchers/steam-review-notes.ts` — ~24h-interval scheduled job, cost logged at ~$0.0035–0.0039/run right after each warning |
| Unlabeled single event (10-27 10:49) | 1 | 18.0k | Same tool-turn pattern as below, Subway Builder |
| Early-morning burst (10-28 02:47–03:09) | 6 | 17.1k–18.1k | `🎯 Model route: SIMPLE → openrouter/auto (6 messages)` then `🔧 Tool turn: ... pinned to anthropic/claude-haiku-4.5` (`engine/4-generate/generate-reply.ts:305`, `engine/4-generate/openrouter.ts:556`) — brownout-mode traffic in Subway Builder/Subway Builder 2 |
| Evening burst (10-28 21:04–22:02) | 12 | 18.2k–18.5k | Identical SIMPLE/tool-turn pattern, dense ~1hr conversation in Subway Builder (`coachartie#3359`) |

**18 of 22 (82%) are the tool-turn pattern**, not the Steam-review job. The log line right
before each is `🎯 Model route: SIMPLE → ... (6 messages)` — i.e. a *simple* 6-message turn is
still shipping 17–18.5k input tokens. That's system-prompt/context overhead, not conversation
length: `engine/3-context/assemble.ts` assembles guild knowledge (`GUILD_CONTEXT_PATHS`),
Discord env/history, recall memories, rules, UI-formatting boilerplate (`UI_MODALITY_RULES_FALLBACK`),
message-format and security-reminder blocks on every call, including cheap/simple ones routed
through the tool-turn path. `generation_traces` shows `rules_applied_count=13` on essentially
every row — a fixed 13-rule tax baked into every turn regardless of content.

Cache hit rate for `response` step_type over 7 days: 839,123 / 2,184,198 prompt tokens cached =
**38%**. Not terrible, but the tool-turn/SIMPLE path during the two bursts above is clearly not
hitting that cache well — note the near-identical token counts per call didn't fall as the
conversation continued, consistent with the guild-knowledge/rules block not being pinned behind
a stable cache breakpoint for this path.

## 2. 7-day spend by step_type / model

```
step_type           calls  cost($)  prompt_tok  cached_tok  cache%
response              175   3.747   2,184,198     839,123    38%
reflection             149   0.938   1,089,274     688,127    63%
observational_learning  32   0.253     524,185           0     0%
background             108   0.130     739,517     144,877    20%
user_scoring           144   0.008      16,932           0     0%
repo_routing            11   0.006       5,676           0     0%
                              -----
                              5.080  total, 7 days
```

Daily totals are extremely lumpy: $2.67 on 10-26, $1.99 on 10-23, $0.01–0.16 every other day.
The spikes are driven by `response|anthropic/claude-opus-5.5` in guild `1420846272545296470`
(Subway Builder) — real user-facing replies, excluded from "leak" ranking per the brief, but
worth flagging: Opus is doing ~$1-1.3/day on the days it's invoked at all, out of a $3.47
balance. That's the actual existential risk, separate from the leaks below.

### Top 3 non-user-facing cost drivers (ranked)

1. **`reflection` — $0.938/7d (~$0.134/day), 149 calls.** `engine/2-turn/save-reflection.ts` /
   `engine/2-turn/reflection-facts.ts:60-92` (`buildReflectionMessages`) fires a background
   note-taking LLM call **after every turn**, split `anthropic/claude-sonnet-5` ($0.501) and
   `anthropic/claude-haiku-4.5` ($0.4366). It has no gate on turn triviality — a one-word reply
   or a reaction-only message still gets a full reflection call quoting the whole turn.
2. **`observational_learning` — $0.253/7d (~$0.036/day), 32 calls, 0% cache hit.**
   `gateway/watchers/observe-channels.ts:368` → `engine/memory/observe.ts:111` — passive
   channel-watching, LLM profile synthesis per person. `cached_tokens` is **zero across all 32
   calls** (vs 38–63% elsewhere), meaning this path never gets `applyCacheControl`
   (`engine/3-context/prompt-cache.ts`) even though its system prompt is presumably static
   per-channel. Easiest fix on this list.
3. **`background` — $0.130/7d (~$0.018/day), 108 calls, 20% cache hit.** Mixed fire-and-forget
   jobs (`getStepType()` default in `engine/4-generate/openrouter.ts:56-57` — any call with no
   `messageId` and not the observational user falls here), spread across `openai/gpt-6-luna`,
   `deepseek/deepseek-v4.1-flash-1017`, `anthropic/claude-haiku-4.5`.

The Steam-review job (`gateway/watchers/steam-review-notes.ts`) that triggered 3 of the 22
token warnings is cheap in isolation (~$0.0037/run, ~24h cadence) and is **not** one of the top
3 — it's folded into whatever step_type it logs under, but its total contribution is ≈$0.01/week.

## 3. `moltbook-social` and `EPIPE` — noise, not spend

- **`Unknown scheduled job type: moltbook-social`** (8x in this log, every 4h: 04:00/08:00/12:00/16:00).
  `engine/jobs/scheduler.ts:364-368` — the job dispatch `switch` has no `case 'moltbook-social'`,
  so it falls to `default: logger.warn(...)` and returns. **No LLM call, no DB write, $0 cost.**
  This is a stale BullMQ repeatable job (registered in Redis, not in code) — dead cron entry,
  pure log noise. Safe to delete the Redis repeat job or implement the case; zero $ either way.
- **`Worker error: write EPIPE`** (5x) — `ioredis` socket write failures
  (`Worker coachartie-messages-incoming error: EPIPE` / `Worker coachartie-discord-outgoing error: EPIPE`),
  immediately followed by `Redis unavailable - suppressing further queue/worker error logs`.
  This is a Redis connection drop under load, unrelated to OpenRouter/LLM spend. **$0 direct
  cost**, but it briefly stalls the queue workers that dispatch LLM calls — a reliability issue,
  not a budget one.

## 4. Ranked fixes, estimated $/day saved

1. **Trim/cache the tool-turn system prompt for SIMPLE-routed calls** (`engine/3-context/assemble.ts`,
   the tool-turn path in `engine/4-generate/openrouter.ts`). 18/22 token warnings are simple
   6-message turns still paying for the full guild-knowledge + 13-rule + UI-formatting +
   message-format + security-reminder stack. Pin that boilerplate behind a stable cache
   breakpoint (or skip the heavy blocks entirely for SIMPLE/tool-turn calls) — **est. $0.15–0.30/day**.
2. **Add `applyCacheControl` to the `observational_learning` path** (`observe-channels.ts` /
   `engine/memory/observe.ts`) — currently 0% cache hit on a presumably repeatable per-channel
   prompt. **Est. $0.01–0.02/day**, but free to do and fixes an obvious gap.
3. **Gate `reflection` on turn triviality** (`engine/2-turn/reflection-facts.ts`) — skip the
   call for empty/0-char messages, reaction-only turns, and turns with no tool use, rather than
   running it on every single turn. **Est. $0.03–0.06/day** (reflection is already the single
   biggest non-user-facing line item at $0.134/day; this is the lever with the most room).
4. **Delete the stale `moltbook-social` BullMQ repeat job** (or implement its case in
   `engine/jobs/scheduler.ts`) — $0 saved, removes 6 log lines/day of noise.
5. **Leave the Steam-review job alone** — ~$0.005/day, already backed off correctly
   (`ANALYSIS_MIN_INTERVAL_MS` / `ANALYSIS_MAX_BACKOFF_MS` in `steam-review-notes.ts`), not worth
   touching relative to items 1–3.

None of these fixes are destructive or urgent-restart items — all are prompt/gating changes
behind existing step-type plumbing. Biggest lever by far is #1 (tool-turn prompt bloat), since
it's the direct cause of 82% of the observed token-limit warnings and touches the highest-volume,
highest-rate models (`response` step_type is $3.75/7d even before counting Opus spikes).
