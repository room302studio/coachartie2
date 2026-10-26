/**
 * Security audit 2026-10-26 (sec-abuse.md Critical #3): OpenAI deep-research spend used to be
 * tracked only in-memory and in research_tasks.cost — never written to model_usage_stats, so
 * daily-cap.ts's getTodaySpendUsd (which sums exactly that table) never saw it. pollTask now
 * records it into the shared ledger at completion, the only point a real dollar cost exists.
 */
import { describe, it, expect, vi } from 'vitest';
import { getUserActionCountToday } from '../../src/engine/budget/daily-cap.js';

vi.mock('../../src/engine/tools/research/harness/openai-research.js', () => ({
  openaiResearchHarness: {
    isAvailable: () => true,
    submitTask: vi.fn(),
    pollTask: vi.fn(async () => ({ status: 'completed', progress: 100, toolCalls: 0, webSearches: 0, codeExecutions: 0, elapsedMs: 1000 })),
    getResult: vi.fn(async () => ({
      content: 'the research says X',
      usage: { inputTokens: 1000, outputTokens: 500 },
      cost: { tokens: 0.006, webSearches: 0, codeInterpreter: 0, total: 0.123, currency: 'USD' as const },
      completedAt: new Date(),
    })),
  },
}));

const { researchQueueService } = await import('../../src/engine/tools/research/harness/research-queue.js');

type PrivatePoll = { pollTask: (task: unknown) => Promise<void> };

describe('deep_research spend ledger', () => {
  it('records the completed task cost into model_usage_stats as step_type deep_research', async () => {
    const userId = `research-user-${Date.now()}`;
    const task = {
      id: `research-${Date.now()}`,
      prompt: 'research the thing',
      userId,
      status: 'running' as const,
      handleId: 'handle-1',
      createdAt: new Date(),
      startedAt: new Date(),
    };

    const before = getUserActionCountToday(userId, 'deep_research');
    await (researchQueueService as unknown as PrivatePoll).pollTask(task);
    const after = getUserActionCountToday(userId, 'deep_research');

    expect(after).toBe(before + 1);
  });
});
