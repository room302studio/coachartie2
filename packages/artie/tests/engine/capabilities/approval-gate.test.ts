/**
 * Approval gate (2026-10-26): "Any tool that sends email, moves money (stripe), or acts
 * outside Discord must require the owner's approval" (owner ruling, 2026-10-23).
 *
 * Gated by each action's declared effect (outside/money, tool-policy.ts), enforced in
 * CapabilityRegistry.execute() — the one choke point every call path (native loop, the
 * legacy XML loop, and the HTTP execute-tool route) shares. A gated call from anyone but the
 * owner — or from the owner without `confirmed: true` — gets parked in pending_actions and a
 * plain "needs EJ's approval" string back, never the real side effect. The `approvals` tool
 * is how EJ actually resolves one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { capabilityBootstrap } from '../../../src/engine/capabilities/register-all.js';
import { capabilityRegistry } from '../../../src/engine/capabilities/registry.js';
import { OWNER_USER_ID } from '../../../src/shared/config/owner.js';
import { listPendingActions } from '../../../src/shared/pending-actions.js';
import { testUserId } from '../../test-ids.js';

const NOT_OWNER = 'some-random-discord-user';

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
});

describe('approval gate: gated calls are blocked, not run', () => {
  it('stripe (all actions) is gated for a non-owner caller', async () => {
    const out = await capabilityRegistry.execute(
      'stripe',
      'create_payment_link',
      { name: 'Test', amount: 10 },
      undefined,
      { userId: testUserId(NOT_OWNER) }
    );
    expect(out).toContain("needs EJ's approval");
    expect(out).toContain('stripe:create_payment_link');
  });

  it('stripe is gated for the owner too, without an explicit confirm', async () => {
    const out = await capabilityRegistry.execute(
      'stripe',
      'create_payment_link',
      { name: 'Test', amount: 10 },
      undefined,
      { userId: testUserId(OWNER_USER_ID) }
    );
    expect(out).toContain("needs EJ's approval");
  });

  it('the owner bypasses the gate with confirmed: true (reaches the real handler)', async () => {
    const out = await capabilityRegistry.execute(
      'stripe',
      'create_payment_link',
      { name: 'Test', amount: 10, confirmed: true },
      undefined,
      { userId: testUserId(OWNER_USER_ID) }
    );
    // Not configured in the test env, so the REAL handler fails for its own reason — the
    // point is it's not the gate's canned message.
    expect(out).not.toContain("needs EJ's approval");
  });

  it('email:send is gated; email:status (read) is not', async () => {
    const gated = await capabilityRegistry.execute(
      'email',
      'send',
      { to: 'a@b.com', subject: 'hi', body: 'hi' },
      undefined,
      { userId: testUserId(NOT_OWNER) }
    );
    expect(gated).toContain("needs EJ's approval");

    const ungated = await capabilityRegistry.execute('email', 'status', {}, undefined, {
      userId: testUserId(NOT_OWNER),
    });
    expect(ungated).not.toContain("needs EJ's approval");
  });

  // http is owner-only now (owner-only.ts), so a non-owner never reaches the gate; the owner
  // still gets gated on writes.
  it('http POST is gated for the owner; http GET is not', async () => {
    const gatedPost = await capabilityRegistry.execute(
      'http',
      'post',
      { url: 'https://example.com', body: {} },
      undefined,
      { userId: testUserId(OWNER_USER_ID) }
    );
    expect(gatedPost).toContain("needs EJ's approval");

    // GET isn't gated — it reaches the real handler, which then fails for its own network
    // reason in this sandbox (no egress). Either a thrown network error or a returned string
    // is fine here; the only thing under test is that it's NOT the gate's canned message.
    try {
      const ungatedGet = await capabilityRegistry.execute(
        'http',
        'get',
        { url: 'https://example.invalid/does-not-matter' },
        undefined,
        { userId: testUserId(OWNER_USER_ID) }
      );
      expect(ungatedGet).not.toContain("needs EJ's approval");
    } catch (error) {
      expect(String(error)).not.toContain("needs EJ's approval");
    }
  });

  it('a gated call creates a pending_actions row', async () => {
    const before = listPendingActions('pending').length;
    await capabilityRegistry.execute('reddit', 'post', { subreddit: 'x', title: 'y', text: 'z' }, undefined, {
      userId: testUserId(NOT_OWNER),
    });
    const after = listPendingActions('pending').length;
    expect(after).toBe(before + 1);
  });

  it('reddit read actions are not gated', async () => {
    // Not configured in the test env, so the real handler throws/errors for its own reason —
    // the only thing under test is that it's not the gate's canned message.
    try {
      const out = await capabilityRegistry.execute('reddit', 'read', {}, undefined, {
        userId: testUserId(NOT_OWNER),
      });
      expect(out).not.toContain("needs EJ's approval");
    } catch (error) {
      expect(String(error)).not.toContain("needs EJ's approval");
    }
  });
});

describe('approvals tool: EJ-only review of the pending queue', () => {
  beforeEach(async () => {
    // Fresh pending item for each test.
    await capabilityRegistry.execute(
      'stripe',
      'deactivate_payment_link',
      { linkId: 'plink_test123' },
      undefined,
      { userId: testUserId(NOT_OWNER) }
    );
  });

  it('a non-owner cannot list/approve/deny', async () => {
    // Refused at the registry (approvals declares who:'owner') before the handler's own check.
    for (const action of ['list', 'approve', 'deny']) {
      const out = await capabilityRegistry.execute('approvals', action, { id: 1 }, undefined, {
        userId: testUserId(NOT_OWNER),
      });
      expect(out, action).toContain('EJ-only');
    }
  });

  it('EJ can list pending actions', async () => {
    const out = await capabilityRegistry.execute('approvals', 'list', {}, undefined, {
      userId: testUserId(OWNER_USER_ID),
    });
    expect(out).toContain('stripe:deactivate_payment_link');
  });

  it('EJ can deny a pending action', async () => {
    const pending = listPendingActions('pending').find((p) => p.tool === 'stripe');
    expect(pending).toBeTruthy();

    const out = await capabilityRegistry.execute(
      'approvals',
      'deny',
      { id: pending!.id },
      undefined,
      { userId: testUserId(OWNER_USER_ID) }
    );
    expect(out).toContain('Denied');

    const stillPending = listPendingActions('pending').find((p) => p.id === pending!.id);
    expect(stillPending).toBeUndefined();
  });

  it('EJ can approve a pending action and it actually runs', async () => {
    const pending = listPendingActions('pending').find(
      (p) => p.tool === 'stripe' && p.status === 'pending'
    );
    expect(pending).toBeTruthy();

    const out = await capabilityRegistry.execute(
      'approvals',
      'approve',
      { id: pending!.id },
      undefined,
      { userId: testUserId(OWNER_USER_ID) }
    );
    expect(out).toContain('Approved');
    // The replayed call reached the real stripe handler (not configured in test env, so it
    // reports its own error) rather than being re-queued as pending again.
    expect(out).not.toContain("needs EJ's approval");
  });
});

/**
 * The drafting flow's email:send specifically carries its payload in `content` (the drafted
 * body), not in `params` — see email-drafting.ts's handleSendDraft(). A bug in the first pass
 * at this gate dropped `content` on the way into pending_actions and back out on replay, so
 * approving a gated email would send with no body. Caught on review, fixed in
 * pending-actions.ts (added a `content` column) and approvals.ts (replays it). This is the
 * end-to-end check: a stub tool whose result IS its content, gated like any real tool, run
 * non-owner (queues), then approved (must come back with the content, not "undefined").
 */
describe('approval gate: content (not just params) survives the pending/approve round-trip', () => {
  const STUB_NAME = 'gate-content-stub';

  beforeAll(() => {
    capabilityRegistry.register({
      name: STUB_NAME,
      supportedActions: ['echo'],
      actions: { echo: { effect: 'outside' } }, // declared outside => approval-gated
      handler: async (_params: unknown, content?: string) => `echoed: ${content ?? '(none)'}`,
    });
  });

  afterAll(() => {
    capabilityRegistry.unregister(STUB_NAME);
  });

  it('a gated call with payload in `content` replays with that same content on approve', async () => {
    const queued = await capabilityRegistry.execute(
      STUB_NAME,
      'echo',
      {},
      'the drafted body',
      { userId: testUserId(NOT_OWNER) }
    );
    expect(queued).toContain("needs EJ's approval");

    const pending = listPendingActions('pending').find((p) => p.tool === STUB_NAME);
    expect(pending).toBeTruthy();
    expect(pending!.content).toBe('the drafted body');

    const approved = await capabilityRegistry.execute(
      'approvals',
      'approve',
      { id: pending!.id },
      undefined,
      { userId: testUserId(OWNER_USER_ID) }
    );
    expect(approved).toContain('echoed: the drafted body');
  });
});
