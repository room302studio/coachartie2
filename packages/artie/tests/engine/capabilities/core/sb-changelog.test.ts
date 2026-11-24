import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseChangelogSource, formatChangelogEntry, sbChangelogCapability } from '../../../../src/engine/capabilities/core/sb-changelog.js';

const SOURCE = `export type ChangelogEntry = { version: string; date: string; info?: string; changes: { type: string; description: string }[] };

export const changelog: ChangelogEntry[] = [
    {
        version: '2.0.1',
        date: '2026-10-29',
        changes: [{ type: 'bugfix', description: 'Fixed the thing.' }],
    },
    {
        version: '2.0.0',
        date: '2026-10-28',
        info: 'A big one.',
        changes: [
            { type: 'bugfix', description: "Fixed trains " + 'not stopping.' },
            { type: 'feature', description: \`Platform doors\` },
            { type: 'moddingchange', description: 'New mod hook.' },
            { type: 'improvement', description: 'Faster big cities.' },
        ],
    },
];
`;

describe('sb_changelog parsing', () => {
  it('reads entries from the TypeScript source without evaluating it', async () => {
    const entries = await parseChangelogSource(SOURCE);
    expect(entries.map((e) => e.version)).toEqual(['2.0.1', '2.0.0']);
    expect(entries[1].info).toBe('A big one.');
    expect(entries[1].changes[0]).toEqual({ type: 'bugfix', description: 'Fixed trains not stopping.' });
  });

  it('formats sections in the game order, with every item', async () => {
    const [, entry] = await parseChangelogSource(SOURCE);
    const out = formatChangelogEntry(entry, 'beta');
    expect(out.startsWith('Subway Builder 2.0.0 (beta, 2026-10-28)\nA big one.')).toBe(true);
    const order = ['Features:', 'Improvements:', 'Bug fixes:', 'Modding changes:'].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain('- Platform doors');
    expect(out).toContain('- New mod hook.');
  });

  it('returns nothing for a file without a changelog array', async () => {
    expect(await parseChangelogSource('export const x = 1;')).toEqual([]);
  });
});

describe('sb_changelog tool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers a specific version, labelling betas, and says so when a version is unknown', async () => {
    const main = SOURCE.replace(/\{\s*version: '2\.0\.1'[\s\S]*?\},\n {4}\{/, '{');
    const branchSource = (url: string) => {
      if (url.includes('ref=beta')) return SOURCE;
      return main;
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(branchSource(url), { status: 200 })));
    const v200 = await sbChangelogCapability.handler({ action: 'get', version: 'v2.0.0' }, undefined);
    expect(v200).toContain('Subway Builder 2.0.0 (public');
    const latest = await sbChangelogCapability.handler({ action: 'get' }, undefined);
    expect(latest).toContain('Subway Builder 2.0.1 (beta');
    expect(latest).toContain('Latest public release: 2.0.0');
    expect(await sbChangelogCapability.handler({ action: 'get', version: '9.9' }, undefined)).toContain(
      'No changelog entry for 9.9'
    );
  });
});
