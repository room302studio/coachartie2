/**
 * Runtime paths — the one place every absolute, cwd-independent path in the system comes from.
 *
 * Before this module, "where does the kill switch / steam notes / guild notes / DB live"
 * was answered a dozen different ways across two packages, almost all of them
 * `process.cwd()`-relative (`join(process.cwd(), '..', '..', 'KILL_SWITCH')`) or
 * `import.meta.url`-relative (`dirname(fileURLToPath(import.meta.url))`). Those happened to
 * agreed back then only because PM2, `turbo run test`, and `nodemon` launched each of the two
 * old services with its cwd set to its own package directory (the since-deleted
 * `packages/capabilities` and `packages/discord`) — nothing enforced that, and wave 3's move
 * into `packages/artie` would have silently re-pointed every one of them.
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
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Walk up from `startDir` until a directory containing `pnpm-workspace.yaml` is found.
 * Throws rather than guessing — a silent wrong answer here is worse than a loud crash at boot.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `paths.ts: walked up from ${startDir} to the filesystem root without finding ` +
          `pnpm-workspace.yaml. This module (packages/artie/src/shared/paths.ts) must live inside ` +
          `the coachartie2 workspace for REPO_ROOT to resolve.`
      );
    }
    dir = parent;
  }
}

// This file's own location — NOT process.cwd(). Whether it's loaded from
// packages/artie/src/shared/paths.ts (tsx/vitest) or packages/artie/dist/shared/paths.js (the
// built output PM2 runs), the walk up finds the same REPO_ROOT either way.
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
 * shares, and `APP_ROOT` was historically an override for guild-file lookups only, not a
 * repo-wide one. That override lives in `getGuildDocsRoot()` below (prod sets `APP_ROOT` to the
 * repo root, so today both agree). The `/app` Docker fallback is genuinely gone —
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

/**
 * Artie's per-guild notes, one Markdown file each. The `scratchpad` capability writes them and
 * the gateway puts them in that guild's context every turn: ONE file per guild, named by
 * `scratchpadPath` in shared/config/guilds.ts, else `guild-<key>.md` here. Until 2026-11-24
 * the tool wrote a different copy (packages/capabilities/..., then reference-docs/scratchpad/)
 * that never reached his context.
 */
export const GUILD_NOTES_DIR = join(REPO_ROOT, 'reference-docs/guild-notes');

/**
 * The root that guild `contextPath` / `scratchpadPath` (shared/config/guilds.ts) resolve
 * against: `APP_ROOT` when it holds a reference-docs/ (an override kept from the Docker days;
 * on prod it equals the repo root), else REPO_ROOT. ONE resolver for the gateway, which reads
 * these files into context, and the scratchpad tool, which writes them, so the two can't
 * point at different files (Codex, 2026-11-24).
 */
export function getGuildDocsRoot(): string {
  const appRoot = process.env.APP_ROOT;
  if (appRoot && existsSync(join(appRoot, 'reference-docs'))) {
    return appRoot;
  }
  return REPO_ROOT;
}

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
 * The one `reference-docs/` tree: guild context files (`contextPath` / `scratchpadPath` in
 * shared/config/guilds.ts, resolved against the repo root), Steam review notes, and
 * GUILD_NOTES_DIR above.
 */
export const REFERENCE_DOCS = {
  root: join(REPO_ROOT, 'reference-docs'),
} as const;

/**
 * The one winston logs directory (wave 9: engine and gateway are one process, so one
 * `logger.ts` instance writes `coachartie-{combined,error,debug}.log` here). `LOGS_DIR` env
 * still wins (`getLogsDir()`). NOT `<repo>/logs` — that's PM2's `out_file`/`error_file`
 * target (`PM2_LOGS`), a different thing.
 */
export const ARTIE_LOGS = join(REPO_ROOT, 'packages/artie/logs');

/**
 * PM2's own `out_file`/`error_file` directory — `ecosystem.config.cjs`'s
 * `coach-artie-out.log`/`coach-artie-error.log` and brain's, NOT winston's `*-combined.log`
 * (`ARTIE_LOGS` above). The vitals monitor is the one reader, and until now it
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
 * Where `logger.ts` writes: `LOGS_DIR` env when set, else `ARTIE_LOGS`
 * (`<repo>/packages/artie/logs`), cwd-independent.
 *
 * Before wave 9 this sniffed `process.cwd()` to tell the engine (cwd `packages/capabilities`)
 * from the gateway (`packages/discord`) and fell back to `<cwd>/logs`. With one process and
 * one package there is nothing to tell apart, so the cwd branch is gone; the directory is the
 * same one `<cwd>/logs` already resolved to since wave 3 (cwd `packages/artie`).
 */
export function getLogsDir(): string {
  if (process.env.LOGS_DIR) return process.env.LOGS_DIR;
  return ARTIE_LOGS;
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
  join(REPO_ROOT, 'packages/artie/src/engine/capabilities/skills/library'),
];

/**
 * The guild-prompt file search order `engine/3-context/assemble.ts` walks, in order: the
 * `APP_ROOT` override, the repo, then the legacy `/data2/*` / `/app` absolute fallbacks
 * verbatim. (`<repo>/packages/capabilities` used to sit second, the old engine's cwd; it held
 * no guild prompts and was removed with that directory on 2026-11-25.)
 *
 * `APP_ROOT` is read per call (not baked in at module load) because it's an env var this
 * search order has always consulted dynamically.
 */
export function getGuildKnowledgeDirs(): string[] {
  return [
    process.env.APP_ROOT,
    REPO_ROOT,
    '/data2/apps/coachartie2',
    '/data2/coachartie2',
    '/app',
  ].filter((dir): dir is string => Boolean(dir));
}

/**
 * The `.env` files the bot loads at boot, in load order, HIGHEST priority first: `dotenv`'s
 * `config()` never overrides a variable that's already set, so the FIRST file to define a
 * name wins, and anything PM2 already put in `process.env` beats it.
 *
 * Just the repo-root `.env`. Wave 9 also listed `packages/capabilities/.env` and
 * `packages/discord/.env` (the two old processes' own files); neither ever existed on prod
 * (checked 2026-10-23 and 2026-11-25), so dropping them changed nothing that loads.
 *
 * `openrouter.ts` deliberately does NOT call this — see its own comment. On prod its old
 * `resolve(__dirname, …)` paths never existed, so it only ever read what PM2 already put in
 * `process.env`; calling `getEnvFiles()` there would load these files earlier than
 * `main.ts`'s own `config()` calls (ESM import hoisting) and change what the micro-LLM slug
 * and model env vars resolve to.
 */
export function getEnvFiles(): string[] {
  return [join(REPO_ROOT, '.env')];
}
