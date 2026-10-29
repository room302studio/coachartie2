# Why 👍/👎 feedback never lands in generation_traces

## Root cause

`discord_message_id` is almost never populated, so `recordFeedback()`'s
`UPDATE ... WHERE discord_message_id = ?` almost always matches zero rows.
Confirmed on prod DB (`/srv/artie/data/coachartie.db`): **1 of 8,197**
`generation_traces` rows, across the entire history of the table, has a
non-null `discord_message_id`. Same for `feedback_sentiment`: 1/8197.

Intents/partials are fine — not the bug. `gateway/main.ts:67-78` requests
`GuildMessageReactions` and `Partials: [Message, Channel, User, Reaction]`.
`setupReactionHandler(client)` is wired at `gateway/main.ts:369`. But prod logs
(`/data2/apps/coachartie2/logs/app/coachartie-debug.log`, covering the last
~2.5 days, 8,384 `message_received` events) contain **zero** `"Reaction
received"` or `reaction_received` telemetry lines. So `MessageReactionAdd`
simply isn't firing in that window either — reactions aren't happening, or
the field never got populated in the one window where they might have.
Either way, the structural bug below is real and independently confirmed by
the DB, regardless of reaction volume.

**The actual break: `gateway/4-reply/stream-reply.ts`'s link call only exists
on the incremental-streaming code paths, not the normal one-shot delivery
path that is how almost every reply actually goes out.**

- `linkDiscordMessage(jobInfo.messageId, discordMsgId)` is called at
  `stream-reply.ts:316` and `:352` — both *inside* the `onProgress` callback's
  `shouldStream` block (`:286-291`), i.e. only when the response streams out
  incrementally in multiple edited chunks before `onComplete` fires.
- The dominant path for a normal (fast, single-shot) reply is the
  `onComplete` handler's final-delivery branch at `stream-reply.ts:501-505`:
  ```
  } else if (streamedChunks === 0) {
    // No streaming happened, send complete response
    await intent.respond(cleanResult);
  }
  ```
  This sends the actual Discord message (`intent.respond` → `discord-reply.ts`
  sets `streamingMessage` at line 206, so `intent.getResponseMessageId()`
  *would* work here) but **never calls `capabilitiesClient.linkDiscordMessage()`
  afterward.** No other branch in `onComplete` calls it either — the
  edit-based-streaming branch (`:473-487`) and the "additional content"
  streaming branch (`:500-523`) also skip it, since by the time `onComplete`
  runs, `discordMessageLinked` was already set `true` by the mid-stream path
  if and only if that path fired.
- `git log -p` on this file confirms this is not a regression: the
  `streamedChunks === 0` branch has never had a link call, in any revision.
  It's a day-one gap in Context Alchemy's wiring, not something the v3
  rewrite broke relative to the old `packages/discord` gateway (worth a
  direct diff against `~/code/coachartie2/packages/discord/src/handlers/reaction-handler.ts`
  if you want to confirm the old bot had the same gap or actually did link
  correctly — not done here, out of scope for a 150-word-budget investigation).

Net effect: for the overwhelming majority of replies, `generation_traces.discord_message_id`
stays NULL forever, so a 👍/👎 reaction on that message can never find a row to update,
even when `handleFeedbackReaction()` in `on-reaction.ts:525` runs perfectly.

## Minimal fix (no code written)

In `gateway/4-reply/stream-reply.ts`, after every branch in `onComplete` that
sends or finalizes the visible reply (`:473` edit-based, `:501` no-streaming,
`:506` additional-content streaming), call
`intent.getResponseMessageId?.()` and, if `!discordMessageLinked` and it
returns an id, call `capabilitiesClient.linkDiscordMessage(jobInfo.messageId, id)`
exactly like the two existing call sites do (fire-and-forget `.catch` on
failure). Simplest implementation: extract the existing "link once" block
(lines ~310-321) into a small helper (`maybeLinkDiscordMessage(intent, jobInfo,
discordMessageLinked)` returning the updated flag) and call it from all four
places instead of just two. Also acceptable: call it once, unconditionally,
right after the whole `onComplete` message-sending `if/else if` chain, since
`getResponseMessageId()` reflects whatever `streamingMessage` is by then regardless
of which branch ran.

No DB schema change needed — `discord_message_id` and its index already exist
(`shared/db/schema.ts:797`, confirmed in prod `.schema generation_traces`).

## How to verify on prod

1. Deploy the fix, restart `coach-artie` (`pm2 restart coach-artie`).
2. Send Artie a message in a guild, wait for the one-shot reply (the common
   case — don't rely on a long streamed reply).
3. `ssh vps "sqlite3 -readonly /srv/artie/data/coachartie.db \"SELECT id, message_id, discord_message_id, started_at FROM generation_traces ORDER BY started_at DESC LIMIT 1;\""` — `discord_message_id` should now be the Discord snowflake of the reply, not NULL.
4. React 👍 or 👎 on that message. Confirm in debug log:
   `grep 'Feedback reaction received\|Recorded .* feedback' logs/app/coachartie-debug.log`.
5. Re-query the same row — `feedback_sentiment`, `feedback_emoji`, `feedback_at`
   should now be set.
6. Watch the aggregate over a day: `SELECT COUNT(*), COUNT(discord_message_id), COUNT(feedback_sentiment) FROM generation_traces WHERE started_at > datetime('now','-1 day');` — `COUNT(discord_message_id)` should now track close to `COUNT(*)`, not near-zero.

## Simple quality meter proposal

Once linkage actually works, surface a daily 👍/👎 rate per model in the
existing self-meter/vitals surface rather than building a new dashboard: one
query — `SELECT model_used, COUNT(*) total, SUM(feedback_sentiment='positive') up, SUM(feedback_sentiment='negative') down FROM generation_traces WHERE started_at > datetime('now','-1 day') GROUP BY model_used` —
rendered as a compact per-model line (`gpt-4o-mini: 12👍 / 1👎 (92%)`) next to
whatever vitals/self-meter already reports response time and error rate for
that model. Since feedback volume will stay low (reactions are opt-in), treat
counts under ~5 total as "insufficient signal" rather than computing a
misleadingly precise percentage, and roll a 7-day window into the same line
for a steadier baseline next to the noisier daily one.
