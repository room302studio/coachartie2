/**
 * Security audit 2026-10-26: owner-only tools, caller identity from context, and the recall
 * target rule. A hostile Discord user must not reach EJ's secrets, data or authority.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { capabilityBootstrap } from '../../../src/engine/capabilities/register-all.js';
import { capabilityRegistry } from '../../../src/engine/capabilities/registry.js';
import { OWNER_ONLY_REFUSAL, gatesFor } from '../../../src/engine/capabilities/policy.js';
import { recallTargetUser } from '../../../src/engine/capabilities/core/memory.js';
import { OWNER_USER_ID } from '../../../src/shared/config/owner.js';

const NOT_OWNER = 'some-random-discord-user';

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
});

function ownerOnly(tool: string, action: string): boolean {
  const cap = capabilityRegistry.list().find((c) => c.name === tool);
  return gatesFor(cap?.actions, action).ownerOnly;
}

// The full per-action matrix lives in policy.test.ts; these are the headline rules.
describe('owner-only, derived from each tool declaration', () => {
  it('locks every action of the dangerous tools, including an undeclared synonym', () => {
    for (const tool of ['sandbox', 'hermes', 'http', 'osint', 'system_memory', 'mention_proxy']) {
      const cap = capabilityRegistry.list().find((c) => c.name === tool)!;
      for (const action of cap.supportedActions) {
        expect(ownerOnly(tool, action), `${tool}:${action}`).toBe(true);
      }
      expect(ownerOnly(tool, 'anything')).toBe(true);
    }
  });

  it('locks only the named actions on mixed tools', () => {
    expect(ownerOnly('self-stats', 'user_costs')).toBe(true);
    expect(ownerOnly('self-stats', 'overview')).toBe(false);
    expect(ownerOnly('deep_research', 'submit')).toBe(true);
    expect(ownerOnly('deep_research', 'status')).toBe(false);
  });

  it('leaves ordinary tools alone', () => {
    expect(ownerOnly('calculator', 'calculate')).toBe(false);
    expect(ownerOnly('web', 'search')).toBe(false);
  });
});

describe('registry refuses owner-only calls from anyone else', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['sandbox', 'exec', { command: 'echo $GITHUB_TOKEN' }],
    ['http', 'get', { url: 'http://127.0.0.1:47324/api/memories' }],
    ['osint', 'investigations', {}],
    ['system_memory', 'read', {}],
    ['hermes', 'execute', { task: 'df -h' }],
    ['hermes', 'run', { task: 'df -h' }], // an old synonym gets the tool's strictest gates
    ['mention_proxy', 'create', { target_user_id: OWNER_USER_ID, response_mode: 'direct' }],
  ];

  for (const [tool, action, params] of cases) {
    it(`${tool}:${action} from a non-owner returns the refusal, not the handler`, async () => {
      const out = await capabilityRegistry.execute(tool, action, params, undefined, {
        userId: NOT_OWNER,
      });
      expect(out).toBe(OWNER_ONLY_REFUSAL);
    });
  }

  it('a context-less call (e.g. a nested sequence step) is refused too', async () => {
    const out = await capabilityRegistry.execute('sandbox', 'exec', { command: 'id' });
    expect(out).toBe(OWNER_ONLY_REFUSAL);
  });

  it('a sequence cannot smuggle an owner-only step or a forged userId', async () => {
    const out = await capabilityRegistry.execute(
      'sequence',
      'execute',
      {
        userId: OWNER_USER_ID,
        steps: JSON.stringify([{ name: 'sandbox', action: 'exec', command: 'id' }]),
      },
      undefined,
      { userId: NOT_OWNER }
    );
    expect(out).toContain(OWNER_ONLY_REFUSAL);
  });
});

describe('memory recall target', () => {
  it('a non-owner always searches only their own memories', () => {
    expect(recallTargetUser(OWNER_USER_ID, NOT_OWNER)).toBe(NOT_OWNER);
    expect(recallTargetUser('john', NOT_OWNER)).toBe(NOT_OWNER);
    expect(recallTargetUser(undefined, NOT_OWNER)).toBe(NOT_OWNER);
  });

  it('the owner may name someone else', () => {
    expect(recallTargetUser('john', OWNER_USER_ID)).toBe('john');
    expect(recallTargetUser(undefined, OWNER_USER_ID)).toBe(OWNER_USER_ID);
  });
});
