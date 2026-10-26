# Interactive components in normal replies (phase 1)

EJ's ask (2026-10-26): "I liked when we gave him affordances to use the cool discord message
features like the little buttons." Before this, `discord-ui`'s buttons/select/modal/context-menu
only ever worked inside a proactive push (`push-worker.ts` parsing a `DISCORD_UI:` marker at the
start of the message). In a normal reply the marker just bounced back to the model as tool-result
text — prod logs showed 0 real uses. This phase makes buttons and select menus actually attach to
Artie's normal replies, the same way pending file attachments already ride a side channel out of
the engine.

## What was built

**The model** (copied from pending-attachments): a tool queues something keyed by the turn, the
gateway takes it once after the final reply and delivers it.

1. **`packages/artie/src/engine/1-intake/pending-components.ts`** (new) — in-memory store,
   `addPendingComponents(turnId, rows)` / `takePendingComponents(turnId)`, 10-minute TTL.
   Keyed by **turn id** (`CapabilityContext.messageId`, which is the same uuid the gateway holds
   as `jobInfo.messageId` from `submitJob`) — NOT by userId, so two turns from the same person
   never cross. A second call for the same turn (e.g. the model calls `buttons` then `select` in
   one reply) **appends** rather than overwrites, clamped to Discord's 5-action-row-per-message
   limit — extra rows from the later call are dropped.

