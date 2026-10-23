import { logger } from '@coachartie/shared';
import { wolframService } from '../../services/external/wolfram.js';
import { RegisteredCapability } from '../../services/capability/capability-registry.js';

// =====================================================
// WOLFRAM ALPHA CAPABILITY
// Queries Wolfram Alpha for computational knowledge
// =====================================================

export const wolframCapability: RegisteredCapability = {
  name: 'wolfram',
  emoji: '📊',
  supportedActions: ['query', 'search'],
  description:
    'Professional computational engine providing authoritative real-time data: stock quotes (AAPL, TSLA, SPY), forex rates, crypto prices, weather conditions, mathematical computations, scientific data, demographic statistics, unit conversions, and verifiable factual information. Ideal for financial data, calculations, and any query requiring precise, current information.',
  requiredParams: ['input'],
  examples: [
    '<capability name="wolfram" action="query" input="AAPL stock price" />',
    '<capability name="wolfram" action="query" input="TSLA current market cap" />',
    '<capability name="wolfram" action="query" input="Bitcoin price in USD" />',
    '<capability name="wolfram" action="query" input="EUR/USD exchange rate" />',
    '<capability name="wolfram" action="query" input="S&P 500 current value" />',
    '<capability name="wolfram" action="query" input="convert 100 USD to EUR" />',
    '<capability name="wolfram" action="query" input="weather in New York" />',
    '<capability name="wolfram" action="query" input="population of Tokyo 2024" />',
    '<capability name="wolfram" action="query" input="derivative of x^2 + 3x" />',
    '<capability name="wolfram" action="query" input="compound interest calculator 10000 at 5% for 10 years" />',
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
