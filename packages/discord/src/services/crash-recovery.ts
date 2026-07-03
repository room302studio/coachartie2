/**
 * Crash recovery: on startup, find recent user messages that never got an
 * assistant reply (i.e. we crashed mid-processing) and replay them through
 * the normal MessageCreate pipeline so all existing guards (whitelist,
 * killswitch, mention checks, cooldowns) apply naturally.
 *
 * Safety properties:
 * - Only rows created BEFORE this process booted are considered (a row that
 *   exists but predates boot with no assistant reply is the crash signature;
 *   anything newer is being handled live right now).
 * - Only the most recent unanswered message per channel.
 * - Hard cap of 5 replays total, spaced 10s apart, oldest-first.
 * - Each candidate is re-fetched from Discord and matched by author + time
 *   (+ content when ambiguous). If we can't confidently re-fetch it, we skip
 *   it — we never synthesize or guess.
 * - Feature flag: CRASH_RECOVERY_REPLAY=false disables (default enabled).
 * - Entire pass is best-effort; failures never affect boot.
 *
 * Known limitation: [SILENT] suppressions do not write an assistant row, so a
 * channel where Artie deliberately stayed quiet can look "unanswered". The 2h
 * window, per-channel dedupe, 5-message cap, and the fact that replays re-run
 * the real response guards (mention/DM/robot-channel checks) keep this safe —
 * a message that wouldn't have gotten a reply still won't get one on replay.
 */

import {
  ChannelType,
  Client,
  Events,
  Message,
  OmitPartialGroupDMChannel,
  TextBasedChannel,
} from 'discord.js';

type PipelineMessage = OmitPartialGroupDMChannel<Message>;
import { logger, getSyncDb } from '@coachartie/shared';

// Captured at module load. Any message row created after this moment was (or
// is being) handled by the live pipeline — never replay it.
const PROCESS_START = new Date(Date.now() - process.uptime() * 1000);

const WINDOW_HOURS = 2;
const MAX_REPLAYS = 5;
const REPLAY_SPACING_MS = 10_000;
// How far a Discord message's timestamp may drift from the DB row's created_at
// (row is inserted shortly after receipt, so this is generous).
const MATCH_WINDOW_MS = 120_000;

interface CandidateRow {
  id: number;
  channel_id: string;
  user_id: string;
  value: string | null;
  created_at: string;
}

