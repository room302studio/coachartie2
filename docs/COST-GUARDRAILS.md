# Cost guardrails (Sept 2026)

Branch `cost-guardrails-2026-09`. Context is epic #97. Persona and restraint rules (`[SILENT]`, mention-only, staying quiet when people share rather than ask) are unchanged. The point is fewer, better-timed generations, not a chattier bot.

## What changed

### 1. Daily spend cap → auto-mute (`capabilities/src/services/monitoring/daily-budget.ts`)
- Today's spend is `SUM(estimated_cost)` from `model_usage_stats` over the **America/New_York** calendar day. It is one indexed range query, and DST is handled (`shared/src/utils/eastern-day.ts`).
- It is checked after every recorded generation (coalesced), plus a 60s interval. The interval is what lifts the mute at midnight and what catches spend the discord process writes directly.
- At or above `DAILY_BUDGET_USD`, the `KILL_SWITCH` file is written as `BUDGET_MUTE {"day":…,"spentUsd":…}` and **one** anomalywatch warning is sent.
- At the next ET midnight the mute lifts itself, but **only if it is still a budget mute**.
  - A manual mute is never lifted or relabelled.
  - `POST /api/killswitch {"enabled":true}` over a budget mute turns it into a manual mute.
  - `{"enabled":false}` during a budget mute records a same-day override (`KILL_SWITCH.budget-override`), so the next call doesn't immediately re-trip the cap.
- **The kill switch now stops every generation.** Before this change it was only checked in `message-handler.ts`, so all of these kept spending while "muted":
  - the scheduler, `/api/observe` (observation summaries and profiles), memory tagging, reflection and social-media behaviour
  - the morning briefing, plus its OpenAI-direct fallback
  - user scores and email drafting
  - `/chat` from SMS/IRC/Slack/email/launch-countdown and mention-proxy judgment
  - vision, image-gen, TTS/ElevenLabs, the micro-LLM preflight and the openai-research harness

  It is now asserted at every call site (`shared/src/utils/kill-switch.ts`). The capabilities queue also drops jobs while muted.
- **Spend was under-recorded.** Usage rows were only written when the caller passed a `messageId`, so background calls were invisible to cost reports and to the cap. Every call is now recorded, and rows with no message behind them get `step_type='background'`.
- **Brownout also tapers on today's spend.** The mode is the more conservative of two signals:
  - **runway**: balance ÷ measured burn
  - **daily**: spent ÷ `DAILY_BUDGET_USD`. At or above `BROWNOUT_DAILY_LEAN_FRACTION` the mode is lean; at or above `BROWNOUT_DAILY_CRITICAL_FRACTION` it is critical; at 1.0 the hard mute takes over.

  A failed spend lookup means the daily signal has no opinion, so the runway signal decides. The transition log line names the driver.
- **Brownout brevity.** Lean and critical cap `max_tokens`. They also insert a short length note as its own system message **after** the cached prefix, so the prefix stays byte-identical across modes (tested). The model then writes a complete short reply instead of a normal one that gets cut off. The note is about length only.
- **Brownout coverage.** Brownout only applies to the main reply path (`llm-response-coordinator.ts`). The paths below use their own model choice and caps, and only the budget mute and kill switch bound them:
  - tool-loop steps (`llm-loop-service.ts`, rotation models)
  - capability triage (`capability-selector.ts`) and error recovery (`capability-executor.ts`)
  - reflection (coordinator `generateReflection`, `reflection-consolidator.ts`)
  - memory tagging (`memory.ts`), the observation handler and user scores
  - conscience, social-media behaviour, email drafting, TTS scripts and the morning briefing
  - micro-LLM, vision, image-gen and the proactive judgment
  - the simple-chat path (`ENABLE_CAPABILITIES=false`)

### 2. Speak gate (`discord/src/services/speak-gate.ts`)
- The persona model runs only when Artie is **@mentioned, replied to (with or without a ping), or DMed**.
- Anything else the routing would still answer unprompted needs a YES from the cheap judgment (`shouldProactivelyAnswer`). That covers proactive answers, respondToAll personas and the strike-lift bit.
  - A judgment error or timeout means silence.
  - Existing rate limits, burst cooldown, dedup and the ambient hourly budget still apply afterwards.
