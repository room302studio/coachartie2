/**
 * Issue clerk (2026-11-13): new github actions, their gating, the approval queue's TTL and
 * dedupe, and the #robot ping text. No network: fetch is stubbed per test.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { capabilityRegistry } from '../../src/engine/5-tool-loop/registry.js';
import { GATED_ACTIONS, isGatedAction } from '../../src/engine/5-tool-loop/approval-gate.js';
import { formatApprovalPing } from '../../src/engine/5-tool-loop/approval-ping.js';
import {
  githubCapability,
  issueClerk,
  normalizeLabels,
  similarity,
  titleTerms,
  withProvenance,
  ARTIE_WRITE_MARKER,
} from '../../src/engine/tools/dev/github.js';
import { OWNER_USER_ID } from '../../src/shared/config/owner.js';
import {
  canonicalJson,
  expireStalePendingActions,
  getPendingAction,
  listPendingActions,
} from '../../src/shared/pending-actions.js';
import { getSyncDb } from '../../src/shared/db/client.js';

const NOT_OWNER = 'issue-clerk-test-user';

/** Every github action that changes something on GitHub. Reads are everything else. */
const WRITE_SHAPED = /^(create|update|add|remove|delete|close|reopen|set|assign|lock|transfer|edit|merge)_/;

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const { status = 200, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    })
  );
  return calls;
}

