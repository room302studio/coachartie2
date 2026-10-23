import { ToolDefinition, toolCallToInvocation } from '../capability/capability-to-tool.js';

/**
 * The new agentic loop (Phase A core, see TOOL-USE-MIGRATION.md).
 *
 * Replaces `llm-loop-service`'s XML-tag + forced-depth design. The model is given native tools;
 * if it returns tool calls we run them (in PARALLEL), feed the results back, and repeat. It stops
 * NATURALLY when the model returns text with no tool calls — no `minDepth`/`canStop` machinery,
 * which is what cures the barging-in + token-burn.
 *
 * Pure + dependency-injected: it takes `generate` (one LLM turn) and `executeTool` (run one tool)
 * as inputs, so it's fully unit-testable with mocks and decoupled from OpenRouter. `openrouter`
 * will supply a thin `generateWithTools` adapter; the registry supplies `executeTool`.
 */

/** Normalized tool call from the model (provider-agnostic). `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A message in the running conversation (superset of chat roles incl. tool results). */
export interface ToolLoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ToolLoopDeps {
  /** Run one LLM turn with tools available. Returns text and/or tool calls. */
  generate: (
    messages: ToolLoopMessage[],
    tools: ToolDefinition[]
  ) => Promise<{ content: string | null; toolCalls: ToolCall[] }>;
  /** Execute one tool call against the capability registry; returns the tool result string. */
  executeTool: (invocation: {
    name: string;
    action?: string;
    content?: string;
    params: Record<string, unknown>;
  }) => Promise<string>;
  /** Safety cap on round-trips (default 8). Natural stop usually happens well before this. */
  maxIterations?: number;
  /** Optional progress hook (logging/telemetry). */
  onStep?: (info: { iteration: number; toolCalls: number }) => void;
}

export interface ToolLoopResult {
  finalText: string;
  iterations: number;
  toolCallsMade: number;
  stoppedReason: 'natural' | 'max_iterations';
}

export async function runToolLoop(
  messages: ToolLoopMessage[],
  tools: ToolDefinition[],
  deps: ToolLoopDeps
): Promise<ToolLoopResult> {
  const maxIterations = deps.maxIterations ?? 8;
  let toolCallsMade = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const { content, toolCalls } = await deps.generate(messages, tools);
    deps.onStep?.({ iteration, toolCalls: toolCalls.length });

    // Natural stop: the model answered with no tool calls.
    if (toolCalls.length === 0) {
      return { finalText: content ?? '', iterations: iteration, toolCallsMade, stoppedReason: 'natural' };
    }

    // Record the assistant turn that requested the tools.
    messages.push({
      role: 'assistant',
      content: content ?? '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Run every requested tool concurrently; each failure becomes a tool-result error
    // (so the model can recover) rather than aborting the whole turn.
    const toolMessages = await Promise.all(
      toolCalls.map(async (tc): Promise<ToolLoopMessage> => {
        toolCallsMade++;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch {
          args = {}; // malformed args — let the handler report what's missing
        }
        let result: string;
        try {
          result = await deps.executeTool(toolCallToInvocation(tc.name, args));
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        return { role: 'tool', tool_call_id: tc.id, content: result };
      })
    );
    messages.push(...toolMessages);
  }

  // Hit the safety cap: force a final answer with tools disabled so the model wraps up.
  const { content } = await deps.generate(messages, []);
  return {
    finalText: content ?? '',
    iterations: maxIterations,
    toolCallsMade,
    stoppedReason: 'max_iterations',
  };
}