- Per guild: `GuildConfig.ambientMode` is `'gated'` (default) or `'never'` (strictly mention/reply/DM).
- The judgment model uses the repo's cheap-model chain: `PROACTIVE_JUDGMENT_MODEL` → `BACKGROUND_MODEL` → `FAST_MODEL` → the old gemini-flash default. The base URL is `PROACTIVE_JUDGMENT_BASE_URL` → `OPENROUTER_BASE_URL`; before this change it was hardcoded to `router.tools.ejfox.com`.
- **Why the judgment went dead on 2026-07-14.** Commit 96d50ce turned `proactiveAnswering` off for Room 302 (it was already off for Subway Builder), so the judgment's only caller stopped running.
- **Passive observation no longer generates.** Unaddressed messages in coach-artie channels were published with `shouldRespond=false`, and the capabilities worker ran the full orchestration on them (persona model included), then threw the reply away. Now the worker stores the message for history and stops (`capabilities/src/queues/passive-observation.ts`). This is very likely the bulk of #88.

### 3. Credit / distress / vitals alerts → anomalywatch only (`shared/src/utils/anomalywatch.ts`)
- `reportToAnomalywatch(level, message, {kind})` shells out to `alert.sh coach-artie <level> <message>` using `execFile` (no shell).
  - Where the script doesn't exist, it only logs.
  - Level is `warning`; only out-of-credits is `error`.
  - It is limited to **one alert per kind per ET day**, stored in SQLite (`alert_rate_limits`) so restarts don't reset it. A failed send releases the day.
- Routed through it: out-of-credits, low balance, critical `credit_alerts`, the distress monitor (its n8n webhook is removed) and the vitals "running a fever" alarm. **None of them touches Discord any more.**
- Also closed:
  - The critical-balance `credit_status` note is no longer injected into the prompt.
  - The distress self-awareness note no longer carries the burn rate. Money in the prompt is something Artie can repeat out loud.
  - The discord error repliers stay silent on billing, credit, budget and mute errors.

### 4. Observation firehose off (`discord/src/services/observational-learning.ts`)
- The 25-minute channel-summary and profile-synthesis loop is behind `OBSERVATIONAL_LEARNING_ENABLED` (default **off**). The history: 7,161 memories written and 0 recalled.
- Explicit memory writes are untouched. That covers a user asking Artie to "remember", and the memory capability.
- If the loop is re-enabled:
  - batches under `OBSERVATION_MIN_MESSAGES` wait for more messages
  - "nothing happened" summaries aren't stored

### 5. Caching fixes found by reading the code
- **`{{USER_MESSAGE}}` was substituted into the cached system prefix.** `prompt-manager.getCapabilityInstructions` did this, and `scripts/restore-prompts.ts`'s PROMPT_SYSTEM ends with that placeholder. Wherever that template is live, the prefix changes on every request and the cache can never be read. The placeholder is now stripped (`stripUserMessagePlaceholder`). To check whether prod had it:
  ```bash
  sqlite3 /data2/apps/coachartie2/data/coachartie.db \
    "select version, instr(content,'{{USER_MESSAGE}}') from prompts where name='PROMPT_SYSTEM' and is_active=1"
  ```
  A result > 0 means the cache had been guaranteed to miss.
- **Cache writes were costed at list price.** With the 1h TTL they bill at 2x (1.25x at 5m). They are now costed at that premium and stored in `model_usage_stats.cache_write_tokens`, a new additive column added on boot.

## Environment variables

