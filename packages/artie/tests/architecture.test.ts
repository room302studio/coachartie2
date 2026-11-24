import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

// Architecture rules (1-2 since wave 3, 3-5 since wave 11):
//   1. src/gateway/** never imports src/engine/**, and the reverse — except through the
//      two seam files (wave 9, one process): the gateway may import src/engine/api.ts and
//      nothing else of the engine; the engine may import src/gateway/api.ts and nothing else
//      of the gateway. src/main.ts (the one entry point, outside both zones) is unrestricted.
//   2. src/shared/** imports neither src/gateway/** nor src/engine/**.
//   3. No index.ts anywhere under src/ (no barrels: an import names the file it means).
//   4. Every src/engine/tools/**/*.ts, and every src/engine/proactive/*.ts that exports a
//      RegisteredCapability, is imported by 5-tool-loop/register-tools.ts (static or dynamic
//      import), except the helper files in TOOL_HELPERS below. A tool file nobody registers
//      is dead code that still looks alive.
//   5. src/engine/tools/** never imports src/engine/2-turn/** or 5-tool-loop/{loop,native-loop}.ts:
//      tools are called BY the loop and must not reach back up into it.
//
// Uses ts.preProcessFile (already a dependency via typescript) instead of regex, so this
// doesn't miss re-exports, type-only imports, or multi-line import clauses the way a
// line-oriented regex would.

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname2, '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

type Zone = 'engine' | 'gateway' | 'shared' | null;
function zoneOf(absPath: string): Zone {
  const rel = relative(SRC, absPath);
  if (rel.startsWith('engine' + '/') || rel === 'engine') return 'engine';
  if (rel.startsWith('gateway' + '/') || rel === 'gateway') return 'gateway';
  if (rel.startsWith('shared' + '/') || rel === 'shared') return 'shared';
  return null;
}

/** The only cross-zone import targets (src-relative, no extension). */
const SEAMS = { engine: join('engine', 'api'), gateway: join('gateway', 'api') } as const;

interface Violation {
  from: string;
  fromZone: Zone;
  spec: string;
  toZone: Zone;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  const files = walk(SRC);

  for (const file of files) {
    const fromZone = zoneOf(file);
    if (!fromZone) continue; // shouldn't happen — src only has engine/gateway/shared

    const text = readFileSync(file, 'utf8');
    const info = ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true);

    for (const imp of info.importedFiles) {
      const spec = imp.fileName;
      if (!spec.startsWith('.')) continue; // bare package specifier — not a cross-zone concern

      const resolvedNoExt = resolve(dirname(file), spec.replace(/\.js$/, ''));
      // We only need to know which top-level zone the resolved path falls under, so comparing
      // the resolved-without-extension path against SRC is enough — no need to probe the
      // filesystem for the real extension (.ts/.tsx/index.ts).
      const toZone = zoneOf(resolvedNoExt + '.ts'); // zoneOf only looks at the path prefix

      if (!toZone || toZone === fromZone) continue;

      // The two seams (wave 9): each zone's api.ts is the only file the other may import.
      const target = relative(SRC, resolvedNoExt);
      if (fromZone === 'gateway' && toZone === 'engine' && target === SEAMS.engine) continue;
      if (fromZone === 'engine' && toZone === 'gateway' && target === SEAMS.gateway) continue;

      const crossesEngineGateway =
        (fromZone === 'gateway' && toZone === 'engine') || (fromZone === 'engine' && toZone === 'gateway');
      const sharedImportsOut = fromZone === 'shared' && (toZone === 'engine' || toZone === 'gateway');

      if (crossesEngineGateway || sharedImportsOut) {
        violations.push({ from: relative(SRC, file), fromZone, spec, toZone });
      }
    }
  }

  return violations;
}

