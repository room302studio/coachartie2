import { logger } from '../../../shared/logger.js';
import {
  capabilityRegistry,
  RegisteredCapability,
} from '../../5-tool-loop/registry.js';

// =====================================================
// SEQUENCE CAPABILITY
// Execute multiple capabilities in sequence with result forwarding
// =====================================================

/** Format a result message, truncating long results. */
function formatResultMessage(result: unknown): string {
  if (typeof result === 'string') {
    return result.substring(0, 100);
  }
  return 'Success';
}

export const sequenceCapability: RegisteredCapability = {
  name: 'sequence',
  emoji: '🔄',
  supportedActions: ['execute'],
  description:
    'Execute multiple capabilities in sequence, passing results forward. Enables complex multi-step workflows. Use "steps" parameter with array of capability objects.',
  handler: async (params, _content, context) => {
    const { steps } = params;
    // Identity comes from the real caller's context, never from model params, and the same
    // context is passed to every step so owner checks see who is really asking (security
    // audit 2026-10-26: userId used to be model-supplied and steps ran with no context).
    const userId = context?.userId;
    const messageId = context?.messageId;

    if (!steps) {
      throw new Error('Steps array is required for sequence execution');
    }

    let stepsArray: any[];

    // Parse steps if it's a string
    if (typeof steps === 'string') {
      try {
        stepsArray = JSON.parse(steps);
      } catch (error) {
        throw new Error(`Failed to parse steps JSON: ${error}`);
      }
    } else if (Array.isArray(steps)) {
      stepsArray = steps;
    } else {
      throw new Error('Steps must be an array or JSON string array');
    }

    if (!Array.isArray(stepsArray) || stepsArray.length === 0) {
      throw new Error('Steps must be a non-empty array');
    }

    const results: any[] = [];
    const startTime = Date.now();

    logger.info(`🔗 SEQUENCE: Starting execution of ${stepsArray.length} steps`);

    for (let i = 0; i < stepsArray.length; i++) {
      const step = stepsArray[i];
      const stepNum = i + 1;

      if (!step.name) {
        throw new Error(`Step ${stepNum} missing required "name" field`);
      }

      const { name, action, ...stepParams } = step;

      try {
        logger.info(
          `🔗 SEQUENCE: Executing step ${stepNum}/${stepsArray.length}: ${name}:${action || 'default'}`
        );

        // Add userId and messageId to step params
        const stepAction = action || stepParams.action;
        const enrichedParams = {
          ...stepParams,
          userId,
          messageId,
          action: stepAction,
        };

        // Execute the capability through the registry.
        // Signature is (name, action, params, content) — this used to pass the
        // params OBJECT as `action`, so every sequence step failed with
        // "attemptedAction.toLowerCase is not a function".
        const result = await capabilityRegistry.execute(name, stepAction, enrichedParams, '', context);

        results.push({
          step: stepNum,
          capability: `${name}:${action || 'default'}`,
          success: true,
          result,
        });

        logger.info(`✅ SEQUENCE: Step ${stepNum} completed successfully`);
      } catch (error: any) {
        logger.error(`❌ SEQUENCE: Step ${stepNum} failed:`, error);

        results.push({
          step: stepNum,
          capability: `${name}:${action || 'default'}`,
          success: false,
          error: error.message,
        });

        // Fail fast - stop execution on first error
        throw new Error(`Sequence failed at step ${stepNum} (${name}:${action}): ${error.message}`);
      }
    }

    const duration = Date.now() - startTime;
    const summary =
      `✅ Sequence completed: ${stepsArray.length} steps in ${duration}ms\n\n` +
      results
        .map((r) => {
          if (r.success) {
            const resultMsg = formatResultMessage(r.result);
            return `${r.step}. ✅ ${r.capability}: ${resultMsg}`;
          }
          return `${r.step}. ❌ ${r.capability}: ${r.error}`;
        })
        .join('\n');

    logger.info(`🔗 SEQUENCE: Completed ${stepsArray.length} steps in ${duration}ms`);

    return summary;
  },
};
