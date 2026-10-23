/**
 * Wave 8: run-turn takes the native tool loop by default and the XML path under TOOL_LOOP=xml.
 *
 * The real pipeline runs (context assembly against the in-memory DB, the real registry, the
 * real openrouter request path); only the OpenAI client (the HTTP boundary) and the model
 * catalog are mocked. Messages are under 20 chars, so preflight skips its micro-LLM.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { createMock } = vi.hoisted(() => {
  process.env.OPENROUTER_MODELS = 'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5';
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'dummy';
  return { createMock: vi.fn() };
});

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('../../src/engine/4-generate/model-catalog.js', () => ({
  openRouterModelsService: {
    supportsTools: vi.fn(async () => true),
    fetchLiveModelInfo: vi.fn(async () => new Map()),
  },
}));

import { capabilityOrchestrator } from '../../src/engine/2-turn/run-turn.js';
import { capabilityRegistry } from '../../src/engine/5-tool-loop/registry.js';
import { getSyncDb } from '../../src/shared/db/client.js';

type WireMsg = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };

function reply(message: Record<string, unknown>) {
  return {
    id: 'gen',
    model: 'anthropic/claude-sonnet-5',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
  };
}

let seq = 0;
function incoming(text: string) {
  seq++;
  return {
    id: `msg-tool-loop-${seq}`,
    timestamp: new Date(),
    retryCount: 0,
    source: 'api',
    userId: 'user-tool-loop',
    message: text,
    respondTo: { type: 'api' as const },
  };
}

const savedToolLoop = process.env.TOOL_LOOP;

beforeAll(async () => {
  // Skills register in a setImmediate after bootstrap (see roster.test.ts).
  const deadline = Date.now() + 5000;
  while (!capabilityRegistry.has('skills') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  // A PROMPT_SYSTEM row keeps the XML path off its LLM-backed capability selector.
  getSyncDb().run(
    `INSERT OR REPLACE INTO prompts (name, content, category, is_active) VALUES (?, ?, ?, 1)`,
    ['PROMPT_SYSTEM', '<role>\nyou are coach artie (test).\n</role>', 'system']
  );
}, 20000);

afterAll(() => {
  getSyncDb().run(`DELETE FROM prompts WHERE name = ?`, ['PROMPT_SYSTEM']);
  if (savedToolLoop === undefined) delete process.env.TOOL_LOOP;
  else process.env.TOOL_LOOP = savedToolLoop;
});

beforeEach(() => {
  createMock.mockReset();
});

describe('TOOL_LOOP unset: the native tool loop', () => {
  beforeEach(() => {
    delete process.env.TOOL_LOOP;
  });

  it('offers native tools, and an ALIAS name in a tool_call runs the canonical tool', async () => {
    const tasks = capabilityRegistry.get('tasks', 'list');
    const handler = vi.spyOn(tasks, 'handler').mockResolvedValue('3 open todos');

    createMock.mockImplementation(async (params: { messages: WireMsg[] }) =>
      params.messages.some((m) => m.role === 'tool')
        ? reply({ content: 'you have 3 todos' })
        : reply({
            content: null,
            tool_calls: [
              { id: 'call_t', type: 'function', function: { name: 'todo', arguments: '{"action":"list"}' } },
            ],
          })
    );

    const result = await capabilityOrchestrator.orchestrateMessage(incoming('my todos?') as never);

    expect(result).toBe('you have 3 todos');
    const first = createMock.mock.calls[0][0];
    const names = (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toContain('tasks');
    expect(names).not.toContain('todo');
    expect(names).not.toContain('variable');
    expect(first.tool_choice).toBe('auto');
    // The system prompt has no XML roster, and the one native line.
    const system = JSON.stringify(first.messages[0].content);
    expect(system).not.toContain('## Your capability roster');
    expect(system).toContain('Use the provided tools; never write <capability> tags.');

    // todo:list ran as tasks:list with the todo tracker.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ action: 'list', tracker: 'todo' });

    // Round 2 carries the tool result back, keyed by the call id.
    const second = createMock.mock.calls[1][0];
    expect(second.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_t', content: '3 open todos' });
    handler.mockRestore();
  }, 20000);

  it('a failing tool comes back to the model as an error result, not a dead turn', async () => {
    // wolfram has no retry-wrapper fallback (calculator does), so its failure surfaces.
    const wolfram = capabilityRegistry.get('wolfram', 'query');
    const handler = vi.spyOn(wolfram, 'handler').mockRejectedValue(new Error('division by zero'));

    createMock.mockImplementation(async (params: { messages: WireMsg[] }) =>
      params.messages.some((m) => m.role === 'tool')
        ? reply({ content: 'that math broke' })
        : reply({
            content: '',
            tool_calls: [
              {
                id: 'call_c',
                type: 'function',
                function: { name: 'wolfram', arguments: '{"action":"query","input":"1/0"}' },
              },
            ],
          })
    );

    const result = await capabilityOrchestrator.orchestrateMessage(incoming('1/0?') as never);

    expect(result).toBe('that math broke');
    const toolMsg = (createMock.mock.calls.at(-1)![0].messages as WireMsg[]).find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/^Error: /);
    handler.mockRestore();
  }, 30000);
});

describe('TOOL_LOOP=xml: the XML path end to end', () => {
  beforeEach(() => {
    process.env.TOOL_LOOP = 'xml';
  });

  it('parses <capability/> from text, runs it, and loops via llm-loop; no tools on the wire', async () => {
    const calc = capabilityRegistry.get('calculator', 'calculate');
    const handler = vi.spyOn(calc, 'handler').mockResolvedValue('4');

    createMock.mockImplementation(async (params: { messages: WireMsg[] }) =>
      JSON.stringify(params.messages).includes('CONVERSATION SO FAR')
        ? reply({ content: 'the answer is 4' })
        : reply({ content: 'on it <capability name="calculator" action="calculate" expression="2+2" />' })
    );

    const result = await capabilityOrchestrator.orchestrateMessage(incoming('2+2?') as never);

    expect(result).toBe('the answer is 4');
    for (const [params] of createMock.mock.calls) {
      expect(params.tools).toBeUndefined();
    }
    expect(handler).toHaveBeenCalled();
    // The XML roster is back in the system prompt.
    expect(JSON.stringify(createMock.mock.calls[0][0].messages[0].content)).toContain(
      '## Your capability roster'
    );
    handler.mockRestore();
  }, 30000);
});
