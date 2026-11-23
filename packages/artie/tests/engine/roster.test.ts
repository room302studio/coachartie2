/**
 * Roster snapshot test.
 *
 * Boots the capability registry the same way production does
 * (capabilityBootstrap.initializeCapabilityRegistry(), then the setImmediate
 * skills registration; embedded-mcp and scrapbook, once a module-load side-door
 * in the registry, are in bootstrap's list since wave 7), then compares the
 * sorted roster of `name: [sorted supportedActions]` against a committed
 * snapshot. This is a tripwire for wave 4's merges, not a judgment on shape.
 */

import { describe, it, expect } from 'vitest';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { capabilityRegistry } from '../../src/engine/5-tool-loop/registry.js';
import expected from './roster.expected.json';

async function bootRoster(): Promise<Record<string, string[]>> {
  capabilityBootstrap.initializeCapabilityRegistry();

  // The skills system registers itself via a `setImmediate` in
  // initializeCapabilityRegistry, and `skillRegistry.initialize()` inside
  // that callback does filesystem discovery + async registration. Poll for
  // the 'skills' capability (or a timeout) instead of a fixed sleep.
  const deadline = Date.now() + 5000;
  while (!capabilityRegistry.has('skills') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // One more tick so per-skill registrations inside that same callback land.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const roster: Record<string, string[]> = {};
  for (const cap of capabilityRegistry.list()) {
    roster[cap.name] = [...cap.supportedActions].sort();
  }
  return roster;
}

describe('Capability roster snapshot', () => {
  it('matches the committed roster.expected.json', async () => {
    const actual = await bootRoster();
    try {
      expect(actual).toEqual(expected);
    } catch (err) {
      console.log('ROSTER_ACTUAL ' + JSON.stringify(actual));
      throw err;
    }
  });
});
