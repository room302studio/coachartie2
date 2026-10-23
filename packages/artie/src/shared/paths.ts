/**
 * Runtime paths — the one place every absolute, cwd-independent path in the system comes from.
 *
 * Before this module, "where does the kill switch / steam notes / guild notes / DB live"
 * was answered a dozen different ways across two packages, almost all of them
 * `process.cwd()`-relative (`join(process.cwd(), '..', '..', 'KILL_SWITCH')`) or
 * `import.meta.url`-relative (`dirname(fileURLToPath(import.meta.url))`). Those happened to
 * agree today because PM2, `turbo run test`, and `nodemon` all launch each service with its
 * cwd set to that service's own package directory (`packages/capabilities` or
 * `packages/discord`) — but nothing enforced that, and the next layout change (wave 3's move
 * into `packages/artie`) would have silently re-pointed every one of them.
 *
 * REPO_ROOT below is found by walking up from THIS FILE's own location (never `process.cwd()`)
 * until a directory containing `pnpm-workspace.yaml` is found. Every other export is built from
 * that, so they resolve to the same absolute location no matter who imports this module or what
 * their cwd is.
 *
 * Env var overrides that existed before this module keep winning, exactly as they did before:
 * `KILL_SWITCH_PATH`, `STRIKE_PATH`, `STEAM_REVIEW_NOTES_PATH`, `CASINO_LEDGER_PATH`,
 * `DATABASE_PATH`, `LOGS_DIR`, `APP_ROOT` (guild-knowledge search only — the Docker-era
 * `APP_ROOT`/`/app` fallback for REPO_ROOT itself is gone now that Docker is: see the
 * `findRepoRoot` doc comment).
 *
 * IMPORTANT: every export whose value depends on `process.env` is a FUNCTION, not a
 * module-load-time constant, and must stay that way. ESM import declarations are hoisted: a
 * module's imports are fully evaluated before ANY of its own top-level statements run,
 * regardless of where the `import` line sits textually. `test-setup.ts` sets
 * `process.env.DATABASE_PATH = ':memory:'` as a top-level statement AFTER its own
 * `import { initializeDb } from './db/client.js';` line — but because of hoisting, that
 * import (and this module, transitively) evaluates BEFORE the assignment runs. A
 * `DATABASE_PATH` computed as a plain const at this module's load time would therefore
 * permanently miss that override (verified empirically; it is not a theoretical concern).
 * Reading `process.env` inside a function, called later, avoids this. `REPO_ROOT` and the
 * other directory constants below have no env override and are genuinely safe as eager consts.
 */

import { existsSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

/**
 * Walk up from `startDir` until a directory containing `pnpm-workspace.yaml` is found.
 * Throws rather than guessing — a silent wrong answer here is worse than a loud crash at boot.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `paths.ts: walked up from ${startDir} to the filesystem root without finding ` +
          `pnpm-workspace.yaml. This module (packages/shared/src/paths.ts) must live inside ` +
          `the coachartie2 workspace for REPO_ROOT to resolve.`
      );
    }
    dir = parent;
  }
}

// This file's own location — NOT process.cwd(). Whether it's loaded from
// packages/shared/src/paths.ts (ts-node/tsx/vitest) or packages/shared/dist/paths.js (the
// built output PM2 actually runs), it sits at the same depth under the repo root, so the walk
// up finds the same REPO_ROOT either way.
const __selfDir = dirname(fileURLToPath(import.meta.url));

/**
 * The repo root: the directory containing `pnpm-workspace.yaml`.
 *
 * `D/handlers/message-handler.ts`'s old `resolveRepoRoot()` additionally probed
 * `process.env.APP_ROOT`, then the hardcoded Docker path `/app`, ahead of two cwd-relative
 * guesses, falling through whenever a candidate didn't contain `reference-docs/`.
 * `C/capabilities/development/filesystem.ts`'s old `PROJECT_ROOT` never had an `APP_ROOT`
 * fallback — it was always plain `path.resolve(process.cwd(), '../..')`.
 *
 * `REPO_ROOT` here deliberately does NOT read `APP_ROOT` — it is the one answer every call site
 * shares, and `APP_ROOT` was historically an override for exactly one of them
 * (`message-handler.ts`'s guild-persona lookup), not a repo-wide one. `.env.production` (read
 * by `ecosystem.config.cjs`, not by this process, and off-limits to open or print per the
 * secrets rules) might still set `APP_ROOT` for all I can verify from here, so
 * `message-handler.ts`'s `resolveRepoRoot()` keeps checking it itself before falling back to
 * `REPO_ROOT`, exactly as it did before. The `/app` Docker fallback there is genuinely gone —
 * the Dockerfiles, docker-compose.prod.yml and start.sh it depended on were deleted in wave 1,
 * so no directory named `/app` exists in any environment this repo now runs in.
 */
export const REPO_ROOT = findRepoRoot(__selfDir);

// ---------------------------------------------------------------------------
// Single files
// ---------------------------------------------------------------------------

/** The global kill switch file. `KILL_SWITCH_PATH` env wins, as it did before. Lazy — see the
 * hoisting note above. */
export function getKillSwitch(): string {
  return process.env.KILL_SWITCH_PATH || join(REPO_ROOT, 'KILL_SWITCH');
}

/** The self-imposed "won't speak in #prison until defended" strike file. `STRIKE_PATH` env
 * wins. Lazy — see the hoisting note above. */
export function getStrikeMode(): string {
  return process.env.STRIKE_PATH || join(REPO_ROOT, 'STRIKE_MODE');
}

/**
 * The Steam review intelligence notes file. `STEAM_REVIEW_NOTES_PATH` env overrides the
 * *relative* suffix (today's default: `reference-docs/subwaybuilder/steam-review-notes.md`),
 * same as before — it was never an override of the whole absolute path. Lazy — see the
 * hoisting note above.
 */
export function getSteamReviewNotes(): string {
  return join(
    REPO_ROOT,
    process.env.STEAM_REVIEW_NOTES_PATH || 'reference-docs/subwaybuilder/steam-review-notes.md'
  );
}

/** The timeout-casino ledger. `CASINO_LEDGER_PATH` env wins. Lazy — see the hoisting note
 * above. */
export function getCasinoLedger(): string {
  return (
    process.env.CASINO_LEDGER_PATH || join(REPO_ROOT, 'packages/discord/data/casino-ledger.json')
  );
}

/** The Steam launch countdown's posted-milestones state. No env override existed before, so
 * this is safe as an eager const. */
export const LAUNCH_STATE = join(REPO_ROOT, 'packages/discord/data/launch-countdown-state.json');

/** The sqlite DB. `DATABASE_PATH` env wins, same as before. Lazy — see the hoisting note above;
 * this is the export the hoisting trap bites hardest, since `test-setup.ts` sets
 * `DATABASE_PATH=':memory:'` for every test run. */
export function getDatabasePath(): string {
  return process.env.DATABASE_PATH || join(REPO_ROOT, 'data/coachartie.db');
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/** The capabilities-package `scratchpad` capability's per-guild notes directory. */
export const CAPABILITIES_GUILD_NOTES = join(
  REPO_ROOT,
  'packages/capabilities/reference-docs/guild-notes'
);

/**
 * The directory the Discord-side "mention proxy" status/metrics/events files and config live
 * in. Preserves `path-resolver.ts`'s exact (if odd) local-mode math:
 * `resolve(dirname(file), '../../../../capabilities/data')` from
 * `packages/discord/src/utils/path-resolver.ts` lands on `<repo>/capabilities/data` — note
 * that's `<repo>/capabilities/data`, NOT `<repo>/packages/capabilities/data`. Keeping that
 * literally, since "Do NOT change behavior" applies to this quirk too.
 */
export const MENTION_PROXY_DATA = join(REPO_ROOT, 'capabilities/data');

/** The root-level `prompts/` directory (seed content; no current runtime read site). */
export const PROMPTS_DIR = join(REPO_ROOT, 'prompts');

/**
 * The two `reference-docs/` trees that exist today. They are NOT the same directory and NOT
 * interchangeable:
 *  - `root`: used by the Discord gateway for guild context/scratchpad files configured in
 *    `guild-whitelist.ts` (`contextPath` / `scratchpadPath`), resolved via `resolveRepoRoot()`
 *    in `message-handler.ts`.
 *  - `capabilities`: the capabilities package's own `reference-docs/`, home to
 *    `CAPABILITIES_GUILD_NOTES` above (the `scratchpad` capability's notes, a different guild
 *    notes concept from the Discord-side one).
 */
export const REFERENCE_DOCS = {
  root: join(REPO_ROOT, 'reference-docs'),
  capabilities: join(REPO_ROOT, 'packages/capabilities/reference-docs'),
} as const;

/**
 * The capabilities engine's logs directory (`winston`'s `*-combined.log`, read by the vitals
 * monitor, the `/logs` route and self-stats). NOT `<repo>/logs` — that's PM2's
 * `error_file`/`out_file` target, a different thing.
 */
export const ENGINE_LOGS = join(REPO_ROOT, 'packages/capabilities/logs');

/** The Discord gateway's logs directory. Same caveats as `ENGINE_LOGS`. */
export const GATEWAY_LOGS = join(REPO_ROOT, 'packages/discord/logs');

/**
 * PM2's own `out_file`/`error_file` directory — `ecosystem.config.cjs`'s
 * `capabilities-out.log`/`discord-out.log` etc, NOT winston's `*-combined.log`
 * (`ENGINE_LOGS`/`GATEWAY_LOGS` above). The vitals monitor is the one reader, and until now it
 * hardcoded the prod absolute path (`/data2/apps/coachartie2/logs`) with `VITALS_LOG_DIR` as
 * its only escape hatch — wrong for this worktree, and wrong for any environment besides that
 * one prod path. `VITALS_LOG_DIR` still wins at the call site; this just fixes the fallback to
 * be cwd-independent and worktree-correct instead of a hardcoded prod path. No behavior change
 * on prod (`ecosystem.config.cjs` never sets `VITALS_LOG_DIR`, so prod fell through to the
 * hardcoded `/data2/apps/coachartie2/logs` before and PM2 really does write there — this export
 * is `REPO_ROOT`-relative, not prod-only, so other environments now get a correct answer too).
 */
export const PM2_LOGS = join(REPO_ROOT, 'logs');

/**
 * Where `logger.ts` (shared by both processes) should write today, cwd-independent.
 *
 * `LOGS_DIR` env always wins (unchanged). No test suite sets `LOGS_DIR` globally today —
 * `paths.test.ts` sets and clears it only inside its own override test (see
 * `packages/shared/tests/paths.test.ts`'s "LOGS_DIR env always wins" case); every other test
 * run inherits the per-package default computed below.
 *
 * This is the one export that still has to look at `process.cwd()` — not to build a relative
 * path (the old bug this wave fixes), but to decide WHICH process's absolute logs directory a
 * single shared logger module should use, since one `logger.ts` module instance runs inside
 * each process. Today cwd is always `<repo>/packages/<pkgname>` under PM2, `turbo run test`
 * (which runs each package's `test` script with that package as cwd) and `nodemon`/`tsx`, so
 * this returns the exact same absolute directory `./logs` resolved to before, for both known
 * packages. Any other cwd (e.g. `packages/shared`'s own tests) falls back to the same
 * cwd-relative `<cwd>/logs` the old code always used — unchanged for that case too.
 *
 * THE COLLAPSE THIS WARNED ABOUT ALREADY HAPPENED, IN THIS WAVE, NOT WAVE 9: `packages/capabilities`
 * and `packages/discord` no longer exist as separate packages with separate cwds — both
 * `dev:engine` and `dev:gateway` (and `test`) now run with cwd `packages/artie`, which matches
 * neither `pkg === 'capabilities'` nor `pkg === 'discord'`, so BOTH branches fall through to the
 * generic `<cwd>/logs` (`packages/artie/logs`) today, for both processes, until they're actually
 * merged into one process (wave 9) or given an explicit per-component logger. This is a real,
 * observable change from wave 2's captured before/after table (which still showed two distinct
 * directories) — flagged in BUILD-LOG for wave 9/CUTOVER rather than silently left. `ENGINE_LOGS`/
 * `GATEWAY_LOGS` are still two separate, correct absolute constants for whoever wires this
 * properly; `LOGS_DIR` env still overrides everything, unchanged.
 */
export function getLogsDir(): string {
  if (process.env.LOGS_DIR) return process.env.LOGS_DIR;
  const pkg = basename(process.cwd());
  if (pkg === 'capabilities') return ENGINE_LOGS;
  if (pkg === 'discord') return GATEWAY_LOGS;
  return join(process.cwd(), 'logs');
}

/**
 * The skills hierarchy search order, highest priority first. Preserves
 * `skill-loader.ts`'s three functionally-distinct entries (its old list of five included two
 * duplicates/dead entries: `PACKAGE_ROOT/skills` is byte-identical to `cwd/skills` when cwd is
 * `packages/capabilities`, and the dist-copy fallback (`__dirname/../../skills`) never has
 * anything under it since nothing copies skills into `dist/`) — checking a directory twice, or
 * checking one that's never populated, changes no observed resolution, so collapsing to the
 * three real candidates here is not a behavior change.
 */
export const SKILLS_DIRS: readonly string[] = [
  join(REPO_ROOT, 'packages/artie/skills'),
  join(process.env.HOME || '', '.coachartie/skills'),
  join(REPO_ROOT, 'packages/artie/src/engine/tools/skills/library'),
];

/**
 * The guild-prompt file search order `context-alchemy.ts`'s `loadGuildPrompt` walks, in order.
 * Preserves the exact order (and the two legacy `/data2/*` / `/app` absolute fallbacks
 * verbatim) from before — only the first two entries (`process.cwd()` and
 * `join(process.cwd(), '..', '..')`) are now anchored off `REPO_ROOT` instead of recomputed
 * from cwd each call; they resolve to the identical absolute paths today (cwd is always
 * `<repo>/packages/capabilities` for this call site).
 *
 * `APP_ROOT` is read per call (not baked in at module load) because it's an env var this
 * search order has always consulted dynamically.
 */
export function getGuildKnowledgeDirs(): string[] {
  return [
    process.env.APP_ROOT,
    join(REPO_ROOT, 'packages/capabilities'),
    REPO_ROOT,
    '/data2/apps/coachartie2',
    '/data2/coachartie2',
    '/app',
  ].filter((dir): dir is string => Boolean(dir));
}

/**
 * The two `.env` files a process loads, in load order, HIGHEST priority first: `dotenv`'s
 * `config()` does not override a variable that's already set, so the FIRST `config()` call
 * wins on conflicts — same as every `C/index.ts`/`D/index.ts` call site today (root `.env`
 * first, then the package-specific one, which therefore can't override the root file's values;
 * both only ever fill in gaps `process.env` doesn't already have).
 *
 * `openrouter.ts` deliberately does NOT call this — see its own comment. On prod its old
 * `resolve(__dirname, …)` paths never existed, so it only ever read what PM2 already put in
 * `process.env`; calling `getEnvFiles()` there would load these files earlier than
 * `index.ts`'s own `config()` calls (ESM import hoisting) and change what the micro-LLM slug
 * and model env vars resolve to.
 */
export function getEnvFiles(pkg: 'capabilities' | 'discord'): string[] {
  return [join(REPO_ROOT, '.env'), join(REPO_ROOT, 'packages', pkg, '.env')];
}
