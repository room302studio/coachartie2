# stack-talk

Ask a cheap long-context model a question over a huge pack of Artie's memories.

Artie's normal recall gives the reply model a few hundred tokens of memories. The store is
~20k memories (~3M tokens). stack-talk packs as much as the chosen model's window holds and
asks one question. It is an archivist, not an oracle: good at "what do we know about X", "who
said Y", "what happened in July"; weak at subtle reasoning across everything.

## Use

Discord, owner only: `/stack-talk question:<…> [deep] [person] [this-server] [public]`.
The reply is private unless `public`.

HTTP (capabilities, localhost only):

```bash
curl -s -X POST http://127.0.0.1:47324/stack-talk -H 'Content-Type: application/json' \
  -d '{"question":"what do we know about the bridge PRs?","askedBy":"<owner discord id>","deep":false}'
```

`scope: { userId?, guildId? }` narrows the pack. `askedBy` must be the owner.

## How the pack is built

1. Keyword matches: the question's keywords OR'd into an FTS5 query on `memories_fts`,
   ranked by bm25 (up to 5,000).
2. Everything else in scope, by importance then recency.
3. Blocklisted users and empty memories are skipped. Lines are added until the budget is
   spent: 80% of the model's window minus the answer and scaffolding, capped by
   `STACK_TALK_MAX_PACK_TOKENS` (default 900k).

## Models and cost (OpenRouter, 2026-09-29)

| setting | default | window | a full pack costs |
|---|---|---|---|
| `STACK_TALK_MODEL` | `moonshotai/kimi-k2.5` | 262k | ~9¢, ~1.4¢ when cached |
| `STACK_TALK_DEEP_MODEL` | `deepseek/deepseek-v4-flash-0731` | 1.31M | ~2¢ |

Other knobs: `STACK_TALK_MAX_OUTPUT_TOKENS` (2000), `STACK_TALK_REASONING` (low),
`STACK_TALK_TIMEOUT_MS` (180000), `STACK_TALK_CONTEXT_TOKENS` (override the window).
Unknown models are assumed to have a 128k window.

## Guardrails

- Same kill switch and daily cap as every call; usage is recorded as step type `stack_talk`.
- **No fallback onto the Haiku/Sonnet rotation** (`fallbackModels: []`): a 200k-token prompt
  there would cost dollars. If the model fails, stack-talk fails.
- Billed at OpenRouter's reported cost. Any model without a `MODEL_PRICING` row now requests
  usage accounting; before, it was booked at $15/$75 per M, so one Kimi pack would have
  recorded ~$3 and tripped the daily cap.

## Registering the command

`npx tsx packages/discord/register-stack-talk.ts` registers only `/stack-talk`, as a guild
command in Room 302 (`STACK_TALK_GUILD_ID` overrides), hidden from non-admins. It does not
touch any other command.
