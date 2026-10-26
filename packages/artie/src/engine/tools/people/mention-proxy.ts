/**
 * Mention Proxy Capability
 *
 * Allows Artie to manage mention proxy rules - acting as a representative
 * for specific users in specific Discord contexts.
 *
 * This gives Artie the "mechanism and affordance" to handle public-facing
 * representation without hard-coding rules.
 */

import { logger } from '../../../shared/logger.js';
import { RegisteredCapability } from '../../5-tool-loop/registry.js';
import * as gateway from '../../../gateway/api.js';

/**
 * The gateway's /api/mention-proxy/rules handlers, in-process since wave 9 (were axios calls
 * to :47321). axios threw on any non-2xx; this keeps that, with axios's message.
 */
async function rules(call: Promise<gateway.ApiResult>): Promise<{ data: any }> {
  const response = await call;
  if (!gateway.isOk(response)) {
    throw new Error(`Request failed with status code ${response.status}`);
  }
  return { data: response.body };
}

interface MentionProxyParams {
  action:
    | 'create'
    | 'list'
    | 'get'
    | 'update'
    | 'delete'
    | 'enable'
    | 'disable'
    | 'list_for_guild'
    | 'list_for_user';
  user_id?: string;
  rule_id?: string;
  target_user_id?: string;
  target_username?: string;
  guild_id?: string;
  guild_name?: string;
  channel_ids?: string[];
  response_mode?: 'direct' | 'announced' | 'assistant';
  response_style?: string;
  trigger_type?: 'any_mention' | 'questions_only' | 'keywords';
  keywords?: string[];
  name?: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

// =============================================================================
// API HELPERS
// =============================================================================

function statusWord(enabled: boolean): string {
  if (enabled) {
    return 'Enabled';
  }
  return 'Disabled';
}

async function createProxyRule(params: MentionProxyParams) {
  if (!params.target_user_id || !params.target_username || !params.guild_id || !params.name) {
    throw new Error(
      'target_user_id, target_username, guild_id, and name are required for create action'
    );
  }

  const response = await rules(
    gateway.mentionProxyRules.create({
      targetUserId: params.target_user_id,
      targetUsername: params.target_username,
      guildId: params.guild_id,
      name: params.name,
      guildName: params.guild_name,
      channelIds: params.channel_ids,
      responseMode: params.response_mode || 'direct',
      responseStyle: params.response_style,
      triggerType: params.trigger_type || 'any_mention',
      keywords: params.keywords,
      description: params.description,
    })
  );

  return JSON.stringify(
    {
      success: true,
      rule: response.data.rule,
      message: `Created mention proxy rule: ${params.name}`,
    },
    null,
    2
  );
}

async function listProxyRules() {
  const response = await rules(gateway.mentionProxyRules.list());
  return JSON.stringify(
    {
      success: true,
      rules: response.data.rules,
      count: response.data.rules.length,
    },
    null,
    2
  );
}

async function getProxyRule(ruleId: string) {
  const response = await rules(gateway.mentionProxyRules.get(String(ruleId)));
  return JSON.stringify(
    {
      success: true,
      rule: response.data.rule,
    },
    null,
    2
  );
}

async function updateProxyRule(ruleId: string, params: MentionProxyParams) {
  const updates: any = {};

  if (params.name) updates.name = params.name;
  if (params.description !== undefined) updates.description = params.description;
  if (params.guild_name !== undefined) updates.guildName = params.guild_name;
  if (params.channel_ids !== undefined) updates.channelIds = params.channel_ids;
  if (params.response_mode) updates.responseMode = params.response_mode;
  if (params.response_style !== undefined) updates.responseStyle = params.response_style;
  if (params.trigger_type) updates.triggerType = params.trigger_type;
  if (params.keywords !== undefined) updates.keywords = params.keywords;
  if (params.enabled !== undefined) updates.enabled = params.enabled;

  const response = await rules(gateway.mentionProxyRules.update(String(ruleId), updates));

  return JSON.stringify(
    {
      success: true,
      rule: response.data.rule,
      message: `Updated mention proxy rule: ${ruleId}`,
    },
    null,
    2
  );
}

async function deleteProxyRule(ruleId: string) {
  await rules(gateway.mentionProxyRules.remove(String(ruleId)));
  return JSON.stringify(
    {
      success: true,
      message: `Deleted mention proxy rule: ${ruleId}`,
    },
    null,
    2
  );
}

async function setProxyRuleEnabled(ruleId: string, enabled: boolean) {
  const response = await rules(gateway.mentionProxyRules.update(String(ruleId), { enabled }));

  return JSON.stringify(
    {
      success: true,
      rule: response.data.rule,
      message: `${statusWord(enabled)} mention proxy rule: ${ruleId}`,
    },
    null,
    2
  );
}

async function listProxyRulesForGuild(guildId: string) {
  const response = await rules(gateway.mentionProxyRules.listForGuild(String(guildId)));
  return JSON.stringify(
    {
      success: true,
      rules: response.data.rules,
      guildId,
      count: response.data.rules.length,
    },
    null,
    2
  );
}

async function listProxyRulesForUser(userId: string) {
  const response = await rules(gateway.mentionProxyRules.listForUser(String(userId)));
  return JSON.stringify(
    {
      success: true,
      rules: response.data.rules,
      userId,
      count: response.data.rules.length,
    },
    null,
    2
  );
}

// =============================================================================
// CAPABILITY HANDLER
// =============================================================================

const handler = async (params: any, _content?: string): Promise<string> => {
  try {
    const { action } = params;

    logger.info(`Mention proxy capability called: ${action}`, { params });

    switch (action) {
      case 'create':
        return await createProxyRule(params);

      case 'list':
        return await listProxyRules();

      case 'get':
        if (!params.rule_id) {
          throw new Error('rule_id is required for get action');
        }
        return await getProxyRule(params.rule_id);

      case 'update':
        if (!params.rule_id) {
          throw new Error('rule_id is required for update action');
        }
        return await updateProxyRule(params.rule_id, params);

      case 'delete':
        if (!params.rule_id) {
          throw new Error('rule_id is required for delete action');
        }
        return await deleteProxyRule(params.rule_id);

      case 'enable':
        if (!params.rule_id) {
          throw new Error('rule_id is required for enable action');
        }
        return await setProxyRuleEnabled(params.rule_id, true);

      case 'disable':
        if (!params.rule_id) {
          throw new Error('rule_id is required for disable action');
        }
        return await setProxyRuleEnabled(params.rule_id, false);

      case 'list_for_guild':
        if (!params.guild_id) {
          throw new Error('guild_id is required for list_for_guild action');
        }
        return await listProxyRulesForGuild(params.guild_id);

      case 'list_for_user':
        if (!params.user_id) {
          throw new Error('user_id is required for list_for_user action');
        }
        return await listProxyRulesForUser(params.user_id);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    logger.error('Mention proxy capability error:', error);
    throw error;
  }
};

// =============================================================================
// CAPABILITY EXPORT
// =============================================================================

export const mentionProxyCapability: RegisteredCapability = {
  name: 'mention_proxy',
  emoji: '🎭',
  supportedActions: [
    'create',
    'list',
    'get',
    'update',
    'delete',
    'enable',
    'disable',
    'list_for_guild',
    'list_for_user',
  ],
  description:
    'Manage mention proxy rules to act as representative for users in Discord. Create rules to respond when specific users are @mentioned in guilds. Supports different response modes (direct/announced/assistant) and trigger types (any_mention/questions_only/keywords).',
  requiredParams: [],
  examples: [
    '<capability name="mention_proxy" action="list" />',
    '<capability name="mention_proxy" action="create" data=\'{"target_user_id":"123456","target_username":"ejfox","guild_id":"789","name":"EJ Subway Builder Rep","response_mode":"direct","trigger_type":"any_mention"}\' />',
    '<capability name="mention_proxy" action="list_for_guild" data=\'{"guild_id":"123456789"}\' />',
    '<capability name="mention_proxy" action="update" data=\'{"rule_id":"proxy-123","enabled":false}\' />',
    '<capability name="mention_proxy" action="delete" data=\'{"rule_id":"proxy-123"}\' />',
  ],
  handler,
};