/** Format a JS Date as the 'YYYY-MM-DD HH:MM:SS' UTC string SQLite uses. */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Parse SQLite UTC 'YYYY-MM-DD HH:MM:SS' back to a JS Date. */
function fromSqliteUtc(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

function normalize(s: string): string {
  return s
    .replace(/<@!?\d+>/g, '') // mentions may be stripped in the stored value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const CANDIDATE_SQL = `
WITH candidates AS (
  SELECT m.id, m.channel_id, m.user_id, m.value, m.created_at
  FROM messages m
  WHERE m.message_type = 'discord'
    AND (m.role IS NULL OR m.role = '')
    AND m.user_id <> 'artie'
    AND m.created_at >= datetime('now', '-${WINDOW_HOURS} hours')
    AND m.created_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM messages a
      WHERE a.channel_id = m.channel_id
        AND a.role = 'assistant'
        AND a.id > m.id
    )
)
SELECT c.id, c.channel_id, c.user_id, c.value, c.created_at
FROM candidates c
WHERE c.id = (SELECT MAX(c2.id) FROM candidates c2 WHERE c2.channel_id = c.channel_id)
ORDER BY c.created_at DESC
`;

/**
 * Re-fetch the actual Discord message for a DB candidate row.
 * Returns undefined if it can't be found confidently.
 */
async function refetchDiscordMessage(
  client: Client,
  row: CandidateRow
): Promise<Message | undefined> {
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  // Group DM partials can't flow through the MessageCreate pipeline; skip them.
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GroupDM) return undefined;

  const recent = await (channel as TextBasedChannel).messages
    .fetch({ limit: 50 })
    .catch(() => null);
  if (!recent) return undefined;

  const rowTime = fromSqliteUtc(row.created_at).getTime();
  const timeMatches = recent.filter(
    (m) =>
      m.author.id === row.user_id &&
      Math.abs(m.createdTimestamp - rowTime) <= MATCH_WINDOW_MS
  );

  if (timeMatches.size === 0) return undefined;
  if (timeMatches.size === 1) return timeMatches.first();

  // Multiple messages from the same author in the window — disambiguate by content.
  const wanted = normalize(row.value || '');
  const contentMatches = timeMatches.filter((m) => {
    const got = normalize(m.content || '');
    if (!wanted || !got) return false;
    return got === wanted || got.includes(wanted.slice(0, 60)) || wanted.includes(got.slice(0, 60));
  });
  if (contentMatches.size === 1) return contentMatches.first();

  // Still ambiguous — never guess.
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The winston console transport only shows warn+ in production, so pair
 * logger calls with console.log to make recovery activity visible in the
 * pm2 out log (same pattern as the rest of this package's boot logging).
 */
function logInfo(msg: string): void {
  console.log(msg);
  logger.info(msg);
}

function logWarn(msg: string, error?: unknown): void {
  console.warn(msg, error ?? '');
  logger.warn(msg, error);
}

/**
 * One-shot startup pass. Call once, ~30s after client ready.
 */
export async function runCrashRecovery(client: Client): Promise<void> {
  try {
    // Feature flag, read at call time.
    if (process.env.CRASH_RECOVERY_REPLAY === 'false') {
      logInfo('🩹 Crash recovery disabled via CRASH_RECOVERY_REPLAY=false');
      return;
    }

    const db = getSyncDb();
    const rows = db.all<CandidateRow>(CANDIDATE_SQL, [toSqliteUtc(PROCESS_START)]);

    if (rows.length === 0) {
      logInfo('🩹 Crash recovery: no unanswered messages found');
      return;
    }

    // rows are newest-first; keep the 5 most recent channels, log the rest.
    const kept = rows.slice(0, MAX_REPLAYS);
    const skipped = rows.slice(MAX_REPLAYS);
    if (skipped.length > 0) {
      logWarn(
        `🩹 Crash recovery: ${rows.length} channels qualified, capping at ${MAX_REPLAYS}. Skipped: ` +
          skipped.map((r) => `channel ${r.channel_id} (msg ${r.id} @ ${r.created_at})`).join('; ')
      );
    }

    // Replay oldest-first.
    kept.reverse();
    logInfo(
      `🩹 Crash recovery: found ${rows.length} unanswered message(s), replaying ${kept.length}`
    );

    let first = true;
    for (const row of kept) {
      try {
        if (!first) await sleep(REPLAY_SPACING_MS);
        first = false;

        const msg = await refetchDiscordMessage(client, row);
        if (!msg) {
          logWarn(
            `🩹 Crash recovery: could not confidently re-fetch message ${row.id} in channel ${row.channel_id} — skipping`
          );
          continue;
        }

        const channelName =
          'name' in msg.channel && msg.channel.name ? `#${msg.channel.name}` : `DM/${row.channel_id}`;
        logInfo(
          `🩹 Crash recovery: replaying message from ${msg.author.tag} in ${channelName}`
        );

        // Re-inject through the real pipeline so every existing guard applies.
        // (Group-DM channels were filtered out during re-fetch, so this cast is safe.)
        client.emit(Events.MessageCreate, msg as PipelineMessage);
      } catch (error) {
        logWarn(`🩹 Crash recovery: replay failed for row ${row.id}:`, error);
      }
    }
  } catch (error) {
    // Recovery must never prevent a clean boot.
    logWarn('🩹 Crash recovery pass failed (non-fatal):', error);
  }
}
