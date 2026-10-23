import { Router } from 'express';
import { logger } from '../../shared/logger.js';

/**
 * POST /api/channel-digest: fold new channel messages into the channel's rolling summary
 * (memory/channel-digest.ts). Moved verbatim out of engine/main.ts (wave 6); path and
 * response shape are unchanged. Mounted at /api by http.ts.
 */
export const channelDigestRouter: Router = Router();

channelDigestRouter.post('/channel-digest', async (req, res) => {
  try {
    const { guildId, guildName, channelId, channelName, lines, lastMessageId } = req.body || {};
    if (!guildId || !channelId || !lastMessageId || !Array.isArray(lines)) {
      return res.status(400).json({ error: 'guildId, channelId, lastMessageId and lines[] required' });
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
    res.status(result ? 200 : 422).json(result ?? { error: 'digest not produced' });
  } catch (error) {
    logger.warn('Channel digest endpoint error:', error);
    res.status(500).json({ error: 'Failed to refresh digest' });
  }
});
