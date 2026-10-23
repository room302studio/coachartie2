/**
 * Wave 10: reflection as {"facts": string[]} (ledger Top-5 #3).
 *
 * The reflection call is mocked at openrouter.js; save-reflection runs for real through
 * reflection-facts.ts and stores into a mocked MemoryService. generate-reply.js (which pulls
 * the whole prompt stack) is replaced by a stub whose generateReflection is the real
 * generateReflectionFacts, the function its method delegates to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateMock, rememberMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  rememberMock: vi.fn(async () => 'ok'),
}));

vi.mock('../../src/engine/4-generate/openrouter.js', () => ({
  openRouterService: { generateFromMessageChain: generateMock },
}));

vi.mock('../../src/engine/4-generate/generate-reply.js', async () => {
  const rf = await import('../../src/engine/2-turn/reflection-facts.js');
  return {
    llmResponseCoordinator: {
      generateReflection: rf.generateReflectionFacts,
      buildCapabilityContext: () => 'Capabilities Used: web:search',
    },
  };
});

vi.mock('../../src/engine/tools/core/memory.js', () => ({
  MemoryService: { getInstance: () => ({ remember: rememberMock }) },
}));

import { memoryOrchestration } from '../../src/engine/2-turn/save-reflection.js';
import {
  REFLECTION_OUTPUT,
  buildReflectionMessages,
  parseReflectionFacts,
} from '../../src/engine/2-turn/reflection-facts.js';
import { isStaleNoise } from '../../src/engine/memory/store.js';
import { logger } from '../../src/shared/logger.js';

function turn(capabilities: Array<{ name: string }> = []) {
  return {
    context: { messageId: 'm1', userId: 'u1', capabilities, results: [] } as any,
    message: {
      message: 'I am building a Tokyo save, version 1.4.0',
      context: { guildId: 'g1', channelId: 'c1' },
      respondTo: { channelId: 'c1' },
    } as any,
  };
}

beforeEach(() => {
  generateMock.mockReset();
  rememberMock.mockClear();
});

describe('reflection JSON path', () => {
  it('stores the N facts as one bullet-list reflection row, tagged reflection_v3, server-scoped', async () => {
    generateMock.mockResolvedValueOnce(
      '{"facts":["the user is building a Tokyo save","the save runs on version 1.4.0","the user prefers night mode"]}'
    );
    const { context, message } = turn();
    await memoryOrchestration.autoStoreReflectionMemory(context, message, 'nice');

    expect(rememberMock).toHaveBeenCalledTimes(1);
    const [userId, content, ctx, importance, related, tags, guildId, channelId] = rememberMock.mock.calls[0] as any[];
    expect(userId).toBe('u1');
    expect(content.split('\n')).toEqual([
      '- the user is building a Tokyo save',
      '- the save runs on version 1.4.0',
      '- the user prefers night mode',
    ]);
    expect([ctx, importance, related]).toEqual(['reflection', 3, undefined]);
    expect(tags).toEqual(['reflection_v3']);
    expect([guildId, channelId]).toEqual(['g1', 'c1']);

    // the call asked for structured output, with a code-owned, persona-free prompt
    const [messages, , , model, opts] = generateMock.mock.calls[0];
    expect(model).toBeUndefined(); // sticky rotation, as before
    expect(opts).toMatchObject({
      stepType: 'reflection',
      rotationKey: 'c1',
      jsonOutput: REFLECTION_OUTPUT,
      maxTokens: 800, // a JSON reply cut off mid-array parses to nothing
    });
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('I am building a Tokyo save');
  });

  it('{"facts":[]} stores nothing', async () => {
    generateMock.mockResolvedValueOnce('{"facts":[]}');
    const { context, message } = turn();
    await memoryOrchestration.autoStoreReflectionMemory(context, message, 'hi');
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('a prose reply stores nothing and warns once', async () => {
    const warn = vi.spyOn(logger, 'warn');
    warn.mockClear();
    generateMock.mockResolvedValueOnce("Lap eighteen, comrade. I'm not extracting memorable facts from this.");
    const { context, message } = turn();
    await memoryOrchestration.autoStoreReflectionMemory(context, message, 'hi');
    expect(rememberMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('reflection was not'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('a capability turn stores the capability facts with their tool tags', async () => {
    generateMock.mockResolvedValueOnce('{"facts":[]}');
    generateMock.mockResolvedValueOnce('```json\n{"facts":["web search needs a query param"]}\n```');
    const { context, message } = turn([{ name: 'web' }, { name: 'web' }]);
    await memoryOrchestration.autoStoreReflectionMemory(context, message, 'done');
    expect(rememberMock).toHaveBeenCalledTimes(1);
    const [, content, ctx, importance, , tags] = rememberMock.mock.calls[0] as any[];
    expect(content).toBe('- web search needs a query param');
    expect([ctx, importance]).toEqual(['capability-reflection', 4]);
    expect(tags).toEqual(['capability-reflection', 'reflection_v3', 'web']);
  });

  it('a failed call stores nothing and does not throw', async () => {
    generateMock.mockRejectedValueOnce(new Error('all models failed'));
    const { context, message } = turn();
    await expect(memoryOrchestration.autoStoreReflectionMemory(context, message, 'x')).resolves.toBeUndefined();
    expect(rememberMock).not.toHaveBeenCalled();
  });
});

describe('parseReflectionFacts', () => {
  it('keeps trimmed non-empty strings, caps the count, rejects non-{facts} replies', () => {
    expect(parseReflectionFacts('{"facts":["  a fact  ", "", 3, null, "b"]}')).toEqual(['a fact', 'b']);
    expect(parseReflectionFacts(JSON.stringify({ facts: Array.from({ length: 20 }, (_, i) => `f${i}`) }))).toHaveLength(8);
    expect(parseReflectionFacts('{"notes":["x"]}')).toBeNull();
    expect(parseReflectionFacts('- a bullet list, not JSON')).toBeNull();
    expect(parseReflectionFacts('{"facts":[]}')).toEqual([]);
  });

  it("the prompt doesn't address the model as a participant or ask it to 'extract'", () => {
    for (const type of ['general', 'capability'] as const) {
      const [system, user] = buildReflectionMessages(type, 'User: hi\nAssistant: hey');
      expect(system.content).toContain('{"facts": []}');
      expect(system.content).not.toMatch(/dialogue I just sent|extract/i);
      expect(user.content).toBe('<turn>\nUser: hi\nAssistant: hey\n</turn>');
    }
  });
});

describe('legacy reflections at recall', () => {
  const inCharacter = 'Lap eighteen, comrade. Still counting.';

  it('an old in-character reflection row is still hidden', () => {
    expect(isStaleNoise({ user_id: 'u', tags: '["reflection"]', importance: 3, context: 'reflection', content: inCharacter })).toBe(true);
  });

  it('a reflection_v3 row is not run through the in-character heuristics', () => {
    expect(
      isStaleNoise({ user_id: 'u', tags: '["reflection_v3"]', importance: 3, context: 'reflection', content: inCharacter })
    ).toBe(false);
  });

  it('non-reflection rows are untouched by it', () => {
    expect(isStaleNoise({ user_id: 'u', tags: '[]', importance: 5, context: 'conversation', content: inCharacter })).toBe(false);
  });
});
