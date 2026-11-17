/**
 * Deep Research Capability
 *
 * Allows Artie to submit complex research tasks that run in the background
 * using specialized models like o4-mini-deep-research.
 *
 * Usage:
 * - "research X deeply" → submits background task
 * - "check research status" → polls active tasks
 * - "get research results" → retrieves completed research
 */

import { logger } from '../../../shared/logger.js';
import { getErrorMessage } from '../../../shared/errors.js';
import type {
  RegisteredCapability,
  CapabilityContext,
} from '../../5-tool-loop/registry.js';
import { researchQueueService } from './harness/research-queue.js';
import { openaiResearchHarness } from './harness/openai-research.js';

interface DeepResearchParams {
  action: string;
  topic?: string;
  context?: string;
  tools?: string[];
  taskId?: string;
  [key: string]: unknown;
}

/**
 * Deep research capability handler
 */
async function handleDeepResearch(
  params: DeepResearchParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`🔬 Deep research handler - Action: ${action}, UserId: ${userId}`);

  try {
    switch (action) {
      case 'submit': {
        const topic = params.topic || content;
        if (!topic) {
          return JSON.stringify({
            success: false,
            error: 'No research topic provided. Use topic parameter or content.',
          });
        }

        // Check if harness is available
        if (!openaiResearchHarness.isAvailable()) {
          return JSON.stringify({
            success: false,
            error: 'Deep research is not configured. Missing OPENAI_API_KEY.',
            hint: 'Ask EJ to add the OpenAI API key to enable deep research.',
          });
        }

        // Estimate cost
        const estimate = openaiResearchHarness.estimateCost({
          id: 'estimate',
          prompt: topic,
          context: params.context,
          tools: params.tools as ('web_search' | 'code_interpreter')[],
          userId,
          createdAt: new Date(),
        });

        // Queue the task
        const taskId = await researchQueueService.queueTask({
          prompt: topic,
          context: params.context,
          tools: params.tools as ('web_search' | 'code_interpreter')[],
          userId,
        });

        logger.info(`🔬 Deep research queued: ${taskId} for user ${userId}`);

        return JSON.stringify({
          success: true,
          taskId,
          message: `Research task queued! I'll work on "${topic}" in the background.`,
          estimatedCost: `$${estimate.typical.toFixed(2)} (typical)`,
          checkStatus: `Use deep_research status action with taskId "${taskId}" to check progress.`,
        });
      }

      case 'status': {
        const taskId = params.taskId || content;

        if (taskId) {
          const task = researchQueueService.getTask(taskId);
          if (!task) {
            return JSON.stringify({ success: false, error: 'Task not found' });
          }

          const promptPreview = task.prompt.slice(0, 100);
          let ellipsis: string;
          if (task.prompt.length > 100) {
            ellipsis = '...';
          } else {
            ellipsis = '';
          }

          return JSON.stringify({
            success: true,
            task: {
              id: task.id,
              prompt: promptPreview + ellipsis,
              status: task.status,
              cost: task.result?.cost?.total,
              createdAt: task.createdAt,
              completedAt: task.completedAt,
            },
          });
        }

        // List recent tasks for this user
        const tasks = researchQueueService
          .listTasks(undefined, 10)
          .filter((t) => t.userId === userId);

        return JSON.stringify({
          success: true,
          tasks: tasks.map((t) => ({
            id: t.id,
            prompt: t.prompt.slice(0, 50) + '...',
            status: t.status,
            cost: t.result?.cost?.total,
          })),
        });
      }

      case 'results': {
        const taskId = params.taskId || content;
        if (!taskId) {
          return JSON.stringify({ success: false, error: 'No taskId provided' });
        }

        const task = researchQueueService.getTask(taskId);

        if (!task) {
          return JSON.stringify({ success: false, error: 'Task not found' });
        }

        if (task.status !== 'completed') {
          let hint: string | undefined;
          if (task.status === 'running') {
            hint = 'Check back in a few minutes.';
          } else {
            hint = undefined;
          }

          return JSON.stringify({
            success: false,
            error: `Task is not completed yet. Status: ${task.status}`,
            hint: hint,
          });
        }

        if (!task.result) {
          return JSON.stringify({ success: false, error: 'No results available' });
        }

        return JSON.stringify({
          success: true,
          taskId: task.id,
          prompt: task.prompt,
          content: task.result.content,
          reasoning: task.result.reasoning,
          toolCalls: task.result.toolCalls?.length || 0,
          cost: task.result.cost,
          completedAt: task.completedAt,
        });
      }

      case 'harness_status': {
        const available = openaiResearchHarness.isAvailable();
        const usage = openaiResearchHarness.getUsage();

        let message: string;
        if (available) {
          message = 'Deep research is ready. Use submit to queue a research task.';
        } else {
          message = 'Deep research is not configured. Missing OPENAI_API_KEY.';
        }

        let reportedUsage: unknown;
        if (available) {
          reportedUsage = usage;
        } else {
          reportedUsage = undefined;
        }

        return JSON.stringify({
          success: true,
          available,
          harness: 'openai-deep-research',
          model: 'o4-mini-deep-research',
          usage: reportedUsage,
          message: message,
        });
      }

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown action: ${action}. Supported: submit, status, results, harness_status`,
        });
    }
  } catch (error) {
    logger.error(`❌ Deep research error for action '${action}':`, error);
    return JSON.stringify({
      success: false,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Deep research capability definition
 */
export const deepResearchCapability: RegisteredCapability = {
  name: 'deep_research',
  emoji: '🔬',
  actions: {
    // Spends real OpenAI money outside the daily budget ledger. Owner only; no approval step,
    // since only EJ can run it and he is the approver.
    submit: { effect: 'money', who: 'owner', approval: false },
    status: { effect: 'read' },
    results: { effect: 'read' },
    harness_status: { effect: 'read' },
  },
  supportedActions: ['submit', 'status', 'results', 'harness_status'],
  description:
    'Submit complex research tasks to run in the background using specialized AI models (o4-mini-deep-research) with web search and code execution.',
  handler: handleDeepResearch,
  examples: [
    '<capability name="deep_research" action="submit" topic="What are the latest developments in quantum computing?" />',
    '<capability name="deep_research" action="status" taskId="research-123456" />',
    '<capability name="deep_research" action="results" taskId="research-123456" />',
    '<capability name="deep_research" action="harness_status" />',
  ],
};
