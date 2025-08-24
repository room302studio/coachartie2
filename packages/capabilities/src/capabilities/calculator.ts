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
  supportedActions: ['calculate', 'eval'],
  description: 'Performs mathematical calculations and evaluates expressions',
  requiredParams: ['expression'],
  examples: [
    '<capability name="calculator" action="calculate" expression="5+5" />',
    '<capability name="calculator" action="calculate" expression="(42 * 2) / 3" />'
  ],
  handler: async (params, content) => {
    logger.info(`🧮 Calculator called with params: ${JSON.stringify(params)}, content: "${content}"`);
    const expression = params.expression || content;
    
    if (!expression) {
      throw new Error('No expression provided for calculation');
    }

    logger.info(`🧮 Calculating expression: ${expression}`);

    try {
      // Use mathjs for safe mathematical expression evaluation
      const result = evaluate(expression);
      const resultString = `${expression} = ${result}`;
      
      logger.info(`✅ Calculation result: ${resultString}`);
      return resultString;
    } catch (error) {
      logger.error(`❌ Invalid mathematical expression: ${expression}`, error);
      throw new Error(`Invalid mathematical expression: ${expression}`);
    }
  }
};