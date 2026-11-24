/**
 * P12 (state-machine audit 2026-10-31): approve wrote 'approved' before running the action and
 * had no executed/failed state, so an approved action whose replay threw looked done.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'approvals-outcome-')), 'test.db');

let approvals: typeof import('../../../../src/engine/capabilities/ops/approvals.js');
let pendingActions: typeof import('../../../../src/shared/pending-actions.js');
let registry: typeof import('../../../../src/engine/capabilities/registry.js')['capabilityRegistry'];
let owner: string;

beforeAll(async () => {
  approvals = await import('../../../../src/engine/capabilities/ops/approvals.js');
  pendingActions = await import('../../../../src/shared/pending-actions.js');
  registry = (await import('../../../../src/engine/capabilities/registry.js')).capabilityRegistry;
  owner = (await import('../../../../src/shared/config/owner.js')).OWNER_USER_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function park(): number {
  return pendingActions.createPendingAction({
    tool: 'email',
    action: 'send',
    params: { to: 'someone@example.com' },
    requestedBy: 'someone',
  });
}

describe('approvals:approve outcome', () => {
  it('marks the action executed once the replay succeeds', async () => {
    vi.spyOn(registry, 'execute').mockResolvedValue('sent');
    const id = park();
    await approvals.approvalsCapability.handler({ action: 'approve', id }, undefined, {
      userId: owner,
    });
    expect(pendingActions.getPendingAction(id)?.status).toBe('executed');
  });

  it('marks the action failed when the replay throws', async () => {
    vi.spyOn(registry, 'execute').mockRejectedValue(new Error('smtp down'));
    const id = park();
    await expect(
      approvals.approvalsCapability.handler({ action: 'approve', id }, undefined, { userId: owner })
    ).rejects.toThrow('smtp down');
    expect(pendingActions.getPendingAction(id)?.status).toBe('failed');
  });

  it('a second approve does not run it again', async () => {
    const execute = vi.spyOn(registry, 'execute').mockResolvedValue('sent');
    const id = park();
    await approvals.approvalsCapability.handler({ action: 'approve', id }, undefined, {
      userId: owner,
    });
    const again = await approvals.approvalsCapability.handler({ action: 'approve', id }, undefined, {
      userId: owner,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(again).toContain('already executed');
  });
});

describe('the requester hears how it ended (Artie, 2026-11-17)', () => {
  function pendingFrom(requestedBy: string, context: Record<string, unknown>) {
    return {
      id: 7,
      tool: 'email',
      action: 'send',
      paramsJson: '{"to":"x@example.com"}',
      content: 'the secret draft body',
      contextJson: JSON.stringify(context),
      requestedBy,
      reason: null,
      status: 'pending' as const,
      createdAt: '2026-11-17 12:00:00',
      resolvedAt: null,
      resolvedBy: null,
    };
  }

  it('pings them in the original channel with the outcome, never the content', () => {
    const notice = approvals.requesterNotice(pendingFrom('u1', { channelId: 'c9' }), 'denied');
    expect(notice).toEqual({
      userId: 'u1',
      channelId: 'c9',
      text: "<@u1> your request #7 (email:send): EJ didn't approve it, so it didn't happen.",
    });
    expect(notice!.text).not.toContain('secret');
  });

  it('falls back to a DM when there was no channel, and covers every outcome', () => {
    for (const outcome of ['executed', 'failed', 'denied', 'expired'] as const) {
      const notice = approvals.requesterNotice(pendingFrom('u1', {}), outcome);
      expect(notice!.channelId).toBeUndefined();
      expect(notice!.text).toMatch(/^<@u1> your request #7/);
    }
  });

  it('says nothing to EJ himself or to system callers', () => {
    expect(approvals.requesterNotice(pendingFrom(owner, { channelId: 'c' }), 'executed')).toBeNull();
    expect(approvals.requesterNotice(pendingFrom('unknown-user', {}), 'denied')).toBeNull();
  });

  it('expiry hands the lapsed rows to the listener', async () => {
    const heard: number[] = [];
    pendingActions.onPendingActionsExpired((rows) => heard.push(...rows.map((r) => r.id)));
    const id = park();
    const { getSyncDb } = await import('../../../../src/shared/db/client.js');
    getSyncDb().run(`UPDATE pending_actions SET created_at = datetime('now', '-8 days') WHERE id = ?`, [id]);
    expect(pendingActions.expireStalePendingActions()).toBeGreaterThanOrEqual(1);
    expect(heard).toContain(id);
    pendingActions.onPendingActionsExpired(null);
  });
});
