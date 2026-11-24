/**
 * Wave 10: `jsonOutput` on a plain generate. `response_format` goes on the wire only when the
 * catalog positively lists structured output for the exact model being tried; never to
 * openrouter/auto, never on a catalog miss, never without a jsonOutput. OpenAI client mocked
 * at the HTTP boundary, as in openrouter-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock, modeMock } = vi.hoisted(() => {
  process.env.OPENROUTER_MODELS = 'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5';
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'dummy';
  return { createMock: vi.fn(), modeMock: vi.fn() };
});

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('../../../src/engine/4-generate/model-catalog.js', () => ({
  openRouterModelsService: {
    supportsTools: vi.fn(async () => true),
    structuredOutputMode: modeMock,
    fetchLiveModelInfo: vi.fn(async () => new Map()),
  },
}));

import { openRouterService } from '../../../src/engine/4-generate/openrouter.js';
import { responseFormatFor, type JsonOutputSpec } from '../../../src/shared/structured-output.js';

const SPEC: JsonOutputSpec = {
  name: 'facts',
  schema: {
    type: 'object',
    properties: { facts: { type: 'array', items: { type: 'string' } } },
    required: ['facts'],
    additionalProperties: false,
  },
};

const MESSAGES = [{ role: 'user' as const, content: 'return JSON' }];

function completion(content: string, model = 'anthropic/claude-haiku-4.5') {
  return {
    id: 'gen-1',
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function catalog(table: Record<string, 'json_schema' | 'json_object' | null | undefined>) {
  modeMock.mockImplementation(async (id: string) => table[id]);
}

beforeEach(() => {
  createMock.mockReset();
  modeMock.mockReset();
  catalog({ 'anthropic/claude-sonnet-5': 'json_schema', 'google/flash': 'json_object', 'meta/plain': null });
});

describe('jsonOutput -> response_format', () => {
  it('json_schema (strict) when the catalog lists structured_outputs', async () => {
    createMock.mockResolvedValueOnce(completion('{"facts":[]}'));
    await openRouterService.generateFromMessageChain(MESSAGES, 'u', undefined, 'anthropic/claude-sonnet-5', {
      jsonOutput: SPEC,
    });
    expect(createMock.mock.calls[0][0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'facts', strict: true, schema: SPEC.schema },
    });
  });

  it('json_object when the catalog lists only response_format', async () => {
    createMock.mockResolvedValueOnce(completion('{"facts":[]}'));
    await openRouterService.generateFromMessageChain(MESSAGES, 'u', undefined, 'google/flash', { jsonOutput: SPEC });
    expect(createMock.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
  });

  it('nothing for a model without it, a catalog miss, or openrouter/auto', async () => {
    for (const model of ['meta/plain', 'unknown/model', 'openrouter/auto', 'auto:low']) {
      createMock.mockResolvedValueOnce(completion('{"facts":[]}'));
      await openRouterService.generateFromMessageChain(MESSAGES, 'u', undefined, model, { jsonOutput: SPEC });
    }
    for (const call of createMock.mock.calls) expect(call[0].response_format).toBeUndefined();
  });

  it('nothing without jsonOutput (every existing call is unchanged), and no catalog lookup', async () => {
    createMock.mockResolvedValueOnce(completion('hi'));
    await openRouterService.generateFromMessageChain(MESSAGES, 'u', undefined, 'anthropic/claude-sonnet-5');
    expect(createMock.mock.calls[0][0].response_format).toBeUndefined();
    expect(modeMock).not.toHaveBeenCalled();
  });

  it('is decided per model on the fallback ladder', async () => {
    createMock.mockRejectedValueOnce(Object.assign(new Error('provider down'), { status: 503 }));
    createMock.mockResolvedValueOnce(completion('{"facts":[]}', 'anthropic/claude-haiku-4.5'));
    catalog({ 'anthropic/claude-sonnet-5': 'json_schema', 'anthropic/claude-haiku-4.5': null });
    await openRouterService.generateFromMessageChain(MESSAGES, 'u', undefined, 'anthropic/claude-sonnet-5', {
      jsonOutput: SPEC,
    });
    expect(createMock.mock.calls[0][0].response_format?.type).toBe('json_schema');
    expect(createMock.mock.calls[1][0].model).toBe('anthropic/claude-haiku-4.5');
    expect(createMock.mock.calls[1][0].response_format).toBeUndefined();
  });

  it('responseFormatFor builds both shapes', () => {
    expect(responseFormatFor(SPEC, 'json_object')).toEqual({ type: 'json_object' });
    expect(responseFormatFor(SPEC, 'json_schema')).toMatchObject({ type: 'json_schema' });
  });
});
