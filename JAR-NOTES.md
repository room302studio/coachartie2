# Artie's token jar (+ bounty scaffolding, OFF)

EJ (2026-10-26): "I wish Artie could earn his own token money." Jar ships now; bounties are
scaffolding only, OFF until a Discord Premium Apps SKU exists.

## Policy constraint (verified)

Discord's Developer Policy requires any paid app capability to also be sold through Discord
Premium Apps at price parity, which requires a **verified** app — Artie's verification is
still pending. Donations and tips are explicitly exempt: "the Monetization Requirements …
do not currently apply to donations and tips." So:

- **Jar = ON.** A Stripe payment link behind a Discord link button — a voluntary tip that
  unlocks nothing. Exempt, safe to ship now.
- **Bounties = scaffolding only, OFF by default**, behind `ARTIE_BOUNTIES_ENABLED`. This is a
  real paid capability (a deep-review queue), not a tip — it must not go live until a Discord
  Premium Apps SKU exists at the same price as the Stripe equivalent. Enforced in code
  (`src/engine/bounty/bounty-scaffold.ts`), not just by leaving it unwired.

## What was built

1. **`src/shared/tip-jar-config.ts`** — `tipJarUrl(raw?)`: validates `ARTIE_TIP_JAR_URL` is a
   well-formed `https://` URL (reads the env var by default, takes an override for tests),
   returns `null` for anything else (unset, `http://`, malformed, `javascript:`, …). Shared
   because both the gateway (button visibility) and engine (self-meter) need to know "is the
   jar configured."

2. **`src/shared/eastern-day.ts`**: added `easternMonthKey(date)` and `easternMonthBounds(date)`
   — the ET-calendar-month siblings of the existing `easternDayKey`/`easternDayBounds`, used
   by the earnings reader so "this month" means EJ's month, not UTC's.