2. **`packages/artie/src/engine/tools/discord/ui.ts`** — `buttons` and `select` actions:
   - When `context.messageId` (a turn id) is present: validate + clamp the payload, build the
     Discord action-row JSON with a **server-built** `custom_id` (`artie:<turnId.slice(-12)>:<index>`
     — the model never supplies this), queue it via `addPendingComponents`, and return a short
     plain-text result the model can use in its reply (e.g. "3 buttons will appear under your
     reply: Yes / No / Maybe.").
   - When there is no turn id (the proactive-push path): **unchanged** legacy behavior — the old
     `DISCORD_UI:BUTTONS:...` / `DISCORD_UI:SELECT:...` inline marker, so `push-worker.ts` keeps
     working exactly as before.
   - Validation (clamp/drop invalid entries, never throw on an individual bad entry):
     - ≤5 rows, ≤5 buttons/row (25 total); label ≤80 chars, non-empty.
     - Styles limited to `primary`/`secondary`/`success`/`danger`/`link`; unknown → `secondary`.
     - `link`-style buttons require an `http(s)` url and get no `custom_id`; without a valid url
       the button is dropped.
     - Select: ≤25 options, each needs a non-empty label.
     - If literally nothing survives validation, the tool throws (there's nothing to show).
   - `modal`/`context-menu`: **unchanged functionally** (still can't attach to a plain reply —
     they need a live interaction to open, or Discord API registration). Only the trailing
     human-readable message changed, from a claim of success ("created! waiting for
     interaction...") to an honest "this can't actually appear here" explanation.
   - Tool description updated to tell the model buttons/select attach under its own reply
     automatically and that a click comes back as a new turn.

3. **`packages/artie/src/engine/api.ts`** — two new seam exports (not HTTP routes, gateway-only):
   - `pendingComponents(turnId)` → `{ rows }`, wrapping `takePendingComponents`.
   - `brownoutStatus()` → the current `BrownoutStatus` (mode/runway), for the click cap below.

4. **`packages/artie/src/gateway/3-ask-engine/engine-client.ts`** — `getPendingComponents(turnId)`
   and `getBrownoutMode()`, mirroring `getPendingAttachments`. `on-component-click.ts` goes
   through `capabilitiesClient.getBrownoutMode()` rather than calling `engine.brownoutStatus()`
   directly, matching how every other gateway caller reaches the engine.

5. **`packages/artie/src/gateway/4-reply/stream-reply.ts`** — right after the existing pending-
   attachments block (post-completion, same `onComplete` handler): if `intent.attachComponents`
   exists, fetch `getPendingComponents(jobInfo.messageId)` (turn id, not userId) and call it.
   Wrapped in its own try/catch — an attach failure never takes down the already-delivered text
   reply, just a `logger.warn`.

6. **`packages/artie/src/gateway/4-reply/discord-reply.ts`** — new `attachComponents` hook.
   `streamingMessage` (pre-existing) is always the FIRST chunk of the reply — `editResponse`/
   `deleteResponse` need that. A second tracking ref, `lastSentMessage`, was added and is updated
   on every `message.reply`/`channel.send` inside `respond`, so `attachComponents` edits the
   actual **last** message the turn sent (falling back to `streamingMessage` if, somehow,
   nothing ever updated it). This matters for a >2000-char reply: chunk 0 goes out via
   `message.reply`, the rest via `channel.send`, and buttons on chunk 0 would sit above trailing
   text otherwise. If there's no editable message at all (e.g. the whole reply stayed
   `[SILENT]`), sends a small follow-up message carrying just the components instead.

7. **`packages/artie/src/gateway/1-receive/on-component-click.ts`** (new) — the click loopback:
   - `parseArtieCustomId` recognizes only `artie:<turnId>:<index>`; anything else (quiz, daily,
     schedule, vote, `ask_`, or a stray third-party id) is left alone.
   - `on-interaction.ts` routes a button/select interaction whose `customId` starts with
     `artie:` here, **before** any of the existing quiz/daily/schedule/vote/`ask_` checks.
   - Caps, in-memory, keyed by the Discord **message** id, 10-minute TTL per entry:
     - One click-turn per user per message (a repeat click gets an ephemeral "Already got your
       pick on this one.").
     - `ARTIE_BUTTON_CLICK_CAP` total click-turns per message (default **8**); past it, an
       ephemeral "That one's closed out — too many clicks already." No LLM call either way.
   - Brownout `critical` (via the new `engine.brownoutStatus()` seam, through
     `capabilitiesClient.getBrownoutMode()`): ephemeral "Running lean right now — @ me
     instead." — no LLM call. The combined decision (brownout wins over the cap) is the pure,
     exported `clickRefusal(brownoutMode, check)` — testable without a live brownout lookup or
     a real interaction.
   - On a genuine, allowed click: defers, then calls `processUserIntent` as the **clicker's own
     turn** (`source: 'button'`), with `context: { platform: 'discord', guildId, channelId }` so
     guild-scoped memory/last-time rules apply instead of owner-only defaults (the existing
     `handleButtonInteraction` for other custom-id families doesn't set this — worth fixing
     there too, left alone here since it's out of this task's scope). The intent also carries
     `attachComponents` (edits the deferred reply via `interaction.editReply({ components })`),
     so a click's own reply can chain further buttons/select menus — not integration-tested here
     (would need mocking the whole submit/poll job pipeline), but code-reviewed against the same
     `ActionRowBuilder.from()` pattern used everywhere else.
   - The click's content, built by `buildClickTurnText`:
     `[button] <displayName> picked "<label>" on your message "<first 80 chars>" (<n>s after you posted)`
     — label comes straight from `interaction.component.label` (button) or the matched select
     option, so there's no server-side label lookup to keep in sync with the queued row.
   - The DM gate (pairing allowlist) already runs at the very top of
     `setupInteractionHandler` for every interaction type, before dispatch reaches here — this
     handler only adds an explicit `isBlockedUser` check (the blocklist is a separate thing from
     DM pairing).

## Env knobs

- `ARTIE_BUTTON_CLICK_CAP` — total click-turns per message before it's "closed out". Default 8.

## Files touched

```
NEW   src/engine/1-intake/pending-components.ts
NEW   src/gateway/1-receive/on-component-click.ts
EDIT  src/engine/api.ts
EDIT  src/engine/tools/discord/ui.ts
EDIT  src/gateway/1-receive/on-interaction.ts
EDIT  src/gateway/3-ask-engine/engine-client.ts
EDIT  src/gateway/4-reply/discord-reply.ts
EDIT  src/gateway/4-reply/stream-reply.ts
NEW   tests/engine/pending-components.test.ts
NEW   tests/engine/discord-ui-components.test.ts
NEW   tests/gateway/on-component-click.test.ts
```

## Phase 2 (not built — notes only)

- **Components V2 layout cards** (containers/sections/separators/media galleries, gated by the
  `IS_COMPONENTS_V2` flag). Prod runs discord.js 14.25.1, which supports it. This would be a
  genuinely different message shape (a "layout card" replacing plain content+components), useful
  for tier lists, digests and quiz results — not a drop-in extension of the buttons/select path
  built here. It would need its own queueing shape in `pending-components.ts` (or a sibling
  store) since V2 cards aren't action rows, and `discord-reply.ts`'s `attachComponents` would
  need a V2-aware variant (the `IS_COMPONENTS_V2` message flag changes how `content` and
  `components` interact — V2 messages can't mix with plain `content` the way action rows do).
- **Tier-list vote tallying that edits the card in place.** Needs the V2 card above as the
  surface to edit, plus a place to persist tallies (a small table keyed by message id, similar
  in shape to the quiz/daily-vote tables already in `commands/quiz/`), and a dedicated
  `artie:tally:...` custom_id family so clicks route past the generic click-turn loopback built
  here straight into a tally update instead of becoming an LLM turn (every click here is a paid
  turn — a tally click should NOT be).

## Open questions / things worth a second look

- `handleButtonInteraction`'s existing non-`artie:` branch (the generic fallback that sends the
  button's label to `processUserIntent`) does not set `context.guildId`/`channelId` either — it
  has the same gap this task's new handler fixes for its own path. Not touched here since it's
  pre-existing behavior outside this task's scope, but it means guild-scoped memory/last-time
  rules are probably already inconsistent for *other* button families (quiz/daily buttons don't
  go through `processUserIntent` at all, so they're unaffected; the generic fallback at the
  bottom of `handleButtonInteraction` is the one that matters).
- The click cap's per-user "already got your pick" is keyed by Discord message id, which is
  stable even if `attachComponents` falls back to a follow-up message (different message id
  than the original reply) — clicks on that follow-up get their own independent cap bucket. This
  seems like the right behavior (it's a distinct message) but is worth confirming against how
  often the follow-up path actually fires in practice.
- Confirmed, not assumed: `engine/proactive/delivery.ts` pushes straight to the
  `OUTGOING_DISCORD` queue (`this.discordQueue`) without running the turn through
  `submitTurn`/the capability registry at all, so proactive content never gets a
  `CapabilityContext.messageId` and the `discord-ui` tool's no-turn-id (legacy `DISCORD_UI:`)
  branch is genuinely the only path that content can take — not a guess.
- `parseArtieCustomId` is exported and unit-tested but `handleComponentClick` doesn't actually
  call it — routing off `customId.startsWith('artie:')` and caps off `interaction.message.id`
  are enough. Fine for phase 1; the turn id encoded in the custom_id isn't load-bearing anywhere
  yet (it would matter if a future phase needed to recover which turn originally queued a row
  from the click alone).
