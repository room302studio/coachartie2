/**
 * Security audit 2026-10-26: owner-only tools, caller identity from context, and the recall
 * target rule. A hostile Discord user must not reach EJ's secrets, data or authority.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { capabilityRegistry } from '../../src/engine/5-tool-loop/registry.js';
import {
  OWNER_ONLY_ACTIONS,
  OWNER_ONLY_REFUSAL,
  isOwnerOnlyAction,
  blocksNonOwner,
} from '../../src/engine/5-tool-loop/owner-only.js';
import { recallTargetUser } from '../../src/engine/tools/core/memory.js';
import { OWNER_USER_ID } from '../../src/shared/config/owner.js';

const NOT_OWNER = 'some-random-discord-user';

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
});

describe('owner-only policy table', () => {
  it('locks every action of the dangerous tools', () => {
    for (const tool of ['sandbox', 'http', 'osint', 'system_memory', 'mention_proxy']) {
      expect(OWNER_ONLY_ACTIONS[tool]).toBe('all');
      expect(isOwnerOnlyAction(tool, 'anything')).toBe(true);
    }
  });

  it('locks only the named actions where a Set is given', () => {
    expect(isOwnerOnlyAction('self-stats', 'user_costs')).toBe(true);
    expect(isOwnerOnlyAction('self-stats', 'summary')).toBe(false);
    expect(isOwnerOnlyAction('deep_research', 'submit')).toBe(true);
    expect(isOwnerOnlyAction('deep_research', 'status')).toBe(false);
  });

  it('leaves ordinary tools alone', () => {
    expect(isOwnerOnlyAction('calculator', 'calculate')).toBe(false);
    expect(isOwnerOnlyAction('web', 'search')).toBe(false);
  });

  it('blocks non-owners and context-less calls, never the owner', () => {
    expect(blocksNonOwner('sandbox', 'exec', { userId: NOT_OWNER })).toBe(true);
    expect(blocksNonOwner('sandbox', 'exec', undefined)).toBe(true);
    expect(blocksNonOwner('sandbox', 'exec', { userId: OWNER_USER_ID })).toBe(false);
  });
});

describe('registry refuses owner-only calls from anyone else', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['sandbox', 'exec', { command: 'echo $GITHUB_TOKEN' }],
    ['http', 'get', { url: 'http://127.0.0.1:47324/api/memories' }],
    ['osint', 'investigations', {}],
    ['system_memory', 'read', {}],
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