| Var | Default | Where | Meaning |
|---|---|---|---|
| `DAILY_BUDGET_USD` | `3` | capabilities | Daily cap in USD per ET day. `0` or `off` disables the cap. |
| `KILL_SWITCH_PATH` | `<repo>/KILL_SWITCH` | both | Shared mute file. Both PM2 apps must resolve the same path. |
| `BROWNOUT_DAILY_LEAN_FRACTION` | `0.60` | capabilities | Fraction of the daily budget at which brownout goes lean. |
| `BROWNOUT_DAILY_CRITICAL_FRACTION` | `0.85` | capabilities | Fraction of the daily budget at which brownout goes critical. |
| `BROWNOUT_LEAN_MAX_TOKENS` | `500` | capabilities | `max_tokens` cap in lean mode. Was hardcoded. |
| `BROWNOUT_CRITICAL_MAX_TOKENS` | `250` | capabilities | `max_tokens` cap in critical mode. Was hardcoded. |
| `ALERT_SH_PATH` | tries `/home/debian/scripts/scripts/alert.sh`, then `/home/debian/scripts/alert.sh` | capabilities | Anomalywatch sender. |
| `CREDIT_ALERTS_DISABLED` | unset | capabilities | `true` silences all credit alerts, as before. |
| `PROACTIVE_JUDGMENT_MODEL` | → `BACKGROUND_MODEL` → `FAST_MODEL` → `google/gemini-2.0-flash-001` | discord | Model for the cheap speak gate. |
| `PROACTIVE_JUDGMENT_BASE_URL` | → `OPENROUTER_BASE_URL` → `https://openrouter.ai/api/v1` | discord | Speak-gate endpoint. Set it to `https://router.tools.ejfox.com/v1` for the old router. |
| `PASSIVE_OBSERVATION_GENERATE` | unset (off) | capabilities | `true` restores full generation on passive Discord messages. |
| `OBSERVATIONAL_LEARNING_ENABLED` | unset (off) | discord | `true` restores observation summaries and profile synthesis. |
| `OBSERVATION_MIN_MESSAGES` | `5` | discord | Substance floor when observation is enabled. |

Per guild, in `guild-whitelist.ts`, set `ambientMode: 'never'` for strict mention/reply/DM only.

## Verifying prompt caching live (#86), once credits exist
1. Top up OpenRouter. Also set a **key limit** in the OpenRouter dashboard as a second, provider-side cap.
2. Start the services: `docker compose ps`, and confirm redis is Up on 47320. Then:
   ```bash
   pm2 start coach-artie-capabilities
   pm2 start coach-artie-discord
   pm2 save
   ```
3. Get about three @mention replies to Artie in one guild within a few minutes.
4. Watch the logs with `pm2 logs coach-artie-capabilities | grep -E "Prompt cache|Cache usage|Usage recorded"`. What a hit looks like:
   - `🗄️ Prompt cache: breakpoint on ~7000tok system prefix (anthropic/claude-opus-4.8, streaming)`. The breakpoint was placed.
   - `🗄️ Cache usage: read 0, write 6800 of 12000 prompt tokens`. This is the first call, which writes the cache (normal).
   - `🗄️ Cache usage: read 6800, write 0 of 12100 prompt tokens`. This is a later call, and **it is a hit.**
   - `📊 Usage recorded: … - cache 6800/12100 (56%)`
5. Run `scripts/check-prompt-cache.sh 1`.
   - **WORKING** means `MAX(cached_tokens) > 0`.
   - **WARMING** means writes but no reads yet. That is fine after one call, but broken if it persists.
   - **NOT CACHING** means neither happened.

   Raw query:
   ```sql
   SELECT timestamp, model_name, step_type, prompt_tokens, cached_tokens, cache_write_tokens, estimated_cost
   FROM model_usage_stats WHERE timestamp > datetime('now','-1 hour') ORDER BY id;
   ```
   A hit is `cached_tokens > 0` on the 2nd and later rows for the same model.
6. If it reads zero, check these in order:
   1. Run the `{{USER_MESSAGE}}` query above.
   2. Check that the model is `anthropic/*`.
   3. Check that the prefix is above the model minimum (Haiku 4.5 needs 4096).
   4. Check that nothing dynamic sits above the breakpoint in `context-alchemy.ts`.
   5. Check that `x-session-id` is still in `openrouter.ts` `defaultHeaders`.

