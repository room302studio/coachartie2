import { Router } from 'express';
import { logger } from '../../shared/logger.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });

/**
 * POST /api/channel-digest: fold new channel messages into the channel's rolling summary
 * (memory/channel-digest.ts). Moved verbatim out of engine/main.ts (wave 6); path and
 * response shape are unchanged. Mounted at /api by http.ts.
 */
export const channelDigestRouter: Router = Router();

channelDigestRouter.post('/channel-digest', async (req, res) => sendResult(res, await channelDigest(req.body)));

/** POST /api/channel-digest's body: fold new lines into the channel's rolling summary. */
export async function channelDigest(body: any): Promise<ApiResult> {
  try {
    const { guildId, guildName, channelId, channelName, lines, lastMessageId } = body || {};
    if (!guildId || !channelId || !lastMessageId || !Array.isArray(lines)) {
      return reply(400, { error: 'guildId, channelId, lastMessageId and lines[] required' });
    }
    const { refreshChannelDigest } = await import('../memory/channel-digest.js');
    const result = await refreshChannelDigest({
      guildId,
      guildName: guildName || guildId,
      channelId,
      channelName: channelName || channelId,
      lines: lines.map(String),
      lastMessageId: String(lastMessageId),
    });
    let statusCode: number;
    let responseBody: any;
    if (result) {
      statusCode = 200;
      responseBody = result;
    } else {
      statusCode = 422;
      responseBody = { error: 'digest not produced' };
    }
    return reply(statusCode, responseBody);
  } catch (error) {
    logger.warn('Channel digest endpoint error:', error);
    return reply(500, { error: 'Failed to refresh digest' });
  }
}
