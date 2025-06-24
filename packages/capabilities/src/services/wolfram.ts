import { logger } from '@coachartie/shared';

export class WolframService {
  private apiKey: string;
  private baseUrl = 'https://api.wolframalpha.com/v1/result';

  constructor() {
    this.apiKey = process.env.WOLFRAM_APP_ID || '';
    if (!this.apiKey) {
      throw new Error('WOLFRAM_APP_ID environment variable is required');
    }
    logger.info('Wolfram Alpha service initialized');
  }

  async query(input: string): Promise<string> {
    try {
      const url = new URL(this.baseUrl);
      url.searchParams.set('appid', this.apiKey);
      url.searchParams.set('input', input);
      url.searchParams.set('format', 'plaintext');

      const response = await fetch(url.toString());
      
      if (!response.ok) {
        throw new Error(`Wolfram Alpha API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.text();
      
      if (result.trim() === '') {
        return `No computational result found for "${input}"`;
      }

      return result.trim();
      
    } catch (error) {
      logger.error('Wolfram Alpha query failed:', error);
      throw new Error(`Failed to query Wolfram Alpha: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const wolframService = new WolframService();