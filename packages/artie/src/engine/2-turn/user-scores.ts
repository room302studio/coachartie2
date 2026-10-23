/**
 * Per-user "vibe" scores — an ongoing, weighted read of each person Artie talks to,
 * on three Jungian-rooted 0-100 dimensions:
 *   - warmth        (Feeling↔Thinking): friendly/kind vs cold/hostile
 *   - openness      (iNtuition/Perceiving): curious/open vs closed/dismissive
 *   - expressiveness(Extraversion): talkative/elaborate vs terse
 *
 * Updated as an exponentially-weighted moving average so recent behavior counts more,
 * scored on the cheap BACKGROUND_MODEL and fired fire-and-forget so it never touches
 * the response latency or the Opus bill.
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { openRouterService } from './llm/openrouter.js';

export interface UserScores {
  warmth: number;
  openness: number;
  expressiveness: number;
  interactions: number;
}

const ALPHA = 0.25; // weight on the newest sample; older behavior decays smoothly
let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getSyncDb();
  db.exec(`CREATE TABLE IF NOT EXISTS user_scores (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',
    warmth REAL DEFAULT 50,
    openness REAL DEFAULT 50,
    expressiveness REAL DEFAULT 50,
    interactions INTEGER DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (user_id, guild_id)
  )`);
  tableReady = true;
}

export function getUserScores(userId: string, guildId = ''): UserScores | null {
  try {
    ensureTable();
    const db = getSyncDb();
    const row = db.get<UserScores>(
      `SELECT warmth, openness, expressiveness, interactions FROM user_scores WHERE user_id = ? AND guild_id = ?`,
      [userId, guildId]
    );
    return row || null;
  } catch (error) {
    logger.warn('getUserScores failed:', error);
    return null;
  }
}

/** One cheap-model read of a single message. Returns null on any failure (never throws upward). */
async function scoreMessage(
  text: string
): Promise<{ warmth: number; openness: number; expressiveness: number } | null> {
  const clean = (text || '').trim().slice(0, 800);
  if (clean.length < 8) return null; // too short to read anything from

  const messages = [
    {
      role: 'system' as const,
      content:
        'Rate the SPEAKER of the following single chat message on three 0-100 dimensions, as revealed by this message: ' +
        'warmth (friendly/kind=high, cold/hostile=low), openness (curious/open-minded=high, closed/dismissive=low), ' +
        'expressiveness (talkative/elaborate=high, terse/clipped=low). ' +
        'Reply with ONLY compact JSON, no prose: {"warmth":N,"openness":N,"expressiveness":N}',
    },
    { role: 'user' as const, content: clean },
  ];

  const model =
    process.env.BACKGROUND_MODEL || process.env.FAST_MODEL || 'google/gemini-2.0-flash-001';

  try {
    const raw = await openRouterService.generateFromMessageChain(
      messages,
      'user-scoring',
      undefined,
      model,
      { stepType: 'user_scoring' }
    );
    const match = raw.match(/\{[^}]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const clamp = (n: unknown) => Math.max(0, Math.min(100, Number(n)));
    if (![parsed.warmth, parsed.openness, parsed.expressiveness].every((v) => Number.isFinite(Number(v)))) {
      return null;
    }
    return {
      warmth: clamp(parsed.warmth),
      openness: clamp(parsed.openness),
      expressiveness: clamp(parsed.expressiveness),
    };
  } catch (error) {
    logger.warn('scoreMessage failed:', error);
    return null;
  }
}

/** Fire-and-forget: score this message and blend it into the user's running profile. */
export async function updateUserScoresFromMessage(
  userId: string,
  guildId = '',
  text: string
): Promise<void> {
  try {
    if (!userId) return;
    const sample = await scoreMessage(text);
    if (!sample) return;

    ensureTable();
    const prev = getUserScores(userId, guildId);
    const blend = (old: number | undefined, s: number) =>
      prev && old !== undefined ? Math.round((ALPHA * s + (1 - ALPHA) * old) * 10) / 10 : s;

    const next = {
      warmth: blend(prev?.warmth, sample.warmth),
      openness: blend(prev?.openness, sample.openness),
      expressiveness: blend(prev?.expressiveness, sample.expressiveness),
      interactions: (prev?.interactions ?? 0) + 1,
    };

    const db = getSyncDb();
    db.run(
      `INSERT INTO user_scores (user_id, guild_id, warmth, openness, expressiveness, interactions, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, guild_id) DO UPDATE SET
         warmth = excluded.warmth,
         openness = excluded.openness,
         expressiveness = excluded.expressiveness,
         interactions = excluded.interactions,
         updated_at = excluded.updated_at`,
      [userId, guildId, next.warmth, next.openness, next.expressiveness, next.interactions, new Date().toISOString()]
    );
  } catch (error) {
    logger.warn('updateUserScoresFromMessage failed:', error);
  }
}

const band = (n: number) => (n >= 67 ? 'high' : n >= 34 ? 'moderate' : 'low');

export function formatUserScores(s: UserScores): string {
  return (
    `Warmth ${Math.round(s.warmth)} (${band(s.warmth)}), ` +
    `Openness ${Math.round(s.openness)} (${band(s.openness)}), ` +
    `Expressiveness ${Math.round(s.expressiveness)} (${band(s.expressiveness)})`
  );
}
