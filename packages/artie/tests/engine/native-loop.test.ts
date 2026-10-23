/**
 * Wave 8: runToolLoop (native-loop.ts), the default tool loop.
 *
 * The original tool-loop.ts (1461974) shipped without a test file — its "9/9 with mocks"
 * validation in TOOL-USE-MIGRATION.md was never committed — so these are written fresh,
 * covering the same cases plus the wave-8 deadline.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runToolLoop,
  type ToolCall,
  type ToolLoopMessage,
} from '../../src/engine/5-tool-loop/native-loop.js';
import type { ToolDefinition } from '../../src/engine/5-tool-loop/tool-schema.js';
import { NATIVE_TOOL_MAX_ITERATIONS } from '../../src/engine/5-tool-loop/timeouts.js';

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'math',
      parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    },
  },
];

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

function base(): ToolLoopMessage[] {
  return [
    { role: 'system', content: 'you are artie' },
    { role: 'user', content: 'what is 2+2?' },
  ];
}

describe('runToolLoop', () => {
  it('stops naturally when the model answers without tool calls', async () => {
    const generate = vi.fn().mockResolvedValue({ content: 'four', toolCalls: [] });
    const executeTool = vi.fn();
    const result = await runToolLoop(base(), TOOLS, { generate, executeTool });
    expect(result).toEqual({ finalText: 'four', iterations: 1, toolCallsMade: 0, stoppedReason: 'natural' });
    expect(executeTool).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][1]).toBe(TOOLS);
  });

  it('runs a single tool, feeds the result back, then stops', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'let me check',
        toolCalls: [call('c1', 'calculator', { action: 'calculate', expression: '2+2' })],
      })
      .mockResolvedValueOnce({ content: 'it is 4', toolCalls: [] });
    const executeTool = vi.fn().mockResolvedValue('4');
    const messages = base();

    const result = await runToolLoop(messages, TOOLS, { generate, executeTool });

    expect(result.finalText).toBe('it is 4');
    expect(result.toolCallsMade).toBe(1);
    expect(result.iterations).toBe(2);
    expect(executeTool).toHaveBeenCalledWith({
      name: 'calculator',
      action: 'calculate',
      content: undefined,
      params: { expression: '2+2' },
    });
    // assistant turn with tool_calls, then the tool result keyed by the call id
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'let me check',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator' } }],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '4' });
  });

  it('runs parallel tool calls concurrently, one result per call id', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const executeTool = vi.fn(async (inv: { params: Record<string, unknown> }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return `result ${inv.params.n}`;
    });
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [
          call('a', 'calculator', { action: 'calculate', n: '1' }),
          call('b', 'calculator', { action: 'calculate', n: '2' }),
          call('c', 'calculator', { action: 'calculate', n: '3' }),
        ],
      })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] });
    const messages = base();

    const result = await runToolLoop(messages, TOOLS, { generate, executeTool });

    expect(result.toolCallsMade).toBe(3);
    expect(maxInFlight).toBe(3);
    const toolResults = messages.filter((m) => m.role === 'tool');
    expect(toolResults.map((m) => [m.tool_call_id, m.content])).toEqual([
      ['a', 'result 1'],
      ['b', 'result 2'],
      ['c', 'result 3'],
    ]);
  });

  it('turns a thrown tool error into an error tool result, not a crash', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call('x', 'calculator', { action: 'calculate' })] })
      .mockResolvedValueOnce({ content: 'sorry, that broke', toolCalls: [] });
    const executeTool = vi.fn().mockRejectedValue(new Error('boom'));
    const messages = base();

    const result = await runToolLoop(messages, TOOLS, { generate, executeTool });

    expect(result.finalText).toBe('sorry, that broke');
    expect(messages.find((m) => m.role === 'tool')).toEqual({
      role: 'tool',
      tool_call_id: 'x',
      content: 'Error: boom',
    });
  });

  it('tolerates malformed JSON arguments (the handler sees empty params)', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call('m', 'calculator', '{"action": "calc')] })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    const executeTool = vi.fn().mockResolvedValue('Error: missing action');

    const result = await runToolLoop(base(), TOOLS, { generate, executeTool });

    expect(result.stoppedReason).toBe('natural');
    expect(executeTool).toHaveBeenCalledWith({
      name: 'calculator',
      action: undefined,
      content: undefined,
      params: {},
    });
  });

  it('maxIterations forces one final call with NO tools', async () => {
    const generate = vi.fn(async (_m: ToolLoopMessage[], tools: ToolDefinition[]) =>
      tools.length === 0
        ? { content: 'wrapping up', toolCalls: [] }
        : { content: '', toolCalls: [call(`c${Math.random()}`, 'calculator', { action: 'calculate' })] }
    );
    const executeTool = vi.fn().mockResolvedValue('again');

    const result = await runToolLoop(base(), TOOLS, { generate, executeTool, maxIterations: 3 });

    expect(result).toMatchObject({ finalText: 'wrapping up', iterations: 3, stoppedReason: 'max_iterations' });
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls[3][1]).toEqual([]);
    expect(executeTool).toHaveBeenCalledTimes(3);
  });

  it('defaults maxIterations to the timeouts.ts constant (8)', async () => {
    expect(NATIVE_TOOL_MAX_ITERATIONS).toBe(8);
    const generate = vi.fn(async (_m: ToolLoopMessage[], tools: ToolDefinition[]) =>
      tools.length === 0
        ? { content: 'final', toolCalls: [] }
        : { content: '', toolCalls: [call('id', 'calculator', { action: 'calculate' })] }
    );
    const result = await runToolLoop(base(), TOOLS, { generate, executeTool: async () => 'r' });
    expect(result.iterations).toBe(8);
    expect(generate).toHaveBeenCalledTimes(9);
  });

  it('past the deadline it starts no new round and returns the best text it has', async () => {
    let clock = 1_000;
    const generate = vi.fn(async () => {
      clock += 100; // each LLM turn takes "100ms"
      return { content: 'checking the scoreboard', toolCalls: [call('d', 'calculator', { action: 'calculate' })] };
    });
    const executeTool = vi.fn(async () => {
      clock += 100;
      return 'r';
    });

    const result = await runToolLoop(base(), TOOLS, {
      generate,
      executeTool,
      deadlineAt: 1_150,
      now: () => clock,
    });

    expect(result).toMatchObject({ stoppedReason: 'deadline', finalText: 'checking the scoreboard' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('reports each turn through onStep with its text', async () => {
    const onStep = vi.fn();
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: 'one sec', toolCalls: [call('s', 'calculator', {})] })
      .mockResolvedValueOnce({ content: 'answer', toolCalls: [] });
    await runToolLoop(base(), TOOLS, { generate, executeTool: async () => 'r', onStep });
    expect(onStep.mock.calls.map((c) => c[0])).toEqual([
      { iteration: 1, toolCalls: 1, content: 'one sec' },
      { iteration: 2, toolCalls: 0, content: 'answer' },
    ]);
  });
});
