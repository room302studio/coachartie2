/**
 * Wave 8: openrouter's tool turns (generateWithTools), with the OpenAI client mocked at the
 * HTTP boundary: what goes on the wire, and which model a tool turn is pinned to.
 *
 * OPENROUTER_MODELS is set to today's production value (anthropic/claude-haiku-4.5,
 * anthropic/claude-sonnet-5, per the prod boot log 2026-10-23) before the service is built.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock, supportsToolsMock } = vi.hoisted(() => {
  process.env.OPENROUTER_MODELS = 'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5';
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'dummy';
  return { createMock: vi.fn(), supportsToolsMock: vi.fn() };
});

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('../../src/engine/4-generate/model-catalog.js', () => ({
  openRouterModelsService: {
    supportsTools: supportsToolsMock,
    fetchLiveModelInfo: vi.fn(async () => new Map()),
  },
}));

import { openRouterService, normalizeToolCalls, wireMaxTokens } from '../../src/engine/4-generate/openrouter.js';
import { brownoutRoute } from '../../src/engine/budget/brownout.js';
import { applyCacheControl } from '../../src/engine/3-context/prompt-cache.js';
import type { ToolDefinition } from '../../src/engine/5-tool-loop/tool-schema.js';

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web',
      description: 'search the web',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search'] } }, required: ['action'] },
    },
  },
];

const MESSAGES = [
  { role: 'system' as const, content: 'you are artie' },
  { role: 'user' as const, content: 'whats the weather' },
];

function completion(message: Record<string, unknown>, model = 'anthropic/claude-haiku-4.5') {
  return {
    id: 'gen-1',
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

/** The catalog: both configured Anthropic models take tools; "meta/no-tools" does not. */
function catalog(overrides: Record<string, boolean | undefined> = {}) {
  const table: Record<string, boolean | undefined> = {
    'anthropic/claude-haiku-4.5': true,
    'anthropic/claude-sonnet-5': true,
    'anthropic/claude-opus-5.5': true,
    'meta/no-tools': false,
    ...overrides,
  };
  supportsToolsMock.mockImplementation(async (id: string) => table[id]);
}

beforeEach(() => {
  createMock.mockReset();
  supportsToolsMock.mockReset();
  catalog();
});

