import { logger } from '@coachartie/shared';
import { wolframService } from '../services/wolfram.js';
import { RegisteredCapability } from '../services/capability-registry.js';

// =====================================================
// WOLFRAM ALPHA CAPABILITY
// Queries Wolfram Alpha for computational knowledge
// =====================================================

export const wolframCapability: RegisteredCapability = {
  name: 'wolfram',
  supportedActions: ['query', 'search'],
  description: 'Queries Wolfram Alpha for computational knowledge, real-time data, stock prices, currency conversion, weather, calculations, and factual information',
  requiredParams: ['input'],
  examples: [
    '<capability name="wolfram" action="query" input="AAPL stock price" />',
    '<capability name="wolfram" action="query" input="convert 100 USD to EUR" />',
    '<capability name="wolfram" action="query" input="weather in New York" />',
    '<capability name="wolfram" action="query" input="population of Tokyo" />',
    '<capability name="wolfram" action="query" input="derivative of x^2 + 3x" />',
  ],
  handler: async (params, content) => {
    const input = params.input || params.query || content;
    if (!input) {
      throw new Error('No input provided for Wolfram Alpha query');
    }

    try {
      const result = await wolframService.query(input);
      return result;
    } catch (error) {
      logger.error('Wolfram Alpha capability failed:', error);
      throw error;
    }
  },
};
