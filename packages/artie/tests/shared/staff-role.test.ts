import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isStaffRole } from '../../src/shared/staff-role.js';

// Wave 7 / ledger #1: one case-insensitive staff-role test replaces four copies.
describe('isStaffRole', () => {
  const table: Array<[string, boolean]> = [
    ['Staff', true],
    ['ADMIN', true],
    ['Admin', true],
    ['dev', true],
    ['Dev Team', true],
    ['Developer', true],
    ['Moderator', true],
    ['Administrator', true],
    ['SBAT', true],
    ['devops', false],
    ['Staffing Agency', false],
    ['adminton', false],
    ['Player', false],
    ['', false],
  ];
  for (const [name, expected] of table) {
    it(`${JSON.stringify(name)} → ${expected}`, () => {
      expect(isStaffRole(name)).toBe(expected);
    });
  }

  it('is the only copy of the staff-role pattern in src/', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../../src');
    const sites = [
      'gateway/routes/moderation.ts',
      'gateway/4-reply/outbound-gate.ts',
      'gateway/1-receive/channel-history.ts',
      'gateway/1-receive/guild-context.ts',
    ];
    for (const rel of sites) {
      const text = readFileSync(join(src, rel), 'utf8');
      expect(text, rel).not.toMatch(/dev\|developer\|moderator/);
      expect(text, rel).toMatch(/isStaffRole\(/);
    }
  });
});
