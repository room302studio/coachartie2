/**
 * Autonomous "nudge" context source builders extracted verbatim from ContextAlchemy.
 *
 * Behavior is byte-for-byte identical to the original private methods — the only
 * change is that instance state (`this.lastSongNudgeAt`) is passed in as an explicit
 * `nudgeState` Map so these live as plain functions. Do not change wording, chances,
 * cooldowns, priorities, or token weights.
 */

import { logger } from '@coachartie/shared';
import { estimateTokens } from '@coachartie/shared';
import type { IncomingMessage } from '@coachartie/shared';
import type { ContextSource } from '../context-providers/types.js';
import { DEBUG } from '../context-providers/types.js';

/**
 * Occasionally nudge Artie to make his reply an ACTUAL sung track. Songs are his single
 * biggest hit in the community (they top the reaction data), but nothing ever made him
 * *decide* to sing on his own — he only sang on explicit request. This gives him
 * autonomous initiative: a probabilistic, per-channel-cooldown'd, banter-channels-only
 * prompt so songs happen naturally without spamming or singing at a bug report.
 * Tunable via SONG_NUDGE_CHANCE (default 0.12); set to 0 to disable.
 *
 * `nudgeState` is the per-channel cooldown map owned by ContextAlchemy
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

/**
 * Add random moltbook peek - like checking Twitter
 * ~10% chance to show what other AIs are posting
 */
export async function addMoltbookPeek(sources: ContextSource[]): Promise<void> {
  try {
    // Only trigger ~10% of the time (like randomly checking social media)
    if (Math.random() > 0.1) {
      return;
    }

    const apiKey = process.env.MOLTBOOK_API_KEY;
    if (!apiKey) {
      return; // Not configured
    }

    if (DEBUG) {
      logger.info('🤖 Moltbook peek triggered (10% random chance)');
    }

    // Hard timeout: this is a blocking external GET on the context-assembly hot path.
    // Without a bound, a slow moltbook response stalls the whole reply. 3s, then bail.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let response: Response;
    try {
      response = await fetch('https://www.moltbook.com/api/v1/feed?limit=3', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as { success: boolean; data?: any[] };
    if (!data.success || !data.data || data.data.length === 0) {
      return;
    }

    const posts = data.data
      .slice(0, 2)
      .map((p: any) => `• @${p.author}: "${p.title}" (m/${p.submolt})`)
      .join('\n');

    const content = `[moltbook peek - what other AIs are posting]\n${posts}`;

    sources.push({
      name: 'moltbook_peek',
      priority: 20, // Low priority - background awareness
      tokenWeight: estimateTokens(content),
      content,
      category: 'system',
    });

    if (DEBUG) {
      logger.info('│ ✅ Added moltbook peek to context');
    }
  } catch (error) {
    // Silent fail - this is optional background context
    if (DEBUG) {
      logger.warn('Moltbook peek failed:', error);
    }
  }
}
