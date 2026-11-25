#!/usr/bin/env node
/**
 * Drift check for the vendored @scrapbook/schema copy.
 * Compares sha256 of the vendored body (everything after the VENDORED-BODY marker)
 * with packages/schema/index.js in the private scrapbook-core monorepo.
 *
 *   node scripts/check-scrap-schema-drift.mjs [path-to-vendored-file]
 *
 * Env SCRAPBOOK_CORE = monorepo checkout (default ~/code/scrapbook-core).
 * Reads origin/main via git when possible, else the working file. Exit 1 on drift,
 * 0 on match or when the monorepo is not reachable (CI) so it never blocks a deploy.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARKER = '// ---- VENDORED-BODY ----\n';
const vendored =
  process.argv[2] || 'packages/artie/src/engine/capabilities/personal/scrap-schema.ts';
const core = process.env.SCRAPBOOK_CORE || join(homedir(), 'code', 'scrapbook-core');
const rel = 'packages/schema/index.js';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function monorepoSource() {
  try {
    return execFileSync('git', ['-C', core, 'show', `origin/main:${rel}`], { encoding: 'utf8' });
  } catch {
    const p = join(core, rel);
    if (existsSync(p)) return readFileSync(p, 'utf8');
    return null;
  }
}

const text = readFileSync(vendored, 'utf8');
const at = text.indexOf(MARKER);
if (at < 0) {
  console.error(`drift-check: no VENDORED-BODY marker in ${vendored}`);
  process.exit(1);
}
const body = text.slice(at + MARKER.length);
const upstream = monorepoSource();
if (upstream === null) {
  console.log('drift-check: scrapbook-core not reachable, skipped');
  process.exit(0);
}
if (sha(body) === sha(upstream)) {
  console.log(`drift-check: ok (${sha(body).slice(0, 12)})`);
  process.exit(0);
}
console.error(
  `drift-check: DRIFT vendored ${sha(body).slice(0, 12)} vs scrapbook-core ${sha(upstream).slice(0, 12)}`
);
console.error(
  'Re-vendor: copy packages/schema/index.js after the marker and update the header commit.'
);
process.exit(1);
