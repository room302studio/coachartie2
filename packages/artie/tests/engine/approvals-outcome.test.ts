/**
 * P12 (state-machine audit 2026-10-31): approve wrote 'approved' before running the action and
 * had no executed/failed state, so an approved action whose replay threw looked done.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'approvals-outcome-')), 'test.db');

let approvals: typeof import('../../src/engine/tools/ops/approvals.js');
let pendingActions: typeof import('../../src/shared/pending-actions.js');
let registry: typeof import('../../src/engine/5-tool-loop/registry.js')['capabilityRegistry'];
let owner: string;

beforeAll(async () => {
  approvals = await import('../../src/engine/tools/ops/approvals.js');
  pendingActions = await import('../../src/shared/pending-actions.js');
  registry = (await import('../../src/engine/5-tool-loop/registry.js')).capabilityRegistry;
  owner = (await import('../../src/shared/config/owner.js')).OWNER_USER_ID;
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