describe('generateWithTools: the request', () => {
  it('carries tools + tool_choice auto, and normalizes tool_calls', async () => {
    createMock.mockResolvedValueOnce(
      completion({
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'web', arguments: '{"action":"search","query":"nyc"}' } },
        ],
      })
    );

    const out = await openRouterService.generateWithTools(
      MESSAGES,
      TOOLS,
      'user-1',
      'msg-1',
      'anthropic/claude-sonnet-5'
    );

    const params = createMock.mock.calls[0][0];
    expect(params.model).toBe('anthropic/claude-sonnet-5');
    expect(params.tools).toEqual(TOOLS);
    expect(params.tool_choice).toBe('auto');
    expect(params.stream).toBeUndefined();
    expect(out).toEqual({
      content: '',
      toolCalls: [{ id: 'call_1', name: 'web', arguments: '{"action":"search","query":"nyc"}' }],
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it("tool_choice 'none' (the forced final answer) keeps the same tool list on the wire", async () => {
    createMock.mockResolvedValueOnce(completion({ content: 'final words' }));
    const out = await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5', {
      toolChoice: 'none',
    });
    const params = createMock.mock.calls[0][0];
    expect(params.tools).toEqual(TOOLS);
    expect(params.tool_choice).toBe('none');
    expect(out.content).toBe('final words');
  });

  function truncatedCompletion(content: string | null, toolCalls?: unknown[]) {
    return {
      ...completion({ content }),
      choices: [
        { index: 0, finish_reason: 'length', message: { role: 'assistant', content, tool_calls: toolCalls } },
      ],
    };
  }

  it('a cut-off reply is never delivered: same model retries once with double room, reasoning off', async () => {
    createMock
      .mockResolvedValueOnce(truncatedCompletion('Honest caveat first.\n- **'))
      .mockResolvedValueOnce(completion({ content: 'the whole answer' }));
    const out = await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5', {
      toolChoice: 'none',
    });
    const [first, second] = createMock.mock.calls.map((c) => c[0]);
    expect(second.model).toBe(first.model);
    expect(second.max_tokens).toBe(first.max_tokens * 2);
    expect(second.reasoning).toEqual({ effort: 'none', exclude: true });
    expect(out.content).toBe('the whole answer');
  });

  it('reasoning-only (no answer) is the same failure, and two truncations fall down the ladder', async () => {
    createMock
      .mockResolvedValueOnce(truncatedCompletion(null))
      .mockResolvedValueOnce(truncatedCompletion('still cut'))
      .mockResolvedValueOnce(completion({ content: 'from the next model' }));
    const out = await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5');
    const models = createMock.mock.calls.map((c) => c[0].model);
    expect(models[0]).toBe(models[1]);
    expect(models[2]).not.toBe(models[0]);
    expect(out.content).toBe('from the next model');
  });

  it('a truncated tool call (half-written JSON) is retried, not run', async () => {
    createMock
      .mockResolvedValueOnce(
        truncatedCompletion(null, [{ id: 'c1', type: 'function', function: { name: 'web', arguments: '{"act' } }])
      )
      .mockResolvedValueOnce(completion({ content: 'done' }));
    const out = await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(out.toolCalls).toEqual([]);
  });

  it('under an affordability clamp the reasoning budget is dropped and truncation skips the same-model retry', async () => {
    createMock
      .mockRejectedValueOnce(Object.assign(new Error('requested up to 6144 tokens, but can only afford 1000'), { status: 402 }))
      .mockResolvedValueOnce(truncatedCompletion('cut'))
      .mockResolvedValueOnce(completion({ content: 'next model answered' }));
    const out = await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5', {
      reasoning: { max_tokens: 2048 },
    });
    const calls = createMock.mock.calls.map((c) => c[0]);
    expect(calls[1].max_tokens).toBe(900);
    expect(calls[1].reasoning).toEqual({ effort: 'none', exclude: true });
    expect(calls[2].model).not.toBe(calls[1].model);
    expect(out.content).toBe('next model answered');
  });

  it('wireMaxTokens: a ceiling that never binds, plus any explicit reasoning budget on top', () => {
    expect(wireMaxTokens(undefined, undefined)).toBe(4096);
    expect(wireMaxTokens(undefined, { max_tokens: 2048 })).toBe(6144);
    expect(wireMaxTokens(120, { enabled: false })).toBe(120);
  });

  it('per-call reasoning is sent as given (brownout turns it off)', async () => {
    createMock.mockResolvedValueOnce(completion({ content: 'ok' }));
    await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5', {
      reasoning: { effort: 'none' },
    });
    expect(createMock.mock.calls[0][0].reasoning).toEqual({ effort: 'none' });
  });

  it('a plain generate sends no tools (the XML path is unchanged)', async () => {
    createMock.mockResolvedValueOnce(completion({ content: '  hello  ' }));
    const text = await openRouterService.generateFromMessageChain(MESSAGES, 'u', 'm', 'anthropic/claude-sonnet-5');
    const params = createMock.mock.calls[0][0];
    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
    expect(text).toBe('hello');
  });

  it('an empty completion with no tool calls is still an error (falls through the ladder)', async () => {
    createMock.mockResolvedValue(completion({ content: null }));
    await expect(
      openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-sonnet-5')
    ).rejects.toThrow(/Empty completion/);
    // tried the requested model, then the other tool-capable one
    expect(createMock.mock.calls.map((c) => c[0].model)).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
    ]);
  });
});

