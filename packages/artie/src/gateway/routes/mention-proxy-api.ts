/**
 * Mention Proxy API Routes
 *
 * REST API for managing mention proxy rules.
 * Called by the capabilities service to CRUD rules.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import { getMentionProxyService } from '../2-gate/mention-proxy.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';
import { getErrorMessage } from '../../shared/errors.js';

// Wave 9: each route's handler body is an exported function (below the routes) returning
// the status + JSON it used to send; gateway/api.ts calls them in-process for the engine's
// mention-proxy tool, which used to reach them over HTTP.
const reply = (status: number, body: any): ApiResult => ({ status, body });

export const mentionProxyRouter: Router = Router();

/**
 * GET /api/mention-proxy/rules
 * List all mention proxy rules
 */
mentionProxyRouter.get('/rules', (req: Request, res: Response) => sendResult(res, listProxyRules()));

/**
 * GET /api/mention-proxy/rules/:id
 * Get a specific mention proxy rule
 */
mentionProxyRouter.get('/rules/:id', (req: Request, res: Response) => sendResult(res, getProxyRule(req.params)));

/**
 * GET /api/mention-proxy/rules/guild/:guildId
 * Get rules for a specific guild
 */
mentionProxyRouter.get('/rules/guild/:guildId', (req: Request, res: Response) => sendResult(res, listProxyRulesForGuild(req.params)));

/**
 * GET /api/mention-proxy/rules/user/:userId
 * Get rules for a specific user
 */
mentionProxyRouter.get('/rules/user/:userId', (req: Request, res: Response) => sendResult(res, listProxyRulesForUser(req.params)));

/**
 * POST /api/mention-proxy/rules
 * Create a new mention proxy rule
 */
mentionProxyRouter.post('/rules', (req: Request, res: Response) => sendResult(res, createProxyRule(req.body)));

/**
 * PATCH /api/mention-proxy/rules/:id
 * Update a mention proxy rule
 */
mentionProxyRouter.patch('/rules/:id', (req: Request, res: Response) => sendResult(res, updateProxyRule(req.params, req.body)));

/**
 * DELETE /api/mention-proxy/rules/:id
 * Delete a mention proxy rule
 */
mentionProxyRouter.delete('/rules/:id', (req: Request, res: Response) => sendResult(res, deleteProxyRule(req.params)));

export function listProxyRules(): ApiResult {
  try {
    const service = getMentionProxyService();
    const rules = service.getAllRules();

    return reply(200, {
      success: true,
      rules,
      count: rules.length,
    });
  } catch (error) {
    logger.error('Failed to list mention proxy rules:', error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export function getProxyRule(params: Record<string, string>): ApiResult {
  try {
    const service = getMentionProxyService();
    const rule = service.getRule(params.id);

    if (!rule) {
      return reply(404, {
        success: false,
        error: 'Rule not found',
      });
    }

    return reply(200, {
      success: true,
      rule,
    });
  } catch (error) {
    logger.error(`Failed to get mention proxy rule ${params.id}:`, error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export function listProxyRulesForGuild(params: Record<string, string>): ApiResult {
  try {
    const service = getMentionProxyService();
    const rules = service.getRulesForGuild(params.guildId);

    return reply(200, {
      success: true,
      rules,
      guildId: params.guildId,
      count: rules.length,
    });
  } catch (error) {
    logger.error(`Failed to get mention proxy rules for guild ${params.guildId}:`, error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export function listProxyRulesForUser(params: Record<string, string>): ApiResult {
  try {
    const service = getMentionProxyService();
    const rules = service.getRulesForUser(params.userId);

    return reply(200, {
      success: true,
      rules,
      userId: params.userId,
      count: rules.length,
    });
  } catch (error) {
    logger.error(`Failed to get mention proxy rules for user ${params.userId}:`, error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export function createProxyRule(body: any): ApiResult {
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
    } = body;

    // Validation
    if (!targetUserId || !targetUsername || !guildId || !name) {
      return reply(400, {
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

    return reply(200, {
      success: true,
      rule,
      message: `Created mention proxy rule: ${name}`,
    });
  } catch (error) {
    logger.error('Failed to create mention proxy rule:', error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export function updateProxyRule(params: Record<string, string>, body: any): ApiResult {
  try {
    const service = getMentionProxyService();
    const updates = body;

    const rule = service.updateRule(params.id, updates);

    if (!rule) {
      return reply(404, {
        success: false,
        error: 'Rule not found',
      });
    }

    return reply(200, {
      success: true,
      rule,
      message: `Updated mention proxy rule: ${params.id}`,
    });
  } catch (error) {
    logger.error(`Failed to update mention proxy rule ${params.id}:`, error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export function deleteProxyRule(params: Record<string, string>): ApiResult {
  try {
    const service = getMentionProxyService();
    const success = service.deleteRule(params.id);

    if (!success) {
      return reply(404, {
        success: false,
        error: 'Rule not found',
      });
    }

    return reply(200, {
      success: true,
      message: `Deleted mention proxy rule: ${params.id}`,
    });
  } catch (error) {
    logger.error(`Failed to delete mention proxy rule ${params.id}:`, error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}