Budget checks: `GET http://127.0.0.1:47321/api/killswitch` shows `{muted, kind}`. Today's spend:
```sql
SELECT SUM(estimated_cost) FROM model_usage_stats
WHERE timestamp >= <ET midnight in UTC> AND timestamp < <next ET midnight in UTC>;
```

## Rollback, per item (no redeploy needed for env flags; `pm2 restart` after editing `.env.production`)
- **Budget cap:** set `DAILY_BUDGET_USD=off`. To clear a current budget mute, `POST /api/killswitch {"enabled":false}` or `rm KILL_SWITCH`. The kill-switch gating itself is only reversible by reverting the commit; it is a pure safety gate.
- **Brownout daily signal:** set `BROWNOUT_DAILY_LEAN_FRACTION=1` and `BROWNOUT_DAILY_CRITICAL_FRACTION=1`. The daily signal then only engages at 100%, when the mute takes over anyway. To bring the brevity note back to pre-change behaviour, revert commit "brownout tapers…".
- **Speak gate:** revert the commit to restore ungated respondToAll personas. `PASSIVE_OBSERVATION_GENERATE=true` restores passive generation. `PROACTIVE_JUDGMENT_BASE_URL` restores the old router.
- **Alerts:** revert the commit to restore Discord DMs. Not recommended.
- **Observation:** set `OBSERVATIONAL_LEARNING_ENABLED=true`.
- **Caching fixes:** revert the individual commits. The `cache_write_tokens` column is additive and harmless to leave.

## Voice: taper by length, never by model (2026-09-29)

EJ's call: Artie's persona model *is* his voice — cheaper models lose his creativity and flavor.
So brownout (lean/critical, from either signal) shortens replies (max_tokens + brevity note) but
keeps the persona model. The single exception: when the OpenRouter **balance** runway itself is
critical, `brownoutModel()` falls back to `BROWNOUT_CRITICAL_MODEL` (default Haiku 4.5) so he keeps
answering instead of failing. Daily-budget pressure never swaps models; the budget mute ends the day.

**Persona model: `anthropic/claude-opus-5.5`** — newest flagship and cheaper than opus-4.8
($4/$20 per M vs $5/$25; cache reads $0.20/M vs $0.50/M, per OpenRouter's live /api/v1/models).
On deploy set in `.env.production`:

    SMART_MODEL=anthropic/claude-opus-5.5

It's priced in `usage-tracker.ts` MODEL_PRICING — required: unknown models bill at top-tier rates
($15/$75), which would have tripped the $3 cap after ~$0.80 of real spend. Its cache minimum
falls back to the conservative 4096-token default in `prompt-cache.ts` (the static prefix is
~7.2k tokens, so it still caches).

### Final third → OpenRouter auto-router (supersedes "never swap models", same day)

EJ: in the final third of either tank, hand model choice to OpenRouter's auto-router so no
hardcoded "cheap model" needs updating. `brownoutRoute()`:

| Condition | Route |
|---|---|
| daily spend < 67% of `DAILY_BUDGET_USD` and balance runway normal | persona model (`SMART_MODEL`) |
| daily spend ≥ `BROWNOUT_DAILY_AUTO_FRACTION` (0.67) **or** runway lean/critical | `openrouter/auto` + `plugins: [{id:'auto-router', cost_tier: BROWNOUT_AUTO_COST_TIER ('low')}]` |
| daily spend ≥ 100% | budget mute until ET midnight |

Length tapering (lean 60% / critical 85%, brevity note after the cache breakpoint) applies on top.
`BROWNOUT_AUTO_ALLOWED_MODELS` (comma wildcards, e.g. `anthropic/*,google/*`) sets a quality
floor; unset = the auto-router's own pool. "Total tank" = balance runway (Artie can't know what
a full OpenRouter balance was). Auto-routed calls are billed at the **served** model
(`completion.model` / the stream chunks' `model`), not `openrouter/auto` — otherwise the
unknown-model fallback ($15/$75) would trip the daily cap early. Docs: openrouter.ai/docs/guides/routing/routers/auto-router