describe('generateWithTools: the tool-capable pin', () => {
  it('openrouter/auto is replaced by the first tool-capable OPENROUTER_MODELS entry, plugin dropped', async () => {
    createMock.mockResolvedValueOnce(completion({ content: 'hi' }));
    const out = await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'openrouter/auto', {
      plugins: [{ id: 'auto-router', cost_tier: 'low' }],
    });
    const params = createMock.mock.calls[0][0];
    expect(params.model).toBe('anthropic/claude-haiku-4.5');
    expect(params.plugins).toBeUndefined();
    expect(params.reasoning).toBeUndefined();
    expect(out.model).toBe('anthropic/claude-haiku-4.5');
  });

  it('an auto:<tier> spec is pinned the same way', async () => {
    createMock.mockResolvedValueOnce(completion({ content: 'hi' }));
    await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'auto:medium');
    expect(createMock.mock.calls[0][0].model).toBe('anthropic/claude-haiku-4.5');
  });

  it('a model the catalog says lacks tools is replaced', async () => {
    createMock.mockResolvedValueOnce(completion({ content: 'hi' }));
    await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'meta/no-tools');
    expect(createMock.mock.calls[0][0].model).toBe('anthropic/claude-haiku-4.5');
  });

  it('a model missing from the catalog (fetch failed) is trusted, not blocked', async () => {
    catalog({ 'anthropic/claude-opus-5.5': undefined });
    createMock.mockResolvedValueOnce(completion({ content: 'hi' }));
    await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'anthropic/claude-opus-5.5');
    expect(createMock.mock.calls[0][0].model).toBe('anthropic/claude-opus-5.5');
  });

  it("brownout's final-third route (openrouter/auto) stays inside the tool-capable set", async () => {
    const route = brownoutRoute(
      { mode: 'lean', runwayHours: 10, runwayMode: 'lean', dailyMode: 'normal', dailySpendFraction: 0.5 },
      'anthropic/claude-opus-5.5'
    );
    expect(route.model).toBe('openrouter/auto'); // the downgrade itself is unchanged

    createMock.mockResolvedValueOnce(completion({ content: 'short reply' }));
    await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', route.model, {
      plugins: route.plugins,
      maxTokens: 500,
    });
    const params = createMock.mock.calls[0][0];
    expect(params.model).toBe('anthropic/claude-haiku-4.5');
    expect(params.plugins).toBeUndefined();
    expect(params.max_tokens).toBe(500); // brownout's length cap still applies
  });

  it('skips a configured model that lacks tools when pinning', async () => {
    catalog({ 'anthropic/claude-haiku-4.5': false });
    createMock.mockResolvedValueOnce(completion({ content: 'hi' }, 'anthropic/claude-sonnet-5'));
    await openRouterService.generateWithTools(MESSAGES, TOOLS, 'u', 'm', 'openrouter/auto');
    expect(createMock.mock.calls[0][0].model).toBe('anthropic/claude-sonnet-5');
  });
});

describe('wire shape helpers', () => {
  it('normalizeToolCalls stringifies object arguments and fills a missing id', () => {
    expect(
      normalizeToolCalls([
        { function: { name: 'web', arguments: { action: 'search' } } },
        { id: 'x', function: { name: 'calculator' } },
        { id: 'bad', function: {} },
      ])
    ).toEqual([
      { id: 'call_0', name: 'web', arguments: '{"action":"search"}' },
      { id: 'x', name: 'calculator', arguments: '{}' },
    ]);
  });

  it('cache marking keeps tool_calls and tool_call_id, and the breakpoint stays on the system prefix', () => {
    const big = 'persona rules. '.repeat(400);
    const chain = [
      { role: 'system' as const, content: big },
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'web', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'sunny' },
    ];
    const out = applyCacheControl(chain, 'anthropic/claude-opus-4.8');
    expect(out.applied).toBe(true);
    expect(Array.isArray(out.messages[0].content)).toBe(true);
    expect(out.messages.slice(1)).toEqual(chain.slice(1));
  });

  it("tool definitions count toward the cache minimum (Haiku's 4096) on a tool turn", () => {
    const system = [{ role: 'system' as const, content: 'x'.repeat(4 * 3000) }]; // ~3000 tok
    expect(applyCacheControl(system, 'anthropic/claude-haiku-4.5').applied).toBe(false);
    const withTools = applyCacheControl(system, 'anthropic/claude-haiku-4.5', 9000);
    expect(withTools.applied).toBe(true);
    expect(withTools.prefixTokens).toBe(12000);
  });

  it('a haiku tool turn sends the breakpoint when tools + system clear the minimum', async () => {
    createMock.mockResolvedValueOnce(completion({ content: 'hi' }));
    const bigTools: ToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({
      type: 'function' as const,
      function: {
        name: `tool_${i}`,
        description: 'd'.repeat(400),
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    }));
    await openRouterService.generateWithTools(
      [{ role: 'system', content: 's'.repeat(4 * 3000) }, { role: 'user', content: 'hi' }],
      bigTools,
      'u',
      'm',
      'anthropic/claude-haiku-4.5'
    );
    const params = createMock.mock.calls[0][0];
    expect(Array.isArray(params.messages[0].content)).toBe(true);
    expect(params.messages[0].content[0].cache_control).toBeDefined();
  });
});
