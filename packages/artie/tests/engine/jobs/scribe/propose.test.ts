import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../../../../src/engine/capabilities/registry.js', () => ({
  capabilityRegistry: { execute: executeMock },
}));

import { submitScribeProposals } from '../../../../src/engine/jobs/scribe/propose.js';
import type { ScribeProposal } from '../../../../src/engine/jobs/scribe/types.js';

const CONTEXT = { userId: 'owner-1', guildId: 'guild-1', channelId: 'channel-1' };

beforeEach(() => {
  executeMock.mockReset();
});

describe('submitScribeProposals: routes through capabilityRegistry.execute, never confirmed', () => {
  it('calls github:create_issue for a create proposal, with no confirmed flag', async () => {
    executeMock.mockResolvedValue('⏸️ This github:create_issue call needs EJ\'s approval first (pending #42). EJ can review it with the approvals tool.');

    const proposals: ScribeProposal[] = [
      { kind: 'create', repo: 'owner/repo', title: 'Bug report', body: 'Steps to repro' },
    ];
    const outcomes = await submitScribeProposals(proposals, CONTEXT);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [name, action, params, content, context] = executeMock.mock.calls[0];
    expect(name).toBe('github');
    expect(action).toBe('create_issue');
    expect(params.repo).toBe('owner/repo');
    expect(params.title).toBe('Bug report');
    expect(params.body).toBe('Steps to repro');
    expect(params).not.toHaveProperty('confirmed');
    expect(content).toBe('Steps to repro');
    expect(context).toEqual(CONTEXT);

    expect(outcomes[0].pendingId).toBe(42);
  });

  it('calls github:update_issue for an update proposal, carrying the issue number', async () => {
    executeMock.mockResolvedValue('⏸️ pending #7');
    const proposals: ScribeProposal[] = [
      { kind: 'update', repo: 'owner/repo', issueNumber: 123, title: 'Still broken', body: 'More detail' },
    ];
    await submitScribeProposals(proposals, CONTEXT);

    const [, action, params] = executeMock.mock.calls[0];
    expect(action).toBe('update_issue');
    expect(params.issueNumber).toBe(123);
    expect(params).not.toHaveProperty('confirmed');
  });

  it('never sets confirmed even if a proposal somehow carried one', async () => {
    executeMock.mockResolvedValue('queued');
    const proposals = [
      { kind: 'create', repo: 'owner/repo', title: 't', body: 'b', confirmed: true } as unknown as ScribeProposal,
    ];
    await submitScribeProposals(proposals, CONTEXT);
    const [, , params] = executeMock.mock.calls[0];
    expect(params).not.toHaveProperty('confirmed');
  });

  it('turns a failed call into a failure outcome instead of throwing, and keeps going', async () => {
    executeMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('pending #5');
    const proposals: ScribeProposal[] = [
      { kind: 'create', repo: 'owner/repo', title: 'a', body: 'b' },
      { kind: 'create', repo: 'owner/repo', title: 'c', body: 'd' },
    ];
    const outcomes = await submitScribeProposals(proposals, CONTEXT);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].pendingId).toBeNull();
    expect(outcomes[0].message).toContain('boom');
    expect(outcomes[1].pendingId).toBe(5);
  });

  it('is a no-op for an empty proposal list', async () => {
    const outcomes = await submitScribeProposals([], CONTEXT);
    expect(outcomes).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
