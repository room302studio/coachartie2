# v3 status (2026-10-26)

v3 is Coach Artie's rebuild: one package (`packages/artie`), one PM2 app (`coach-artie`),
native parallel tool calls, a multiplayer-aware gateway. **It has been live in prod since
2026-10-26 14:35 ET** (branch `v3`). CUTOVER.md records the run, its deviations and the
rollback.

Bench (VPS `/data2/tmp/artie-v3`, HEAD 8261cf9):
- typecheck clean
- lint 0 errors
- **1093 passed / 6 skipped**, up from 985 before this round

## What landed this round

Artie ranked his own wishlist (2026-10-26). Each item below was built, reviewed, and then
approved by him over `/chat`. His sign-off is saved as memory 20493.

| Artie's ask | Where | Notes |
|---|---|---|
| Know who's talking to whom | MULTIPLAYER-NOTES.md §1 | Reply chains, @-targets and "for someone else" flags, built from fields that survive without the MessageContent intent |
| Debounce plus "landed while you were thinking" | MULTIPLAYER-NOTES.md §2 | **Batches are per author** (review fix: a mixed batch ran under one userId). The landed note marks side conversations "(to X)" in arrival order (Artie's follow-up ask) |
| Parallel tool calls | native tool loop (ARCHITECTURE.md) | Already in v3 |
| Collapse the memory zoo | TOOLS-NOTES.md §1 | `memory` gains forget/pin/recent/stats plus a `kind` tag. scratchpad, system_memory, user-profile, goals and variable stay separate, for structural reasons |
| Per-person "last time" line | RECALL-NOTES.md | Open loops and the global profile are **DM-only** (review fix: those tables have no guild_id) |
| Real-time reactions | MULTIPLAYER-NOTES.md §3 | |
| Prune dead tools; gate stripe/email | TOOLS-NOTES.md §2-3 | hello-world merged into `diagnose ping` (F1: merge, never delete). Money, email, reddit/github/wiki writes and http writes queue as `pending_actions` until EJ approves via the `approvals` tool. The bypass flag is stripped on both loops (review fix) |
| Loud fallbacks | self-meter (prod f3e0d5b) + TOOLS-NOTES.md §4 | Swallowed tool failures are now prefixed `Error:` |
| Lighter security reminder | prompts/2026-10-26-kindness-streak.md | **Live in prod** (v3) |
| Creative/kindness streak | prompts/2026-10-26-kindness-streak.md | Warm-first, maker streak, multiplayer block, rude-vs-hostile line (Artie's edit). **Live in prod** (v9) |

**No ternaries (EJ's rule, 2026-10-26).**
- All 1,260 ternaries are gone.
- `eslint.config.mjs` sets `no-ternary: error`, plus a `no-restricted-syntax` ban on sync IIFEs, the ternary in disguise. `pnpm lint` in packages/artie runs both.
- Shared error helpers live in `src/shared/errors.ts`.
- Verified: lint 0 errors, tsc clean, 1093 passed / 6 skipped. The test count is unchanged by the rewrite.

Also this round: CUTOVER.md's boot checks fixed (they would have false-alarmed into a
rollback), winston logs moved onto the LUKS mount (`logs/app`), 17 unused deps dropped, and
stale dev scripts removed (one could `pkill` prod).

## Prod vs. this branch (2026-10-26 end of day)

**Live in prod** (HEAD 2c87a53):
- the v3 cutover
- the kindness prompt v9 and security reminder v3
- the security hotfix (owner-only tools, caller identity from context, closed admin and health routes)

The sandbox container is STOPPED (restart=no).

**Merged here, NOT deployed** (b3dcc0a, 1302 passed / 6 skipped, lint 0):
- **Buttons/selects in replies:** COMPONENTS-NOTES.md
- **`/scribe` voice meeting scribe, Room 302 only:** VOICE-NOTES.md
- **Token jar:** JAR-NOTES.md. It reuses Stripe link "The Artie Fund", `plink_1TvO5aB2X0HWOIsKzUtVUko6`.
- **Security batch 2:** SECURITY-NOTES.md

**To deploy:**
1. Bundle, then ff-merge prod onto v3.
2. `pnpm install --frozen-lockfile` (adds the voice deps).
3. `pnpm --filter @coachartie/artie build`, then `pm2 restart coach-artie`.
4. Run `packages/discord/register-commands.ts` to publish `/scribe`.
5. Set `ARTIE_TIP_JAR_URL` and `ARTIE_TIP_JAR_PAYMENT_LINK_ID` in `.env.production`.

`STRIPE_JAR_READ_KEY` arrives via `scripts/jar-key-from-clipboard.sh`, which hands it to `~/scripts/set-artie-jar-key.sh` on the VPS.

## Needs EJ (nothing below happens without a yes)

1. **OpenRouter top-up.** The account balance is about $5 and drives brownout/lean mode.
2. ~~Load the prompt proposal.~~ **Done 2026-10-26.** It's live in prod (v9/v3). Rollback is in
   the proposal file.
3. ~~Run the cutover.~~ **Done 2026-10-26.** Soak watch for 24h (CUTOVER.md step 11).
4. **UX change to confirm:** EJ's own stripe/email calls become two-step: Artie queues the
   call, then EJ approves it. The model can no longer self-confirm.
5. **After the soak:** move or delete the 618M of plaintext pre-v3 winston logs in
   `packages/{capabilities,discord}/logs`.
6. **Outside Discord's control:** privileged intents are pending app verification. Until
   they're approved, Artie sees only @mentions and DMs, and channel digests idle.

## Known gaps (not blocking)

- `pending_actions` has no expiry (TOOLS-NOTES.md, open question 4).
- Scratchpad is still read straight from a file by guild-context.ts (TOOLS-NOTES.md, open question 1).
- Pending burst batches are dropped on shutdown, a window of ≤2.5s. Reaction removals are not
  tracked (MULTIPLAYER-NOTES.md).
- `memory forget` is a hard delete of the caller's own memory.
- Neither `artie-lean` nor `v3` is pushed to GitHub.
