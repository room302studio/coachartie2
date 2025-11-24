import { evaluate } from 'mathjs';
import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

/**
 * Calculator capability - performs mathematical calculations and evaluates expressions
 *
 * Supported actions:
 * - calculate: Evaluates a mathematical expression
 * - eval: Alias for calculate
 *
 * Parameters:
 * - expression: The mathematical expression to evaluate
 *
 * Content: Can also provide the expression as content instead of a parameter
 */
export const calculatorCapability: RegisteredCapability = {
  name: 'calculator',
  emoji: '🧮',
  supportedActions: ['calculate', 'eval'],
  description: 'Performs mathematical calculations and evaluates expressions',
  requiredParams: ['expression'],
  examples: [
    '<capability name="calculator" action="calculate" expression="5+5" />',
    '<capability name="calculator" action="calculate" expression="(42 * 2) / 3" />',
  ],
  handler: async (params, content) => {
    logger.info(
      `🧮 Calculator called with params: ${JSON.stringify(params)}, content: "${content}"`
    );

    // Extract expression from multiple possible sources
    let expression = params.expression || params.query || content;

    // If params is a stringified JSON, try to parse it
    if (!expression && typeof params === 'string') {
      try {
        const parsed = JSON.parse(params);
        expression = parsed.expression || parsed.query;
      } catch {
        // Not JSON, use as-is
        expression = params;
      }
    }

    // Clean up expression
    if (expression) {
      expression = String(expression).trim();
    }

    if (!expression) {
      logger.error(
        `❌ No expression provided. params=${JSON.stringify(params)}, content="${content}"`
      );
      throw new Error(
        'No expression provided for calculation. Use: <capability name="calculator" action="calculate" expression="2+2" /> or <capability name="calculator" action="calculate" data=\'{"expression":"2+2"}\' />'
      );
    }

    logger.info(`🧮 Calculating expression: ${expression}`);

    try {
      // Use mathjs for safe mathematical expression evaluation
      const result = evaluate(expression);
      const resultString = `${expression} = ${result}`;

      logger.info(`✅ Calculation result: ${resultString}`);
      return resultString;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Invalid mathematical expression: ${expression}`, error);
      throw new Error(
        `Invalid mathematical expression: "${expression}"\n` +
          `Error: ${errorMessage}\n` +
          `\n` +
          `Supported operations: +, -, *, /, ^, sqrt(), sin(), cos(), tan(), log(), abs(), etc.\n` +
          `Example: <capability name="calculator" action="calculate" expression="sqrt(16) + 2^3" />`
      );
    }
  },
};
