/**
 * Security Monitoring Routes - Monitor information disclosure prevention
 */

import { Request, Response, Router } from 'express';
import { logger } from '@coachartie/shared';
import { securityMonitor } from '../services/security-monitor.js';

const router: Router = Router();

/**
 * GET /security/status - Get security monitoring statistics
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    const stats = securityMonitor.getSecurityStats();
    const trends = securityMonitor.checkSecurityTrends();

    res.json({
      status: 'monitoring_active',
      timestamp: new Date().toISOString(),
      statistics: stats,
      trends: trends,
      security_posture: {
        critical_incidents_24h: trends.criticalIncidents,
        overall_threat_level:
          trends.criticalIncidents > 0
            ? 'high'
            : trends.highIncidentsRecent > 10
              ? 'medium'
              : 'low',
        pattern_trend_alert: trends.patternTrendAlert,
      },
    });
  } catch (error) {
    logger.error('Failed to get security status:', error);
    res.status(500).json({ error: 'Failed to retrieve security status' });
  }
});

/**
 * GET /security/incidents - Get recent security incidents (admin only)
 */
router.get('/incidents', (req: Request, res: Response) => {
  try {
    const stats = securityMonitor.getSecurityStats();

    // Return anonymized recent incidents
    const incidents = stats.recentIncidents.map((incident) => ({
      timestamp: incident.timestamp,
      incidentType: incident.incidentType,
      severity: incident.severity,
      patterns: incident.patterns,
      reductionPercent: incident.reductionPercent,
      // Don't include userId/messageId for privacy
    }));

    res.json({
      incidents,
      total_incidents: stats.totalIncidents,
      incident_summary: stats.incidentsByType,
    });
  } catch (error) {
    logger.error('Failed to get security incidents:', error);
    res.status(500).json({ error: 'Failed to retrieve security incidents' });
  }
});

/**
 * GET /security/patterns - Get top attack patterns detected
 */
router.get('/patterns', (req: Request, res: Response) => {
  try {
    const stats = securityMonitor.getSecurityStats();

    res.json({
      top_patterns: stats.topPatterns,
      pattern_analysis: {
        most_common: stats.topPatterns[0]?.pattern || 'none',
        pattern_diversity: stats.topPatterns.length,
        detection_coverage: [
          'analysis_leak',
          'assistant_commentary',
          'assistant_final_marker',
          'thinking_tags',
          'debug_output',
          'system_messages',
          'json_leak',
          'arrow_fragments',
          'colon_fragments',
          'xml_debug_tags',
        ].length,
      },
    });
  } catch (error) {
    logger.error('Failed to get security patterns:', error);
    res.status(500).json({ error: 'Failed to retrieve security patterns' });
  }
});

export { router as securityRouter };
