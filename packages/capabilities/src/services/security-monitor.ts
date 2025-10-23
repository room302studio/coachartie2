/**
 * Security Monitor - Tracks and logs potential information disclosure attempts
 *
 * This module monitors LLM responses for patterns that could expose:
 * - Internal system prompts
 * - Debug information
 * - Structured reasoning chains
 * - Configuration data
 * - Processing internals
 */

import { logger } from '@coachartie/shared';

interface SecurityIncident {
  timestamp: Date;
  userId: string;
  messageId: string;
  incidentType:
    | 'structured_output_leak'
    | 'debug_info_leak'
    | 'system_prompt_leak'
    | 'internal_reasoning_leak';
  patterns: string[];
  originalLength: number;
  sanitizedLength: number;
  reductionPercent: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export class SecurityMonitor {
  private incidents: SecurityIncident[] = [];
  private patternCounts = new Map<string, number>();

  /**
   * Analyze and log a security incident where internal information was exposed
   */
  logSanitizationEvent(
    originalContent: string,
    sanitizedContent: string,
    userId: string,
    messageId: string
  ): void {
    const detectedPatterns = this.analyzeSecurityPatterns(originalContent);

    if (detectedPatterns.length === 0) {
      return; // No security patterns detected
    }

    const reductionPercent = Math.round(
      ((originalContent.length - sanitizedContent.length) / originalContent.length) * 100
    );
    const severity = this.calculateSeverity(detectedPatterns, reductionPercent);

    const incident: SecurityIncident = {
      timestamp: new Date(),
      userId,
      messageId,
      incidentType: this.categorizeIncident(detectedPatterns),
      patterns: detectedPatterns,
      originalLength: originalContent.length,
      sanitizedLength: sanitizedContent.length,
      reductionPercent,
      severity,
    };

    this.incidents.push(incident);

    // Update pattern counters for trend analysis
    detectedPatterns.forEach((pattern) => {
      this.patternCounts.set(pattern, (this.patternCounts.get(pattern) || 0) + 1);
    });

    // Log based on severity
    this.logIncident(incident, originalContent.substring(0, 200));

    // Keep only last 1000 incidents to prevent memory bloat
    if (this.incidents.length > 1000) {
      this.incidents = this.incidents.slice(-1000);
    }
  }

  /**
   * Analyze content for security-sensitive patterns
   */
  private analyzeSecurityPatterns(content: string): string[] {
    const patterns: string[] = [];

    // Internal reasoning patterns
    if (content.match(/^analysis[A-Z]/im)) {
      patterns.push('analysis_leak');
    }
    if (content.match(/^assistant\s*commentary/im)) {
      patterns.push('assistant_commentary');
    }
    if (content.match(/^assistant\s*final/im)) {
      patterns.push('assistant_final_marker');
    }
    if (content.match(/<thinking>/i)) {
      patterns.push('thinking_tags');
    }

    // Debug and system patterns
    if (content.match(/^(DEBUG|TRACE|INFO):/im)) {
      patterns.push('debug_output');
    }
    if (content.match(/^\[SYSTEM/im)) {
      patterns.push('system_messages');
    }
    if (content.match(/^(execute|processing|result):/im)) {
      patterns.push('execution_debug');
    }

    // Structured data patterns
    if (content.match(/json\s*\{/i)) {
      patterns.push('json_leak');
    }
    if (content.match(/^→\s*/m)) {
      patterns.push('arrow_fragments');
    }
    if (content.match(/^:\s*/m)) {
      patterns.push('colon_fragments');
    }

    // XML debug patterns
    if (content.match(/<(analysis|commentary|debug|internal)/i)) {
      patterns.push('xml_debug_tags');
    }

    return patterns;
  }

  /**
   * Categorize the type of security incident
   */
  private categorizeIncident(patterns: string[]): SecurityIncident['incidentType'] {
    if (patterns.some((p) => ['system_messages', 'debug_output'].includes(p))) {
      return 'debug_info_leak';
    }
    if (
      patterns.some((p) => ['analysis_leak', 'thinking_tags', 'assistant_commentary'].includes(p))
    ) {
      return 'internal_reasoning_leak';
    }
    if (patterns.some((p) => ['json_leak', 'xml_debug_tags'].includes(p))) {
      return 'system_prompt_leak';
    }
    return 'structured_output_leak';
  }

  /**
   * Calculate severity based on patterns and content reduction
   */
  private calculateSeverity(
    patterns: string[],
    reductionPercent: number
  ): SecurityIncident['severity'] {
    // Critical: System messages or high reduction
    if (patterns.includes('system_messages') || reductionPercent > 80) {
      return 'critical';
    }

    // High: Debug output or significant reduction
    if (patterns.includes('debug_output') || reductionPercent > 50) {
      return 'high';
    }

    // Medium: Internal reasoning patterns
    if (
      patterns.some((p) => ['analysis_leak', 'thinking_tags', 'assistant_commentary'].includes(p))
    ) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Log the security incident with appropriate level
   */
  private logIncident(incident: SecurityIncident, contentPreview: string): void {
    const logData = {
      userId: incident.userId,
      messageId: incident.messageId,
      incidentType: incident.incidentType,
      patterns: incident.patterns,
      severity: incident.severity,
      reductionPercent: incident.reductionPercent,
      contentPreview:
        contentPreview + (contentPreview.length < incident.originalLength ? '...' : ''),
    };

    switch (incident.severity) {
      case 'critical':
        logger.error('🚨 CRITICAL SECURITY INCIDENT: Information disclosure prevented', logData);
        break;
      case 'high':
        logger.warn('⚠️ HIGH SECURITY ALERT: Potential information leak sanitized', logData);
        break;
      case 'medium':
        logger.warn('🛡️ SECURITY: Internal reasoning patterns sanitized', logData);
        break;
      case 'low':
        logger.info('🧹 SECURITY: Minor structured output cleaned', logData);
        break;
    }
  }

  /**
   * Get security statistics for monitoring
   */
  getSecurityStats(): {
    totalIncidents: number;
    incidentsByType: Record<string, number>;
    incidentsBySeverity: Record<string, number>;
    topPatterns: Array<{ pattern: string; count: number }>;
    recentIncidents: SecurityIncident[];
  } {
    const incidentsByType: Record<string, number> = {};
    const incidentsBySeverity: Record<string, number> = {};

    this.incidents.forEach((incident) => {
      incidentsByType[incident.incidentType] = (incidentsByType[incident.incidentType] || 0) + 1;
      incidentsBySeverity[incident.severity] = (incidentsBySeverity[incident.severity] || 0) + 1;
    });

    const topPatterns = Array.from(this.patternCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([pattern, count]) => ({ pattern, count }));

    return {
      totalIncidents: this.incidents.length,
      incidentsByType,
      incidentsBySeverity,
      topPatterns,
      recentIncidents: this.incidents.slice(-10),
    };
  }

  /**
   * Check if we're seeing concerning security trends
   */
  checkSecurityTrends(): {
    criticalIncidents: number;
    highIncidentsRecent: number;
    patternTrendAlert: boolean;
    recommendations: string[];
  } {
    const last24Hours = Date.now() - 24 * 60 * 60 * 1000;
    const recentIncidents = this.incidents.filter((i) => i.timestamp.getTime() > last24Hours);

    const criticalIncidents = recentIncidents.filter((i) => i.severity === 'critical').length;
    const highIncidentsRecent = recentIncidents.filter((i) => i.severity === 'high').length;

    // Check for pattern trend alerts (same pattern appearing frequently)
    const recentPatternCounts = new Map<string, number>();
    recentIncidents.forEach((incident) => {
      incident.patterns.forEach((pattern) => {
        recentPatternCounts.set(pattern, (recentPatternCounts.get(pattern) || 0) + 1);
      });
    });

    const patternTrendAlert = Array.from(recentPatternCounts.values()).some((count) => count > 5);

    const recommendations: string[] = [];

    if (criticalIncidents > 0) {
      recommendations.push(
        'URGENT: Review model configuration - critical information leaks detected'
      );
    }
    if (highIncidentsRecent > 10) {
      recommendations.push(
        'Consider stricter model prompting to reduce internal reasoning exposure'
      );
    }
    if (patternTrendAlert) {
      recommendations.push('Review sanitization patterns - new attack vectors may be emerging');
    }

    return {
      criticalIncidents,
      highIncidentsRecent,
      patternTrendAlert,
      recommendations,
    };
  }
}

// Export singleton
export const securityMonitor = new SecurityMonitor();
