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

import { logger } from '@coachartie/shared';
import type { RegisteredCapability, CapabilityContext } from '../../services/capability/capability-registry.js';
import { researchQueueService } from '../../services/harnesses/research-queue.js';
import { openaiResearchHarness } from '../../services/harnesses/openai-research.js';

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
async function handleDeepResearch(params: DeepResearchParams, content?: string, ctx?: CapabilityContext): Promise<string> {
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

          return JSON.stringify({
            success: true,
            task: {
              id: task.id,
              prompt: task.prompt.slice(0, 100) + (task.prompt.length > 100 ? '...' : ''),
              status: task.status,
              cost: task.result?.cost?.total,
              createdAt: task.createdAt,
              completedAt: task.completedAt,
            },
          });
        }

        // List recent tasks for this user
        const tasks = researchQueueService.listTasks(undefined, 10)
          .filter(t => t.userId === userId);

        return JSON.stringify({
          success: true,
          tasks: tasks.map(t => ({
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
          return JSON.stringify({
            success: false,
            error: `Task is not completed yet. Status: ${task.status}`,
            hint: task.status === 'running' ? 'Check back in a few minutes.' : undefined,
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

        return JSON.stringify({
          success: true,
          available,
          harness: 'openai-deep-research',
          model: 'o4-mini-deep-research',
          usage: available ? usage : undefined,
          message: available
            ? 'Deep research is ready. Use submit to queue a research task.'
            : 'Deep research is not configured. Missing OPENAI_API_KEY.',
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deep research capability definition
 */
export const deepResearchCapability: RegisteredCapability = {
  name: 'deep_research',
  emoji: '🔬',
  supportedActions: ['submit', 'status', 'results', 'harness_status'],
  description: 'Submit complex research tasks to run in the background using specialized AI models (o4-mini-deep-research) with web search and code execution.',
  handler: handleDeepResearch,
  examples: [
    '<capability name="deep_research" action="submit" topic="What are the latest developments in quantum computing?" />',
    '<capability name="deep_research" action="status" taskId="research-123456" />',
    '<capability name="deep_research" action="results" taskId="research-123456" />',
    '<capability name="deep_research" action="harness_status" />',
  ],
};

export default deepResearchCapability;
