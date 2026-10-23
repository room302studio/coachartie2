import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveJailedPath,
  filesystemCapability,
} from '../../src/engine/tools/dev/filesystem.js';

// Wave 7 (c) / ledger #9: the filesystem tool's jail is path.resolve + a root+sep prefix
// check + realpath, not a '..'-stripping regex.
describe('filesystem jail (temp root)', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fs-jail-'));
    outside = mkdtempSync(join(tmpdir(), 'fs-outside-'));
    writeFileSync(join(root, 'README.md'), '# hi');
    writeFileSync(join(root, '.env.production'), 'X=1');
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'coachartie.db'), '');
    mkdirSync(join(root, 'packages', 'artie'), { recursive: true });
    writeFileSync(join(root, 'packages', 'artie', '.env'), 'X=1');
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(root, '.env.production'), join(root, 'innocent.txt'));
  });

  const refused = [
    '../../etc/passwd',
    '%2e%2e/',
    '%2e%2e/%2e%2e/etc/passwd',
    '/etc/passwd',
    '.env.production',
    'packages/artie/.env',
    'data/coachartie.db',
    'escape/secret.txt', // symlink out of the root
    'escape/missing.txt', // missing leaf under a symlinked parent
    'innocent.txt', // symlink to a sensitive file inside the root
    'README.md/../../x', // resolve() normalizes, then the prefix check refuses
  ];
  for (const p of refused) {
    it(`refuses ${p}`, async () => {
      await expect(resolveJailedPath(p, root)).rejects.toThrow(/Access denied/);
    });
  }

  it('refuses a sibling directory that shares the root as a string prefix', async () => {
    await expect(resolveJailedPath(`../${root.split('/').pop()}-old/x`, root)).rejects.toThrow(
      /Access denied/
    );
  });

  it('allows README.md and the root itself', async () => {
    await expect(resolveJailedPath('README.md', root)).resolves.toBe(join(root, 'README.md'));
    await expect(resolveJailedPath('.', root)).resolves.toBe(root);
  });

  it('allows a missing file inside the root (exists reports it absent)', async () => {
    await expect(resolveJailedPath('nope/missing.md', root)).resolves.toBe(
      join(root, 'nope', 'missing.md')
    );
  });
});

describe('filesystem tool on the real repo', () => {
  const run = (path: string, action = 'read_file') =>
    filesystemCapability.handler({ action, path }, undefined);

  it('reads README.md', async () => {
    await expect(run('README.md')).resolves.toMatch(/^File content from README\.md:/);
  });

  for (const p of ['../../etc/passwd', '%2e%2e/', '/etc/passwd', '.env.production', 'data/coachartie.db']) {
    it(`refuses ${p}`, async () => {
      await expect(run(p)).rejects.toThrow(/Access denied/);
    });
  }

  it('is still read-only', () => {
    expect(filesystemCapability.supportedActions).toEqual(['read_file', 'list_directory', 'exists']);
  });
});
