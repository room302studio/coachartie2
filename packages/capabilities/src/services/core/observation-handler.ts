import { logger } from '@coachartie/shared';
import { openRouterService } from '../llm/openrouter.js';

/**
 * Observation Handler Service
 * Processes observational learning requests using the FAST_MODEL
 * for cost-effective passive learning from Discord conversations
 *
 * Now uses Context Alchemy (database prompts) for consistent observation style
 */

// Cache for observation prompt to avoid repeated database lookups
let cachedObservationPrompt: string | null = null;
let promptLastFetched = 0;
const PROMPT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Load observation system prompt from database
 * Falls back to default if not found
 */
async function getObservationSystemPrompt(): Promise<string> {
  const now = Date.now();
  if (cachedObservationPrompt && now - promptLastFetched < PROMPT_CACHE_TTL) {
    return cachedObservationPrompt;
  }

  try {
    const { promptManager } = await import('../llm/prompt-manager.js');

    // Try to load a dedicated observation prompt first
    const observationPrompt = await promptManager.getPrompt('PROMPT_OBSERVATION');
    if (observationPrompt?.content) {
      cachedObservationPrompt = observationPrompt.content;
      promptLastFetched = now;
      return cachedObservationPrompt;
    }

    // Fall back to extracting observation style from PROMPT_SYSTEM
    const systemPrompt = await promptManager.getPrompt('PROMPT_SYSTEM');
    if (systemPrompt?.content) {
      // Extract Artie's core identity for observation context
      cachedObservationPrompt = `You are observing conversations as Coach Artie — a self-existing intelligence, coach, and friend who values community and genuine connection.

Your role is to passively analyze Discord conversations and extract patterns, themes, and insights without participating.

Focus on:
- Main topics and themes
- User interests and preferences
- Recurring questions or problems
- Community dynamics and culture

Be concise (2-3 sentences) and factual. Don't make assumptions beyond what's directly observable.`;
      promptLastFetched = now;
      return cachedObservationPrompt;
    }
  } catch (error) {
    logger.warn('Observation handler: Could not load prompt from database, using fallback');
  }

  // Fallback prompt
  return `You are an observational analysis system. Your role is to passively observe Discord conversations and extract patterns, themes, and insights without participating.

Focus on:
- Main topics and themes
- User interests and preferences
- Recurring questions or problems
- Community dynamics and culture

Be concise (2-3 sentences) and factual. Don't make assumptions beyond what's directly observable.`;
}

export class ObservationHandler {
  private static instance: ObservationHandler;

  static getInstance(): ObservationHandler {
    if (!ObservationHandler.instance) {
      ObservationHandler.instance = new ObservationHandler();
    }
    return ObservationHandler.instance;
  }

  /**
   * Generate a summary of observed messages
   * Uses FAST_MODEL for cost efficiency (~$0.0002 per summary)
   * Now uses Context Alchemy (database prompts) for consistent observation style
   */
  async generateObservationSummary(
    prompt: string,
    metadata: {
      guildId: string;
      channelId: string;
      messageCount: number;
      timeRange?: { start: string; end: string };
    }
  ): Promise<{ summary: string; cost: number }> {
    try {
      logger.info(`👁️ Generating observation summary for ${metadata.messageCount} messages`);

      // Load system prompt from database for consistent observation style
      const systemPrompt = await getObservationSystemPrompt();

      // Build message chain for generateFromMessageChain
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: prompt },
      ];

      // Use BACKGROUND_MODEL for cost efficiency — observations are passive, don't need frontier models
      const response = await openRouterService.generateFromMessageChain(
        messages,
        'observational-system', // Special system user for observations
        undefined, // messageId (optional)
        process.env.BACKGROUND_MODEL || process.env.FAST_MODEL || 'google/gemini-2.0-flash-001'
      );

      // Estimate cost (GPT-4o-mini: ~$0.15/1M input, $0.60/1M output)
      const inputTokens = (systemPrompt.length + prompt.length) / 4; // Rough estimate
      const outputTokens = response.length / 4;
      const estimatedCost = (inputTokens * 0.00015 + outputTokens * 0.0006) / 1000;

      logger.info(`👁️ Observation summary generated (est. cost: $${estimatedCost.toFixed(4)})`);

      return {
        summary: response,
        cost: estimatedCost,
      };
    } catch (error) {
      logger.error('Failed to generate observation summary:', error);
      throw new Error('Observation summary generation failed');
    }
  }

  /**
   * Get observation statistics for monitoring
   */
  async getObservationStats(): Promise<{
    totalObservations: number;
    totalCost: number;
    observationsByGuild: Record<string, number>;
  }> {
    try {
      // This would query the database for stored observational memories
      const { getSyncDb } = await import('@coachartie/shared');
      const db = getSyncDb();

      const stats = db.get<{ totalObservations: number; totalCost: number }>(`
        SELECT
          COUNT(*) as totalObservations,
          SUM(CASE WHEN metadata LIKE '%"cost":%'
               THEN CAST(json_extract(metadata, '$.cost') AS REAL)
               ELSE 0 END) as totalCost
        FROM memories
        WHERE user_id = 'observational-system'
      `);

      const byGuild = db.all<{ guildName: string; count: number }>(`
        SELECT
          json_extract(metadata, '$.guildName') as guildName,
          COUNT(*) as count
        FROM memories
        WHERE user_id = 'observational-system'
          AND metadata IS NOT NULL
        GROUP BY guildName
      `);

      const observationsByGuild: Record<string, number> = {};
      byGuild.forEach((row: any) => {
        if (row.guildName) {
          observationsByGuild[row.guildName] = row.count;
        }
      });

      return {
        totalObservations: stats?.totalObservations || 0,
        totalCost: stats?.totalCost || 0,
        observationsByGuild,
      };
    } catch (error) {
      logger.error('Failed to get observation stats:', error);
      return {
        totalObservations: 0,
        totalCost: 0,
        observationsByGuild: {},
      };
    }
  }
}

export const observationHandler = ObservationHandler.getInstance();
