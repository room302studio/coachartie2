import OpenAI from 'openai';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../../.env') });

import { logger } from '@coachartie/shared';

class OpenRouterService {
  private client: OpenAI;
  private models: string[];
  private currentModelIndex: number = 0;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    
    // Primary model + fallback free models
    this.models = [
      process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
      'mistralai/mistral-7b-instruct:free',
      'microsoft/phi-3-mini-128k-instruct:free',
      'meta-llama/llama-3.2-3b-instruct:free',
      'google/gemma-2-9b-it:free',
      'openai/gpt-3.5-turbo'  // Sometimes has free tier
    ];

    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY environment variable is required');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://coach-artie.local',
        'X-Title': 'Coach Artie',
      },
    });

    logger.info(`OpenRouter client initialized with models: ${this.models.join(', ')}`);
  }

  async generateResponse(
    userMessage: string, 
    userId: string, 
    context?: string
  ): Promise<string> {
    const systemPrompt = `You are Coach Artie, a helpful and encouraging AI assistant. You provide supportive, motivational, and practical advice. Keep responses concise but warm and engaging.

${context ? `Context from previous conversations: ${context}` : ''}`;

    // Try each model in order until one works
    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];
      
      try {
        logger.info(`Attempting to generate response with model: ${model}`);
        
        const completion = await this.client.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
          max_tokens: 500,
          temperature: 0.7,
        });

        const response = completion.choices[0]?.message?.content;
        
        if (!response) {
          throw new Error('No response generated');
        }

        logger.info(`✅ Generated response for user ${userId} using ${model}`);
        return response.trim();

      } catch (error: any) {
        logger.warn(`❌ Model ${model} failed: ${error.message}`);
        
        // If this was a credit/billing error, try free models
        if (error.message?.includes('credit') || 
            error.message?.includes('billing') || 
            error.message?.includes('quota') ||
            error.status === 402) {
          logger.info('💳 Billing/credit error detected, skipping to free models...');
          continue;
        }
        
        // For other errors, try next model
        if (i < this.models.length - 1) {
          logger.info(`🔄 Trying next model...`);
          continue;
        }
        
        // Last model failed
        logger.error('All models failed:', error);
      }
    }
    
    // All models failed
    logger.error('🚨 All OpenRouter models failed, using fallback response');
    return "I'm Coach Artie! I'm having some technical difficulties right now, but I'm here to help. What can I assist you with today?";
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Simple health check - try the first model
      const completion = await this.client.chat.completions.create({
        model: this.models[0],
        messages: [
          {
            role: 'user',
            content: 'Say "OK" if you can respond.',
          },
        ],
        max_tokens: 5,
        temperature: 0,
      });

      return !!completion.choices[0]?.message?.content;
    } catch (error) {
      logger.error('OpenRouter health check failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const openRouterService = new OpenRouterService();