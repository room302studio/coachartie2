# Voice meeting scribe (phase 1) — build notes

Branch `v3-voice`. Built against `/private/tmp/.../voice-build-spec.md` and the research doc it
names (`voice-scribe-spec.md`). Everything below is phase 1: join, listen, transcribe,
summarize, propose GitHub changes through the approval gate. No TTS, no live captions.

## What was built

**Gateway side** (owns the Discord voice connection):
- `packages/artie/src/gateway/voice/scribe-session.ts` — joins with `joinVoiceChannel`
  (`selfDeaf: false, selfMute: true`), subscribes per speaker on
  `receiver.speaking.on('start', …)` with `EndBehaviorType.AfterSilence` (~1000ms), decodes
  Opus->PCM with `prism-media`, downmixes stereo->mono, wraps PCM as WAV, and hands each
  utterance to the engine through `engine/api.ts` only. Owns auto-stop (hard cap 2h, no-humans
  for 2 minutes — checked on a 15s tick plus every `VoiceStateUpdate` in the watched channel),
  one-rejoin-then-stop on disconnect, and the graceful-shutdown sweep
  (`stopAllVoiceScribeSessions`, wired into `gateway/main.ts`'s `stop()`).
- `packages/artie/src/gateway/voice/wav.ts` — hand-rolled 44-byte WAV header (no ffmpeg) +
  stereo->mono downmix + duration calc.
- `packages/artie/src/gateway/voice/scribe-timers.ts` — the auto-stop/drop-short-utterance
  rules as pure functions, so they're unit-testable without mocking discord.js.
- `packages/artie/src/gateway/commands/scribe.ts` — `/scribe start [channel]`, `/scribe stop`,
  `/scribe status`. start/stop are owner-only (`shared/config/owner.ts`); status is open to
  anyone. Registered in `gateway/commands/registry.ts`.
- `packages/artie/src/gateway/api.ts` gained one new seam function,
  `sendChunkedChannelMessage(channelId, text)` — `sendChannelMessage` plus
  `4-reply/chunks.ts`'s splitting, since the engine (which posts the final summary) can't reach
  into `gateway/4-reply/` directly.

**Engine side** (STT, storage, summarization, the gated GitHub flow):
- `packages/artie/src/engine/jobs/scribe/` — not `engine/tools/` on purpose: this isn't a model
  tool, so it's exempt from `tests/architecture.test.ts`'s "every tool is registered" rule
  (same precedent as `engine/jobs/github-push/`).
  - `stt.ts` — OpenRouter's `/api/v1/audio/transcriptions`, same key/base-URL as every other
    OpenRouter call (`4-generate/openrouter.ts`).
  - `cost.ts` — per-minute STT pricing + `SCRIBE_STT_MODEL` env override.
  - `summary.ts` — the one summary LLM call (reuses `openRouterService.generateFromMessageChain`,
    `SMART_MODEL` or rotation), tolerant JSON parsing (`parseModelJson`).
  - `propose.ts` — turns proposed GitHub changes into `capabilityRegistry.execute('github',
    'create_issue'|'update_issue', …)` calls, **without** `confirmed` — these are already in
    `approval-gate.ts`'s `GATED_ACTIONS.github` set, so no new gate code was needed.
  - `orchestrator.ts` — the actual functions behind the seam: `scribeCanStart` (brownout
    check), `startScribeSession`, `submitScribeUtterance` (STT + usage-ledger write + transcript
    row, opt-out/blocked defense-in-depth, audio-cap enforcement), `stopScribeSession` (summary
    + proposals + posting), `getScribeStatus`.
- `packages/artie/src/engine/api.ts` gained `scribeCanStart`, `scribeStart`,
  `scribeSubmitUtterance`, `scribeStop`, `scribeStatus` — the gateway's only way into any of
  this.
- `packages/artie/src/shared/db/scribe-store.ts` — `scribe_sessions` / `scribe_utterances`,
  lazy `CREATE TABLE IF NOT EXISTS` on first use (the `privacy-opt-out.ts`/`pending-actions.ts`
  idiom — **not** `schema.ts`'s drizzle tables + `client.ts`'s bootstrap block: that path is
  only actually invoked by two lazy call sites in this codebase today, `tasks.ts` and
  `watch-loop.ts`, not at boot, so it was the wrong model to copy for a table that needs to
  exist reliably from the first write). Also owns `sweepExpiredScribeData()` (7-day default,
  `SCRIBE_RETENTION_DAYS`), run on every new session start — no separate scheduler job needed.
- `packages/artie/src/shared/config/guilds.ts` — `SCRIBE_ALLOWED_GUILD_IDS` /
  `isScribeAllowedGuild()`. Currently just Room 302 Studio's id. Adding a guild later is a
  one-line change to that array.
- `packages/artie/src/gateway/main.ts` — added `GatewayIntentBits.GuildVoiceStates`
  (non-privileged, no portal flag).

## Consent / privacy behaviour

- Guild-gated to Room 302 Studio only (`isScribeAllowedGuild`); every other guild (Subway
  Builder included) is refused in the slash command before anything joins.
- On join, the bot posts the announcement in the invoking text channel verbatim:
  "📝 Artie is taking notes on this call. Opted-out people (`/artie-optout`) are never
  transcribed. `/scribe stop` ends it."
- Opted-out/blocked users (`shared/privacy-opt-out.ts`, `shared/blocklist.ts`) are never
  subscribed to in the first place (`scribe-session.ts`'s `handleSpeakingStart` checks
  `isBlockedUser` before calling `receiver.subscribe`), with a second check engine-side
  (`submitScribeUtterance`) in case someone opts out mid-call.
- Audio is never written to disk. Each utterance's PCM/WAV buffer lives only in memory for the
  duration of one STT call and is discarded (GC'd) once it returns; only the transcript text
  persists, and only for `SCRIBE_RETENTION_DAYS` (default 7).
- Only the owner (EJ) may run `/scribe start` or `/scribe stop`; anyone may run
  `/scribe status`.
- Every proposed GitHub create/update goes through the existing approval gate
  (`approval-gate.ts`), queued as a `pending_actions` row — reviewed with the `approvals` tool,
  same as any other gated write.

## Env knobs

- `SCRIBE_STT_MODEL` — default `openai/whisper-large-v3-turbo` (OpenRouter routes this to
  Groq — verified 2026-10-26 against openrouter.ai/openai/whisper-large-v3-turbo's provider
  table, ~$0.00066/min, matching the research doc's number). OpenRouter's own router (not this
  code) picks the provider per request; pin `provider: {only:['groq']}` server-side later if
  the routed provider ever drifts and the cost assumption needs to hold exactly.
- `SCRIBE_MAX_AUDIO_MIN` — default 180 (3h) of cumulative STT audio per session; past that,
  utterances stop being transcribed (not dropped — the session just stops adding to the
  transcript) and the summary notes it.
- `SCRIBE_RETENTION_DAYS` — default 7.
- `SMART_MODEL` — reused for the one summary call per session (no new env var; this is the
  model summary.ts falls back to when picking a quality-sensitive one-shot model, same
  pattern as the rest of the codebase).

## Cost estimate

Matches the research doc: Groq-via-OpenRouter STT at ~$0.00066/min, roughly one audio-minute of
billed STT per roughly one real minute of meeting (one speaker at a time; downmixing to mono
before sending halves the bytes but duration — what's actually billed — is unchanged by that).
A 60-minute, 4-person meeting with normal turn-taking: **~$0.04 STT + ~$0.01–0.03 for the one
summary call ≈ $0.05–0.10 per meeting.**

## Deploy steps (NOT run — do these before this ships)

1. Register the new slash command with Discord — this is a separate step from code deploy:
   `npx tsx packages/discord/register-commands.ts --dry-run` first, then without `--dry-run`.
2. Prod already has `@discordjs/voice`/`@discordjs/opus`/`prism-media` after
   `pnpm install --frozen-lockfile` (pinned in commit `fa3c099`, confirmed present on the bench
   via `generateDependencyReport()`) — no new install needed.
3. Set `SCRIBE_STT_MODEL`/`SCRIBE_MAX_AUDIO_MIN`/`SCRIBE_RETENTION_DAYS` in prod's env only if
   the defaults above aren't what's wanted; otherwise nothing new to configure.

## Open questions / things I wasn't fully sure about

- **STT provider pinning.** OpenRouter's own balanced routing decides which provider actually
  serves `openai/whisper-large-v3-turbo` per request (Groq, DeepInfra, etc. all host it) — the
  cost estimate above assumes it lands on Groq, matching the research doc, but nothing in this
  code forces that. If the cost assumption needs to be exact rather than "probably Groq,"
  `stt.ts`'s request body would need a `provider: { only: ['groq'] }` hint — I left it unpinned
  since the spec didn't ask for that and it adds a failure mode (no provider available) for a
  phase-1 build.
- **Default GitHub repo.** Scribe proposals default to whatever's first in Room 302's
  `GUILD_CONFIGS.room_302_studio.githubSync.repos` (currently `Subway-Builder/metro-maker4`) when
  a proposal doesn't name a repo explicitly. This is the "most plausible configured repo" call
  the build spec asked for when ambiguous — worth a second look if that default ever feels
  wrong for a specific meeting's content.
- **`scribe_sessions`/`scribe_utterances` placement.** Built as a lazy-`ensureTable()` module
  (`shared/db/scribe-store.ts`) rather than drizzle rows in `schema.ts` + `client.ts`'s bootstrap
  — see the reasoning above. If the team's actual convention is "always add to schema.ts
  regardless," this is an easy follow-up migration.
- **Gateway voice code is unverified end-to-end** — no live Discord, no real voice connection,
  by the build spec's own rule ("never join a real voice channel or call Discord"). The
  `@discordjs/voice`/`prism-media` API surface (`joinVoiceChannel`, `receiver.speaking`,
  `receiver.subscribe`, `EndBehaviorType.AfterSilence`, `opus.Decoder`, `entersState`,
  `connection.rejoin()`) is written from the documented API and the research doc's confirmation
  that voice receive works, but it only gets exercised for real once it's deployed and someone
  runs `/scribe start` in Room 302 Studio for the first time.
