import { describe, it, expect, vi } from 'vitest';

// Wave 7 (e): registry.ts registers nothing when it loads; register-tools.ts owns every
// registration, including embedded_mcp and scrapbook (the old module-load side-door).
describe('capability registry has no load-time registrations', () => {
  it('a freshly loaded registry is empty', async () => {
    vi.resetModules();
    const { capabilityRegistry } = await import('../../src/engine/5-tool-loop/registry.js');
    expect(capabilityRegistry.size()).toBe(0);
  });

  it('bootstrap registers embedded_mcp and scrapbook first, where the side-door put them', async () => {
    vi.resetModules();
    const { capabilityRegistry } = await import('../../src/engine/5-tool-loop/registry.js');
    const { capabilityBootstrap } = await import('../../src/engine/5-tool-loop/register-tools.js');
    capabilityBootstrap.initializeCapabilityRegistry();
    const names = capabilityRegistry.list().map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['embedded_mcp', 'scrapbook', 'calculator']);
  });
});
