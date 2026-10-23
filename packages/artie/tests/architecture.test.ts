import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

// Wave 3 architecture rules (rules 3-5 arrive in wave 11):
//   1. src/gateway/** never imports src/engine/**, and the reverse — except through the
//      two seam files (wave 9, one process): the gateway may import src/engine/api.ts and
//      nothing else of the engine; the engine may import src/gateway/api.ts and nothing else
//      of the gateway. src/main.ts (the one entry point, outside both zones) is unrestricted.
//   2. src/shared/** imports neither src/gateway/** nor src/engine/**.
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
