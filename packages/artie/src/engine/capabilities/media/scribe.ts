/**
 * scribe: Artie's handle on the voice meeting scribe (his audio asks #1 and #3, 2026-11-23).
 * status: anyone may ask whether notes are being taken and where the summary lands.
 * start/stop: EJ only (who:'owner'; the gateway checks again), from a Room 302 channel. The
 * summary posts to the channel it was started from, and the same "Artie is taking notes"
 * notice /scribe posts goes up on start, so nobody is recorded without being told.
 */
import type { RegisteredCapability, CapabilityContext } from '../registry.js';
import * as gateway from '../../../gateway/api.js';
import { logger } from '../../../shared/logger.js';
import { snowflakeOf } from '../discord/search.js';

async function scribeHandler(params: Record<string, unknown>, context?: CapabilityContext): Promise<string> {
  const guildId = context?.guildId ?? null;
  const userId = context?.userId ?? null;
  const from = context?.channelId;
  try {
    if (params.action === 'status') {
      return JSON.stringify((await gateway.scribeStatus(guildId, userId, from)).body);
    }
    if (params.action === 'last_summary') {
      return JSON.stringify((await gateway.scribeLastSummary(guildId, userId, from)).body);
    }
    if (params.action === 'start') {
      const resp = await gateway.scribeStart(guildId, userId, from, snowflakeOf(params.voiceChannelId));
      return JSON.stringify(resp.body);
    }
    if (params.action === 'stop') {
      return JSON.stringify((await gateway.scribeStop(guildId, userId, from)).body);
    }
  } catch (error) {
    logger.error('[scribe tool] failed:', error);
    return JSON.stringify({ success: false, error: 'scribe unavailable: discord may be down' });
  }
  throw new Error(`Unknown scribe action: ${String(params.action)}`);
}

export const scribeCapability: RegisteredCapability = {
  name: 'scribe',
  emoji: '📝',
  actions: {
    status: { effect: 'read' },
    last_summary: { effect: 'read' },
    // Recording people is EJ's call, the same as /scribe start.
    start: {
      effect: 'discord',
      who: 'owner',
      params: {
        voiceChannelId: {
          type: 'string',
          description: 'Voice channel to join; default: the one EJ is in',
        },
      },
    },
    stop: { effect: 'discord', who: 'owner' },
  },
  supportedActions: ['status', 'last_summary', 'start', 'stop'],
  description:
    'The voice meeting scribe (Room 302). status: is a session live, where its summary will post, ' +
    'what auto-scribe watches and where those summaries go, and the last session. last_summary: ' +
    'the last meeting\'s summary text ("what did we decide?"), when everyone here can see where it ' +
    'was posted. start/stop: ' +
    'only when EJ asks; start joins his voice channel, posts the notes notice, and the summary ' +
    'lands in the channel you started it from.',
  requiredParams: ['action'],
  examples: ['<capability name="scribe" action="status" />'],
  handler: async (params: Record<string, unknown>, _content: string | undefined, context?: CapabilityContext) =>
    scribeHandler(params, context),
};
