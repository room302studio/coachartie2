/**
 * The surfaces the issue clerk reaches that the unit tests in issue-clerk.test.ts don't:
 * the model's real entry point (executeNativeToolCall), the tool schema the model is shown,
 * and the webhook path's self-echo filter (handle-push.ts). 2026-11-13.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { publishMessage } = vi.hoisted(() => ({ publishMessage: vi.fn(async () => {}) }));
vi.mock('../../src/shared/queue/enqueue-message.js', () => ({ publishMessage }));

import { capabilityBootstrap } from '../../src/engine/5-tool-loop/register-tools.js';
import { executeNativeToolCall } from '../../src/engine/5-tool-loop/execute.js';
import { capabilityToTool } from '../../src/engine/5-tool-loop/tool-schema.js';
import { githubCapability } from '../../src/engine/tools/dev/github.js';
import { handleGitHubWebhook } from '../../src/engine/jobs/github-push/handle-push.js';
import type { OrchestrationContext } from '../../src/engine/2-turn/types.js';
import { OWNER_USER_ID } from '../../src/shared/config/owner.js';
import { getPendingAction } from '../../src/shared/pending-actions.js';

function makeContext(userId: string): OrchestrationContext {
  return {
    messageId: 'surfaces-msg',
    userId,
    originalMessage: 'test',
    source: 'test',
    capabilities: [],
    results: [],
    currentStep: 0,
    respondTo: async () => {},
    capabilityFailureCount: new Map(),
  } as unknown as OrchestrationContext;
}

beforeAll(() => {
  capabilityBootstrap.initializeCapabilityRegistry();
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

describe('native tool call: the model entry point', () => {
  it('a model-set confirmed:true is stripped, so even the owner\'s github write is parked', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await executeNativeToolCall(makeContext(OWNER_USER_ID), {
      name: 'github',
      action: 'add_labels',
      params: { repo: 'o/r', issueNumber: '41', labels: 'bug,P2', confirmed: true },
    });
    vi.unstubAllGlobals();
    expect(out).toContain("needs EJ's approval");
    expect(fetchSpy).not.toHaveBeenCalled();
    const id = Number(/pending #(\d+)/.exec(out)![1]);
    const row = getPendingAction(id)!;
    const stored = JSON.parse(row.paramsJson);
    expect(stored.confirmed).toBeUndefined();
    expect(stored).toMatchObject({ repo: 'o/r', issueNumber: '41', labels: 'bug,P2' });
  });

  it('reads run straight through the native path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('per_page=1')) {
          return new Response(JSON.stringify({ total_count: 2 }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      })
    );
    const out = await executeNativeToolCall(makeContext('someone'), {
      name: 'github',
      action: 'list_triage',
      params: { repo: 'o/r', filter: 'stale', staleDays: '30' },
    });
    vi.unstubAllGlobals();
    expect(out).not.toContain('approval');
    expect(out).toContain('"staleDays":30');
  });
});

describe('tool schema the model sees', () => {
  const tool = capabilityToTool(githubCapability);
  const props = tool.function.parameters.properties as Record<string, unknown>;

  it('declares every param the clerk actions read', () => {
    for (const name of [
      'repo',
      'issueNumber',
      'labels',
      'label',
      'body',
      'title',
      'filter',
      'staleDays',
      'limit',
      'duplicateOf',
      'state',
      'state_reason',
      'assignees',
      'keywords',
    ]) {
      expect(props, `schema should declare "${name}"`).toHaveProperty(name);
    }
  });

  it('lists the new actions in the action enum', () => {
    const actionEnum = (props.action as { enum: string[] }).enum;
    for (const a of ['find_similar_issues', 'list_triage', 'add_comment', 'add_labels', 'remove_label']) {
      expect(actionEnum).toContain(a);
    }
  });

  it('the description survives the 200-char clip and still says writes need approval', () => {
    expect(tool.function.description).toContain('approval');
  });
});

describe('webhook path: Artie\'s own GitHub actions do not echo', () => {
  const repository = { name: 'r', full_name: 'o/r' };
  let n = 1000;

  function issuePayload(action: string, author: string, sender: string) {
    n += 1;
    return {
      action,
      repository,
      sender: { login: sender },
      issue: { number: n, title: 'T', html_url: 'u', user: { login: author }, labels: [], body: 'b' },
    };
  }

  beforeEach(() => {
    publishMessage.mockClear();
  });

  it('skips an issue Artie opened', async () => {
    await handleGitHubWebhook(issuePayload('opened', 'coachartie', 'coachartie') as any, {
      'x-github-event': 'issues',
    } as any);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('skips Artie closing a human\'s issue (sender is Artie, author is not)', async () => {
    await handleGitHubWebhook(issuePayload('closed', 'ejfox', 'coachartie') as any, {
      'x-github-event': 'issues',
    } as any);
    expect(publishMessage).not.toHaveBeenCalled();
  });

  it('still posts a human closing Artie\'s issue', async () => {
    await handleGitHubWebhook(issuePayload('closed', 'coachartie', 'ejfox') as any, {
      'x-github-event': 'issues',
    } as any);
    expect(publishMessage).toHaveBeenCalledTimes(1);
  });

  it('skips Artie\'s comments, posts a human\'s', async () => {
    const comment = (login: string) => {
      n += 1;
      return {
        action: 'created',
        repository,
        issue: { number: n, title: 'T', html_url: 'u', user: { login: 'ejfox' } },
        comment: { id: n, body: 'hi', html_url: 'u', user: { login } },
      };
    };
    await handleGitHubWebhook(comment('coachartie') as any, { 'x-github-event': 'issue_comment' } as any);
    expect(publishMessage).not.toHaveBeenCalled();
    await handleGitHubWebhook(comment('ejfox') as any, { 'x-github-event': 'issue_comment' } as any);
    expect(publishMessage).toHaveBeenCalledTimes(1);
  });
});
