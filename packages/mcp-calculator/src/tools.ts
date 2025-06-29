import { evaluate } from 'mathjs';
import { z } from 'zod';

// Zod schemas for input validation
const CalculateSchema = z.object({
  expression: z.string().min(1, 'Expression cannot be empty'),
});

const BinaryOperationSchema = z.object({
  a: z.number().finite('First number must be a finite number'),
  b: z.number().finite('Second number must be a finite number'),
});

const DivideSchema = z.object({
  a: z.number().finite('First number must be a finite number'),
  b: z.number().finite('Second number must be a finite number').refine(
    (val) => val !== 0,
    'Division by zero is not allowed'
  ),
});

// Tool type definition
interface CalculatorTool {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<string>;
}

// Helper function to safely evaluate mathematical expressions
async function safeEvaluate(expression: string): Promise<number> {
  try {
    const result = evaluate(expression);
    
    // Ensure result is a number
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new Error('Expression did not evaluate to a finite number');
    }
    
    return result;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid mathematical expression: ${error.message}`);
    }
    throw new Error('Invalid mathematical expression');
  }
}

// Calculator tool implementations
export const calculatorTools: CalculatorTool[] = [
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression using mathjs. Supports arithmetic operations, functions, constants, and more complex mathematical expressions.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate (e.g., "2 + 3 * 4", "sqrt(16)", "sin(pi/2)")',
        },
      },
      required: ['expression'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any): Promise<string> => {
      const { expression } = CalculateSchema.parse(args);
      
      const result = await safeEvaluate(expression);
      return `${expression} = ${result}`;
    },
  },
  
  {
    name: 'add',
    description: 'Add two numbers together.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'number',
          description: 'The first number',
        },
        b: {
          type: 'number',
          description: 'The second number',
        },
      },
      required: ['a', 'b'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any): Promise<string> => {
      const { a, b } = BinaryOperationSchema.parse(args);
      const result = a + b;
      return `${a} + ${b} = ${result}`;
    },
  },
  
  {
    name: 'subtract',
    description: 'Subtract the second number from the first number.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'number',
          description: 'The first number (minuend)',
        },
        b: {
          type: 'number',
          description: 'The second number (subtrahend)',
        },
      },
      required: ['a', 'b'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any): Promise<string> => {
      const { a, b } = BinaryOperationSchema.parse(args);
      const result = a - b;
      return `${a} - ${b} = ${result}`;
    },
  },
  
  {
    name: 'multiply',
    description: 'Multiply two numbers together.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'number',
          description: 'The first number',
        },
        b: {
          type: 'number',
          description: 'The second number',
        },
      },
      required: ['a', 'b'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any): Promise<string> => {
      const { a, b } = BinaryOperationSchema.parse(args);
      const result = a * b;
      return `${a} * ${b} = ${result}`;
    },
  },
  
  {
    name: 'divide',
    description: 'Divide the first number by the second number.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'number',
          description: 'The dividend (number to be divided)',
        },
        b: {
          type: 'number',
          description: 'The divisor (number to divide by, cannot be zero)',
        },
      },
      required: ['a', 'b'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any): Promise<string> => {
      const { a, b } = DivideSchema.parse(args);
      const result = a / b;
      return `${a} / ${b} = ${result}`;
    },
  },
];

export default calculatorTools;