import { logger } from '@coachartie/shared';
import { openRouterService } from './openrouter.js';

/**
 * Observation Handler Service
 * Processes observational learning requests using the FAST_MODEL
 * for cost-effective passive learning from Discord conversations
 */

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

      // System prompt for observation analysis
      const systemPrompt = `You are an observational analysis system. Your role is to passively observe Discord conversations and extract patterns, themes, and insights without participating.

Focus on:
- Main topics and themes
- User interests and preferences
- Recurring questions or problems
- Community dynamics and culture

Be concise (2-3 sentences) and factual. Don't make assumptions beyond what's directly observable.`;

      // Build message chain for generateFromMessageChain
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: prompt }
      ];

      // Use FAST_MODEL for cost efficiency
      const response = await openRouterService.generateFromMessageChain(
        messages,
        'observational-system', // Special system user for observations
        undefined, // messageId (optional)
        process.env.FAST_MODEL || 'openai/gpt-4o-mini'
      );

      // Estimate cost (GPT-4o-mini: ~$0.15/1M input, $0.60/1M output)
      const inputTokens = (systemPrompt.length + prompt.length) / 4; // Rough estimate
      const outputTokens = response.length / 4;
      const estimatedCost = (inputTokens * 0.00015 + outputTokens * 0.0006) / 1000;

      logger.info(`👁️ Observation summary generated (est. cost: $${estimatedCost.toFixed(4)})`);

      return {
        summary: response,
        cost: estimatedCost
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
      const { getDatabase } = await import('@coachartie/shared');
      const db = await getDatabase();

      const stats = await db.get(`
        SELECT
          COUNT(*) as totalObservations,
          SUM(CASE WHEN metadata LIKE '%"cost":%'
               THEN CAST(json_extract(metadata, '$.cost') AS REAL)
               ELSE 0 END) as totalCost
        FROM memories
        WHERE user_id = 'observational-system'
      `);

      const byGuild = await db.all(`
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
        observationsByGuild
      };
    } catch (error) {
      logger.error('Failed to get observation stats:', error);
      return {
        totalObservations: 0,
        totalCost: 0,
        observationsByGuild: {}
      };
    }
  }
}

export const observationHandler = ObservationHandler.getInstance();