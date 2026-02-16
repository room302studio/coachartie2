/**
 * Error Tracker - Structured error logging for pattern analysis
 */

import { logger, getDb } from '@coachartie/shared';
import { errorEvents } from '@coachartie/shared';
import { desc, sql } from 'drizzle-orm';

export const ERROR_TYPES = {
  LLM_BILLING: 'llm_billing',
  LLM_RATE_LIMIT: 'llm_rate_limit',
  LLM_AUTH: 'llm_auth',
  LLM_MODEL: 'llm_model',
  LLM_TIMEOUT: 'llm_timeout',
  CAP_NOT_FOUND: 'cap_not_found',
  CAP_INVALID_PARAMS: 'cap_invalid_params',
  CAP_EXECUTION: 'cap_execution',
  CAP_TAINTED: 'cap_tainted',
  MEM_SEARCH_FAIL: 'mem_search_fail',
  MEM_STORE_FAIL: 'mem_store_fail',
  DISCORD_API: 'discord_api',
  GITHUB_API: 'github_api',
  DB_ERROR: 'db_error',
  NETWORK_ERROR: 'network_error',
  UNKNOWN: 'unknown',
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];

export interface ErrorContext {
  traceId?: string;
  userId?: string;
  guildId?: string;
  capability?: string;
  action?: string;
  attempt?: number;
  [key: string]: any;
}

class ErrorTracker {
  private static instance: ErrorTracker;
  private enabled: boolean;

  private constructor() {
    this.enabled = process.env.ENABLE_TRACING !== 'false';
  }

  static getInstance(): ErrorTracker {
    if (!ErrorTracker.instance) {
      ErrorTracker.instance = new ErrorTracker();
    }
    return ErrorTracker.instance;
  }

  async trackError(options: {
    error: Error | string;
    errorType: ErrorType;
    service: string;
    severity?: 'warning' | 'error' | 'critical';
    context?: ErrorContext;
    recovered?: boolean;
    recoveryAction?: string;
    retryCount?: number;
  }): Promise<void> {
    if (!this.enabled) return;

    try {
      const db = getDb();
      const errorMessage =
        typeof options.error === 'string' ? options.error : options.error.message;
      const stackTrace =
        typeof options.error === 'string' ? undefined : options.error.stack?.slice(0, 2000);
      const errorCode = this.extractErrorCode(errorMessage);

      await db.insert(errorEvents).values({
        errorType: options.errorType,
        errorCode,
        severity: options.severity || 'error',
        traceId: options.context?.traceId,
        userId: options.context?.userId,
        guildId: options.context?.guildId,
        service: options.service,
        message: errorMessage?.slice(0, 1000),
        stackTrace,
        contextJson: options.context ? JSON.stringify(options.context) : null,
        recovered: options.recovered || false,
        recoveryAction: options.recoveryAction,
        retryCount: options.retryCount || 0,
      });

      logger.debug(`🚨 Error tracked: ${options.errorType} in ${options.service}`);
    } catch (trackError) {
      logger.error('Failed to track error:', trackError);
    }
  }

  classifyError(error: Error | string): {
    type: ErrorType;
    code?: string;
    severity: 'warning' | 'error' | 'critical';
  } {
    const message = typeof error === 'string' ? error : error.message;
    const lowerMessage = message.toLowerCase();

    if (
      lowerMessage.includes('credit') ||
      lowerMessage.includes('billing') ||
      lowerMessage.includes('402')
    ) {
      return { type: ERROR_TYPES.LLM_BILLING, code: '402', severity: 'critical' };
    }
    if (lowerMessage.includes('rate limit') || lowerMessage.includes('429')) {
      return { type: ERROR_TYPES.LLM_RATE_LIMIT, code: '429', severity: 'warning' };
    }
    if (
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('401') ||
      lowerMessage.includes('403')
    ) {
      return { type: ERROR_TYPES.LLM_AUTH, code: '401', severity: 'critical' };
    }
    if (lowerMessage.includes('timeout') || lowerMessage.includes('etimedout')) {
      return { type: ERROR_TYPES.LLM_TIMEOUT, severity: 'error' };
    }
    if (lowerMessage.includes('capability not found')) {
      return { type: ERROR_TYPES.CAP_NOT_FOUND, severity: 'warning' };
    }
    if (lowerMessage.includes('invalid param') || lowerMessage.includes('missing required')) {
      return { type: ERROR_TYPES.CAP_INVALID_PARAMS, severity: 'warning' };
    }
    if (lowerMessage.includes('tainted')) {
      return { type: ERROR_TYPES.CAP_TAINTED, severity: 'error' };
    }
    if (lowerMessage.includes('fts5') || lowerMessage.includes('search')) {
      return { type: ERROR_TYPES.MEM_SEARCH_FAIL, severity: 'error' };
    }
    if (
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('network') ||
      lowerMessage.includes('fetch failed')
    ) {
      return { type: ERROR_TYPES.NETWORK_ERROR, severity: 'error' };
    }
    if (lowerMessage.includes('sqlite') || lowerMessage.includes('database')) {
      return { type: ERROR_TYPES.DB_ERROR, severity: 'error' };
    }
    if (lowerMessage.includes('discord')) {
      return { type: ERROR_TYPES.DISCORD_API, severity: 'error' };
    }
    if (lowerMessage.includes('github')) {
      return { type: ERROR_TYPES.GITHUB_API, severity: 'error' };
    }

    return { type: ERROR_TYPES.UNKNOWN, severity: 'error' };
  }

  async getErrorsByType(days: number = 7): Promise<any[]> {
    if (!this.enabled) return [];

    try {
      const db = getDb();
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const results = await db.all(sql`
        SELECT
          error_type as errorType,
          service,
          COUNT(*) as count,
          SUM(CASE WHEN recovered = 1 THEN 1 ELSE 0 END) as recovered
        FROM error_events
        WHERE created_at > ${cutoffDate}
        GROUP BY error_type, service
        ORDER BY count DESC
      `);

      return results || [];
    } catch (error) {
      logger.error('Failed to get errors by type:', error);
      return [];
    }
  }

  async getRecentErrors(limit: number = 50): Promise<any[]> {
    if (!this.enabled) return [];

    try {
      const db = getDb();
      return await db.select().from(errorEvents).orderBy(desc(errorEvents.createdAt)).limit(limit);
    } catch (error) {
      logger.error('Failed to get recent errors:', error);
      return [];
    }
  }

  private extractErrorCode(message: string): string | null {
    const match = message.match(/\b(4\d{2}|5\d{2})\b/);
    return match ? match[1] : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const errorTracker = ErrorTracker.getInstance();
