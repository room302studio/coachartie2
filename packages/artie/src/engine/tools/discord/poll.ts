/**
 * Discord Poll Capability
 * Lets Artie create native Discord polls in the current channel and read their results.
 * Active polls are rate-limited per channel by the discord service (anti-spam).
 */

import {
  RegisteredCapability,
  CapabilityContext,
} from '../../5-tool-loop/registry.js';
import { logger } from '../../../shared/logger.js';
import * as gateway from '../../../gateway/api.js';

/** Split "A | B | C" (preferred) or newline-separated option lists into an array. */
function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((o) => String(o));
  if (typeof raw !== 'string') return [];
  let sep: string;
  if (raw.includes('|')) {
    sep = '|';
  } else {
    sep = '\n';
  }
  return raw
    .split(sep)
    .map((o) => o.trim())
    .filter(Boolean);
}

export const discordPollCapability: RegisteredCapability = {
  name: 'discord-poll',
  emoji: '🗳️',
  supportedActions: ['create_poll', 'read_poll'],
  description:
    'Create a native Discord poll in the current channel, or read a poll\'s live results. ' +
    'Use create_poll with a question and options (2-10, separated by "|") to run a vote — ' +
    'great for launch-tagline votes, ranking bits, and sales-team standings. Optional: ' +
    'duration_hours (default 24) and multi="true" to allow multiple picks. ' +
    'Use read_poll with a message_id to fetch current tallies (or omit it to read the poll you last created here). ' +
    'Channels cap how many of your polls can be active at once, so make them count.',
  requiredParams: [],
  examples: [
    '<capability name="discord-poll" action="create_poll" question="Best launch tagline?" options="Build the city it deserves | Every great city runs on rails | Wishlist the commute" />',
    '<capability name="discord-poll" action="create_poll" question="Rank the S-tier builder" options="jan_gbg | rebecka_j | anseriform" duration_hours="6" />',
    '<capability name="discord-poll" action="read_poll" message_id="1520088794551025684" />',
  ],

  handler: async (params: any, _content: string | undefined, context?: CapabilityContext) => {
    const action = params.action;
    // channelId is auto-injected into params (like discord-threads); context is a fallback.
    const channelId = params.channelId || context?.channelId;

    if (!channelId) {
      return JSON.stringify({
        success: false,
        error: 'No channelId in context — polls only work in a channel',
      });
    }

    try {
      if (action === 'read_poll') {
        const messageId = params.message_id || lastPollByChannel.get(channelId);
        if (!messageId) {
          return JSON.stringify({ success: false, error: 'no message_id given and no recent poll to read' });
        }
        // Gateway's GET /api/channels/:id/polls/:messageId, in-process since wave 9
        const resp = await gateway.readPoll(String(channelId), String(messageId));
        const data = resp.body;
        if (!gateway.isOk(resp) || !(data as any).success) {
          return JSON.stringify({ success: false, error: (data as any).error || 'could not read poll' });
        }
        return JSON.stringify(data);
      }

      // create_poll
      const question = String(params.question || '').trim();
      const options = parseOptions(params.options);
      if (!question || options.length < 2) {
        return JSON.stringify({
          success: false,
          error: 'create_poll needs a question and at least 2 options separated by "|"',
        });
      }

      // Gateway's POST /api/channels/:id/polls, in-process since wave 9
      let durationHours: number | undefined;
      if (params.duration_hours) {
        durationHours = Number(params.duration_hours);
      } else {
        durationHours = undefined;
      }
      const resp = await gateway.createPoll(String(channelId), {
        question,
        options,
        durationHours,
        allowMultiselect: params.multi === 'true' || params.multi === true,
      });
      const data = resp.body as any;
      if (!gateway.isOk(resp) || !data.success) {
        return JSON.stringify({ success: false, error: data.error || 'poll creation failed' });
      }

      lastPollByChannel.set(channelId, data.messageId);
      logger.info(`[poll] Created poll in ${channelId}: "${question}"`);
      return JSON.stringify({
        success: true,
        message: `Poll is live: "${question}" (${options.length} options, ${data.durationHours}h)`,
        messageId: data.messageId,
      });
    } catch (error) {
      logger.error('[poll] failed:', error);
      return JSON.stringify({ success: false, error: 'poll request failed — discord service may be down' });
    }
  },
};

// Remember the last poll Artie made per channel so read_poll works without an explicit id.
const lastPollByChannel = new Map<string, string>();
