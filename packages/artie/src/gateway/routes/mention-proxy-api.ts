/**
 * Mention Proxy API Routes
 *
 * REST API for managing mention proxy rules.
 * Called by the capabilities service to CRUD rules.
 */

import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { getMentionProxyService } from '../services/mention-proxy-service.js';

export const mentionProxyRouter: Router = Router();

/**
 * GET /api/mention-proxy/rules
 * List all mention proxy rules
 */
mentionProxyRouter.get('/rules', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const rules = service.getAllRules();

    res.json({
      success: true,
      rules,
      count: rules.length,
    });
  } catch (error) {
    logger.error('Failed to list mention proxy rules:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/mention-proxy/rules/:id
 * Get a specific mention proxy rule
 */
mentionProxyRouter.get('/rules/:id', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const rule = service.getRule(req.params.id);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Rule not found',
      });
    }

    res.json({
      success: true,
      rule,
    });
  } catch (error) {
    logger.error(`Failed to get mention proxy rule ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/mention-proxy/rules/guild/:guildId
 * Get rules for a specific guild
 */
mentionProxyRouter.get('/rules/guild/:guildId', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const rules = service.getRulesForGuild(req.params.guildId);

    res.json({
      success: true,
      rules,
      guildId: req.params.guildId,
      count: rules.length,
    });
  } catch (error) {
    logger.error(`Failed to get mention proxy rules for guild ${req.params.guildId}:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/mention-proxy/rules/user/:userId
 * Get rules for a specific user
 */
mentionProxyRouter.get('/rules/user/:userId', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const rules = service.getRulesForUser(req.params.userId);

    res.json({
      success: true,
      rules,
      userId: req.params.userId,
      count: rules.length,
    });
  } catch (error) {
    logger.error(`Failed to get mention proxy rules for user ${req.params.userId}:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/mention-proxy/rules
 * Create a new mention proxy rule
 */
mentionProxyRouter.post('/rules', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const {
      targetUserId,
      targetUsername,
      guildId,
      name,
      guildName,
      channelIds,
      responseMode,
      responseStyle,
      triggerType,
      keywords,
      description,
      createdBy,
    } = req.body;

    // Validation
    if (!targetUserId || !targetUsername || !guildId || !name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: targetUserId, targetUsername, guildId, name',
      });
    }

    const rule = service.createRule(targetUserId, targetUsername, guildId, name, {
      guildName,
      channelIds,
      responseMode,
      responseStyle,
      triggerType,
      keywords,
      description,
      createdBy,
    });

    res.json({
      success: true,
      rule,
      message: `Created mention proxy rule: ${name}`,
    });
  } catch (error) {
    logger.error('Failed to create mention proxy rule:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/mention-proxy/rules/:id
 * Update a mention proxy rule
 */
mentionProxyRouter.patch('/rules/:id', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const updates = req.body;

    const rule = service.updateRule(req.params.id, updates);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Rule not found',
      });
    }

    res.json({
      success: true,
      rule,
      message: `Updated mention proxy rule: ${req.params.id}`,
    });
  } catch (error) {
    logger.error(`Failed to update mention proxy rule ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/mention-proxy/rules/:id
 * Delete a mention proxy rule
 */
mentionProxyRouter.delete('/rules/:id', (req: Request, res: Response) => {
  try {
    const service = getMentionProxyService();
    const success = service.deleteRule(req.params.id);

    if (!success) {
      return res.status(404).json({
        success: false,
        error: 'Rule not found',
      });
    }

    res.json({
      success: true,
      message: `Deleted mention proxy rule: ${req.params.id}`,
    });
  } catch (error) {
    logger.error(`Failed to delete mention proxy rule ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
