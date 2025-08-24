import { getDatabase } from '@coachartie/shared';
import { logger } from '@coachartie/shared';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface UsageStats {
  model_name: string;
  user_id: string;
  message_id: string;
  input_length: number;
  output_length: number;
  response_time_ms: number;
  capabilities_detected: number;
  capabilities_executed: number;
  capability_types: string;
  success: boolean;
  error_type?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost: number;
}

// Model pricing per 1K tokens (input/output) - OpenRouter pricing as of 2024
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-3.5-sonnet': { input: 0.003, output: 0.015 },
  'mistralai/mistral-7b-instruct:free': { input: 0, output: 0 },
  'microsoft/phi-3-mini-128k-instruct:free': { input: 0, output: 0 },
  'meta-llama/llama-3.2-3b-instruct:free': { input: 0, output: 0 },
  'google/gemma-2-9b-it:free': { input: 0, output: 0 },
  'openai/gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'openai/gpt-4': { input: 0.03, output: 0.06 },
  'openai/gpt-4-turbo': { input: 0.01, output: 0.03 },
};

export class UsageTracker {
  /**
   * Calculate estimated cost based on token usage and model
   */
  static calculateCost(modelName: string, usage: TokenUsage): number {
    const pricing = MODEL_PRICING[modelName];
    if (!pricing) {
      logger.warn(`⚠️ No pricing info for model: ${modelName}`);
      return 0;
    }

    const inputCost = (usage.prompt_tokens / 1000) * pricing.input;
    const outputCost = (usage.completion_tokens / 1000) * pricing.output;
    
    return inputCost + outputCost;
  }

  /**
   * Record usage statistics to database
   */
  static async recordUsage(stats: UsageStats): Promise<void> {
    try {
      const db = await getDatabase();
      
      await db.run(
        `INSERT INTO model_usage_stats (
          model_name, user_id, message_id, input_length, output_length,
          response_time_ms, capabilities_detected, capabilities_executed,
          capability_types, success, error_type, prompt_tokens,
          completion_tokens, total_tokens, estimated_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stats.model_name,
          stats.user_id,
          stats.message_id,
          stats.input_length,
          stats.output_length,
          stats.response_time_ms,
          stats.capabilities_detected,
          stats.capabilities_executed,
          stats.capability_types,
          stats.success,
          stats.error_type || null,
          stats.prompt_tokens,
          stats.completion_tokens,
          stats.total_tokens,
          stats.estimated_cost
        ]
      );

      logger.info(`📊 Usage recorded: ${stats.model_name} - ${stats.total_tokens} tokens - $${stats.estimated_cost.toFixed(4)}`);
    } catch (error) {
      logger.error('❌ Failed to record usage stats:', error);
      // Don't throw - usage tracking failure shouldn't break the main flow
    }
  }

  /**
   * Get usage statistics for a user or model
   */
  static async getUserUsage(userId: string, days: number = 30): Promise<{
    total_tokens: number;
    total_cost: number;
    requests: number;
    most_used_model: string;
  }> {
    try {
      const db = await getDatabase();
      
      const result = await db.get(`
        SELECT 
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          COUNT(*) as requests,
          (SELECT model_name FROM model_usage_stats 
           WHERE user_id = ? AND timestamp >= datetime('now', '-${days} days')
           GROUP BY model_name ORDER BY COUNT(*) DESC LIMIT 1) as most_used_model
        FROM model_usage_stats 
        WHERE user_id = ? 
        AND timestamp >= datetime('now', '-${days} days')
      `, [userId, userId]);

      return {
        total_tokens: result?.total_tokens || 0,
        total_cost: result?.total_cost || 0,
        requests: result?.requests || 0,
        most_used_model: result?.most_used_model || 'none'
      };
    } catch (error) {
      logger.error('❌ Failed to get user usage:', error);
      return { total_tokens: 0, total_cost: 0, requests: 0, most_used_model: 'none' };
    }
  }

  /**
   * Get model usage statistics
   */
  static async getModelUsage(modelName: string, days: number = 30): Promise<{
    total_tokens: number;
    total_cost: number;
    requests: number;
    avg_tokens_per_request: number;
  }> {
    try {
      const db = await getDatabase();
      
      const result = await db.get(`
        SELECT 
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          COUNT(*) as requests,
          AVG(total_tokens) as avg_tokens_per_request
        FROM model_usage_stats 
        WHERE model_name = ? 
        AND timestamp >= datetime('now', '-${days} days')
      `, [modelName]);

      return {
        total_tokens: result?.total_tokens || 0,
        total_cost: result?.total_cost || 0,
        requests: result?.requests || 0,
        avg_tokens_per_request: result?.avg_tokens_per_request || 0
      };
    } catch (error) {
      logger.error('❌ Failed to get model usage:', error);
      return { total_tokens: 0, total_cost: 0, requests: 0, avg_tokens_per_request: 0 };
    }
  }

  /**
   * Get tool usage performance by model
   */
  static async getToolUsagePerformance(days: number = 30): Promise<Array<{
    model_name: string;
    total_requests: number;
    capabilities_detected: number;
    capabilities_executed: number;
    tool_success_rate: number;
    xml_format_success_rate: number;
    avg_response_time: number;
  }>> {
    try {
      const db = await getDatabase();
      
      const results = await db.all(`
        SELECT 
          model_name,
          COUNT(*) as total_requests,
          SUM(capabilities_detected) as capabilities_detected,
          SUM(capabilities_executed) as capabilities_executed,
          ROUND(
            CASE 
              WHEN SUM(capabilities_detected) > 0 
              THEN (SUM(capabilities_executed) * 100.0 / SUM(capabilities_detected))
              ELSE 0 
            END, 2
          ) as tool_success_rate,
          ROUND(
            CASE 
              WHEN COUNT(*) > 0
              THEN (SUM(CASE WHEN capabilities_detected > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))
              ELSE 0
            END, 2
          ) as xml_format_success_rate,
          ROUND(AVG(response_time_ms), 0) as avg_response_time
        FROM model_usage_stats 
        WHERE timestamp >= datetime('now', '-${days} days')
        GROUP BY model_name
        ORDER BY tool_success_rate DESC, xml_format_success_rate DESC
      `);

      return results.map(row => ({
        model_name: row.model_name,
        total_requests: row.total_requests,
        capabilities_detected: row.capabilities_detected,
        capabilities_executed: row.capabilities_executed,
        tool_success_rate: row.tool_success_rate,
        xml_format_success_rate: row.xml_format_success_rate,
        avg_response_time: row.avg_response_time
      }));
    } catch (error) {
      logger.error('❌ Failed to get tool usage performance:', error);
      return [];
    }
  }

  /**
   * Get daily usage summary
   */
  static async getDailyUsage(days: number = 7): Promise<Array<{
    date: string;
    total_tokens: number;
    total_cost: number;
    requests: number;
  }>> {
    try {
      const db = await getDatabase();
      
      const results = await db.all(`
        SELECT 
          DATE(timestamp) as date,
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost) as total_cost,
          COUNT(*) as requests
        FROM model_usage_stats 
        WHERE timestamp >= datetime('now', '-${days} days')
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `);

      return results.map(row => ({
        date: row.date,
        total_tokens: row.total_tokens || 0,
        total_cost: row.total_cost || 0,
        requests: row.requests || 0
      }));
    } catch (error) {
      logger.error('❌ Failed to get daily usage:', error);
      return [];
    }
  }
}

export { UsageTracker as usageTracker };