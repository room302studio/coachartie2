import { ToolDefinition, toolCallToInvocation } from './tool-schema.js';
import { NATIVE_TOOL_MAX_ITERATIONS } from './timeouts.js';
import { getErrorMessage } from '../../shared/errors.js';

/**
 * The native agentic loop (TOOL-USE-MIGRATION.md Phase A; wired in wave 8, the default loop).
 *
 * Replaces `llm-loop`'s XML-tag + forced-loop design. The model is given native tools; if it
 * returns tool calls we run them (in PARALLEL), feed the results back, and repeat. It stops
 * NATURALLY when the model returns text with no tool calls — no `minDepth`/`canStop` machinery,
 * which is what cures the barging-in + token-burn.
 *
 * Pure + dependency-injected: it takes `generate` (one LLM turn) and `executeTool` (run one tool)
 * as inputs, so it's fully unit-testable with mocks and decoupled from OpenRouter. run-turn.ts
 * supplies openrouter's generateWithTools and the registry's execute path.
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
  /**
   * Run one LLM turn with tools available. Returns text and/or tool calls. An EMPTY `tools`
   * array means "answer now, no more tool calls" (the forced final answer); the adapter decides
   * how to say that on the wire (openrouter sends the list with tool_choice 'none').
   */
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
  /** Safety cap on round-trips (default NATIVE_TOOL_MAX_ITERATIONS, 8). */
  maxIterations?: number;
  /**
   * Absolute soft deadline (Date.now() ms; context.deadlineAt). Past it the loop starts no new
   * LLM call or tool round and returns the best text it already has.
   */
  deadlineAt?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Progress hook: called after every LLM turn with the text that came with it. */
  onStep?: (info: { iteration: number; toolCalls: number; content: string }) => void;
}

export interface ToolLoopResult {
  finalText: string;
  iterations: number;
  toolCallsMade: number;
  stoppedReason: 'natural' | 'max_iterations' | 'deadline';
}

export async function runToolLoop(
  messages: ToolLoopMessage[],
  tools: ToolDefinition[],
  deps: ToolLoopDeps
): Promise<ToolLoopResult> {
  const maxIterations = deps.maxIterations ?? NATIVE_TOOL_MAX_ITERATIONS;
  const now = deps.now ?? Date.now;
  const outOfTime = () => deps.deadlineAt !== undefined && now() >= deps.deadlineAt;
  let toolCallsMade = 0;
  // Text the model wrote alongside its tool calls ("let me check..."): the best answer we have
  // if the deadline hits before a final turn.
  let bestText = '';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (iteration > 1 && outOfTime()) {
      return { finalText: bestText, iterations: iteration - 1, toolCallsMade, stoppedReason: 'deadline' };
    }

    const { content, toolCalls } = await deps.generate(messages, tools);
    deps.onStep?.({ iteration, toolCalls: toolCalls.length, content: content ?? '' });

    // Natural stop: the model answered with no tool calls.
    if (toolCalls.length === 0) {
      return { finalText: content ?? '', iterations: iteration, toolCallsMade, stoppedReason: 'natural' };
    }
    if (content && content.trim()) bestText = content;

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
          const parsed = JSON.parse(tc.arguments || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed;
          } else {
            args = {};
          }
        } catch {
          args = {}; // malformed args — let the handler report what's missing
        }
        let result: string;
        try {
          result = await deps.executeTool(toolCallToInvocation(tc.name, args));
        } catch (error) {
          result = `Error: ${getErrorMessage(error)}`;
        }
        return { role: 'tool', tool_call_id: tc.id, content: result };
      })
    );
    messages.push(...toolMessages);
  }

  if (outOfTime()) {
    return { finalText: bestText, iterations: maxIterations, toolCallsMade, stoppedReason: 'deadline' };
  }

  // Hit the safety cap: force a final answer with tools disabled so the model wraps up.
  const { content } = await deps.generate(messages, []);
  let finalTextValue: string;
  if (content && content.trim()) {
    finalTextValue = content;
  } else {
    finalTextValue = bestText;
  }
  return {
    finalText: finalTextValue,
    iterations: maxIterations,
    toolCallsMade,
    stoppedReason: 'max_iterations',
  };
}
