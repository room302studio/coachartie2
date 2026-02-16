/**
 * Capability Tracker - Logs every capability invocation for analysis
 */

import { logger, getSyncDb } from '@coachartie/shared';

interface CapabilityInvocationData {
  traceId?: string;
  capabilityName: string;
  action: string;
  params?: Record<string, any>;
  result?: any;
  startedAt: Date;
  completedAt?: Date;
  success: boolean;
  error?: string;
  sequenceNumber?: number;
}

class CapabilityTracker {
  private static instance: CapabilityTracker;
  private enabled: boolean;

  private constructor() {
    this.enabled = process.env.ENABLE_TRACING !== 'false';
  }

  static getInstance(): CapabilityTracker {
    if (!CapabilityTracker.instance) {
      CapabilityTracker.instance = new CapabilityTracker();
    }
    return CapabilityTracker.instance;
  }

  async logInvocation(data: CapabilityInvocationData): Promise<void> {
    if (!this.enabled) return;

    try {
      const db = getSyncDb();
      const durationMs = data.completedAt
        ? data.completedAt.getTime() - data.startedAt.getTime()
        : null;

      db.run(
        `INSERT INTO capability_invocations
         (trace_id, capability_name, action, params_json, result_json, started_at, completed_at, duration_ms, success, error_type, error_message, sequence_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.traceId || null,
          data.capabilityName,
          data.action,
          data.params ? JSON.stringify(data.params).slice(0, 4000) : null,
          data.result ? JSON.stringify(data.result).slice(0, 4000) : null,
          data.startedAt.toISOString(),
          data.completedAt?.toISOString() || null,
          durationMs,
          data.success ? 1 : 0,
          data.error ? 'execution_error' : null,
          data.error?.slice(0, 1000) || null,
          data.sequenceNumber || 0,
        ]
      );

      logger.debug(
        `📊 Capability invocation logged: ${data.capabilityName}:${data.action} (${data.success ? 'success' : 'failed'})`
      );
    } catch (error) {
      logger.error('Failed to log capability invocation:', error);
    }
  }

  async getCapabilityStats(days: number = 7): Promise<any[]> {
    if (!this.enabled) return [];

    try {
      const db = getSyncDb();
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      return (
        db.all(
          `SELECT
            capability_name as capabilityName,
            action,
            COUNT(*) as total,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
            AVG(duration_ms) as avgDurationMs,
            MAX(duration_ms) as maxDurationMs
          FROM capability_invocations
          WHERE started_at > ?
          GROUP BY capability_name, action
          ORDER BY total DESC`,
          [cutoffDate]
        ) || []
      );
    } catch (error) {
      logger.error('Failed to get capability stats:', error);
      return [];
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const capabilityTracker = CapabilityTracker.getInstance();
