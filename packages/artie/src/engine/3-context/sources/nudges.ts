/**
 * Autonomous "nudge" context source builders extracted verbatim from ContextAssembler (assemble.ts).
 *
 * Behavior is byte-for-byte identical to the original private methods — the only
 * change is that instance state (`this.lastSongNudgeAt`) is passed in as an explicit
 * `nudgeState` Map so these live as plain functions. Do not change wording, chances,
 * cooldowns, priorities, or token weights.
 */

import { logger } from '../../../shared/logger.js';
import { estimateTokens } from '../../../shared/async.js';
import type { IncomingMessage } from '../../../shared/queue/types.js';
import type { ContextSource } from './types.js';
import { DEBUG } from './types.js';

/**
 * Occasionally nudge Artie to make his reply an ACTUAL sung track. Songs are his single
 * biggest hit in the community (they top the reaction data), but nothing ever made him
 * *decide* to sing on his own — he only sang on explicit request. This gives him
 * autonomous initiative: a probabilistic, per-channel-cooldown'd, banter-channels-only
 * prompt so songs happen naturally without spamming or singing at a bug report.
 * Tunable via SONG_NUDGE_CHANCE (default 0.12); set to 0 to disable.
 *
 * `nudgeState` is the per-channel cooldown map owned by ContextAssembler
 * (this.lastSongNudgeAt) — passed in so behavior is identical.
 */
export async function addSongNudge(
  message: IncomingMessage,
  sources: ContextSource[],
  nudgeState: Map<string, number>
): Promise<void> {
  try {
    const chance = parseFloat(process.env.SONG_NUDGE_CHANCE || '0.12');
    if (!(chance > 0) || Math.random() > chance) return;

    const channelId = message.context?.channelId;
    if (!channelId) return;

    // No channel-name gating — the nudge itself tells Artie "only if it genuinely fits;
    // don't force a song onto a serious moment," and he's better at reading whether a
    // bug report wants a song than any keyword list would be. Trust his judgment.

    // Per-channel cooldown so a busy channel doesn't get nudged every other message.
    const now = Date.now();
    if (now - (nudgeState.get(channelId) ?? 0) < 20 * 60 * 1000) return;
    nudgeState.set(channelId, now);

    const content =
      `🎨 MAKE SOMETHING: your multimedia bits — songs, sound effects, generated images — are ` +
      `your biggest hits and you reach for them nowhere near enough. If this moment would land ` +
      `harder as MEDIA, make it instead of just typing: sing an actual track (sing action, real ` +
      `lyrics); drop a sound effect (sfx — an airhorn, a train horn doppler, a sad trombone, a ` +
      `record scratch, whatever the punchline needs); or generate an image (image_gen) when ` +
      `someone's describing something you could just SHOW them. Commit and post the file. Only ` +
      `if it genuinely fits the moment — don't force media onto a serious one.`;

    sources.push({
      name: 'media_nudge',
      priority: 55,
      tokenWeight: estimateTokens(content),
      content,
      category: 'system',
    });
    if (DEBUG) logger.info(`│ 🎵 Song-moment nudge injected for channel ${channelId}`);
  } catch (e) {
    logger.warn('Song nudge failed:', e);
  }
}