describe('github gating', () => {
  it('every write-shaped github action is gated, every read is not', () => {
    const gate = GATED_ACTIONS.github;
    expect(gate).not.toBe('all');
    for (const action of githubCapability.supportedActions) {
      if (WRITE_SHAPED.test(action)) {
        expect(isGatedAction('github', action), `${action} must be in GATED_ACTIONS.github`).toBe(true);
      } else {
        expect(isGatedAction('github', action), `${action} is a read and must stay open`).toBe(false);
      }
    }
  });

  it('add_comment from a non-owner is parked, not sent', async () => {
    const calls = stubFetch(() => ({ body: {} }));
    const out = await capabilityRegistry.execute(
      'github',
      'add_comment',
      { repo: 'o/r', issueNumber: '5', body: 'gate test unique 1' },
      undefined,
      { userId: NOT_OWNER }
    );
    expect(out).toContain("needs EJ's approval");
    expect(calls).toHaveLength(0);
  });

  it('an identical gated call reuses the pending row instead of stacking another', async () => {
    const params = { repo: 'o/r', issueNumber: '6', labels: 'bug' };
    const reordered = { labels: 'bug', issueNumber: '6', repo: 'o/r' };
    const first = await capabilityRegistry.execute('github', 'add_labels', params, undefined, { userId: NOT_OWNER });
    const second = await capabilityRegistry.execute('github', 'add_labels', reordered, undefined, {
      userId: NOT_OWNER,
    });
    const id = Number(/#(\d+)/.exec(first)![1]);
    expect(second).toContain('already waiting');
    expect(second).toContain("needs EJ's approval");
    expect(second).toContain(`#${id}`);
    const rows = listPendingActions('pending').filter(
      (p) => p.tool === 'github' && p.action === 'add_labels' && p.paramsJson === canonicalJson(params)
    );
    expect(rows).toHaveLength(1);
  });
});

describe('pending TTL', () => {
  it('rows older than the TTL expire and can no longer be approved', async () => {
    const out = await capabilityRegistry.execute(
      'github',
      'remove_label',
      { repo: 'o/r', issueNumber: '7', label: 'ttl-test' },
      undefined,
      { userId: NOT_OWNER }
    );
    const id = Number(/#(\d+)/.exec(out)![1]);
    getSyncDb().run(`UPDATE pending_actions SET created_at = datetime('now', '-8 days') WHERE id = ?`, [id]);
    expect(expireStalePendingActions()).toBeGreaterThanOrEqual(1);
    expect(getPendingAction(id)?.status).toBe('expired');

    const calls = stubFetch(() => ({ body: [] }));
    const approve = await capabilityRegistry.execute('approvals', 'approve', { id }, undefined, {
      userId: OWNER_USER_ID,
    });
    expect(approve).toContain('already expired');
    expect(calls).toHaveLength(0);
  });
});

describe('approval ping text', () => {
  it('github asks show repo, issue and what changes', () => {
    const line = formatApprovalPing({
      id: 12,
      tool: 'github',
      action: 'add_labels',
      params: { repo: 'Subway-Builder/metro-maker4', issueNumber: '831', labels: 'bug,P2' },
    });
    expect(line).toContain('#12');
    expect(line).toContain('github:add_labels');
    expect(line).toContain('Subway-Builder/metro-maker4#831');
    expect(line).toContain('bug,P2');
  });

  it('non-github asks never leak params into the channel', () => {
    const line = formatApprovalPing({
      id: 3,
      tool: 'email',
      action: 'send',
      params: { to: 'someone@example.com', subject: 'private' },
    });
    expect(line).toContain('email:send');
    expect(line).not.toContain('example.com');
    expect(line).not.toContain('private');
  });
});

describe('helpers', () => {
  it('normalizeLabels accepts arrays, JSON strings and csv, and dedupes', () => {
    expect(normalizeLabels(['bug', 'P2'])).toEqual(['bug', 'P2']);
    expect(normalizeLabels('["bug","P2"]')).toEqual(['bug', 'P2']);
    expect(normalizeLabels('bug, P2,bug')).toEqual(['bug', 'P2']);
    expect(normalizeLabels(undefined)).toEqual([]);
    expect(normalizeLabels('')).toEqual([]);
  });

  it('withProvenance adds the footer and marker once', () => {
    const once = withProvenance('Hello');
    expect(once).toContain('approved by EJ');
    expect(once).toContain(ARTIE_WRITE_MARKER);
    expect(withProvenance(once)).toBe(once);
  });

  it('title similarity ranks the real duplicate first', () => {
    const q = titleTerms('Trains disappear after loading a save');
    const dup = similarity(q, titleTerms('Trains disappear when loading save file'));
    const other = similarity(q, titleTerms('Add dark mode to settings menu'));
    expect(dup).toBeGreaterThan(0.4);
    expect(other).toBe(0);
  });
});

describe('issue clerk actions (owner-confirmed, fetch stubbed)', () => {
  it('add_comment posts JSON with the provenance footer', async () => {
    const calls = stubFetch(() => ({ status: 201, body: { id: 99, html_url: 'https://github.com/o/r/issues/5#c99' } }));
    const result = await issueClerk.add_comment({ repo: 'o/r', issueNumber: '#5', body: 'Possible duplicate of #4' });
    expect(result.data.commentId).toBe(99);
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/issues/5/comments');
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.body).toContain('Possible duplicate of #4');
    expect(sent.body).toContain(ARTIE_WRITE_MARKER);
  });

  it('add_labels is additive (POST) and parses csv', async () => {
    const calls = stubFetch(() => ({ body: [{ name: 'existing' }, { name: 'bug' }, { name: 'P2' }] }));
    const result = await issueClerk.add_labels({ repo: 'o/r', issueNumber: '5', labels: 'bug,P2' });
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ labels: ['bug', 'P2'] });
    expect(result.data.labelsNow).toContain('existing');
  });

  it('remove_label treats a missing label as a no-op, not an error', async () => {
    stubFetch(() => ({ status: 404, body: { message: 'Label does not exist' } }));
    const result = await issueClerk.remove_label({ repo: 'o/r', issueNumber: '5', label: 'nope' });
    expect(result.data.removed).toBeNull();
  });

  it('remove_label on a missing issue is an error, not a silent no-op', async () => {
    stubFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    await expect(issueClerk.remove_label({ repo: 'o/r', issueNumber: '99999', label: 'bug' })).rejects.toThrow(
      /not found/
    );
  });

  it('state_reason "reopened" alone reopens', async () => {
    const calls = stubFetch(() => ({ body: { number: 5, title: 't', state: 'open', html_url: 'u', updated_at: '' } }));
    await capabilityRegistry.execute(
      'github',
      'update_issue',
      { repo: 'o/r', issueNumber: '5', state_reason: 'reopened', confirmed: true },
      undefined,
      { userId: OWNER_USER_ID }
    );
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ state: 'open', state_reason: 'reopened' });
  });

  it('a 403 says Artie may lack write access', async () => {
    stubFetch(() => ({ status: 403, body: { message: 'Resource not accessible' } }));
    await expect(issueClerk.add_labels({ repo: 'o/r', issueNumber: '5', labels: 'bug' })).rejects.toThrow(
      /write access/
    );
  });

  it('find_similar_issues scores and sorts, skipping PRs and the issue itself', async () => {
    stubFetch(() => ({
      body: {
        items: [
          { number: 10, title: 'Settings menu typo', state: 'open', html_url: 'u10', updated_at: '', created_at: '', comments: 0 },
          { number: 11, title: 'Trains disappear after loading save', state: 'open', html_url: 'u11', updated_at: '', created_at: '', comments: 2 },
          { number: 12, title: 'Trains disappear fix', state: 'closed', html_url: 'u12', updated_at: '', created_at: '', comments: 0, pull_request: {} },
          { number: 13, title: 'Trains disappear after loading a save', state: 'open', html_url: 'u13', updated_at: '', created_at: '', comments: 0 },
        ],
      },
    }));
    const result = await issueClerk.find_similar_issues({
      repo: 'o/r',
      title: 'Trains disappear after loading a save',
      excludeNumber: '13',
    });
    const numbers = result.data.matches.map((m: { number: number }) => m.number);
    expect(numbers[0]).toBe(11);
    expect(numbers).not.toContain(12);
    expect(numbers).not.toContain(13);
  });

  it('list_triage returns the three facet counts and a list', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('per_page=1')) return { body: { total_count: 4 } };
      return { body: { items: [{ number: 1, title: 'Old', state: 'open', html_url: 'u', updated_at: '', created_at: '', comments: 0 }] } };
    });
    const result = await issueClerk.list_triage({ repo: 'o/r', filter: 'unassigned' });
    expect(result.data.counts).toEqual({ unassigned: 4, unlabeled: 4, stale: 4, open: 4 });
    expect(result.data.issues).toHaveLength(1);
    expect(decodeURIComponent(calls[calls.length - 1].url)).toContain('no:assignee');
  });

  it('update_issue closes as duplicate using the other issue id', async () => {
    const calls = stubFetch((url, init) => {
      if (!init?.method) return { body: { id: 555000, number: 4 } };
      return { body: { number: 5, title: 't', state: 'closed', html_url: 'u', updated_at: '' } };
    });
    const out = await capabilityRegistry.execute(
      'github',
      'update_issue',
      { repo: 'o/r', issueNumber: '5', duplicateOf: '#4', confirmed: true },
      undefined,
      { userId: OWNER_USER_ID }
    );
    expect(out).toContain('duplicate of #4');
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({
      state: 'closed',
      state_reason: 'duplicate',
      duplicate_issue_id: 555000,
    });
  });
});
