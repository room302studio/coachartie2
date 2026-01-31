import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { metroModulePath, memoryModulePath, processMetroAttachment, remember } = vi.hoisted(() => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODELS = 'test/model';
  process.env.AUTO_VISION_EXTRACT = 'false';
  return {
    metroModulePath: new URL('../src/services/monitoring/metro-doctor.js', import.meta.url).pathname,
    memoryModulePath: new URL('../src/capabilities/memory/memory.js', import.meta.url).pathname,
    processMetroAttachment: vi.fn(),
    remember: vi.fn(),
  };
});

vi.mock(metroModulePath, () => ({
  processMetroAttachment,
}));

vi.mock(memoryModulePath, () => ({
  MemoryService: {
    getInstance: () => ({
      remember,
      recall: vi.fn().mockResolvedValue(''),
      recallByTags: vi.fn().mockResolvedValue([]),
    }),
  },
}));

import { contextAlchemy } from '../src/services/llm/context-alchemy';

describe.skip('ContextAlchemy metro follow-ups', () => {
  const baseSystemPrompt = 'system';
  const userId = 'user-123';
  const recentTimestamp = new Date().toISOString();
  const recentMetro = {
    id: 'att-1',
    name: 'save.metro',
    url: 'https://example.com/save.metro',
    contentType: 'application/octet-stream',
    size: 1234,
    proxyUrl: null,
    author: 'tester',
    authorId: userId,
    messageId: 'msg-1',
    timestamp: recentTimestamp,
  };

  beforeEach(() => {
    processMetroAttachment.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      filename: 'save.metro',
      analysis: {
        summary: 'summary',
        stats: { stations: 1, routes: 2, trains: 3, money: 4 },
        warnings: [],
      },
    });
    remember.mockResolvedValue(undefined);
    process.env.AUTO_METRO_DOCTOR = 'true';
  });

  afterEach(() => {
    processMetroAttachment.mockReset();
    remember.mockReset();
    delete process.env.AUTO_METRO_DOCTOR;
  });

  it('reuses a recent metro attachment for follow-up questions', async () => {
    await contextAlchemy.buildMessageChain(
      'Which routes have the longest distances between stations?',
      userId,
      baseSystemPrompt,
      [],
      {
        includeCapabilities: false,
        discordContext: {
          attachments: [],
          recentAttachments: [recentMetro],
          recentUrls: [],
        },
      }
    );

    expect(processMetroAttachment).toHaveBeenCalledTimes(1);
    expect(processMetroAttachment).toHaveBeenCalledWith(recentMetro.url, undefined);
  });

  it('does not reuse recent metro attachments for unrelated messages', async () => {
    await contextAlchemy.buildMessageChain('hello there', userId, baseSystemPrompt, [], {
      includeCapabilities: false,
      discordContext: {
        attachments: [],
        recentAttachments: [recentMetro],
        recentUrls: [],
      },
    });

    expect(processMetroAttachment).not.toHaveBeenCalled();
  });
});