describe('architecture: gateway/engine/shared boundaries', () => {
  it('src/gateway/** imports only src/engine/api.ts of the engine, and the reverse', () => {
    const violations = findViolations().filter(
      (v) =>
        (v.fromZone === 'gateway' && v.toZone === 'engine') ||
        (v.fromZone === 'engine' && v.toZone === 'gateway')
    );
    expect(
      violations,
      violations.map((v) => `${v.from} imports '${v.spec}' (zone ${v.toZone})`).join('\n')
    ).toEqual([]);
  });

  it('src/shared/** imports neither src/engine/** nor src/gateway/**', () => {
    const violations = findViolations().filter((v) => v.fromZone === 'shared');
    expect(
      violations,
      violations.map((v) => `${v.from} imports '${v.spec}' (zone ${v.toZone})`).join('\n')
    ).toEqual([]);
  });

  it('the seam files exist (so the exception above is not vacuous)', () => {
    for (const seam of Object.values(SEAMS)) {
      expect(statSync(join(SRC, seam + '.ts')).isFile()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Rules 3-5 (wave 11)
// ---------------------------------------------------------------------------------------------

/** src-relative paths (with .ts) of every relative import in a file, static or dynamic. */
function importTargets(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return info.importedFiles
    .map((imp) => imp.fileName)
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => relative(SRC, resolve(dirname(file), spec.replace(/\.js$/, ''))) + '.ts');
}

const rel = (abs: string) => relative(SRC, abs);
const REGISTER_TOOLS = join(SRC, 'engine', '5-tool-loop', 'register-tools.ts');

/**
 * Helper files under src/engine/tools/ that register-tools.ts does not import: they hold code a
 * tool uses, not a tool. Each rule names why. The spec's helper shapes are *-client, *-fetch,
 * *-format, *-runtime, harness/**, skills/library/**, email-drafting and meeting helpers; the
 * last two rows (model-router, skills/loader) are helpers without a helper-shaped name.
 */
const TOOL_HELPERS: Array<{ why: string; match: (p: string) => boolean }> = [
  { why: '*-client.ts: API client a tool calls', match: (p) => p.endsWith('-client.ts') },
  { why: '*-fetch.ts: fetch helper', match: (p) => p.endsWith('-fetch.ts') },
  { why: '*-format.ts: output formatting', match: (p) => p.endsWith('-format.ts') },
  { why: '*-runtime.ts: runtime a tool drives', match: (p) => p.endsWith('-runtime.ts') },
  { why: 'research harness', match: (p) => p.startsWith('engine/tools/research/harness/') },
  { why: 'skill library (SKILL.md + scripts)', match: (p) => p.startsWith('engine/tools/skills/library/') },
  { why: 'email drafting mode, routed from run-turn', match: (p) => p === 'engine/tools/people/email-drafting.ts' },
  { why: 'model tier table, used by ops/autonomous.ts', match: (p) => p === 'engine/tools/ops/model-router.ts' },
  { why: 'skill discovery, used by skills/registry.ts', match: (p) => p === 'engine/tools/skills/loader.ts' },
];
const isToolHelper = (p: string) => TOOL_HELPERS.some((h) => h.match(p));

/** Pinned so a new helper file is a deliberate decision, not a silent exception. */
const EXPECTED_HELPER_FILES = [
  'engine/tools/core/web-fetch.ts',
  'engine/tools/ops/embedded-mcp-runtime.ts',
  'engine/tools/ops/model-router.ts',
  'engine/tools/ops/rules-format.ts',
  'engine/tools/ops/system-monitor-format.ts',
  'engine/tools/people/email-drafting.ts',
  'engine/tools/personal/reddit-client.ts',
  'engine/tools/research/harness/openai-research.ts',
  'engine/tools/research/harness/research-queue.ts',
  'engine/tools/research/harness/types.ts',
  'engine/tools/skills/loader.ts',
  'engine/tools/web/wolfram-client.ts',
];

describe('architecture: no barrels', () => {
  it('there is no index.ts under src/', () => {
    const barrels = walk(SRC)
      .filter((f) => /^index\.tsx?$/.test(f.split('/').pop()!))
      .map(rel);
    expect(barrels).toEqual([]);
  });
});

describe('architecture: every tool is registered', () => {
  const registered = new Set(importTargets(REGISTER_TOOLS));
  const toolFiles = walk(join(SRC, 'engine', 'tools')).map(rel);

  it('every src/engine/tools/**/*.ts is imported by register-tools.ts, or is a named helper', () => {
    const missing = toolFiles.filter((p) => !isToolHelper(p) && !registered.has(p));
    expect(missing, `not imported by 5-tool-loop/register-tools.ts:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the helper exceptions are exactly the expected files', () => {
    const helpers = toolFiles.filter(isToolHelper).sort();
    expect(helpers).toEqual(EXPECTED_HELPER_FILES);
  });

  it('every proactive/*.ts that exports a RegisteredCapability is imported by register-tools.ts', () => {
    const dir = join(SRC, 'engine', 'proactive');
    const capabilityFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(dir, f))
      .filter((f) => /export\s+const\s+\w+\s*:\s*RegisteredCapability\s*=/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(capabilityFiles.length).toBeGreaterThan(0); // not vacuous
    const missing = capabilityFiles.filter((p) => !registered.has(p));
    expect(missing, `not imported by 5-tool-loop/register-tools.ts:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('architecture: tools never reach back into the loop', () => {
  it('src/engine/tools/** imports nothing under 2-turn/ and not the loop file', () => {
    const forbidden = (target: string) =>
      target.startsWith('engine/2-turn/') || target === 'engine/5-tool-loop/native-loop.ts';
    const violations: string[] = [];
    for (const file of walk(join(SRC, 'engine', 'tools'))) {
      for (const target of importTargets(file)) {
        if (forbidden(target)) violations.push(`${rel(file)} imports ${target}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
