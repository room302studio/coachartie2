import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

// Every relative import specifier under src/ resolves to a real file.
//
// tsc does not check side-effect-only imports (`import './x.js'`), so a stale one builds
// and type-checks cleanly and then throws ERR_MODULE_NOT_FOUND when node links the module.
// Wave 3 left exactly that in engine/main.ts (`./services/capability/capability-orchestrator.js`,
// found and fixed in wave 6). This catches the whole class, dynamic import() included.

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname2, '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function resolves(fromFile: string, spec: string): boolean {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base].some(
    (p) => existsSync(p) && statSync(p).isFile()
  );
}

describe('relative imports resolve', () => {
  it('every relative specifier in src/ points at an existing file', () => {
    const unresolved: string[] = [];
    for (const file of walk(SRC)) {
      const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
      for (const imp of info.importedFiles) {
        if (!imp.fileName.startsWith('.')) continue;
        if (!resolves(file, imp.fileName)) {
          unresolved.push(`${relative(SRC, file)} -> ${imp.fileName}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