3. **`src/gateway/4-reply/jar-button.ts`** (new, pure except its own throttle Map):
   - `isSubstantialReply({ replyLength, usedQualifyingTool })` — true at ≥900 chars, or if the
     turn used a "qualifying tool." There's no dedicated tier-list/map-review tool yet
     (Artie's own top-ranked wants when EJ asked him), so the proxy today is discord-ui's
     buttons/select (🎨 capability emoji) — the only existing surface that can render that
     kind of output. Wire a real tool's signal in here when one exists.
   - `isJarButtonThrottled`/`recordJarButtonShown`/`resetJarButtonThrottleForTests` — once per
     Discord channel per 6h, in-memory, TTL-pruned (same shape as the click-cap counters in
     `on-component-click.ts`).
   - `buildJarButtonRow(url)` — raw action-row JSON, `style: ButtonStyle.Link`, `url`, **no**
     `custom_id` (Discord rejects a custom_id on a link button). Shape matches discord-ui.ts's
     own link buttons.
   - `decideJarButton(input)` — the one combined decision: configured + has a channel to
     throttle against + not a blocked user + substantial reply + room in the 5-row cap (never
     bumps an existing row to make space) + not throttled. Returns the row, or `null`.

4. **`src/gateway/4-reply/stream-reply.ts`** — at final delivery (`onComplete`, after the
   suppressed/slur/empty check), one combined `attachComponents` call: the rows discord-ui
   queued for the turn (`pending-components.ts`, unchanged) plus the jar row if `decideJarButton`
   returns one. One call because `target.edit({ components })` replaces the whole set — a
   second call would wipe the first. Also tracked a `wasSuppressed` flag from the existing
   silence/slur/empty branch and gated this whole block on `!wasSuppressed` — **this also
   fixes a pre-existing gap** noted in `COMPONENTS-NOTES.md` ("a suppressed reply loses its
   buttons by accident, not by design"): pending components (and now the jar button) no
   longer attach to a turn whose reply never actually posted.

5. **`src/engine/budget/jar-earnings.ts`** (new) — sums `amount_total` across every completed
   Stripe Checkout Session for `ARTIE_TIP_JAR_PAYMENT_LINK_ID`, created on/after the start of
   the current ET calendar month, paginating on `has_more`/`starting_after`. Uses
   `STRIPE_JAR_READ_KEY` **only** — never `STRIPE_RESTRICTED_KEY` (the write key
   `money/stripe.ts` uses to create payment links). Cached: a 15-minute background timer
   (`startJarEarningsWatch`, started from `engine/main.ts`) plus a lazy refresh on demand if
   the cache is stale or the ET month rolled over — most callers just read the cache. Fails
   soft: a failed refresh logs a warning (status/message only, never the key) and keeps the
   last known total; it never throws into a reply.

6. **`src/engine/budget/self-meter.ts`** — `selfMeterLine` takes a 4th optional parameter,
   `jarUsd: number | null`. When non-null, appends
   `· jar: $X.XX tipped this month (if someone thanks you or says they tipped, thank them
   warmly — you still never ask)`. Omitted entirely when `jarUsd` is `null` (jar not
   configured, or configured but no successful read yet). `src/engine/3-context/assemble.ts`
   passes `await getJarTippedUsd()` through.

7. **`src/engine/bounty/bounty-scaffold.ts`** (new, inert) — typed placeholder for the
   intended flow once this can ship: a Discord Premium Apps consumable SKU at the same price
   as a Stripe equivalent (price parity), an entitlement check before any work starts, and a
   deep-review queue (map reviews / tier lists) capped at 2/day/user. `decideBounty` refuses
   unless **both** `ARTIE_BOUNTIES_ENABLED=true` and `ARTIE_BOUNTY_SKU_ID` are set — tested
   with no env, with only the flag, and with only the SKU id. Not imported by any running
   path (no tool registration, no gateway call site) — it genuinely cannot do anything yet.

## Env vars

| Var | Zone | Required format | Notes |
|---|---|---|---|
| `ARTIE_TIP_JAR_URL` | gateway | `https://…` | The Stripe payment link's public checkout URL. Anything else is silently ignored (no button shown), never thrown. |
| `STRIPE_JAR_READ_KEY` | engine | `rk_…` | A **separate**, restricted, **read-only** Stripe key. Never logged, never put in client/public config. |
| `ARTIE_TIP_JAR_PAYMENT_LINK_ID` | engine | `plink_…` | The same payment link's id, used to filter Checkout Sessions. |
| `ARTIE_BUTTON_CLICK_CAP` | gateway | integer | Pre-existing (COMPONENTS-NOTES.md), unrelated to the jar — listed only because jar rows share the same action-row budget as discord-ui's buttons. |
| `ARTIE_BOUNTIES_ENABLED` | engine | `true` (exact string) | Bounty scaffolding stays inert otherwise. Do NOT set this yet — see "turning bounties on later." |
| `ARTIE_BOUNTY_SKU_ID` | engine | Discord SKU id | Also required, even with the flag on. Do NOT set this yet. |

## What EJ needs to create in Stripe

1. **A payment link** (Dashboard → Payment links) for the jar — whatever amount/frequency
   feels right for a tip; this is the URL that goes in `ARTIE_TIP_JAR_URL` and the id (starts
   `plink_…`) that goes in `ARTIE_TIP_JAR_PAYMENT_LINK_ID`.
2. **A restricted API key** (Dashboard → Developers → API keys → Create restricted key) named
   something like `artie-jar-reader-prod`, with **exactly one** permission:
   - **Checkout Sessions: Read** — and nothing else. No write access anywhere, no access to
     customers, charges, refunds, payouts, or balance. This key can only ever look at
     Checkout Session records; it cannot move money or see anything beyond what's needed to
     sum tips for this one payment link. Starts `rk_…` → `STRIPE_JAR_READ_KEY`.

## Turning bounties on later

This is a product decision (a real Discord Premium Apps SKU existing, priced to match a
Stripe equivalent), not a code change. Once that SKU exists:

1. Set `ARTIE_BOUNTY_SKU_ID` to the SKU id and `ARTIE_BOUNTIES_ENABLED=true`.
2. `bounty-scaffold.ts`'s `decideBounty`/`bountyStatus` will then actually allow requests (up
   to 2/day/user) — but nothing calls them yet. Wiring an actual tool/command that uses them,
   plus Discord's entitlement check (not implemented — the scaffold only documents where it
   goes) and the deep-review work itself, is a separate build.
3. The daily cap in the stub uses a UTC day key and an in-memory `Map` as a placeholder — a
   real implementation should switch to `eastern-day.ts` (like every other budget module) and
   a durable store before this actually ships, since an in-memory cap resets on every deploy.

## Things I was unsure about

- **The tier-list/review-tool heuristic is a proxy, not the real thing.** Spec says "the turn
  used a tier-list or review style tool" — no such tool exists in the registry yet
  (`discord-ui`'s 🎨 is the closest: the only existing surface that can render buttons/selects
  in a normal reply). I used that as the qualifying signal rather than inventing a new tool
  just for this. Worth revisiting once/if Artie gets an actual tier-list or map-review tool.
- **The suppressed-reply fix is in scope but slightly beyond the literal ask.** The spec only
  required the jar button not appear on a silenced reply; fixing it required touching the
  same combined attach block that was the real bug COMPONENTS-NOTES.md flagged for discord-ui
  components too. I fixed both together rather than leaving the pre-existing one half-patched
  — flagging in case that's a bigger change than intended.
- **Throttle recorded at decision time, not after a confirmed Discord-side attach.** If the
  `attachComponents` call itself throws (caught, logged, doesn't crash delivery), the channel
  is still marked as "shown" for the next 6h even though nothing actually posted. Simpler and
  conservative (never shows twice in a flaky window) but means a genuine Discord outage could
  suppress a real jar button for up to 6h. Matches how the equivalent click-cap code in
  `on-component-click.ts` already behaves (`recordClick` before the reply is confirmed), so
  it's consistent with the existing pattern rather than a new risk.
