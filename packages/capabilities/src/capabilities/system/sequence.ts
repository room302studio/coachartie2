import { logger } from '@coachartie/shared';
import { capabilityRegistry, RegisteredCapability } from '../../services/capability/capability-registry.js';

// =====================================================
// SEQUENCE CAPABILITY
// Execute multiple capabilities in sequence with result forwarding
// =====================================================

export const sequenceCapability: RegisteredCapability = {
  name: 'sequence',
  emoji: '🔄',
  supportedActions: ['execute'],
  description:
    'Execute multiple capabilities in sequence, passing results forward. Enables complex multi-step workflows. Use "steps" parameter with array of capability objects.',
  handler: async (params, _content) => {
    const { steps, userId, messageId } = params;

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
        const enrichedParams = {
          ...stepParams,
          userId,
          messageId,
          action: action || stepParams.action,
        };

        // Execute the capability through the registry
        const result = await capabilityRegistry.execute(name, enrichedParams, '');

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
        .map((r) =>
          r.success
            ? `${r.step}. ✅ ${r.capability}: ${typeof r.result === 'string' ? r.result.substring(0, 100) : 'Success'}`
            : `${r.step}. ❌ ${r.capability}: ${r.error}`
        )
        .join('\n');

    logger.info(`🔗 SEQUENCE: Completed ${stepsArray.length} steps in ${duration}ms`);

    return summary;
  },
};
